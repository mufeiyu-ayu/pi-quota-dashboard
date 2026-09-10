import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installedPi } from '../scripts/pi-installation.mjs';
import { resolveCredential } from '../auth.mjs';
import { statusText, snapshot, parseQuota } from '../core.mjs';

process.env.JITI_FS_CACHE = 'false';
const project = fileURLToPath(new URL('..', import.meta.url));

test('pi 0.85.1: installed OAuth toAuth / DeepSeek resolve remain read-only with fake credentials', async () => {
  const { pi, providers } = await installedPi();
  assert.equal(pi.VERSION, '0.85.1');
  assert.equal(typeof pi.readStoredCredential, 'function');
  const now = Date.now();
  for (const [id, provider] of Object.entries(providers)) {
    const credential = id === 'deepseek' ? { type: 'api_key', key: 'FAKE_DS' } : {
      type: 'oauth', access: id === 'anthropic' ? 'FAKE_CLAUDE' : `fake.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'FAKE_ACCOUNT' } })).toString('base64url')}.fake`, expires: now + 3600_000,
    };
    const ctx = { model: { provider: id, baseUrl: provider.baseUrl }, modelRegistry: { getProvider: () => provider, getProviderAuthStatus: () => ({ source: 'stored' }), getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined } };
    const auth = await resolveCredential(ctx, { providers, readCredential: () => credential, readConfig: () => ({}) }, new AbortController().signal, now);
    assert.ok(auth.key, id);
    assert.equal(auth.token, id === 'deepseek' ? credential.key : credential.access);
  }
});

test('pi installed loader loads index.ts and registers lifecycle/command without models or writes', async () => {
  const { root } = await installedPi();
  const { loadExtensions } = await import(pathToFileURL(resolve(root, 'dist/core/extensions/loader.js')).href);
  const result = await loadExtensions([resolve(project, 'index.ts')], project);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.ok(extension.commands.has('dashboard'));
  for (const name of ['session_start', 'session_shutdown', 'model_select', 'thinking_level_select', 'message_update', 'turn_end', 'session_compact']) assert.ok(extension.handlers.has(name), name);
  const statuses = new Map([['ponytail', 'unchanged']]);
  const ctx = {
    hasUI: true, model: { provider: 'FAKE_UNKNOWN', id: 'FAKE_MODEL', contextWindow: 100 }, thinkingLevel: 'off',
    getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 100 }), sessionManager: { getEntries: () => [] },
    ui: { setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value), notify: () => {} },
  };
  try {
    for (const handler of extension.handlers.get('session_start')) await handler({ type: 'session_start', reason: 'startup' }, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(statuses.has('zz-pi-quota-dashboard'), false); // 不支持的 provider 整条撤掉
  } finally {
    for (const handler of extension.handlers.get('session_shutdown')) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx);
  }
  assert.deepEqual([...statuses], [['ponytail', 'unchanged']]);
});

