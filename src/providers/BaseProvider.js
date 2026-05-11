// Base provider class for all LLM providers (browser-only)

export class BaseProvider {
  constructor(config) {
    this.config = config
    this.capabilities = new Set()
    this.activeRequests = new Map() // Track active requests for cancellation
  }

  async initialize() {
    await this.detectCapabilities()
  }

  async detectCapabilities() {
    // Override in subclasses
  }

  prepareRequest(messages, options) {
    throw new Error('prepareRequest must be implemented by subclass')
  }

  processResponse(response) {
    throw new Error('processResponse must be implemented by subclass')
  }

  async streamRequest(messages, options, onChunk) {
    const request = this.prepareRequest(messages, options)
    const abortController = new AbortController()
    
    // Store request for cancellation
    const requestId = options.requestId || this.generateRequestId()
    this.activeRequests.set(requestId, abortController)
    
    try {
      const response = await this.makeStreamingRequest(request, abortController.signal)
      
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullContent = ''
      let fullThinking = ''
      let buffer = ''

      const handleLine = (line) => {
        if (!line.trim()) return null
        const parsed = this.parseStreamingLine(line)
        if (!parsed) return null
        const result = this.extractStreamingContent(parsed)
        if (!result) return null
        if (result.content) fullContent += result.content
        if (result.thinking) fullThinking += result.thinking
        onChunk({
          content: result.content || '',
          thinking: result.thinking || '',
          fullContent,
          fullThinking,
          done: result.done || false,
          usage: result.usage || null,
          finishReason: result.finishReason || null
        })
        return result.done ? 'done' : null
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          // Flush any trailing line that wasn't terminated by a newline
          if (buffer.length > 0) handleLine(buffer)
          break
        }

        buffer += decoder.decode(value, { stream: true })

        // Process all complete lines; keep the trailing partial line in buffer.
        let newlineIdx
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx)
          buffer = buffer.slice(newlineIdx + 1)
          if (handleLine(line) === 'done') return fullContent
        }
      }

      return fullContent
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request cancelled')
      }
      throw error
    } finally {
      this.activeRequests.delete(requestId)
    }
  }

  async makeRequest(request, signal, requestId) {
    const abortController = signal ? { signal } : new AbortController()
    
    if (!signal) {
      // Store request for cancellation if not provided
      requestId = requestId || this.generateRequestId()
      this.activeRequests.set(requestId, abortController)
    }

    try {
      const headers = this.buildHeaders()
      const response = await fetch(this.getEndpoint(), {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: abortController.signal || signal
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`LLM API Error (${response.status}): ${errorText}`)
      }

      return response.json()
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request cancelled')
      }
      throw error
    } finally {
      if (!signal && requestId) {
        this.activeRequests.delete(requestId)
      }
    }
  }

  async makeStreamingRequest(request, signal) {
    const headers = this.buildHeaders()
    const response = await fetch(this.getStreamingEndpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`LLM API Error (${response.status}): ${errorText}`)
    }

    return response
  }

  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' }
    
    if (this.requiresAuth()) {
      headers[this.getAuthHeaderName()] = this.getAuthHeaderValue()
    }
    
    return headers
  }

  getStreamingEndpoint() {
    return `${this.config.baseUrl}${this.getApiPath()}`
  }

  getEndpoint() {
    return `${this.config.baseUrl}${this.getApiPath()}`
  }

  parseStreamingLine(_line) {
    throw new Error('parseStreamingLine must be implemented by subclass')
  }

  extractStreamingContent(_parsed) {
    throw new Error('extractStreamingContent must be implemented by subclass')
  }

  getApiPath() {
    throw new Error('getApiPath must be implemented by subclass')
  }

  requiresAuth() {
    return false
  }

  getAuthHeaderName() {
    return 'Authorization'
  }

  getAuthHeaderValue() {
    return `Bearer ${this.config.apiKey}`
  }

  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  // Cancel all active requests
  cancelAllRequests() {
    for (const [, controller] of this.activeRequests) {
      controller.abort()
    }
    this.activeRequests.clear()
  }

  // Cancel specific request
  cancelRequest(requestId) {
    const controller = this.activeRequests.get(requestId)
    if (controller) {
      controller.abort()
      this.activeRequests.delete(requestId)
    }
  }

  // Check if provider has capability
  hasCapability(capability) {
    return this.capabilities.has(capability)
  }

  // Discover available models (override in subclass if needed)
  async discoverModels(timeoutMs = 10000) {
    try {
      const headers = this.buildHeaders()
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(this.getModelsEndpoint(), {
        method: 'GET',
        headers,
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      return this.parseModelsResponse(data)
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Model discovery timeout - please check your connection')
      } else {
        throw error
      }
    }
  }

  getModelsEndpoint() {
    throw new Error('getModelsEndpoint must be implemented by subclass')
  }

  parseModelsResponse(_data) {
    throw new Error('parseModelsResponse must be implemented by subclass')
  }
}
