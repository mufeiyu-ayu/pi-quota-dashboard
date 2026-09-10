import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Verification scripts only. Runtime extensions use pi's normal package imports.
export async function installedPi() {
  const root = process.env.PI_DASHBOARD_PI_ROOT || resolve(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent');
  const require = createRequire(resolve(root, 'package.json'));
  const load = (name) => {
    const path = name === '@earendil-works/pi-coding-agent' ? resolve(root, 'dist/index.js')
      : name.startsWith('@earendil-works/pi-ai/providers/') ? resolve(root, 'node_modules/@earendil-works/pi-ai/dist', name.slice('@earendil-works/pi-ai/'.length) + '.js')
      : name === '@earendil-works/pi-tui' ? resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js')
      : require.resolve(name);
    return import(pathToFileURL(path).href);
  };
  const pi = await load('@earendil-works/pi-coding-agent');
  const providers = {
    anthropic: (await load('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider(),
    'openai-codex': (await load('@earendil-works/pi-ai/providers/openai-codex')).openaiCodexProvider(),
    deepseek: (await load('@earendil-works/pi-ai/providers/deepseek')).deepseekProvider(),
  };
  return { root, pi, providers, load, require };
}
