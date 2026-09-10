import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ENDPOINTS, officialBase, unavailable, number } from './core.mjs';

const secretString = (v) => typeof v === 'string' && v.length > 0 && v.length < 32768 && !/[\s\x00-\x1f\x7f]/.test(v);
export function authFingerprint(provider, token, accountId = '') {
  return createHash('sha256').update(JSON.stringify([provider, ENDPOINTS[provider], token, accountId])).digest('hex');
}
export function codexIdentity(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { accountId: payload['https://api.openai.com/auth']?.chatgpt_account_id, expires: number(payload.exp) === null ? null : payload.exp * 1000 };
  } catch { return {}; }
}
// Only plain literals and whole-variable references are accepted here. Never run
// !commands (including keychain/CLI helpers) from a read-only status integration.
export function readOnlyKey(raw, scoped = {}, env = process.env) {
  if (raw === undefined) return { key: undefined };
  if (typeof raw !== 'string' || raw.startsWith('!')) return { reason: 'command_or_invalid_credential' };
  if (raw.includes('$')) {
    const match = raw.match(/^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/);
    if (!match) return { reason: 'credential_template_unsupported' };
    const name = match[1] ?? match[2];
    return { key: scoped[name] || env[name] || undefined, credentialSource: scoped[name] ? 'pi_scoped_environment' : 'environment' };
  }
  return { key: raw, credentialSource: 'pi_stored_api_key' };
}

// 与 pi 的 isUsingSubscription 同构（isUsingOAuth && provider.auth.oauth.isSubscription），
// 但只认 Pi 存储的 OAuth：environment/runtime 凭据这一层看不到，宁可漏标 (sub) 也不猜。
export function isSubscription(ctx, readCredential) {
  const id = ctx.model?.provider;
  if (id === undefined) return false;
  if (id === 'kimi-coding') return true;
  try {
    return readCredential(id)?.type === 'oauth'
      && ctx.modelRegistry.getProvider(id)?.auth?.oauth?.isSubscription === true;
  } catch { return false; }
}

export function readModelConfig(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw new Error('configuration_unverified'); }
}
export function authConfigOverride(config, id, modelId) {
  const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!record(config) || (config.providers !== undefined && !record(config.providers))) return 'configuration_unverified';
  const p = config.providers?.[id];
  if (p === undefined) return null;
  if (!record(p)) return 'configuration_unverified';
  if (p.models !== undefined && !Array.isArray(p.models)) return 'configuration_unverified';
  if (p.modelOverrides !== undefined && !record(p.modelOverrides)) return 'configuration_unverified';
  const model = p.models?.find((m) => m?.id === modelId);
  const override = p.modelOverrides?.[modelId];
  const present = (v) => v !== undefined && v !== null && v !== '' && v !== false && !(record(v) && Object.keys(v).length === 0);
  return [p.apiKey, p.headers, p.authHeader, p.oauth, model?.headers, override?.headers].some(present)
    ? 'custom_auth_configuration_unconfirmed' : null;
}

// 仅解析 Pi 存储/环境凭据；公开配置检查不能排除已加载的隐藏 headers 或请求 hook，
// 因此这些凭据始终不代表已验证的活动请求账户。
export async function resolveCredential(ctx, { readCredential, providers, readConfig, env = process.env }, signal, now = Date.now()) {
  const id = ctx.model?.provider;
  let credentialSource = 'unresolved';
  const fail = (state, reason) => ({ result: { ...unavailable(id, state, reason), credentialSource } });
  if (!Object.hasOwn(ENDPOINTS, id ?? '')) return fail('unsupported', 'provider_not_supported');
  const registry = ctx.modelRegistry;
  const activeProvider = registry.getProvider(id);
  if (!officialBase(id, ctx.model?.baseUrl) || !officialBase(id, activeProvider?.baseUrl))
    return fail('unsupported', 'custom_endpoint');
  if (registry.getRegisteredProviderConfig(id) || registry.getRegisteredNativeProvider(id) ||
      Object.keys(ctx.model?.headers ?? {}).length || Object.keys(activeProvider?.headers ?? {}).length)
    return fail('unsupported', 'custom_provider_or_headers');
  try {
    const configReason = authConfigOverride(readConfig(), id, ctx.model?.id);
    if (configReason) return fail('unsupported', configReason);
  } catch { return fail('unsupported', 'configuration_unverified'); }
  const source = registry.getProviderAuthStatus(id)?.source;
  if (source && !['stored', 'environment'].includes(source)) return fail('unsupported', 'auth_source_unconfirmed');
  try {
    signal.throwIfAborted();
    const stored = readCredential(id);
    const provider = providers[id];
    let token, accountId;
    if (id === 'deepseek') {
      if (stored && stored.type !== 'api_key') return fail('unsupported', 'auth_type_unsupported');
      const resolved = readOnlyKey(stored?.key, stored?.env, env);
      if (resolved.reason) return fail('unsupported', resolved.reason);
      credentialSource = resolved.key ? resolved.credentialSource : 'unresolved';
      // 存储 key 无法解析时，不静默改用环境中的其他账户。
      if (stored?.key !== undefined && !resolved.key) return fail('unauthenticated', 'credential_unresolved');
      const auth = await provider.auth.apiKey.resolve({
        credential: stored ? { type: 'api_key', key: resolved.key } : undefined,
        ctx: { env: async (name) => {
          const value = stored?.env?.[name] || env[name];
          if (value) credentialSource = stored?.env?.[name] ? 'pi_scoped_environment' : 'environment';
          return value;
        }, fileExists: async () => false }, signal,
      });
      token = auth?.auth.apiKey;
    } else {
      if (!stored) return fail('unauthenticated', 'pi_oauth_missing');
      if (stored.type !== 'oauth') return fail('unsupported', 'subscription_requires_pi_oauth');
      credentialSource = 'pi_stored_oauth';
      if (number(stored.expires) === null) return fail('unknown', 'credential_expiry_missing');
      if (stored.expires <= now) return fail('expired', 'pi_oauth_expired_no_refresh');
      token = (await provider.auth.oauth.toAuth(stored))?.apiKey;
      if (id === 'openai-codex') {
        const identity = codexIdentity(token ?? '');
        accountId = identity.accountId;
        if (!secretString(accountId)) return fail('unknown', 'account_id_missing');
        if (identity.expires !== null && identity.expires !== undefined && identity.expires <= now)
          return fail('expired', 'pi_oauth_expired_no_refresh');
        if (stored.accountId && stored.accountId !== accountId) return fail('unknown', 'account_id_mismatch');
      }
    }
    signal.throwIfAborted();
    if (!token) return fail('unauthenticated', 'credential_missing');
    if (!secretString(token)) return fail('error', 'credential_invalid');
    return { provider: id, token, accountId, credentialSource, activeAccountVerified: false, key: authFingerprint(id, token, accountId) };
  } catch { return fail(signal.aborted ? 'unavailable' : 'error', signal.aborted ? 'cancelled' : 'credential_resolution_failed'); }
}
