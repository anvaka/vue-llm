import { BaseProvider } from './BaseProvider.js'

export class OllamaProvider extends BaseProvider {
  async detectCapabilities() {
    if (!this.config.model) return
    try {
      const modelInfo = await this.fetchModelInfo()
      const capabilities = modelInfo.capabilities || []
      if (capabilities.includes('thinking')) this.capabilities.add('thinking')
      if (capabilities.includes('vision')) this.capabilities.add('vision')
      if (capabilities.includes('tools')) this.capabilities.add('tools')
    } catch (e) {
      console.warn('Ollama capability detection failed:', e)
    }
  }

  async fetchModelInfo() {
    const response = await fetch(`${this.config.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.config.model })
    })
    if (!response.ok) throw new Error(`Failed to fetch model info: ${response.status}`)
    return response.json()
  }

  prepareRequest(messages, options) {
    const model = options.model || this.config.model
    if (!model) throw new Error('Model must be specified for Ollama requests')
    const request = {
      model,
      messages: this.processMessages(messages, options),
      stream: options.stream || false,
      think: options.enableThinking || false,
      options: { temperature: options.temperature || 0.7, num_predict: options.maxTokens || 1000 }
    }
    if (options.enableThinking && this.capabilities.has('thinking')) {
      request.options.enable_thinking = true
    }
    return request
  }

  processMessages(messages, options) {
    if (options.images && this.capabilities.has('vision')) return this.addImagesToMessages(messages, options.images)
    return messages
  }

  addImagesToMessages(messages, images) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage && lastMessage.role === 'user') {
      lastMessage.images = images.map(img => typeof img === 'string' ? (img.startsWith('data:') ? img.split(',')[1] : img) : img)
    }
    return messages
  }

  processResponse(response) {
    const result = { content: response.message?.content || '', usage: response.eval_count ? { tokens: response.eval_count } : null, finishReason: mapFinishReason(response.finish_reason) }
    if (response.thinking) result.thinking = response.thinking
    return result
  }

  parseStreamingLine(line) {
    try { return JSON.parse(line) } catch { return null }
  }

  extractStreamingContent(parsed) {
    return { content: parsed.message?.content || '', thinking: parsed.thinking || '', done: parsed.done || false, usage: parsed.eval_count ? { tokens: parsed.eval_count } : null, finishReason: mapFinishReason(parsed.finish_reason) }
  }

  getApiPath() { return '/api/chat' }
  requiresAuth() { return false }
  getModelsEndpoint() { return `${this.config.baseUrl}/api/tags` }
  parseModelsResponse(data) { return data.models?.map(m => m.name) || [] }
}

function mapFinishReason(reason) {
  if (!reason) return null
  const r = String(reason).toLowerCase()
  if (r === 'max_tokens') return 'length'
  return r
}
