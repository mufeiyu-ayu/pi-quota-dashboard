import { ENDPOINTS, TTL_MS, parseQuota, unavailable } from './core.mjs';

export function retryAfterMs(value, now) {
  if (typeof value !== 'string') return 0;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
  const ms = seconds === null ? Date.parse(value) - now : seconds * 1000;
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 86400_000)) : 0;
}
// A fixed endpoint per adapter; no caller URL and no redirect-following path.
export async function requestQuota(auth, signal, fetcher = fetch, now = Date.now) {
  const url = ENDPOINTS[auth.provider];
  if (!Object.hasOwn(ENDPOINTS, auth.provider)) return unavailable(auth.provider, 'unsupported', 'provider_not_supported');
  const headers = { Accept: 'application/json', Authorization: `Bearer ${auth.token}` };
  if (auth.provider === 'anthropic') headers['anthropic-beta'] = 'oauth-2025-04-20';
  if (auth.provider === 'openai-codex') headers['ChatGPT-Account-Id'] = auth.accountId;
  const response = await fetcher(url, { method: 'GET', headers, redirect: 'manual', signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const state = response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate_limited' : 'error';
    return { ...unavailable(auth.provider, state, response.status >= 300 && response.status < 400 ? 'redirect_blocked' : 'http_error'), httpStatus: response.status, retryAfterMs: retryAfterMs(response.headers.get('retry-after'), now()) };
  }
  // Bound untrusted responses; timeout stays active through body consumption.
  if (!response.body) return unavailable(auth.provider, 'error', 'invalid_response');
  const reader = response.body.getReader();
  const cancelBody = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelBody, { once: true });
  if (signal.aborted) cancelBody();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        return unavailable(auth.provider, 'error', 'response_too_large');
      }
      chunks.push(value);
    }
    return { ...parseQuota(auth.provider, JSON.parse(Buffer.concat(chunks).toString('utf8')), now()), httpStatus: response.status };
  } catch {
    return unavailable(auth.provider, 'error', signal.aborted ? 'timeout_or_cancelled' : 'invalid_response');
  } finally {
    signal.removeEventListener('abort', cancelBody);
    reader.releaseLock();
  }
}

export class QuotaCache {
  constructor({ fetcher = fetch, now = Date.now, timeoutMs = 8000, ttlMs = TTL_MS } = {}) {
    Object.assign(this, { fetcher, now, timeoutMs, ttlMs });
    this.entries = new Map();
    this.pending = new Map();
    this.epoch = 0;
  }
  view(key) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    const stale = e.result.fetchedAt !== undefined && this.now() - e.result.fetchedAt >= this.ttlMs;
    return stale ? { ...e.result, state: 'stale' } : e.result;
  }
  async get(auth, force = false) {
    const existing = this.pending.get(auth.key);
    if (existing) return { ...await existing.promise, credentialSource: auth.credentialSource ?? 'unresolved', activeAccountVerified: false };
    const e = this.entries.get(auth.key);
    if (e && (this.now() < e.retryAt || (!force && this.now() < e.expiresAt)))
      return { ...this.view(auth.key), credentialSource: auth.credentialSource ?? 'unresolved', activeAccountVerified: false };
    const controller = new AbortController();
    const epoch = this.epoch;
    let timer;
    const aborted = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(unavailable(auth.provider, 'error', 'timeout_or_cancelled')), { once: true });
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    });
    const promise = (async () => {
      let result = await Promise.race([
        requestQuota(auth, controller.signal, this.fetcher, this.now).catch(() => unavailable(auth.provider, 'error', 'network_error')),
        aborted,
      ]);
      const now = this.now();
      const failed = !['ok', 'unknown', 'unavailable'].includes(result.state);
      const failures = failed ? (e?.failures ?? 0) + 1 : 0;
      const backoff = failed ? Math.max(result.retryAfterMs ?? 0, Math.min(300_000, this.ttlMs * 2 ** Math.min(failures - 1, 4))) : 0;
      // 仅复用同一存储/环境凭据指纹的数据，不把失败刷新标成新数据。
      if (!failed && result.httpStatus === 200) result = { ...result, fetchedAt: now };
      else if (e?.result.fetchedAt !== undefined) result = {
        ...e.result, state: 'stale', reason: result.reason, lastError: result.state, httpStatus: result.httpStatus ?? null,
      };
      result = { ...result, credentialSource: auth.credentialSource ?? 'unresolved', activeAccountVerified: false, checkedAt: now, retryAt: backoff ? now + backoff : null };
      if (epoch === this.epoch) {
        if (this.entries.size >= 16 && !this.entries.has(auth.key)) this.entries.delete(this.entries.keys().next().value);
        this.entries.set(auth.key, { result, failures, retryAt: now + backoff, expiresAt: now + this.ttlMs });
      }
      return result;
    })().finally(() => {
      clearTimeout(timer);
      if (this.pending.get(auth.key)?.promise === promise) this.pending.delete(auth.key);
    });
    this.pending.set(auth.key, { promise, controller });
    return promise;
  }
  cancelPending() {
    this.epoch++;
    for (const p of this.pending.values()) p.controller.abort();
    this.pending.clear();
  }
  clear() {
    this.cancelPending();
    this.entries.clear();
  }
}
