export const TTL_MS = 60_000;
export const ENDPOINTS = Object.freeze({
  anthropic: 'https://api.anthropic.com/api/oauth/usage',
  'openai-codex': 'https://chatgpt.com/backend-api/wham/usage',
  deepseek: 'https://api.deepseek.com/user/balance',
});
const BASES = {
  anthropic: ['https://api.anthropic.com', 'https://api.anthropic.com/v1'],
  'openai-codex': ['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/codex'],
  deepseek: ['https://api.deepseek.com', 'https://api.deepseek.com/v1'],
};
export const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const percent = (v) => number(v) !== null && v <= 100 ? v : null;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const safeLabel = (v) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '').slice(0, 120) : null;
const decimal = (v) => typeof v === 'string' && v.length <= 128 && /^-?\d+(?:\.\d+)?$/.test(v) ? v : null;
const iso = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const secondsISO = (v) => number(v) !== null && v <= 253402300799 ? new Date(v * 1000).toISOString() : null;
export function officialBase(provider, baseUrl) {
  return typeof baseUrl === 'string' && BASES[provider]?.includes(baseUrl.replace(/\/$/, '')) === true;
}
export function unavailable(provider, state, reason) {
  return { provider: provider ?? null, kind: provider === 'deepseek' ? 'api_balance' : 'subscription_quota', credentialSource: 'unresolved', activeAccountVerified: false, state, reason, windows: [], balances: [] };
}
function window(id, raw, durationSeconds, isCodex = false, now = Date.now()) {
  const usedPercent = percent(isCodex ? raw?.used_percent : raw?.utilization);
  const resetAt = isCodex
    ? secondsISO(raw?.reset_at) ?? (number(raw?.reset_after_seconds) !== null ? secondsISO(now / 1000 + raw.reset_after_seconds) : null)
    : iso(raw?.resets_at);
  return {
    id, state: !object(raw) ? 'unavailable' : usedPercent === null ? 'unknown' : 'ok',
    durationSeconds, usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent, resetAt,
  };
}
export function parseQuota(provider, raw, now = Date.now()) {
  if (!object(raw)) return unavailable(provider, 'error', 'invalid_response');
  const result = unavailable(provider, 'unknown', 'fields_missing');
  if (provider === 'anthropic') {
    for (const id of ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus']) {
      if (id === 'five_hour' || id === 'seven_day' || Object.hasOwn(raw, id))
        result.windows.push(window(id, raw[id], id === 'five_hour' ? 18000 : 604800));
    }
    if (Array.isArray(raw.limits)) for (const item of raw.limits.slice(0, 30)) {
      if (item?.kind === 'weekly_scoped') {
        const scope = safeLabel(item.scope?.model?.display_name);
        result.windows.push({ ...window('weekly_scoped', { utilization: item.percent, resets_at: item.resets_at }, 604800), scope });
      }
    }
  } else if (provider === 'openai-codex') {
    // 账户实际返回哪些窗口就是哪些：Pro 只有一个 7d 的 primary_window，
    // 没有 5h secondary，也没有 code review 桶。缺席的窗口不凭空造成 unavailable。
    for (const group of ['rate_limit', 'code_review_rate_limit']) {
      if (!object(raw[group])) continue;
      for (const id of ['primary_window', 'secondary_window']) {
        if (!Object.hasOwn(raw[group], id)) continue;
        const w = raw[group][id];
        result.windows.push(window(`${group}.${id}`, w, number(w?.limit_window_seconds), true, now));
      }
    }
  } else if (provider === 'deepseek') {
    result.isAvailable = typeof raw.is_available === 'boolean' ? raw.is_available : null;
    if (Array.isArray(raw.balance_infos)) result.balances = raw.balance_infos.slice(0, 30).map((b) => ({
      currency: typeof b?.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) ? b.currency : null,
      total: decimal(b?.total_balance), granted: decimal(b?.granted_balance), toppedUp: decimal(b?.topped_up_balance),
    }));
    if (result.balances.some((b) => b.currency !== null && b.total !== null)) {
      result.state = result.isAvailable === false ? 'unavailable' : 'ok';
      result.reason = result.isAvailable === false ? 'balance_insufficient' : null;
    }
    return result;
  } else return unavailable(provider, 'unsupported', 'provider_not_supported');
  if (result.windows.some((w) => w.state === 'ok')) {
    result.state = 'ok';
    result.reason = null;
  }
  return result;
}

