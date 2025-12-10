import { LLMClient } from '../core/LLMClient.js'
import { ConfigStore } from '../core/configStore.js'
import { KeyStore } from '../core/keyStore.js'
import { LocalStorageAdapter } from '../core/storageAdapter.js'

export const LLM_CLIENT_SYMBOL = Symbol('LLM_CLIENT')
export const LLM_CONFIG_SYMBOL = Symbol('LLM_CONFIG')
export const LLM_KEYSTORE_SYMBOL = Symbol('LLM_KEYSTORE')

export function createLLM(options = {}) {
  // Default namespace is 'llm' so all apps share the same config by default
  const namespace = options.namespace || 'llm'
  const storageAdapter = options.storageAdapter || new LocalStorageAdapter(namespace)
  const configStore = new ConfigStore({ storageAdapter })
  const keyStore = new KeyStore(storageAdapter)
  const client = new LLMClient({ configStore, logger: options.logger })
  return { client, configStore, keyStore }
}

export const LLMPlugin = {
  install(app, options = {}) {
    const { client, configStore, keyStore } = createLLM(options)
    app.provide(LLM_CLIENT_SYMBOL, client)
    app.provide(LLM_CONFIG_SYMBOL, configStore)
    app.provide(LLM_KEYSTORE_SYMBOL, keyStore)
    if (options.autoInit) {
      try { client.ensureInitialized() } catch { /* swallow until user configures */ }
    }
  }
}
