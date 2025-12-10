import { BaseProvider } from './BaseProvider.js'

export class GrokProvider extends BaseProvider {
  async detectCapabilities() {
    if (!this.config.model) return
    const model = this.config.model.toLowerCase()
    if (model.includes('grok-2') || model.includes('vision')) this.capabilities.add('vision')
    this.capabilities.add('tools')
  }

  prepareRequest(messages, options) {
    const request = {
      model: options.model || this.config.model || 'grok-beta',
      messages: this.processMessages(messages, options),
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 1000,
      stream: options.stream || false
    }
    if (options.tools && this.capabilities.has('tools')) request.tools = options.tools
    return request
  }

  processMessages(messages, options) {
    if (options.images && this.capabilities.has('vision')) return this.addImagesToMessages(messages, options.images)
    return messages
  }

  addImagesToMessages(messages, images) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage && lastMessage.role === 'user') {
      const content = [{ type: 'text', text: lastMessage.content }]
      images.forEach(img => content.push({ type: 'image_url', image_url: { url: typeof img === 'string' ? img : img.url } }))
      lastMessage.content = content
    }
    return messages
  }

  processResponse(response) {
    return { content: response.choices?.[0]?.message?.content || '', usage: response.usage || null, finishReason: mapFinishReason(response.choices?.[0]?.finish_reason) }
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
    return { content: delta?.content || '', done: false, usage: parsed.usage || null, finishReason: mapFinishReason(parsed.choices?.[0]?.finish_reason) }
  }

  getApiPath() { return '/v1/chat/completions' }
  requiresAuth() { return !!this.config.apiKey }
  getModelsEndpoint() { return `${this.config.baseUrl}/v1/models` }
  parseModelsResponse(data) { return data.data?.filter(m => String(m.id).toLowerCase().includes('grok'))?.map(m => m.id)?.sort() || [] }
}

function mapFinishReason(reason) {
  if (!reason) return null
  const r = String(reason).toLowerCase()
  if (r === 'length' || r === 'max_tokens') return 'length'
  return r
}
