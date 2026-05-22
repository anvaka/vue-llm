import { BaseProvider } from './BaseProvider.js'

export class AnthropicProvider extends BaseProvider {
  async detectCapabilities() {
    if (this.config.model?.includes('claude-3') || this.config.model?.includes('claude-sonnet') || this.config.model?.includes('claude-opus') || this.config.model?.includes('claude-haiku')) {
      this.capabilities.add('vision')
      this.capabilities.add('tools')
    }
  }

  prepareRequest(messages, options) {
    const converted = convertMessagesToAnthropic(messages)
    const request = {
      model: options.model || this.config.model || 'claude-3-sonnet-20240229',
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature ?? 0.7,
      messages: converted,
      stream: options.stream || false
    }
    const systemMessage = messages.find(msg => msg.role === 'system')
    if (systemMessage) request.system = systemMessage.content
    if (options.tools && this.capabilities.has('tools')) {
      request.tools = convertToolsToAnthropic(options.tools)
      if (options.tool_choice) request.tool_choice = options.tool_choice
    }
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
    const blocks = response.content || []
    const textBlock = blocks.find(b => b.type === 'text')
    const toolUses = blocks.filter(b => b.type === 'tool_use')
    const toolCalls = toolUses.map(b => ({ id: b.id, name: b.name, args: b.input || {} }))
    return {
      content: textBlock?.text || '',
      usage: response.usage || null,
      finishReason,
      toolCalls
    }
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
    if (parsed.type === 'content_block_start') {
      const cb = parsed.content_block
      if (cb?.type === 'tool_use') {
        return {
          content: '',
          done: false,
          toolCallDelta: { index: parsed.index, id: cb.id, name: cb.name, argsTextDelta: '' }
        }
      }
      return null
    }
    if (parsed.type === 'content_block_delta') {
      if (parsed.delta?.type === 'text_delta') {
        return { content: parsed.delta?.text || '', thinking: '', done: false, usage: null, finishReason: null }
      }
      if (parsed.delta?.type === 'input_json_delta') {
        return {
          content: '',
          done: false,
          toolCallDelta: { index: parsed.index, argsTextDelta: parsed.delta?.partial_json || '' }
        }
      }
      return null
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

// Canonical in-memory message shape (OpenAI-flavored):
//   { role: 'system' | 'user' | 'assistant' | 'tool',
//     content: string,
//     tool_calls?: [{ id, name, args }],   // on assistant
//     tool_call_id?: string }              // on tool
// Anthropic wants assistant tool_use blocks and tool_result inside user messages,
// and has no system role inside the messages array.
function convertMessagesToAnthropic(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args || {}
        })
      }
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: String(m.content ?? '')
        }]
      })
      continue
    }
    out.push({ role: m.role, content: m.content })
  }
  return out
}

function convertToolsToAnthropic(tools) {
  return tools.map(t => {
    if (t.type === 'function' && t.function) {
      return {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} }
      }
    }
    return t
  })
}
