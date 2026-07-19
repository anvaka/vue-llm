// OpenAI provider implementation (extracted)
import { BaseProvider } from './BaseProvider.js'
import { isOpenAIReasoningModel } from './samplingPolicy.js'
import { supportsVision } from './visionPolicy.js'

export class OpenAIProvider extends BaseProvider {
  async detectCapabilities() {
    if (!this.config.model) return
    const id = this.config.model.toLowerCase()
    if (isOpenAIReasoningModel(id)) {
      this.capabilities.add('thinking')
    }
    if (supportsVision(id)) {
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
      messages: convertMessagesToOpenAI(this.processMessages(messages, options)),
      stream: options.stream || false
    }
    // OpenAI omits the usage block from streamed responses unless this flag
    // is set, so cost reporting silently breaks on .stream() without it.
    if (request.stream) request.stream_options = { include_usage: true }

    if (this.#requiresMaxCompletionTokens(model)) {
      request.max_completion_tokens = options.maxTokens || 1000
    } else {
      request.max_tokens = options.maxTokens || 1000
    }
    // Temperature per the model's sampling policy (reasoning models -> fixed 1).
    this.applySamplingParams(request, options)

    // Reasoning effort (`reasoning_effort`) per the model's policy — only when
    // thinking is on, and only for models that expose a graded effort control.
    this.applyReasoningParams(request, options)

    if (options.tools && this.capabilities.has('tools')) {
      request.tools = options.tools
    }
    return request
  }

  #requiresMaxCompletionTokens(modelId) {
    const id = (modelId || '').toLowerCase()
    // Broader than the temperature predicate on purpose: the whole gpt-5 family
    // (incl. the conversational gpt-5-chat, which isOpenAIReasoningModel excludes)
    // uses max_completion_tokens, and any model we detected as a thinking model
    // does too.
    return isOpenAIReasoningModel(id) || id.includes('gpt-5') || this.capabilities.has('thinking')
  }

  processResponse(response) {
    const msg = response.choices?.[0]?.message
    const result = {
      content: msg?.content || '',
      usage: normalizeOpenAIUsage(response.usage),
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
        usage: normalizeOpenAIUsage(parsed.usage),
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
      usage: normalizeOpenAIUsage(parsed.usage),
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

// OpenAI's usage object: prompt_tokens (includes cached), completion_tokens
// (includes reasoning), total_tokens, plus the breakdown sub-objects
// prompt_tokens_details.cached_tokens and completion_tokens_details.reasoning_tokens.
// Map to the library's canonical shape.
export function normalizeOpenAIUsage(raw) {
  if (!raw) return null
  const inputTokens = raw.prompt_tokens ?? 0
  const outputTokens = raw.completion_tokens ?? 0
  const totalTokens = raw.total_tokens ?? (inputTokens + outputTokens)
  const cached = raw.prompt_tokens_details?.cached_tokens
  const reasoning = raw.completion_tokens_details?.reasoning_tokens
  const out = { inputTokens, outputTokens, totalTokens, raw }
  if (cached != null) out.cachedInputTokens = cached
  if (reasoning != null) out.reasoningTokens = reasoning
  return out
}

// Canonical in-memory messages use { tool_calls: [{id, name, args}] } on the
// assistant message. OpenAI's wire format wants { tool_calls: [{id, type, function:{name, arguments:string}}] }.
// Tool messages are already in wire format.
//
// Multimodal content needs no conversion here at all: the canonical part array
// (imageContent.js) IS the OpenAI Chat Completions spelling, data URLs included.
// The same is true for Grok, OpenRouter, llama.cpp and the Custom provider,
// which all reuse this converter.
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
