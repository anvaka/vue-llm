import { BaseProvider } from './BaseProvider.js'
import { convertMessagesToOpenAI, normalizeOpenAIUsage } from './OpenAIProvider.js'

export class LlamaServerProvider extends BaseProvider {
  async detectCapabilities() {
    // llama.cpp's server speaks OpenAI's chat-completions API; tool-call support
    // depends on the loaded model, so we advertise the capability and let the
    // caller opt in by passing tools.
    this.capabilities.add('tools')
  }
  prepareRequest(messages, options) {
    const request = {
      model: options.model || this.config.model || 'llama2',
      messages: convertMessagesToOpenAI(messages),
      max_tokens: options.maxTokens || 1000,
      stream: options.stream || false
    }
    this.applySamplingParams(request, options)
    if (request.stream) request.stream_options = { include_usage: true }
    if (options.tools && this.capabilities.has('tools')) {
      request.tools = options.tools
      if (options.tool_choice) request.tool_choice = options.tool_choice
    }
    return request
  }
  processResponse(response) {
    const msg = response.choices?.[0]?.message
    const result = {
      content: msg?.content || '',
      usage: normalizeOpenAIUsage(response.usage),
      finishReason: mapFinishReason(response.choices?.[0]?.finish_reason)
    }
    if (Array.isArray(msg?.tool_calls)) {
      result.toolCalls = msg.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name,
        args: parseArgs(tc.function?.arguments)
      }))
    }
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
    const choice = parsed.choices?.[0]
    const delta = choice?.delta
    if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      const tc = delta.tool_calls[0]
      return {
        content: delta.content || '',
        thinking: '',
        done: false,
        usage: normalizeOpenAIUsage(parsed.usage),
        finishReason: mapFinishReason(choice?.finish_reason),
        toolCallDelta: {
          index: tc.index ?? 0,
          id: tc.id || undefined,
          name: tc.function?.name || undefined,
          argsTextDelta: tc.function?.arguments || ''
        }
      }
    }
    return { content: delta?.content || '', thinking: '', done: false, usage: normalizeOpenAIUsage(parsed.usage), finishReason: mapFinishReason(choice?.finish_reason) }
  }
  getApiPath() { return '/v1/chat/completions' }
  requiresAuth() { return false }
  getModelsEndpoint() { return `${this.config.baseUrl}/v1/models` }
  parseModelsResponse(data) { return data.data?.filter(m => { const id = m.id.toLowerCase(); return id.includes('mistral') || id.includes('llama') || id.includes('codellama') || id.includes('.gguf') || id.includes('.bin') }).map(m => m.id).sort() || [] }
}
function mapFinishReason(reason) { if (!reason) return null; const r = String(reason).toLowerCase(); if (r === 'max_tokens') return 'length'; return r }
function parseArgs(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { __parseError: true, raw: text } }
}
