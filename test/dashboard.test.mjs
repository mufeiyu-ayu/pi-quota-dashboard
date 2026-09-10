import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuota, sessionUsage, snapshot, statusText, ENDPOINTS, officialBase } from '../core.mjs';
import { resolveCredential, readOnlyKey, authConfigOverride, authFingerprint, isSubscription } from '../auth.mjs';
import { requestQuota, QuotaCache, retryAfterMs } from '../quota.mjs';
import { Dashboard, registerDashboard, STATUS_KEY } from '../runtime.mjs';

// All fixtures in this file are simulated, not copied from live accounts.
const NOW = 1_800_000_000_000;
const jwt = (accountId = 'FAKE_ACCOUNT', exp = NOW / 1000 + 3600) => `fake.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.fake`;
const claude = { five_hour: { utilization: 0, resets_at: '2027-01-15T14:00:00+01:00' }, seven_day: { utilization: 80, resets_at: null }, seven_day_sonnet: null, limits: [{ kind: 'weekly_scoped', percent: 10, resets_at: '2027-01-20T13:00:00Z', scope: { model: { display_name: 'Fable' } } }] };
const codex = { rate_limit: { primary_window: { used_percent: 25, reset_at: NOW / 1000 + 100, limit_window_seconds: 18000 }, secondary_window: { used_percent: 0, reset_after_seconds: 0, limit_window_seconds: 604800 } }, code_review_rate_limit: { primary_window: null } };
const balance = { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.000000000000000001', granted_balance: '0.00', topped_up_balance: '-0.000000000000000001' }, { currency: 'USD', total_balance: '12345678901234567890.123456789', granted_balance: null }] };
const usage = (cost = 0.1) => ({ input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15, cost: { total: cost } });
const message = (u = usage()) => ({ type: 'message', message: { role: 'assistant', usage: u } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise((r) => setImmediate(r));
const response = (data = claude, status = 200, headers) => new Response(JSON.stringify(data), { status, headers });
const requestAuth = (key = 'FAKE_KEY', provider = 'anthropic') => ({ provider, key, token: 'FAKE_SECRET', accountId: 'FAKE_ACCOUNT' });
function harness(id = 'anthropic') {
  const bases = { anthropic: 'https://api.anthropic.com', 'openai-codex': 'https://chatgpt.com/backend-api', deepseek: 'https://api.deepseek.com' };
  const statuses = new Map([['ponytail', 'keep me']]);
  const notifications = [];
  let credential = id === 'deepseek' ? { type: 'api_key', key: 'FAKE_DS_SECRET' } : { type: 'oauth', access: id === 'openai-codex' ? jwt() : 'FAKE_CLAUDE_SECRET', expires: NOW + 3600_000 };
  let source = 'stored', config = {}, entries = [], contextUsage = { tokens: 20, contextWindow: 100, percent: 20 };
  const provider = { baseUrl: bases[id], auth: { oauth: { toAuth: async (c) => ({ apiKey: c.access }) }, apiKey: { resolve: async ({ credential: c, ctx }) => ({ auth: { apiKey: c?.key || await ctx.env('DEEPSEEK_API_KEY') } }) } } };
  const ctx = {
    hasUI: true, model: { provider: id, baseUrl: bases[id], id: 'FAKE_MODEL', name: 'Fake Model', contextWindow: 100 }, thinkingLevel: 'high',
    ui: { setStatus: (k, v) => v === undefined ? statuses.delete(k) : statuses.set(k, v), notify: (v) => notifications.push(v) },
    modelRegistry: { getProvider: () => provider, getProviderAuthStatus: () => ({ source }), getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined },
    sessionManager: { getEntries: () => entries }, getContextUsage: () => contextUsage,
  };
  const deps = { readCredential: () => credential, providers: { [id]: provider }, readConfig: () => config, env: {} };
  return { ctx, deps, statuses, notifications, setCredential: (v) => { credential = v; }, setSource: (v) => { source = v; }, setConfig: (v) => { config = v; }, setEntries: (v) => { entries = v; }, setContext: (v) => { contextUsage = v; } };
}
const resolve = (h) => resolveCredential(h.ctx, h.deps, new AbortController().signal, NOW);

test('parseQuota: Claude zero, missing, null, scoped and multiple windows, ISO offset', () => {
  const q = parseQuota('anthropic', claude, NOW);
  assert.equal(q.state, 'ok');
  assert.deepEqual(q.windows.map((w) => w.usedPercent), [0, 80, null, 10]);
  assert.equal(q.windows[0].remainingPercent, 100);
  assert.equal(q.windows[0].resetAt, '2027-01-15T13:00:00.000Z');
  assert.equal(q.windows[2].state, 'unavailable');
  assert.equal(q.windows[3].durationSeconds, 604800);
  assert.equal(q.windows[3].scope, 'Fable');
  assert.equal(parseQuota('anthropic', {}).state, 'unknown');
  assert.equal(parseQuota('anthropic', { five_hour: { utilization: '0' } }).windows[0].usedPercent, null);
});
test('parseQuota: Codex seconds are not minutes/ms; zero reset and missing durations', () => {
  const q = parseQuota('openai-codex', codex, NOW);
  assert.equal(q.windows.length, 3); // code_review 只有 primary_window，缺席的 secondary 不造出来
  assert.equal(q.windows[0].resetAt, new Date(NOW + 100_000).toISOString());
  assert.equal(q.windows[1].resetAt, new Date(NOW).toISOString());
  assert.equal(q.windows[1].remainingPercent, 100);
  assert.equal(q.windows[2].durationSeconds, null);
  assert.equal(parseQuota('openai-codex', { rate_limit: { primary_window: { reset_at: NOW } } }).windows[0].resetAt, null);
});
test('parseQuota: decimal strings, currencies and insufficient balance stay distinct', () => {
  const q = parseQuota('deepseek', balance);
  assert.equal(q.state, 'unavailable');
  assert.equal(q.isAvailable, false);
  assert.equal(q.balances[0].total, balance.balance_infos[0].total_balance);
  assert.equal(q.balances[1].total, balance.balance_infos[1].total_balance);
  assert.equal(q.balances[1].granted, null);
  assert.equal(q.balances[1].currency, 'USD');
  assert.equal(parseQuota('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: 0 }] }).balances[0].total, null);
  assert.equal(parseQuota('deepseek', { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0' }] }).balances[0].total, '0');
});
test('parseQuota: malformed payloads, invalid percent, unknown provider', () => {
  for (const raw of [null, [], 'oops', 0]) assert.equal(parseQuota('anthropic', raw).state, 'error');
  for (const utilization of [NaN, Infinity, -1, 101, false]) assert.equal(parseQuota('anthropic', { five_hour: { utilization } }).windows[0].usedPercent, null);
  assert.equal(parseQuota('unlisted', {}).state, 'unsupported');
  assert.equal(parseQuota('anthropic', { five_hour: { utilization: 1, resets_at: 'bad' } }).windows[0].resetAt, null);
});
test('sessionUsage: empty zero vs missing and catalog-zero cost, nested tools and summaries', () => {
  assert.equal(sessionUsage([]).cost.amount, 0);
  assert.equal(sessionUsage([]).cost.state, 'known');
  assert.equal(sessionUsage([message(undefined)]).cost.state, 'estimated');
  assert.equal(sessionUsage([message(null)]).tokens.input, null);
  assert.equal(sessionUsage([message(usage(0))]).cost.amount, null);
  assert.equal(sessionUsage([message({ ...usage(), totalTokens: 0 })]).tokens.totalTokens, null);
  const q = sessionUsage([message(), { type: 'message', message: { role: 'toolResult', usage: usage() } }, { type: 'compaction', usage: usage() }, { type: 'branch_summary', usage: usage() }, { type: 'custom', usage: usage() }]);
  assert.equal(q.tokens.totalTokens, 60);
  assert.equal(q.cost.amount, 0.4);
  assert.equal(sessionUsage([message(), message(null)]).cost.estimatedSubtotal, 0.1);
  // 分项全为 0 的空响应（中断/切模型）不该把整轮会话的费用与 token 抹成未知。
  const blank = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
  const withBlank = sessionUsage([message(), message(blank), message()]);
  assert.equal(withBlank.cost.amount, 0.2);
  assert.equal(withBlank.cost.state, 'estimated');
  assert.equal(withBlank.tokens.totalTokens, 30);
  // 计费过的响应报 0 仍然可疑：pi 的零价不能当成实测免费。
  assert.equal(sessionUsage([message(), message({ ...usage(), cost: { total: 0 } })]).cost.amount, null);
});
test('snapshot/statusText: context unknown after compaction, provider identity and control stripping', () => {
  const h = harness();
  h.setContext({ tokens: null, percent: null, contextWindow: 100 });
  h.ctx.model.name = 'Fake\x1b\nModel';
  const s = snapshot(h.ctx, parseQuota('anthropic', claude));
  assert.equal(s.context.tokens, null);
  assert.equal(s.context.usedPercent, null);
  assert.equal(s.model.name, 'FakeModel');
  // 模型/思考/上下文/会话统计由 pi 自带 footer 显示，底栏不再重复；详情仍在 snapshot 里。
  assert.doesNotMatch(statusText(s), /ctx|think|session|FakeModel/);
});
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
test('底栏仅隐藏编号2至5，其余信息及详情保留', () => {
  const h = harness('openai-codex');
  const q = parseQuota('openai-codex', { rate_limit: { primary_window: { used_percent: 74, limit_window_seconds: 604800 } } });
  const s = snapshot(h.ctx, { ...q, credentialSource: 'pi_stored_oauth' });
  const text = statusText(s, NOW);
  assert.doesNotMatch(text, /dashboard|credentialSource|activeAccountVerified|未核验|存储账户|openai-codex/);
  // 显示剩余而非已用：used 74% 就是还剩 26%。
  assert.equal(plain(text), '7d 26%');
  assert.equal(plain(statusText({ ...s, quota: { ...s.quota, state: 'stale' } }, NOW)), '7d 26% ~');
  for (const [state, label] of [['expired', 'expired'], ['error', 'error'], ['rate_limited', '429'], ['unknown', '?']])
    assert.equal(plain(statusText({ ...s, quota: { ...s.quota, state, windows: [] } }, NOW)), `${label}`);
  assert.equal(statusText({ ...s, quota: { ...s.quota, state: 'loading', windows: [] } }, NOW), '\x1b[2m…\x1b[0m');
  // 当前 provider 查不到额度就整条撤掉，不在底栏占位。
  assert.equal(statusText({ ...s, quota: { ...s.quota, state: 'unsupported' } }, NOW), '');
  const ds = plain(statusText(snapshot(h.ctx, parseQuota('deepseek', balance)), NOW));
  // 服务报余额不足时把两笔都亮出来；充足时整条不占位。
  assert.equal(ds, '¥0.00+ · $12345678901234567890.12+');
  assert.equal(statusText(snapshot(h.ctx, parseQuota('deepseek', { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '31.03' }] })), NOW), '');
  assert.equal(plain(statusText(snapshot(h.ctx, parseQuota('deepseek', { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] })), NOW)), '¥0.00');
  assert.equal(s.quota.activeAccountVerified, false);
  assert.equal(s.quota.credentialSource, 'pi_stored_oauth');
  assert.equal(s.model.provider, 'openai-codex');
});
test('底栏：窗口简写、缺数据窗口不占位、仅最短窗口带重置倒计时', () => {
  const h = harness();
  // seven_day_sonnet 无数据，不该在底栏占一个 "?%" 的位置。
  assert.equal(plain(statusText(snapshot(h.ctx, parseQuota('anthropic', claude)), NOW)), '5h 100% (5h0m) · 7d 20% · Fable 90%');
  assert.equal(plain(statusText(snapshot(h.ctx, parseQuota('openai-codex', codex)), NOW)), '5h 75% (1m) · 7d 100%');
  const scoped = parseQuota('anthropic', { five_hour: null, seven_day: null, seven_day_opus: { utilization: 12.4 } });
  assert.equal(plain(statusText(snapshot(h.ctx, scoped), NOW)), '7d Opus 88%');
  const review = parseQuota('openai-codex', { rate_limit: {}, code_review_rate_limit: { secondary_window: { used_percent: 3, limit_window_seconds: 86400 } } });
  assert.equal(plain(statusText(snapshot(h.ctx, review), NOW)), 'CR 1d 97%');
  // 色阶按剩余量的 50/20 分档，且 SGR 序列不影响 pi-tui 计算的可见宽度。
  const colored = statusText(snapshot(h.ctx, parseQuota('anthropic', claude)), NOW);
  assert.match(colored, /\x1b\[32m100%/);
  assert.match(colored, /\x1b\[31m20%/);
  assert.match(statusText(snapshot(h.ctx, parseQuota('anthropic', { five_hour: { utilization: 50 } })), NOW), /\x1b\[33m50%/);
});
test('Codex Pro 只有一个 7d 窗口：账户没有的窗口不凭空造成 unavailable', () => {
  // 实测 Pro 账户返回的原始形状：只有 rate_limit.primary_window，且它是 7d 不是 5h。
  const pro = parseQuota('openai-codex', { rate_limit: { primary_window: { used_percent: 75, reset_at: NOW / 1000 + 385_000, limit_window_seconds: 604800 } } }, NOW);
  assert.equal(pro.windows.length, 1);
  assert.equal(pro.windows[0].durationSeconds, 604800);
  assert.equal(plain(statusText(snapshot(harness('openai-codex').ctx, pro), NOW)), '7d 25% (4d10h)');
  assert.equal(parseQuota('openai-codex', { rate_limit: {} }, NOW).windows.length, 0);
  assert.equal(parseQuota('openai-codex', { rate_limit: null }, NOW).state, 'unknown');
});
test('resolveCredential: official pi OAuth, expiry, missing, API-key subscription unsupported', async () => {
  const h = harness();
  assert.ok((await resolve(h)).key);
  h.setCredential({ type: 'oauth', access: 'FAKE', expires: NOW - 1 });
  assert.equal((await resolve(h)).result.state, 'expired');
  h.setCredential({ type: 'oauth', access: 'FAKE' });
  assert.equal((await resolve(h)).result.state, 'unknown');
  h.setCredential(undefined);
  assert.equal((await resolve(h)).result.state, 'unauthenticated');
  h.setCredential({ type: 'api_key', key: 'FAKE' });
  assert.equal((await resolve(h)).result.state, 'unsupported');
});
test('resolveCredential: Codex verified claim and account rotation fingerprint', async () => {
  const h = harness('openai-codex');
  const first = await resolve(h);
  assert.equal(first.accountId, 'FAKE_ACCOUNT');
  h.setCredential({ type: 'oauth', access: jwt('FAKE_SECOND'), expires: NOW + 1000 });
  assert.notEqual((await resolve(h)).key, first.key);
  h.setCredential({ type: 'oauth', access: jwt('FAKE_SECOND'), accountId: 'FAKE_MISMATCH', expires: NOW + 1000 });
  assert.equal((await resolve(h)).result.reason, 'account_id_mismatch');
  h.setCredential({ type: 'oauth', access: jwt('FAKE_SECOND', NOW / 1000 - 1), expires: NOW + 1000 });
  assert.equal((await resolve(h)).result.state, 'expired');
});
test('resolveCredential: runtime/config overrides, custom gateway, no model-name inference', async () => {
  const h = harness();
  for (const source of ['runtime', 'fallback', 'models_json_key', 'models_json_command']) {
    h.setSource(source);
    assert.equal((await resolve(h)).result.reason, 'auth_source_unconfirmed');
  }
  h.setSource('stored');
  for (const baseUrl of ['https://evil.test', 'http://api.anthropic.com', 'https://api.anthropic.com@evil.test', 'https://api.anthropic.com:444', 'https://api.anthropic.com/v1?token=FAKE']) {
    h.ctx.model.baseUrl = baseUrl;
    assert.equal((await resolve(h)).result.reason, 'custom_endpoint');
  }
  h.ctx.model.provider = 'unknown';
  h.ctx.model.id = 'claude-opus';
  assert.equal((await resolve(h)).result.state, 'unsupported');
  assert.equal(officialBase('deepseek', 'https://api.deepseek.com/v1/'), true);
});
test('authConfigOverride: only active provider/model, empty config, malformed fail closed', async () => {
  assert.equal(authConfigOverride({}, 'deepseek', 'current'), null);
  assert.equal(authConfigOverride({ providers: { deepseek: { headers: {}, models: [{ id: 'other', headers: { Authorization: 'FAKE' } }] } } }, 'deepseek', 'current'), null);
  for (const p of [{ headers: { Authorization: 'FAKE' } }, { apiKey: 'FAKE' }, { modelOverrides: { current: { headers: { 'x-auth': 'FAKE' } } } }])
    assert.equal(authConfigOverride({ providers: { deepseek: p } }, 'deepseek', 'current'), 'custom_auth_configuration_unconfirmed');
  for (const config of [null, [], { providers: [] }, { providers: { deepseek: { models: {} } } }])
    assert.equal(authConfigOverride(config, 'deepseek', 'current'), 'configuration_unverified');
  const h = harness('deepseek');
  h.deps.readConfig = () => { throw new Error('FAKE_SECRET'); };
  assert.equal((await resolve(h)).result.reason, 'configuration_unverified');
});
test('readOnlyKey/resolveCredential: no commands, env precedence, unresolved never ambient fallback', async () => {
  assert.equal(readOnlyKey('!touch /bad').reason, 'command_or_invalid_credential');
  assert.equal(readOnlyKey('$KEY', { KEY: 'scoped' }, { KEY: 'ambient' }).key, 'scoped');
  assert.equal(readOnlyKey('${KEY}', {}, { KEY: 'ambient' }).key, 'ambient');
  assert.equal(readOnlyKey('${KEY}_suffix').reason, 'credential_template_unsupported');
  const h = harness('deepseek');
  h.deps.env.DEEPSEEK_API_KEY = 'FAKE_AMBIENT';
  h.setCredential({ type: 'api_key', key: '!echo FAKE_SECRET' });
  assert.equal((await resolve(h)).result.state, 'unsupported');
  h.setCredential({ type: 'api_key', key: '$UNSET' });
  assert.equal((await resolve(h)).result.reason, 'credential_unresolved');
  h.setCredential(undefined);
  assert.equal((await resolve(h)).token, 'FAKE_AMBIENT');
});
test('requestQuota: exact official HTTPS GET, redirect blocked, secret/raw-body not returned', async () => {
  let calls = 0;
  const result = await requestQuota(requestAuth(), new AbortController().signal, async (url, init) => {
    calls++;
    assert.equal(url, ENDPOINTS.anthropic);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, 'Bearer FAKE_SECRET');
    return response({ error: 'FAKE_SECRET' }, 302, { Location: 'https://evil.test' });
  });
  assert.equal(calls, 1);
  assert.equal(result.reason, 'redirect_blocked');
  assert.ok(!JSON.stringify(result).includes('FAKE_SECRET'));
});
test('requestQuota: HTTP states, malformed JSON, oversized body and Retry-After units', async () => {
  for (const [status, state] of [[401, 'unauthenticated'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'error']]) {
    const result = await requestQuota(requestAuth(), new AbortController().signal, async () => response({ secret: 'FAKE' }, status));
    assert.equal(result.state, state);
  }
  assert.equal((await requestQuota(requestAuth(), new AbortController().signal, async () => new Response('FAKE_SECRET'))).reason, 'invalid_response');
  assert.equal((await requestQuota(requestAuth(), new AbortController().signal, async () => new Response('x'.repeat(262145)))).reason, 'response_too_large');
  assert.equal(retryAfterMs('60', NOW), 60_000);
  assert.equal(retryAfterMs(new Date(NOW + 120_000).toUTCString(), NOW), 120_000);
  assert.equal(retryAfterMs('no', NOW), 0);
});
test('QuotaCache: 60s TTL, request coalescing, forced refresh, stale backoff and account isolation', async () => {
  let now = NOW, calls = 0, fail = false;
  const hold = deferred();
  const cache = new QuotaCache({ now: () => now, fetcher: async () => { calls++; await hold.promise; return response(claude, fail ? 429 : 200, { 'Retry-After': '120' }); } });
  const a = cache.get(requestAuth()), b = cache.get(requestAuth());
  hold.resolve();
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
  now += 59_999;
  await cache.get(requestAuth()); assert.equal(calls, 1);
  now++;
  assert.equal(cache.view('FAKE_KEY').state, 'stale');
  fail = true;
  const stale = await cache.get(requestAuth());
  assert.equal(stale.state, 'stale');
  assert.equal(stale.lastError, 'rate_limited');
  assert.equal(stale.fetchedAt, NOW);
  await cache.get(requestAuth(), true); assert.equal(calls, 2);
  const other = await cache.get(requestAuth('OTHER'));
  assert.equal(other.state, 'rate_limited'); assert.equal(other.windows.length, 0);
  now += 120_000; fail = false;
  assert.equal((await cache.get(requestAuth())).state, 'ok');
  await cache.get(requestAuth(), true); assert.equal(calls, 5);
  cache.clear();
});
test('QuotaCache: 401/403 backoff cannot be force-bypassed; no errors leak', async () => {
  for (const code of [401, 403]) {
    let calls = 0;
    const c = new QuotaCache({ fetcher: async () => { calls++; return response({ error: 'FAKE_SECRET' }, code); } });
    await c.get(requestAuth()); await c.get(requestAuth(), true);
    assert.equal(calls, 1); c.clear();
  }
  const c = new QuotaCache({ fetcher: async () => { throw new Error('FAKE_SECRET'); } });
  assert.ok(!JSON.stringify(await c.get(requestAuth())).includes('FAKE_SECRET')); c.clear();
});
test('QuotaCache: header/body timeout including uncooperative fetch and clear in-flight', async () => {
  const c = new QuotaCache({ timeoutMs: 10, fetcher: async () => new Promise(() => {}) });
  assert.equal((await c.get(requestAuth())).reason, 'timeout_or_cancelled'); c.clear();
  const body = new QuotaCache({ timeoutMs: 10, fetcher: async () => new Response(new ReadableStream({ start() {} })) });
  assert.equal((await body.get(requestAuth())).reason, 'timeout_or_cancelled'); body.clear();
  const late = deferred();
  const cancelled = new QuotaCache({ fetcher: async () => late.promise });
  const pending = cancelled.get(requestAuth()); cancelled.clear();
  await pending; late.resolve(response()); await settle();
  assert.equal(cancelled.entries.size, 0);
});
test('Dashboard: model switch discards old response, session reset, shutdown/reload cleanup, no factory timers', async () => {
  const h = harness(), ds = harness('deepseek');
  let intervals = 0, cleared = 0, calls = 0;
  const old = deferred();
  const cache = new QuotaCache({ now: () => NOW, fetcher: async (url) => { calls++; return url === ENDPOINTS.anthropic ? old.promise : response(balance); } });
  const deps = { ...h.deps, providers: { ...h.deps.providers, ...ds.deps.providers }, readCredential: (id) => (id === 'deepseek' ? ds.deps : h.deps).readCredential() };
  const d = new Dashboard(deps, { cache, now: () => NOW, setIntervalFn: () => { intervals++; return 1; }, clearIntervalFn: () => { cleared++; } });
  assert.equal(intervals, 0);
  h.setEntries([message()]); d.start(h.ctx); await settle();
  assert.equal(d.local().session.cost.amount, 0.1);
  d.select(ds.ctx); await settle();
  old.resolve(response(claude)); await settle();
  assert.equal(d.local().quota.provider, 'deepseek');
  assert.equal(d.local().session.cost.amount, 0);
  assert.equal(d.local().quota.kind, 'api_balance');
  const before = calls;
  for (let i = 0; i < 5; i++) d.local();
  assert.equal(calls, before);
  d.stop(); d.stop();
  assert.equal(cache.pending.size, 0); assert.equal(cache.entries.size, 0);
  assert.equal(cleared, 1); assert.equal(ds.statuses.get('ponytail'), 'keep me');
  assert.equal(ds.statuses.has(STATUS_KEY), false);
});
test('Dashboard: credential changes while HTTP pending are rechecked, cannot publish old account', async () => {
  const h = harness(); const hold = deferred();
  const d = new Dashboard(h.deps, { now: () => NOW, cache: new QuotaCache({ now: () => NOW, fetcher: async () => { await hold.promise; return response(); } }), setIntervalFn: () => 1, clearIntervalFn: () => {} });
  d.start(h.ctx); await settle();
  h.setCredential({ type: 'oauth', access: 'FAKE_OTHER_SECRET', expires: NOW + 1000 });
  hold.resolve(response()); await settle(); await settle();
  assert.equal(d.local().quota.state, 'unavailable');
  assert.equal(d.local().quota.windows.length, 0);
  assert.equal(d.local().quota.reason, 'account_changed_refresh_required');
  await d.refresh(); assert.equal(d.local().quota.state, 'ok');
  h.setCredential(undefined); await d.refresh();
  assert.equal(d.local().quota.state, 'unauthenticated'); d.stop();
});
test('registerDashboard: real named events/command, thinking updates, no UI no polling, snapshot not persisted', async () => {
  const handlers = new Map(), commands = new Map();
  const h = harness(); let timers = 0;
  const d = new Dashboard(h.deps, { now: () => NOW, cache: new QuotaCache({ fetcher: async () => response(), now: () => NOW }), setIntervalFn: () => { timers++; return 1; }, clearIntervalFn: () => {} });
  registerDashboard({ on: (k, f) => handlers.set(k, f), registerCommand: (k, f) => commands.set(k, f) }, d);
  assert.equal(timers, 0);
  handlers.get('session_start')({}, h.ctx); await settle();
  h.ctx.thinkingLevel = 'low'; handlers.get('thinking_level_select')({}, h.ctx);
  assert.equal(d.local().model.thinking, 'low');
  await commands.get('dashboard').handler('', h.ctx);
  assert.equal(JSON.parse(h.notifications[0]).model.provider, 'anthropic');
  assert.ok(!h.notifications[0].includes('FAKE_CLAUDE_SECRET'));
  handlers.get('session_shutdown')();
  h.ctx.hasUI = false; handlers.get('session_start')({}, h.ctx);
  assert.equal(timers, 1); handlers.get('session_shutdown')();
  assert.equal(authFingerprint('deepseek', 'FAKE').includes('FAKE'), false);
});

test('Dashboard: model cycling (including unsupported) preserves account backoff', async () => {
  const h = harness(); let calls = 0;
  const d = new Dashboard(h.deps, { now: () => NOW, cache: new QuotaCache({ now: () => NOW, fetcher: async () => { calls++; return response({}, 429); } }), setIntervalFn: () => 1, clearIntervalFn: () => {} });
  d.start(h.ctx); await settle();
  assert.equal(calls, 1);
  d.select({ ...h.ctx, model: { ...h.ctx.model, provider: 'unknown' } }); await settle();
  d.select(h.ctx); await settle();
  await d.refresh(true);
  assert.equal(calls, 1);
  assert.equal(d.local().quota.state, 'rate_limited'); d.stop();
});
test('Dashboard: late auth resolution cannot undo a newer model/account selection', async () => {
  const h = harness(), ds = harness('deepseek'), oldAuth = deferred();
  h.deps.providers.anthropic.auth.oauth.toAuth = async () => oldAuth.promise;
  const d = new Dashboard({ ...h.deps, providers: { ...h.deps.providers, ...ds.deps.providers }, readCredential: (id) => (id === 'deepseek' ? ds.deps : h.deps).readCredential() }, { now: () => NOW, cache: new QuotaCache({ now: () => NOW, fetcher: async () => response(balance) }), setIntervalFn: () => 1, clearIntervalFn: () => {} });
  d.start(h.ctx); await settle(); d.select(ds.ctx); await settle();
  oldAuth.resolve({ apiKey: 'FAKE_OLD' }); await settle();
  assert.equal(d.local().quota.provider, 'deepseek');
  assert.equal(d.local().quota.reason, 'balance_insufficient'); d.stop();
});
test('Dashboard: does not render cached but not yet account-confirmed HTTP response', async () => {
  const h = harness(), confirm = deferred(); let authCalls = 0;
  h.deps.providers.anthropic.auth.oauth.toAuth = async (c) => ++authCalls === 2 ? confirm.promise : { apiKey: c.access };
  const d = new Dashboard(h.deps, { now: () => NOW, cache: new QuotaCache({ now: () => NOW, fetcher: async () => response(claude) }), setIntervalFn: () => 1, clearIntervalFn: () => {} });
  d.start(h.ctx); await settle();
  assert.equal(d.local().quota.state, 'loading');
  assert.equal(d.local().quota.windows.length, 0);
  confirm.resolve({ apiKey: 'FAKE_OTHER' }); await settle();
  assert.equal(d.local().quota.windows.length, 0); d.stop();
});
test('snapshot: returned model kept separate from selection and missing is not invented', () => {
  const h = harness();
  h.setEntries([{ type: 'message', message: { role: 'assistant', model: 'requested', responseModel: 'returned', provider: 'other-provider', usage: usage() } }]);
  const s = snapshot(h.ctx, parseQuota('anthropic', claude));
  assert.equal(s.lastResponse.returnedModel, 'returned');
  assert.equal(s.lastResponse.provider, 'other-provider');
  assert.equal(s.model.provider, 'anthropic');
});

test('resolveCredential: failures cannot leak credential error text; expired never calls toAuth', async () => {
  const h = harness(); let called = false;
  h.deps.providers.anthropic.auth.oauth.toAuth = async () => { called = true; throw new Error('FAKE_SECRET'); };
  h.setCredential({ type: 'oauth', access: 'FAKE_SECRET', expires: NOW - 1 });
  assert.equal((await resolve(h)).result.state, 'expired'); assert.equal(called, false);
  h.setCredential({ type: 'oauth', access: 'FAKE_SECRET', expires: NOW + 1 });
  const failed = (await resolve(h)).result;
  assert.equal(failed.state, 'error'); assert.ok(!JSON.stringify(failed).includes('FAKE_SECRET'));
});
test('Dashboard: new/resumed session start recomputes only that session entries', async () => {
  const old = harness(), fresh = harness(); old.setEntries([message()]);
  const d = new Dashboard(old.deps, { now: () => NOW, cache: new QuotaCache({ now: () => NOW, fetcher: async () => response() }), setIntervalFn: () => 1, clearIntervalFn: () => {} });
  d.start(old.ctx); assert.equal(d.local().session.cost.amount, 0.1);
  d.start(fresh.ctx); assert.equal(d.local().session.cost.amount, 0);
  assert.equal(old.statuses.has(STATUS_KEY), false);
  fresh.setEntries([message(usage(0.2))]); d.start(fresh.ctx);
  assert.equal(d.local().session.cost.amount, 0.2); d.stop();
  await settle(); assert.equal(fresh.statuses.has(STATUS_KEY), false);
});

for (const scenario of ['磁盘配置已删除但已加载 headers 仍用 B', '不可见 before_provider_headers 将活动请求改用 B']) {
  test(`账户归属降级：${scenario}`, async () => {
    const h = harness('deepseek');
    // 模拟活动请求的隐藏状态；dashboard 的公开 registry 和磁盘检查均看不到它。
    const fakeRuntime = { activeRequestHeaders: { Authorization: 'Bearer FAKE_ACCOUNT_B' } };
    h.setConfig({});
    h.setCredential({ type: 'api_key', key: 'FAKE_ACCOUNT_A' });
    const hooks = new Map([['before_provider_headers', () => { throw new Error('不能执行请求 hook'); }]]);
    const d = new Dashboard(h.deps, {
      now: () => NOW,
      cache: new QuotaCache({ now: () => NOW, fetcher: async (_url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer FAKE_ACCOUNT_A');
        assert.notEqual(init.headers.Authorization, fakeRuntime.activeRequestHeaders.Authorization);
        return response(balance);
      } }), setIntervalFn: () => 1, clearIntervalFn: () => {},
    });
    registerDashboard({ on: (name, fn) => hooks.set(name, fn), registerCommand: () => {} }, d);
    try {
      d.start(h.ctx); await settle();
      const s = d.local();
      assert.equal(s.quota.credentialSource, 'pi_stored_api_key');
      assert.equal(s.quota.activeAccountVerified, false);
      assert.doesNotMatch(h.statuses.get(STATUS_KEY), /credentialSource|activeAccountVerified|未核验/);
      assert.ok(!JSON.stringify(s).includes('FAKE_ACCOUNT_A'));
      assert.ok(!JSON.stringify(s).includes('FAKE_ACCOUNT_B'));
      await d.refresh();
      assert.equal(d.local().quota.activeAccountVerified, false);
    } finally { d.stop(); }
  });
}

test('凭据来源：存储 OAuth、存储 key、环境引用与 DeepSeek 环境回退均明确标注', async () => {
  assert.equal((await resolve(harness())).credentialSource, 'pi_stored_oauth');
  for (const [credential, scoped, expected] of [
    [{ type: 'api_key', key: 'FAKE_LITERAL' }, false, 'pi_stored_api_key'],
    [undefined, false, 'environment'],
    [{ type: 'api_key', key: '$DEEPSEEK_API_KEY' }, false, 'environment'],
    [{ type: 'api_key', key: '$DEEPSEEK_API_KEY' }, true, 'pi_scoped_environment'],
    [{ type: 'api_key' }, true, 'pi_scoped_environment'],
  ]) {
    const h = harness('deepseek');
    if (scoped) credential.env = { DEEPSEEK_API_KEY: 'FAKE_SCOPED' };
    h.setCredential(credential);
    h.deps.env.DEEPSEEK_API_KEY = 'FAKE_ENV';
    const auth = await resolve(h);
    assert.equal(auth.credentialSource, expected);
    assert.equal(auth.activeAccountVerified, false);
    const cache = new QuotaCache({ now: () => NOW, fetcher: async () => response({}, 403) });
    try {
      for (const force of [false, true]) {
        const q = await cache.get(auth, force);
        assert.equal(q.credentialSource, expected);
        assert.equal(q.activeAccountVerified, false);
      }
    } finally { cache.clear(); }
  }
});

function getterHarness() {
  const h = harness(), ds = harness('deepseek');
  let activeModel = h.ctx.model;
  Object.defineProperty(h.ctx, 'model', { get: () => activeModel });
  h.deps.providers = { ...h.deps.providers, ...ds.deps.providers };
  const readClaude = h.deps.readCredential;
  h.deps.readCredential = (id) => id === 'deepseek' ? ds.deps.readCredential() : readClaude();
  h.ctx.modelRegistry.getProvider = (id) => h.deps.providers[id];
  return { ...h, nextModel: ds.ctx.model, setModel: (model) => { activeModel = model; } };
}

test('实时 getter：thinking 先于 model_select 时立即清旧额度，模型 id/baseUrl 改变同样失效', async () => {
  for (const change of ['provider', 'id', 'baseUrl']) {
    const h = getterHarness(), handlers = new Map(), pending = deferred();
    let delay = false, requestSignal;
    const d = new Dashboard(h.deps, { now: () => NOW, cache: new QuotaCache({ now: () => NOW, fetcher: async (_url, init) => {
      requestSignal = init.signal;
      if (delay) await pending.promise;
      return response(claude);
    } }), setIntervalFn: () => 1, clearIntervalFn: () => {} });
    registerDashboard({ on: (name, fn) => handlers.set(name, fn), registerCommand: () => {} }, d);
    try {
      d.start(h.ctx); await settle();
      assert.equal(d.local().quota.windows[0].usedPercent, 0);
      delay = true;
      const refresh = d.refresh(true); await settle();
      assert.equal(d.cache.pending.size, 1);
      const next = change === 'provider' ? h.nextModel : { ...h.ctx.model, [change]: change === 'id' ? 'FAKE_NEW_MODEL' : 'https://api.anthropic.com/v1' };
      h.setModel(next);
      h.ctx.thinkingLevel = 'off';
      // 模拟 Pi 的真实顺序，此时 dashboard 尚未收到 model_select。
      handlers.get('thinking_level_select')({ level: 'off' }, h.ctx);
      assert.equal(d.quota.provider, next.provider);
      assert.deepEqual(d.quota.windows, []);
      assert.equal(d.quota.state, 'loading');
      assert.equal(d.local().model.id, next.id);
      assert.ok(!h.statuses.get(STATUS_KEY).includes('used '));
      assert.equal(d.cache.pending.size, 0);
      assert.equal(requestSignal.aborted, true);
      pending.resolve(); await refresh;
      assert.deepEqual(d.quota.windows, []);
    } finally { pending.resolve(); d.stop(); }
  }
});

test('实时 getter：没有先到事件时，异步 current 也独立检查 provider/id/baseUrl 并丢弃旧结果', async () => {
  for (const change of ['provider', 'id', 'baseUrl']) {
    const h = getterHarness(), pending = deferred();
    let delay = false;
    const d = new Dashboard(h.deps, { now: () => NOW, cache: new QuotaCache({ now: () => NOW, fetcher: async () => { if (delay) await pending.promise; return response(claude); } }), setIntervalFn: () => 1, clearIntervalFn: () => {} });
    try {
      d.start(h.ctx); await settle();
      assert.equal(d.quota.state, 'ok');
      delay = true;
      const refresh = d.refresh(true); await settle();
      const next = change === 'provider' ? h.nextModel : { ...h.ctx.model, [change]: change === 'id' ? 'FAKE_NEW_MODEL' : 'https://api.anthropic.com/v1' };
      h.setModel(next);
      pending.resolve(); await refresh;
      // 不调用 local/select 触发补救：这里必须已由异步 current 清理并发布。
      assert.equal(d.quota.state, 'loading');
      assert.equal(d.quota.provider, next.provider);
      assert.deepEqual(d.quota.windows, []);
      assert.equal(d.cache.pending.size, 0);
      assert.ok(!h.statuses.get(STATUS_KEY).includes('used '));
    } finally { pending.resolve(); d.stop(); }
  }
});

test('isSubscription: 只认 Pi 存储的 OAuth，kimi-coding 特判，读凭据抛错不外泄', () => {
  const ctx = (id, declares) => ({ model: { provider: id }, modelRegistry: { getProvider: () => ({ auth: { oauth: { isSubscription: declares } } }) } });
  assert.equal(isSubscription(ctx('anthropic', true), () => ({ type: 'oauth' })), true);
  assert.equal(isSubscription(ctx('anthropic', true), () => ({ type: 'api_key' })), false);
  assert.equal(isSubscription(ctx('deepseek', false), () => ({ type: 'oauth' })), false);
  // 环境/runtime 凭据这一层看不到，宁可漏标 (sub) 也不猜。
  assert.equal(isSubscription(ctx('anthropic', true), () => undefined), false);
  assert.equal(isSubscription(ctx('kimi-coding', false), () => undefined), true);
  assert.equal(isSubscription({ model: undefined }, () => { throw new Error('FAKE'); }), false);
  assert.equal(isSubscription(ctx('anthropic', true), () => { throw new Error('FAKE'); }), false);
});