// Pi initializes missing provider usage/prices to zero. Keep the reported values,
// but never call an all-zero response or an unpriced request a measured free call.
export function sessionUsage(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let count = 0, cost = 0, tokensKnown = true, costKnown = true;
  const missing = new Set();
  for (const e of entries) {
    const assistant = e.type === 'message' && e.message?.role === 'assistant';
    const usage = e.type === 'message' && ['assistant', 'toolResult'].includes(e.message?.role) ? e.message?.usage : ['compaction', 'branch_summary'].includes(e.type) ? e.usage : undefined;
    if (!assistant && usage === undefined) continue;
    count++;
    let reported = 0;
    for (const key of Object.keys(totals)) {
      const value = number(usage?.[key]);
      if (value === null) { tokensKnown = false; missing.add(key); }
      else {
        totals[key] += value;
        if (key !== 'totalTokens') reported += value;
      }
    }
    // 分项全为 0 是一次空响应（中断、切换模型），零 token 零成本自洽，不是缺数据。
    // 只有计费过的响应报出 0 才可疑：那可能是 pi 的零价，不能当成实测的免费调用。
    const empty = reported === 0;
    if (assistant && !empty && !(number(usage?.totalTokens) > 0)) tokensKnown = false;
    const value = number(usage?.cost?.total);
    if (value === null || (value === 0 && !empty)) costKnown = false;
    else cost += value;
  }
  return {
    scope: 'all_entries_in_current_session', responsesWithUsage: count,
    tokens: { state: tokensKnown ? (count ? 'reported' : 'known') : 'unknown', ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, missing.has(key) ? null : value])), totalTokens: tokensKnown ? totals.totalTokens : null, reportedSubtotal: totals.totalTokens },
    cost: { state: costKnown ? (count ? 'estimated' : 'known') : 'unknown', amount: costKnown ? cost : null, estimatedSubtotal: cost, currency: 'USD', source: 'pi_usage_cost_not_invoice' },
  };
}
export function snapshot(ctx, quota) {
  const usage = ctx.getContextUsage();
  const tokens = number(usage?.tokens);
  const entries = ctx.sessionManager.getEntries();
  const last = entries.findLast((e) => e.type === 'message' && e.message?.role === 'assistant')?.message;
  return {
    lastResponse: last ? { provider: safeLabel(last.provider), requestedModel: safeLabel(last.model), returnedModel: safeLabel(last.responseModel) } : null,
    model: { provider: safeLabel(ctx.model?.provider), id: safeLabel(ctx.model?.id), name: safeLabel(ctx.model?.name), thinking: safeLabel(ctx.thinkingLevel) },
    context: { state: tokens === null ? 'unknown' : 'estimated', tokens, windowTokens: number(usage?.contextWindow ?? ctx.model?.contextWindow), usedPercent: tokens === null ? null : number(usage?.percent), source: 'pi_getContextUsage' },
    session: sessionUsage(entries),
    quota: { ...quota, credentialSource: quota.credentialSource ?? 'unresolved', activeAccountVerified: false },
  };
}
// pi-tui 的 visibleWidth/truncateToWidth 按可见宽度计算，SGR 序列不占列也不会被截断切坏。
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const HEAT = ['\x1b[32m', '\x1b[33m', '\x1b[31m'];
const LIGHT = ['🟢', '🟡', '🔴'];
const paint = (code, text) => `${code}${text}${RESET}`;
const dim = (text) => paint(DIM, text);
// 分档看的是剩余量：还剩一半以上宽裕，两成以下告急。
const level = (remainingPercent) => remainingPercent > 50 ? 0 : remainingPercent > 20 ? 1 : 2;
const CURRENCY = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥' };
const STATE_LABEL = {
  unknown: '?', unavailable: 'n/a', unauthenticated: 'auth',
  expired: 'expired', forbidden: '403', rate_limited: '429', error: 'error',
};
const shortDuration = (seconds) => seconds === null ? null
  : seconds % 86400 === 0 ? `${seconds / 86400}d`
  : seconds % 3600 === 0 ? `${seconds / 3600}h`
  : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
