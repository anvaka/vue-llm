// Core exports
export { LLMClient } from './core/LLMClient.js'
export { ConfigStore } from './core/configStore.js'
export { KeyStore, maskApiKey } from './core/keyStore.js'
export { LocalStorageAdapter, MemoryStorageAdapter } from './core/storageAdapter.js'

// Provider exports
export { PROVIDERS, DEFAULT_CONFIGS, createProvider, registerProvider, createProviderFlexible } from './providers/factory.js'

// Vue plugin and composables
export { LLMPlugin, createLLM, LLM_CLIENT_SYMBOL, LLM_CONFIG_SYMBOL, LLM_KEYSTORE_SYMBOL } from './vue/plugin.js'
export { useLLM, createDefaultConfig } from './vue/useLLM.js'

// Vue components
export { default as ProviderSelector } from './vue/components/ProviderSelector.vue'
export { default as LLMConfigModal } from './vue/components/LLMConfigModal.vue'
export { default as StoredKeysManager } from './vue/components/StoredKeysManager.vue'

// Singleton for non-Vue usage (browser-only)
import { createLLM } from './vue/plugin.js'
const __singleton = createLLM({})
export const llmClient = __singleton.client
export const configStore = __singleton.configStore
export const keyStore = __singleton.keyStore