test('pi core footer: narrow terminal widths do not overflow or overwrite other statuses', async () => {
  const { root, load } = await installedPi();
  const { FooterComponent } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/components/footer.js')).href);
  const { initTheme } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/theme/theme.js')).href);
  const { visibleWidth } = await load('@earendil-works/pi-tui');
  initTheme('dark', false);
  const ctx = { model: { provider: 'anthropic', id: 'FAKE_模型', contextWindow: 100 }, thinkingLevel: 'high', getContextUsage: () => ({ tokens: null, contextWindow: 100, percent: null }), sessionManager: { getEntries: () => [], getCwd: () => project, getSessionName: () => undefined } };
  const text = statusText(snapshot(ctx, parseQuota('anthropic', { five_hour: { utilization: 0 } })));
  const statuses = new Map([['zz-pi-quota-dashboard', text], ['ponytail', 'unchanged']]);
  const footer = new FooterComponent({ state: { model: ctx.model }, sessionManager: ctx.sessionManager, getContextUsage: ctx.getContextUsage, modelRuntime: { isUsingSubscription: () => false } }, { getExtensionStatuses: () => statuses, getGitBranch: () => null, getAvailableProviderCount: () => 1 });
  for (const width of [0, 1, 2, 3, 8, 20, 40, 80, 160]) {
    for (const line of footer.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}`);
  }
  assert.equal(statuses.get('ponytail'), 'unchanged');
  assert.match(footer.render(20)[2], /unchanged/);
  assert.match(footer.render(160)[2], /🟢.*5h.*100%/);
  footer.dispose();
});

test('merged footer: 扩展状态与统计并进同一行、不溢出、随会话结束交还内置 footer', async () => {
  const { root, load } = await installedPi();
  const { loadExtensions } = await import(pathToFileURL(resolve(root, 'dist/core/extensions/loader.js')).href);
  const { initTheme, theme } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/theme/theme.js')).href);
  const { visibleWidth } = await load('@earendil-works/pi-tui');
  initTheme('dark', false);
  const extension = (await loadExtensions([resolve(project, 'index.ts')], project)).extensions[0];

  const message = (usage) => ({ type: 'message', message: { role: 'assistant', usage } });
  const statuses = new Map([['ponytail', 'FULL']]);
  let factory;
  // FAKE_UNKNOWN 既让额度查询直接 unsupported（不联网），也让真实 readStoredCredential 稳定返回 undefined。
  const ctx = {
    hasUI: true, mode: 'tui', thinkingLevel: 'high',
    model: { provider: 'FAKE_UNKNOWN', id: 'FAKE_模型', contextWindow: 1000, reasoning: true },
    getContextUsage: () => ({ tokens: 500, contextWindow: 1000, percent: 50 }),
    sessionManager: {
      getCwd: () => project, getSessionName: () => undefined,
      getEntries: () => [message({ input: 1200, output: 34, cacheRead: 900, cacheWrite: 100, totalTokens: 2234, cost: { total: 0.0125 } })],
    },
    modelRegistry: { getProvider: () => undefined, getProviderAuthStatus: () => ({ source: 'stored' }), getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined },
    ui: {
      setStatus: (k, v) => v === undefined ? statuses.delete(k) : statuses.set(k, v),
      setFooter: (f) => { factory = f; }, notify: () => {},
    },
  };
  try {
    for (const handler of extension.handlers.get('session_start')) await handler({ type: 'session_start', reason: 'startup' }, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(typeof factory, 'function', 'session_start 应接管 footer');
    const footer = factory(null, theme, { getGitBranch: () => 'main', getExtensionStatuses: () => statuses, getAvailableProviderCount: () => 3 });

    const lines = footer.render(160);
    assert.equal(lines.length, 1); // pi 的三行全部并成一行
    const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, '');
    // 上下文、费用与扩展状态同行，模型仍右对齐。
    // 模型、分支、上下文、费用、扩展状态全在这一行，每段一个图标。
    assert.match(plain(lines[0]), /^🤖 high · FAKE_模型 │ 🌿 main │ 📊 █████░░░░░ 50\.0% 500\/1\.0k │ 💰 \$0\.013 │ FULL$/);
    // 不显示厂商，模型段也不再右对齐。
    assert.doesNotMatch(plain(lines[0]), /FAKE_UNKNOWN/);
    // 会话尚无统计时行首不留空格。
    ctx.sessionManager.getEntries = () => [];
    assert.match(plain(footer.render(160)[0]), /│ 📊 █████░░░░░ 50\.0% 500\/1\.0k │ FULL/);
    ctx.sessionManager.getEntries = () => [message({ input: 1200, output: 34, cacheRead: 900, cacheWrite: 100, totalTokens: 2234, cost: { total: 0.0125 } })];
    // 宽度不够时先丢上下文的绝对计数；额度与其他扩展状态任何一级都不丢。
    const at = (w) => plain(footer.render(w)[0]);
    assert.match(at(200), /🌿 main │ 📊 █████░░░░░ 50\.0% 500\/1\.0k │ /);
    assert.doesNotMatch(at(75), /500\/1\.0k/);
    assert.match(at(75), /🌿 main │ 📊 █████░░░░░ 50\.0% │ /);
    assert.doesNotMatch(at(65), /🌿/);
    assert.match(at(65), /^🤖 high · FAKE_模型 │ 📊 █████░░░░░ 50\.0% │ 💰 \$0\.013 │ FULL/);
    for (const width of [0, 1, 2, 3, 8, 20, 40, 80, 160])
      for (const line of footer.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}`);
    // 有响应但 cost=0 时不拿 0 冒充已知零花费。
    ctx.sessionManager.getEntries = () => [message({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { total: 0 } })];
    assert.match(plain(footer.render(160)[0]), /💰 \$\?/);
  } finally {
    for (const handler of extension.handlers.get('session_shutdown')) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx);
  }
  assert.equal(factory, undefined, 'session_shutdown 应交还内置 footer');
  assert.deepEqual([...statuses], [['ponytail', 'FULL']]);
});