// 只保留两个最大单位：底栏宽度有限，宁可少写一位也不撑长这一行。
function countdown(resetAt, now) {
  const ms = Date.parse(resetAt ?? '') - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return days ? `${days}d${hours % 24}h` : hours ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}
// 窗口时长本身就是最短的标签；模型专属周窗和 code review 桶各自补一个限定词区分。
function windowLabel(w) {
  if (w.scope) return w.scope;
  const model = /^seven_day_(.+)$/.exec(w.id)?.[1];
  const fallback = w.id.includes('secondary') ? '2nd' : w.id.includes('primary') ? '1st' : w.id;
  return [
    w.id.startsWith('code_review_') ? 'CR' : null,
    shortDuration(w.durationSeconds) ?? fallback,
    model ? model[0].toUpperCase() + model.slice(1) : null,
  ].filter(Boolean).join(' ');
}
// 服务返回的十进制字符串按位截断，不做浮点换算，也不四舍五入抬高余额。
// 截断掉的非零位补 `+`，免得极小的正余额在底栏显示成 0.00。
const shortAmount = (value) => {
  const [int, frac] = value.split('.');
  if (frac === undefined) return int;
  return `${int}.${frac.slice(0, 2)}${/[1-9]/.test(frac.slice(2)) ? '+' : ''}`;
};
export function statusText(s, now = Date.now()) {
  const q = s.quota;
  // 模型、思考级别、上下文、会话 tokens 和费用由 pi 自带 footer 显示，这里只补它没有的额度。
  // 底栏不写插件名、凭据来源、账户核验提示和厂商；这些字段完整保留在 /dashboard 的快照里。
  if (q.state === 'unsupported') return '';
  if (q.state === 'loading') return '⏳';
  // ⚪ 表示数据过期未刷新；红绿灯只在数据当次刷新过时才代表真实水位。
  const stale = q.state === 'stale';
  const light = (rank) => stale ? '⚪' : LIGHT[rank];
  const parts = [];
  // 服务直接说余额不足时以它为准，不靠数字自行判断。
  const insufficient = q.isAvailable === false;
  if (q.kind === 'api_balance') for (const b of q.balances) {
    // 余额不像配额那样会在会话中途用光，平时不占位；见底了才提示，完整数字在 /dashboard。
    // 色阶与判空都按底栏实际显示的位数，所见即所得。
    if (b.total === null) continue;
    const short = shortAmount(b.total);
    if (!insufficient && !/^-|^0+(?:\.0*)?$/.test(short)) continue;
    const symbol = b.currency === null ? '' : CURRENCY[b.currency] ?? '';
    const suffix = symbol === '' && b.currency !== null ? ` ${b.currency}` : '';
    parts.push(`${stale ? '⚪' : '🔴'} ${paint(HEAT[2], `${symbol}${short}${suffix}`)}`);
  } else {
    // 显示的是剩余额度，不是已用：关心的是还能用多少。
    const shown = q.windows.filter((w) => w.remainingPercent !== null);
    // 只给最短的窗口带重置倒计时：它最先重置，也最常撞上。
    const shortest = Math.min(...shown.map((w) => w.durationSeconds ?? Infinity));
    for (const w of shown) {
      const rank = level(w.remainingPercent);
      const left = w.durationSeconds === shortest ? countdown(w.resetAt, now) : null;
      parts.push(`${light(rank)} ${dim(windowLabel(w))} ${paint(stale ? DIM : HEAT[rank], `${Math.round(w.remainingPercent)}%`)}${left ? dim(` ↻${left}`) : ''}`);
    }
  }
  // 每个窗口自带一盏灯，灯本身就是分隔符，不再另加符号。
  if (parts.length) return parts.join(' ');
  // 查到了数据但没有需要提示的（余额充足、窗口全无数据）：不占位，也不报警。
  if (q.state === 'ok' || q.state === 'stale') return '';
  return `⚠️ ${dim(STATE_LABEL[q.state] ?? q.state)}`;
}
