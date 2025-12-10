import { BaseProvider } from './BaseProvider.js'

export class CustomProvider extends BaseProvider {
  async detectCapabilities() { /* no assumptions */ }
  prepareRequest(messages, options) {
    return {
      model: options.model || this.config.model || 'gpt-3.5-turbo',
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 1000,
      stream: options.stream || false
    }
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
    return { content: parsed.choices?.[0]?.delta?.content || '', thinking: '', done: false, usage: parsed.usage || null, finishReason: mapFinishReason(parsed.choices?.[0]?.finish_reason) }
  }
  getApiPath() { return '/v1/chat/completions' }
  requiresAuth() { return !!this.config.apiKey }
  getModelsEndpoint() { return `${this.config.baseUrl}/v1/models` }
  parseModelsResponse(data) { return data.data?.map(m => m.id)?.sort() || [] }
}
function mapFinishReason(reason) { if (!reason) return null; const r = String(reason).toLowerCase(); if (r === 'max_tokens') return 'length'; return r }
