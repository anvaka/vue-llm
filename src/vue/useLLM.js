import { inject, ref, computed } from 'vue'
import { LLM_CLIENT_SYMBOL, LLM_CONFIG_SYMBOL, LLM_KEYSTORE_SYMBOL } from './plugin.js'
import { createProvider } from '../providers/factory.js'

/**
 * Main composable for LLM functionality.
 * Provides access to the client, config store, and key store with reactive helpers.
 */
export function useLLM() {
  const client = inject(LLM_CLIENT_SYMBOL)
  const configStore = inject(LLM_CONFIG_SYMBOL)
  const keyStore = inject(LLM_KEYSTORE_SYMBOL)

  if (!client || !configStore) {
    throw new Error('LLM not provided. Did you install the LLMPlugin?')
  }

  // Reactive streaming state
  const isStreaming = ref(false)
  const streamContent = ref('')
  const streamThinking = ref('')

  /**
   * Stream a chat completion with reactive state updates.
   */
  async function stream(messages, options = {}) {
    isStreaming.value = true
    streamContent.value = ''
    streamThinking.value = ''

    try {
      const result = await client.stream({ messages, ...options }, (chunk) => {
        streamContent.value = chunk.fullContent || ''
        streamThinking.value = chunk.fullThinking || ''
      })
      return result
    } finally {
      isStreaming.value = false
    }
  }

  /**
   * Get all enabled provider configurations.
   */
  function getEnabledConfigs() {
    return configStore.getEnabledConfigs()
  }

  /**
   * Get all provider configurations (including disabled).
   */
  function getAllConfigs() {
    const all = configStore.listConfigs()
    return Object.entries(all)
      .filter(([_, c]) => c && c.provider && c.baseUrl)
      .map(([id, c]) => ({ id, ...c }))
  }

  /**
   * Get the currently active provider configuration.
   */
  function getActiveConfig() {
    return configStore.getActiveConfig()
  }

  /**
   * Get the active provider ID.
   */
  function getActiveProviderId() {
    return configStore.getActiveProviderId()
  }

  /**
   * Set the active provider by ID.
   */
  function setActiveProviderId(id) {
    configStore.setActiveProviderId(id)
    return true
  }

  /**
   * Save a provider configuration.
   * Optionally stores the API key in the key store.
   */
  function saveConfig(id, config) {
    const saved = configStore.saveConfig(id, config)
    
    // Also store key in keyStore for reuse
    if (saved && config.apiKey && config.provider && keyStore) {
      const keyId = config.provider === 'custom' ? id : config.provider
      const options = {
        providerType: config.provider,
        ...(config.provider === 'custom' && config.baseUrl && { serviceEndpoint: config.baseUrl }),
        ...(config.provider === 'custom' && config.name && { providerName: config.name })
      }
      keyStore.set(keyId, config.apiKey, options)
    }
    
    return saved
  }

  /**
   * Delete a provider configuration.
   */
  function deleteConfig(id) {
    return configStore.deleteConfig(id)
  }

  /**
   * Enable a provider.
   */
  function enableProvider(id) {
    const cfg = configStore.getConfig(id)
    if (!cfg) return false
    cfg.enabled = true
    return configStore.saveConfig(id, cfg)
  }

  /**
   * Disable a provider.
   */
  function disableProvider(id) {
    const cfg = configStore.getConfig(id)
    if (!cfg) return false
    cfg.enabled = false
    const result = configStore.saveConfig(id, cfg)
    if (getActiveProviderId() === id) {
      setActiveProviderId(null)
    }
    return result
  }

  /**
   * Get available models for a provider configuration.
   */
  async function getAvailableModels(providerType, config) {
    const providerInstance = createProvider(providerType, config)
    return providerInstance.discoverModels()
  }

  /**
   * Test connection to a provider.
   */
  async function testConnection(config) {
    return client.testConnection(config)
  }

  /**
   * Refresh the client (re-initialize with current active config).
   */
  async function refresh() {
    return client.refresh()
  }

  // Key store helpers
  function getStoredKey(id) {
    return keyStore?.get(id) || null
  }

  function hasStoredKey(providerType) {
    return keyStore?.has(providerType) || false
  }

  function getAllStoredKeys() {
    return keyStore?.getAll() || {}
  }

  function storeKey(id, apiKey, options = {}) {
    return keyStore?.set(id, apiKey, options) || false
  }

  function deleteStoredKey(id) {
    return keyStore?.delete(id) || false
  }

  function getStoredKeyMeta(id) {
    return keyStore?.meta(id) || null
  }

  return {
    // Core objects
    client,
    configStore,
    keyStore,

    // Streaming
    stream,
    isStreaming,
    streamContent,
    streamThinking,

    // Config management
    getEnabledConfigs,
    getAllConfigs,
    getActiveConfig,
    getActiveProviderId,
    setActiveProviderId,
    saveConfig,
    deleteConfig,
    enableProvider,
    disableProvider,
    getAvailableModels,
    testConnection,
    refresh,

    // Key management
    getStoredKey,
    hasStoredKey,
    getAllStoredKeys,
    storeKey,
    deleteStoredKey,
    getStoredKeyMeta
  }
}

/**
 * Create a default provider configuration object.
 */
export function createDefaultConfig(provider) {
  return {
    name: '',
    provider,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
    enableThinking: false,
    enabled: true,
    configuredAt: new Date().toISOString()
  }
}
