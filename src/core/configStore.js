// Configuration store abstraction (replaces direct localStorage usage)
import { LocalStorageAdapter } from './storageAdapter.js'

export class ConfigStore {
  constructor({ storageAdapter = null } = {}) {
    this.storage = storageAdapter || new LocalStorageAdapter('llm')
    this.CONFIGS_KEY = 'configs'
    this.ACTIVE_KEY = 'active-provider'
  }

  _readConfigs() {
    const raw = this.storage.get(this.CONFIGS_KEY)
    if (!raw) return {}
    try { return JSON.parse(raw) } catch { return {} }
  }

  _writeConfigs(configs) {
    try { this.storage.set(this.CONFIGS_KEY, JSON.stringify(configs)) } catch {}
  }

  listConfigs() {
    return this._readConfigs()
  }

  getConfig(id) {
    return this._readConfigs()[id] || null
  }

  saveConfig(id, config) {
    const configs = this._readConfigs()
    configs[id] = { ...config, configuredAt: new Date().toISOString() }
    this._writeConfigs(configs)
    return true
  }

  deleteConfig(id) {
    const configs = this._readConfigs()
    delete configs[id]
    this._writeConfigs(configs)
    if (this.getActiveProviderId() === id) {
      this.setActiveProviderId(null)
    }
    return true
  }

  getActiveProviderId() {
    return this.storage.get(this.ACTIVE_KEY)
  }

  setActiveProviderId(id) {
    if (id) this.storage.set(this.ACTIVE_KEY, id)
    else this.storage.remove(this.ACTIVE_KEY)
  }

  getActiveConfig() {
    const id = this.getActiveProviderId()
    return id ? this.getConfig(id) : null
  }

  getEnabledConfigs() {
    const all = this._readConfigs()
    return Object.entries(all)
      .filter(([_, c]) => c && c.enabled !== false && c.provider && c.baseUrl)
      .map(([id, c]) => ({ id, ...c }))
  }
}

export function createDefaultConfig(provider) {
  return {
    name: '',
    provider,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxTokens: 1000,
    enableThinking: false,
    enabled: true,
    configuredAt: new Date().toISOString()
  }
}
