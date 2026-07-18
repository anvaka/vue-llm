// Seeds provider configs from the shell-injected `virtual:demo-preconfig`
// module (see demo/vite.config.js) into the same localStorage the plugin reads, so the
// playground boots with providers already configured. Keys come from your shell
// at dev time only — nothing here is committed.
import { ConfigStore, createDefaultConfig } from '@lib/core/configStore.js'
import { KeyStore } from '@lib/core/keyStore.js'
import { LocalStorageAdapter } from '@lib/core/storageAdapter.js'
// Provided by demo/vite.config.js as a virtual module (dev only; [] in a build).
import PRESETS from 'virtual:demo-preconfig'

// Labels of the providers seeded from the shell, for display in the UI.
export const shellLabels = PRESETS.map(p => p.label)

// Must match the plugin's namespace in demo/main.js (LLMPlugin { namespace: 'llm' }).
const NAMESPACE = 'llm'

export function seedFromShell() {
  if (!PRESETS.length) return []

  const adapter = new LocalStorageAdapter(NAMESPACE)
  const store = new ConfigStore({ storageAdapter: adapter })
  const keyStore = new KeyStore(adapter)

  for (const p of PRESETS) {
    // Seed once. If a config for this id already exists, leave it alone —
    // whatever key/model you set in the Configure modal wins and survives
    // reloads. (Previously this clobbered your key from the shell on every
    // load, which reverted a hand-entered key back to a stale shell one.)
    // To re-pull from the shell, delete the provider in the modal and reload.
    if (store.getConfig(p.id)) continue

    const config = { ...createDefaultConfig(p.config.provider), ...p.config, name: p.label }
    store.saveConfig(p.id, config)
    // Mirror into the key store so the Configure modal's key reuse works too.
    keyStore.set(p.config.provider, p.config.apiKey, { providerType: p.config.provider })
  }

  // Activate the first pre-loaded provider if the user hasn't chosen one.
  if (!store.getActiveProviderId()) store.setActiveProviderId(PRESETS[0].id)

  return PRESETS.map(p => p.label)
}
