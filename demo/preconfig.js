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

function openStores() {
  const adapter = new LocalStorageAdapter(NAMESPACE)
  return { store: new ConfigStore({ storageAdapter: adapter }), keyStore: new KeyStore(adapter) }
}

// Write a preset into storage as a fresh config (config + mirrored key).
function writePreset(store, keyStore, p) {
  const config = { ...createDefaultConfig(p.config.provider), ...p.config, name: p.label }
  store.saveConfig(p.id, config)
  keyStore.set(p.config.provider, p.config.apiKey, { providerType: p.config.provider })
}

// Boot seed: create shell providers that don't exist yet, and never clobber an
// existing entry — your Configure-modal edits survive reloads. (Previously this
// overwrote the key from the shell on every load, reverting a hand-entered key.)
export function seedFromShell() {
  if (!PRESETS.length) return []
  const { store, keyStore } = openStores()
  for (const p of PRESETS) {
    if (store.getConfig(p.id)) continue
    writePreset(store, keyStore, p)
  }
  if (!store.getActiveProviderId()) store.setActiveProviderId(PRESETS[0].id)
  return PRESETS.map(p => p.label)
}

// Explicit reseed (the "Reseed from shell" button): overwrite every shell
// provider back to its current shell values, so a rotated key is picked up
// without deleting the provider by hand.
export function reseedFromShell() {
  if (!PRESETS.length) return []
  const { store, keyStore } = openStores()
  for (const p of PRESETS) writePreset(store, keyStore, p)
  if (!store.getActiveProviderId()) store.setActiveProviderId(PRESETS[0].id)
  return PRESETS.map(p => p.label)
}
