#!/usr/bin/env node
import { installedPi } from './pi-installation.mjs';
import { resolveCredential } from '../auth.mjs';
import { QuotaCache } from '../quota.mjs';

// Explicit opt-in; GET only. Does not instantiate ModelRuntime or refresh auth.
if (!process.argv.includes('--live')) {
  console.log('Read-only live smoke: node scripts/smoke.mjs --live [anthropic|openai-codex|deepseek]');
} else {
  let dispatcher, cache;
  try {
    const { pi, providers, load } = await installedPi();
    const { fetch, EnvHttpProxyAgent } = await load('undici');
    dispatcher = new EnvHttpProxyAgent();
    dispatcher.on('error', () => {});
    cache = new QuotaCache({ fetcher: (url, init) => fetch(url, { ...init, dispatcher }) });
    const chosen = process.argv.slice(2).filter((a) => a !== '--live');
    if (chosen.some((p) => !Object.hasOwn(providers, p))) throw new Error('invalid provider');
    for (const id of chosen.length ? chosen : Object.keys(providers)) {
      const provider = providers[id];
      const ctx = {
        model: { provider: id, baseUrl: provider.baseUrl },
        modelRegistry: {
          getProvider: () => provider,
          getProviderAuthStatus: () => ({ source: pi.readStoredCredential(id) ? 'stored' : 'environment' }),
          getRegisteredProviderConfig: () => undefined,
          getRegisteredNativeProvider: () => undefined,
        },
      };
      const auth = await resolveCredential(ctx, { readCredential: pi.readStoredCredential, providers, readConfig: () => ({}) }, AbortSignal.timeout(8000));
      const result = auth.result ?? await cache.get(auth, true);
      // Deliberately omit token, account id, fingerprint, headers and raw bodies.
      console.log(JSON.stringify({ validation: 'live_official_stored_pi_account_not_active_model', piVersion: pi.VERSION, ...result }));
    }
  } catch {
    console.log(JSON.stringify({ state: 'error', reason: 'smoke_setup_failed_no_details_logged' }));
    process.exitCode = 1;
  } finally {
    cache?.clear();
    await dispatcher?.destroy();
  }
}
