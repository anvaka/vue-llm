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
      options: { temperature: options.temperature ?? 0.7, num_predict: options.maxTokens || 1000 }
    }
    if (options.enableThinking && this.capabilities.has('thinking')) {
      request.options.enable_thinking = true
    }
    if (options.tools && this.capabilities.has('tools')) {
      // Ollama accepts OpenAI-style tool definitions verbatim.
      request.tools = options.tools
    }
    return request
  }

  processMessages(messages, options) {
    const converted = convertMessagesToOllama(messages)
    if (options.images && this.capabilities.has('vision')) return this.addImagesToMessages(converted, options.images)
    return converted
  }

  addImagesToMessages(messages, images) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage && lastMessage.role === 'user') {
      lastMessage.images = images.map(img => typeof img === 'string' ? (img.startsWith('data:') ? img.split(',')[1] : img) : img)
    }
    return messages
  }

  processResponse(response) {
    const result = {
      content: response.message?.content || '',
      usage: normalizeOllamaUsage(response),
      finishReason: mapFinishReason(response.finish_reason)
    }
    if (response.thinking) result.thinking = response.thinking
    const calls = response.message?.tool_calls
    if (Array.isArray(calls) && calls.length) {
      result.toolCalls = calls.map((tc, i) => ({
        id: synthId(i),
        name: tc.function?.name,
        args: normalizeArgs(tc.function?.arguments)
      }))
    }
    return result
  }

  parseStreamingLine(line) {
    try { return JSON.parse(line) } catch { return null }
  }

  extractStreamingContent(parsed) {
    const out = {
      content: parsed.message?.content || '',
      thinking: parsed.thinking || parsed.message?.thinking || '',
      done: parsed.done || false,
      usage: normalizeOllamaUsage(parsed),
      finishReason: mapFinishReason(parsed.finish_reason)
    }
    const calls = parsed.message?.tool_calls
    if (Array.isArray(calls) && calls.length) {
      // Ollama delivers tool_calls fully formed in one chunk (usually the final
      // one). Emit each as a synthetic delta so BaseProvider's accumulator can
      // produce the canonical toolCalls array. JSON-stringify the object args
      // because the accumulator parses argsText back into an object.
      out.toolCallDeltas = calls.map((tc, i) => ({
        index: i,
        id: synthId(i),
        name: tc.function?.name || '',
        argsTextDelta: JSON.stringify(tc.function?.arguments ?? {})
      }))
    }
    return out
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

function synthId(i) { return `ollama_call_${i}` }

// Ollama returns prompt_eval_count / eval_count at the top level of the
// response (and in the final streaming chunk). Cache concepts don't apply
// for local inference. Skip if neither field is present so intermediate
// streaming chunks don't emit empty usage.
export function normalizeOllamaUsage(raw) {
  if (!raw) return null
  if (raw.prompt_eval_count == null && raw.eval_count == null) return null
  const inputTokens = raw.prompt_eval_count ?? 0
  const outputTokens = raw.eval_count ?? 0
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, raw }
}

function normalizeArgs(args) {
  if (args == null) return {}
  if (typeof args === 'string') {
    try { return JSON.parse(args) } catch { return { __parseError: true, raw: args } }
  }
  return args
}

// Reshape canonical in-memory messages into Ollama's wire format. The codebase
// stores assistant tool calls as `{tool_calls: [{id, name, args}]}` and tool
// results in OpenAI wire form `{role:'tool', tool_call_id, content}`. Ollama
// wants `{function:{name, arguments:<object>}}` (no id, no type wrapper) and
// `{role:'tool', content}` with no tool_call_id. Match is positional.
export function convertMessagesToOllama(messages) {
  return messages.map(m => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls.map(tc => ({
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? safeParse(tc.args) : (tc.args || {})
          }
        }))
      }
    }
    if (m.role === 'tool') {
      const { tool_call_id, ...rest } = m
      return rest
    }
    return m
  })
}

function safeParse(text) {
  try { return JSON.parse(text) } catch { return {} }
}
