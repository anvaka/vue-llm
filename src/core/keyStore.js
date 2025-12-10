const DEFAULT_KEYS_NS = 'stored-keys'

export class KeyStore {
  constructor(storageAdapter, keyNamespace = DEFAULT_KEYS_NS) {
    this.storage = storageAdapter
    this.key = keyNamespace
  }
  _read() {
    const raw = this.storage.get(this.key)
    if (!raw) return {}
    try { return JSON.parse(raw) } catch { return {} }
  }
  _write(obj) {
    try { this.storage.set(this.key, JSON.stringify(obj)) } catch {}
  }
  getAll() { return this._read() }
  get(id) { const all = this._read(); return all[id]?.apiKey || null }
  set(id, apiKey, options = {}) {
    const all = this._read()
    const { providerType, serviceEndpoint, providerName } = options
    all[id] = { apiKey, storedAt: new Date().toISOString(), ...(providerType && { providerType }), ...(serviceEndpoint && { serviceEndpoint }), ...(providerName && { providerName }) }
    this._write(all)
    return true
  }
  delete(id) { const all = this._read(); delete all[id]; this._write(all); return true }
  has(providerType) {
    const all = this._read()
    if (providerType === 'custom') return Object.values(all).some(k => k.providerType === 'custom')
    return !!(all[providerType]?.apiKey)
  }
  getForType(providerType) {
    const all = this._read()
    const result = {}
    for (const [id, data] of Object.entries(all)) {
      if (data.providerType === providerType || id === providerType) result[id] = data
    }
    return result
  }
  meta(id) {
    const data = this._read()[id]
    if (!data) return null
    return { hasKey: !!data.apiKey, storedAt: data.storedAt, maskedKey: data.apiKey ? maskApiKey(data.apiKey) : null, providerType: data.providerType, serviceEndpoint: data.serviceEndpoint, providerName: data.providerName }
  }
}

export function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length < 12) return '••••••••'
  return `${apiKey.substring(0, 8)}••••${apiKey.substring(apiKey.length - 4)}`
}
