import { BaseProvider } from './BaseProvider.js'

export class AnthropicProvider extends BaseProvider {
  async detectCapabilities() {
    if (this.config.model?.includes('claude-3')) {
      this.capabilities.add('vision')
    }
  }

  prepareRequest(messages, options) {
    const request = {
      model: options.model || this.config.model || 'claude-3-sonnet-20240229',
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature || 0.7,
      messages: messages.filter(msg => msg.role !== 'system'),
      stream: options.stream || false
    }
    const systemMessage = messages.find(msg => msg.role === 'system')
    if (systemMessage) request.system = systemMessage.content
    return request
  }

  processMessages(messages, options) {
    if (options.images && this.capabilities.has('vision')) {
      return this.addImagesToMessages(messages, options.images)
    }
    return messages
  }

  addImagesToMessages(messages, images) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage && lastMessage.role === 'user') {
      const content = [{ type: 'text', text: lastMessage.content }]
      images.forEach(img => {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: typeof img === 'string' ? img : img.data }
        })
      })
      lastMessage.content = content
    }
    return messages
  }

  processResponse(response) {
    const finishReason = mapFinishReason(response.stop_reason)
    return { content: response.content?.[0]?.text || '', usage: response.usage || null, finishReason }
  }

  parseStreamingLine(line) {
    if (!line.startsWith('data: ')) return null
    const data = line.slice(6).trim()
    if (data === '[DONE]') return { done: true }
    try { return JSON.parse(data) } catch { return null }
  }

  extractStreamingContent(parsed) {
    if (parsed.done) return { done: true }
    if (parsed.type === 'error') {
      const code = parsed.error?.type || 'anthropic_error'
      const e = new Error(parsed.error?.message || 'Anthropic streaming error')
      e.code = code
      if (parsed.request_id) e.requestId = parsed.request_id
      throw e
    }
    if (parsed.type === 'content_block_delta') {
      return { content: parsed.delta?.text || '', thinking: '', done: false, usage: null, finishReason: null }
    }
    if (parsed.type === 'message_delta') {
      return { content: '', thinking: '', done: false, usage: parsed.usage ? { tokens: parsed.usage.output_tokens || 0 } : null, finishReason: mapFinishReason(parsed.delta?.stop_reason) }
    }
    if (parsed.type === 'message_stop') {
      return { content: '', thinking: '', done: true, usage: null, finishReason: mapFinishReason(parsed.stop_reason) }
    }
    return null
  }

  getApiPath() { return '/v1/messages' }
  requiresAuth() { return !!this.config.apiKey }
  getAuthHeaderName() { return 'x-api-key' }
  getAuthHeaderValue() { return this.config.apiKey }
  buildHeaders() { const h = super.buildHeaders(); if (this.requiresAuth()) { h['anthropic-version'] = '2023-06-01'; h['anthropic-dangerous-direct-browser-access'] = 'true' } return h }
  getModelsEndpoint() { return `${this.config.baseUrl}/v1/models` }
  parseModelsResponse(data) { return data.data?.map(m => m.id) || [] }
}

function mapFinishReason(reason) {
  if (!reason) return null
  const r = String(reason).toLowerCase()
  if (r === 'max_tokens') return 'length'
  return r
}
