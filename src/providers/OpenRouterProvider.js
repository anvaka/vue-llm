import { BaseProvider } from './BaseProvider.js'

export class OpenRouterProvider extends BaseProvider {
  async detectCapabilities() {
    if (!this.config.model) return
    this.capabilities.add('tools')
    if (this.config.model.includes('o1') || this.config.model.includes('thinking') || this.config.model.includes('reasoning')) this.capabilities.add('thinking')
    if (this.config.model.includes('vision') || this.config.model.includes('gpt-4') || this.config.model.includes('claude') || this.config.model.includes('gemini')) this.capabilities.add('vision')
  }
  prepareRequest(messages, options) {
    const request = {
      model: options.model || this.config.model,
      messages: this.processMessages(messages, options),
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 1000,
      stream: options.stream || false
    }
    if (options.enableThinking && this.capabilities.has('thinking')) {
      request.reasoning = options.reasoning !== false
      if (options.reasoningEffort) request.reasoning_effort = options.reasoningEffort
    }
    if (options.tools && this.capabilities.has('tools')) {
      request.tools = options.tools
      if (options.tool_choice) request.tool_choice = options.tool_choice
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
      lastMessage.content = [ { type: 'text', text: lastMessage.content }, ...images.map(i => ({ type: 'image_url', image_url: { url: i } })) ]
    }
    return messages
  }
  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' }
    if (this.requiresAuth()) headers[this.getAuthHeaderName()] = this.getAuthHeaderValue()
    if (this.config.siteUrl) headers['HTTP-Referer'] = this.config.siteUrl
    if (this.config.siteName) headers['X-Title'] = this.config.siteName
    return headers
  }
  processResponse(response) {
    const result = { content: response.choices?.[0]?.message?.content || '', usage: response.usage || null, finishReason: mapFinishReason(response.choices?.[0]?.finish_reason) }
    if (response.choices?.[0]?.message?.reasoning) result.thinking = response.choices[0].message.reasoning
    return result
  }
  parseStreamingLine(line) {
    if (!line.startsWith('data: ')) return null
    const data = line.slice(6).trim()
    if (data === '[DONE]') return { done: true }
    try { return JSON.parse(data) } catch { return null }
  }
  extractStreamingContent(parsed) {
    if (parsed.done) return { done: true }
    const delta = parsed.choices?.[0]?.delta
    return { content: delta?.content || '', thinking: delta?.reasoning || '', done: false, usage: parsed.usage || null, finishReason: mapFinishReason(parsed.choices?.[0]?.finish_reason) }
  }
  getApiPath() { return '/v1/chat/completions' }
  requiresAuth() { return !!this.config.apiKey }
  getModelsEndpoint() { return `${this.config.baseUrl}/v1/models` }
  parseModelsResponse(data) {
    if (!Array.isArray(data.data)) return []
    return data.data.filter(m => { const modality = m.architecture?.modality; return modality && (modality.includes('text->text') || modality.includes('text+image->text')) }).map(m => m.id).sort()
  }
  async discoverModelsWithMetadata(timeoutMs = 15000) {
    try {
      const headers = this.buildHeaders()
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      const response = await fetch(this.getModelsEndpoint(), { method: 'GET', headers, signal: controller.signal })
      clearTimeout(timeoutId)
      if (!response.ok) throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
      const data = await response.json()
      return data.data || []
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Model discovery timeout - please check your connection')
      throw e
    }
  }
}
function mapFinishReason(reason) { if (!reason) return null; const r = String(reason).toLowerCase(); if (r === 'length' || r === 'max_tokens') return 'length'; return r }
