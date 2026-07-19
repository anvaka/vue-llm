import { BaseProvider } from './BaseProvider.js'
import { convertMessagesToOpenAI, normalizeOpenAIUsage } from './OpenAIProvider.js'
import { supportsReasoningEffort } from './reasoningPolicy.js'

export class OpenRouterProvider extends BaseProvider {
  async detectCapabilities() {
    if (!this.config.model) return
    this.capabilities.add('tools')
    // The name-substring heuristics (o1/thinking/reasoning) miss proxied Claude
    // and gpt-5 ids; supportsReasoningEffort recognizes those model families so
    // their effort control is actually offered and sent.
    if (this.config.model.includes('o1') || this.config.model.includes('thinking') || this.config.model.includes('reasoning') || supportsReasoningEffort(this.config.model)) this.capabilities.add('thinking')
    if (this.config.model.includes('vision') || this.config.model.includes('gpt-4') || this.config.model.includes('claude') || this.config.model.includes('gemini')) this.capabilities.add('vision')
  }
  prepareRequest(messages, options) {
    const request = {
      model: options.model || this.config.model,
      messages: this.processMessages(messages, options),
      max_tokens: options.maxTokens || 1000,
      stream: options.stream || false
    }
    this.applySamplingParams(request, options)
    if (request.stream) request.stream_options = { include_usage: true }
    if (options.enableThinking && this.capabilities.has('thinking')) {
      // OpenRouter's unified reasoning param is an object: `enabled` turns it on,
      // `effort` (added by applyReasoningParams below, clamped to the underlying
      // model's range) sets the depth. A model with no known effort control just
      // keeps `{ enabled: true }` with no effort field.
      request.reasoning = { enabled: options.reasoning !== false }
      this.applyReasoningParams(request, options)
    }
    if (options.tools && this.capabilities.has('tools')) {
      request.tools = options.tools
      if (options.tool_choice) request.tool_choice = options.tool_choice
    }
    return request
  }
  // OpenRouter nests effort inside the `reasoning` object rather than the
  // top-level `reasoning_effort` field, so override the BaseProvider default.
  applyReasoningParams(request, options = {}) {
    const level = this.reasoningEffortFor(request, options)
    if (!level) return request
    const reasoning = (request.reasoning && typeof request.reasoning === 'object') ? request.reasoning : {}
    request.reasoning = { ...reasoning, effort: level }
    return request
  }

  processMessages(messages, options) {
    const converted = convertMessagesToOpenAI(messages)
    if (options.images && this.capabilities.has('vision')) return this.addImagesToMessages(converted, options.images)
    return converted
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
    const msg = response.choices?.[0]?.message
    const result = { content: msg?.content || '', usage: normalizeOpenAIUsage(response.usage), finishReason: mapFinishReason(response.choices?.[0]?.finish_reason) }
    if (msg?.reasoning) result.thinking = msg.reasoning
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
        thinking: delta.reasoning || '',
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
    return { content: delta?.content || '', thinking: delta?.reasoning || '', done: false, usage: normalizeOpenAIUsage(parsed.usage), finishReason: mapFinishReason(choice?.finish_reason) }
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

function parseArgs(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { __parseError: true, raw: text } }
}
