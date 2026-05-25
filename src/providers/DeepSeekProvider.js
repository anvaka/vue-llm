import { BaseProvider } from './BaseProvider.js'
import { convertMessagesToOpenAI } from './OpenAIProvider.js'

export class DeepSeekProvider extends BaseProvider {
  async detectCapabilities() {
    if (!this.config.model) return
    const id = this.config.model.toLowerCase()
    this.capabilities.add('tools')
    if (id.includes('reasoner') || id.includes('reasoning')) this.capabilities.add('thinking')
  }

  prepareRequest(messages, options) {
    const request = {
      model: options.model || this.config.model || 'deepseek-chat',
      messages: convertMessagesForDeepSeek(messages),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens || 1000,
      stream: options.stream || false
    }
    if (request.stream) request.stream_options = { include_usage: true }
    if (options.tools && this.capabilities.has('tools')) {
      request.tools = options.tools
      if (options.tool_choice) request.tool_choice = options.tool_choice
    }
    if (options.enableThinking && this.capabilities.has('thinking')) {
      // DeepSeek's reasoner model emits reasoning_content by default; the
      // explicit `thinking` toggle is accepted for forward compatibility.
      request.thinking = { type: 'enabled' }
    }
    return request
  }

  processResponse(response) {
    const msg = response.choices?.[0]?.message
    const result = {
      content: msg?.content || '',
      usage: normalizeDeepSeekUsage(response.usage),
      finishReason: mapFinishReason(response.choices?.[0]?.finish_reason)
    }
    if (msg?.reasoning_content) result.thinking = msg.reasoning_content
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
        thinking: delta.reasoning_content || '',
        done: false,
        usage: normalizeDeepSeekUsage(parsed.usage),
        finishReason: mapFinishReason(choice?.finish_reason),
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
      thinking: delta?.reasoning_content || '',
      done: false,
      usage: normalizeDeepSeekUsage(parsed.usage),
      finishReason: mapFinishReason(choice?.finish_reason)
    }
  }

  getApiPath() { return '/chat/completions' }
  requiresAuth() { return !!this.config.apiKey }
  getModelsEndpoint() { return `${this.config.baseUrl}/models` }
  parseModelsResponse(data) {
    return data.data?.filter(m => String(m.id).toLowerCase().includes('deepseek'))?.map(m => m.id)?.sort() || []
  }
}

function mapFinishReason(reason) {
  if (!reason) return null
  const r = String(reason).toLowerCase()
  if (r === 'length' || r === 'max_tokens') return 'length'
  return r
}

function parseArgs(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { __parseError: true, raw: text } }
}

// DeepSeek: prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
// (cached tokens are already included in prompt_tokens, OpenAI-style).
export function normalizeDeepSeekUsage(raw) {
  if (!raw) return null
  const inputTokens = raw.prompt_tokens ?? 0
  const outputTokens = raw.completion_tokens ?? 0
  const totalTokens = raw.total_tokens ?? (inputTokens + outputTokens)
  const out = { inputTokens, outputTokens, totalTokens, raw }
  if (raw.prompt_cache_hit_tokens != null) out.cachedInputTokens = raw.prompt_cache_hit_tokens
  return out
}

// DeepSeek's thinking-mode models require the prior assistant `reasoning_content`
// to be echoed back on subsequent requests, otherwise the API returns 400
// ("The `reasoning_content` in the thinking mode must be passed back to the
// API."). The codebase stores the captured reasoning on the assistant message
// as `thinking`; here we forward it as `reasoning_content` on the wire (and
// strip the in-memory `thinking` field so it doesn't leak as an unknown key)
// while reusing convertMessagesToOpenAI for tool-call reshaping.
function convertMessagesForDeepSeek(messages) {
  const baseConverted = convertMessagesToOpenAI(messages)
  return baseConverted.map((m, i) => {
    if (m.role !== 'assistant') return m
    const original = messages[i] || {}
    const reasoning = original.thinking || original.reasoning_content
    // Strip the in-memory `thinking` key if it slipped through (the OpenAI
    // converter returns the original object when there are no tool_calls).
    const { thinking, reasoning_content, ...clean } = m
    if (reasoning) clean.reasoning_content = reasoning
    return clean
  })
}
