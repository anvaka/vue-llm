// OpenAI provider implementation (extracted)
import { BaseProvider } from './BaseProvider.js'

export class OpenAIProvider extends BaseProvider {
  async detectCapabilities() {
    if (!this.config.model) return
    const id = this.config.model.toLowerCase()
    if (id.startsWith('o1') || id.startsWith('o2') || id.startsWith('o3') || id.startsWith('o-') || id.includes('gpt-5') || id === 'gpt5') {
      this.capabilities.add('thinking')
    }
    if (id.includes('gpt-4') && id.includes('vision')) {
      this.capabilities.add('vision')
    }
    if (id.includes('gpt-4') || id.includes('gpt-3.5') || id.includes('gpt-5')) {
      this.capabilities.add('tools')
    }
  }

  prepareRequest(messages, options) {
    const model = options.model || this.config.model || 'gpt-3.5-turbo'
    const request = {
      model,
      messages: this.processMessages(messages, options),
      temperature: options.temperature ?? 0.7,
      stream: options.stream || false
    }

    if (this.#requiresMaxCompletionTokens(model)) {
      request.max_completion_tokens = options.maxTokens || 1000
      // Reasoning models require fixed/default temperature
      request.temperature = 1
    } else {
      request.max_tokens = options.maxTokens || 1000
    }

    if (options.enableThinking && this.capabilities.has('thinking')) {
      request.reasoning_effort = options.reasoningEffort || 'medium'
    }

    if (options.tools && this.capabilities.has('tools')) {
      request.tools = options.tools
    }
    return request
  }

  #requiresMaxCompletionTokens(modelId) {
    const id = (modelId || '').toLowerCase()
    return (
      id.startsWith('o1') || id.startsWith('o2') || id.startsWith('o3') || id.startsWith('o-') ||
      id.includes('gpt-5') || id === 'gpt5' || id.includes('reasoning') ||
      this.capabilities.has('thinking')
    )
  }

  processMessages(messages, options) {
    const converted = convertMessagesToOpenAI(messages)
    if (options.images && this.capabilities.has('vision')) {
      return this.addImagesToMessages(converted, options.images)
    }
    return converted
  }

  addImagesToMessages(messages, images) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage && lastMessage.role === 'user') {
      const content = [ { type: 'text', text: lastMessage.content } ]
      images.forEach(img => {
        content.push({
          type: 'image_url',
          image_url: { url: typeof img === 'string' ? img : img.url }
        })
      })
      lastMessage.content = content
    }
    return messages
  }

  processResponse(response) {
    const msg = response.choices?.[0]?.message
    const result = {
      content: msg?.content || '',
      usage: response.usage || null,
      finishReason: response.choices?.[0]?.finish_reason || null
    }
    if (response.reasoning) {
      result.thinking = response.reasoning
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
      // OpenAI streams tool_calls as an array of partial fragments per chunk.
      // Each fragment has `index` and may include id / function.name / function.arguments
      // (the arguments are a streaming JSON-text string). We only handle the
      // first fragment per chunk here — multi-fragment chunks would need an
      // outer loop, but in practice each delta carries one tool call slot.
      const tc = delta.tool_calls[0]
      return {
        content: delta.content || '',
        thinking: delta.reasoning || '',
        done: false,
        usage: parsed.usage || null,
        finishReason: choice?.finish_reason || null,
        toolCallDelta: {
          index: tc.index ?? 0,
          id: tc.id || undefined,
          name: tc.function?.name || undefined,
          argsTextDelta: tc.function?.arguments || ''
        }
      }
    }
    return {
      content: delta?.content || '',
      thinking: delta?.reasoning || '',
      done: false,
      usage: parsed.usage || null,
      finishReason: choice?.finish_reason || null
    }
  }

  getApiPath() { return '/v1/chat/completions' }
  requiresAuth() { return !!this.config.apiKey }
  getModelsEndpoint() { return `${this.config.baseUrl}/v1/models` }
  parseModelsResponse(data) {
    return data.data?.filter(m => {
      const id = m.id.toLowerCase()
      return id.includes('gpt') || id.includes('chat')
    }).map(m => m.id).sort() || []
  }
}

function parseArgs(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { __parseError: true, raw: text } }
}

// Canonical in-memory messages use { tool_calls: [{id, name, args}] } on the
// assistant message. OpenAI's wire format wants { tool_calls: [{id, type, function:{name, arguments:string}}] }.
// Tool messages are already in wire format.
export function convertMessagesToOpenAI(messages) {
  return messages.map(m => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {})
          }
        }))
      }
    }
    return m
  })
}
