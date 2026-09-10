import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir, readStoredCredential } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { readModelConfig } from './auth.mjs';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { Dashboard, registerDashboard } from './runtime.mjs';
import { MergedFooter } from './footer.mjs';

export default function (pi: ExtensionAPI) {
  registerDashboard(pi, new Dashboard({
    readCredential: readStoredCredential,
    readConfig: () => readModelConfig(join(getAgentDir(), 'models.json')),
    providers: Object.fromEntries(builtinProviders()
      .filter((provider) => ['anthropic', 'openai-codex', 'deepseek'].includes(provider.id))
      .map((provider) => [provider.id, provider])),
  }, { createFooter: (...args) => new MergedFooter(...args) }));
}
