// StorageAdapter interface + localStorage implementation

export class LocalStorageAdapter {
  constructor(namespace = 'llm') {
    this.ns = namespace
  }

  _k(key) { return `${this.ns}:${key}` }

  get(key) {
    try { return localStorage.getItem(this._k(key)) } catch { return null }
  }

  set(key, value) {
    try { localStorage.setItem(this._k(key), value) } catch {}
  }

  remove(key) {
    try { localStorage.removeItem(this._k(key)) } catch {}
  }

  // List all keys for this namespace (returns object of raw string values)
  list(prefix = '') {
    const result = {}
    try {
      const fullPrefix = this._k(prefix)
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(this.ns + ':') && k.startsWith(fullPrefix)) {
          result[k.slice(this.ns.length + 1)] = localStorage.getItem(k)
        }
      }
    } catch {}
    return result
  }
}

export class MemoryStorageAdapter {
  constructor(namespace = 'llm') { this.ns = namespace; this.store = new Map() }
  _k(key) { return `${this.ns}:${key}` }
  get(key) { return this.store.get(this._k(key)) || null }
  set(key, value) { this.store.set(this._k(key), value) }
  remove(key) { this.store.delete(this._k(key)) }
  list(prefix = '') {
    const result = {}
    const fullPrefix = this._k(prefix)
    for (const [k,v] of this.store.entries()) {
      if (k.startsWith(fullPrefix)) {
        result[k.slice(this.ns.length + 1)] = v
      }
    }
    return result
  }
}
