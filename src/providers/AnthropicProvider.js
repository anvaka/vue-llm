import { BaseProvider } from './BaseProvider.js'
// The Claude-5 / Opus-4.7+ "no sampling params" rule now lives in the shared,
// provider-agnostic policy module (samplingPolicy.js), applied via
// BaseProvider.applySamplingParams so it covers every transport (OpenRouter,
// custom gateways) that may carry a Claude id — not just this native provider.

export class AnthropicProvider extends BaseProvider {
  async detectCapabilities() {
    if (this.config.model?.includes('claude-3') || this.config.model?.includes('claude-sonnet') || this.config.model?.includes('claude-opus') || this.config.model?.includes('claude-haiku')) {
      this.capabilities.add('vision')
      this.capabilities.add('tools')
    }
  }

  prepareRequest(messages, options) {
    const converted = convertMessagesToAnthropic(messages)
    const model = options.model || this.config.model || 'claude-3-sonnet-20240229'
    const request = {
      model,
      max_tokens: options.maxTokens || 1000,
      messages: converted,
      stream: options.stream || false
    }
    // Temperature per the model's sampling policy: Opus 4.7+ / the Claude-5
    // generation dropped sampling params and 400 if sent — applySamplingParams
    // omits the field for those and passes it through otherwise.
    this.applySamplingParams(request, options)
    const systemMessage = messages.find(msg => msg.role === 'system')
    if (systemMessage) request.system = systemMessage.content
    if (options.tools && this.capabilities.has('tools')) {
      request.tools = convertToolsToAnthropic(options.tools)
      if (options.tool_choice) request.tool_choice = options.tool_choice
    }
    if (this.promptCachingEnabled(options)) applyPromptCaching(request, options)
    return request
  }

  // Prompt caching is on by default for the Claude/Anthropic-family path
  // (Bedrock inherits this method) because it's strictly cheaper and degrades
  // gracefully — a prefix under the model's minimum cacheable length is simply
  // not cached, with no error. Disable per-call with options.promptCache:false
  // or per-config with config.promptCache:false.
  promptCachingEnabled(options) {
    return options?.promptCache !== false && this.config?.promptCache !== false
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
      usage: normalizeAnthropicUsage(response.usage),
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
    if (parsed.type === 'message_start') {
      // Anthropic reports input + cache tokens once at message_start; output
      // tokens are streamed via message_delta. Forward usage so BaseProvider's
      // fullUsage accumulator can merge them.
      return { content: '', thinking: '', done: false, usage: normalizeAnthropicUsage(parsed.message?.usage), finishReason: null }
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
      return { content: '', thinking: '', done: false, usage: normalizeAnthropicUsage(parsed.usage), finishReason: mapFinishReason(parsed.delta?.stop_reason) }
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

// Anthropic's `input_tokens` is uncached-only — cache hits/writes are reported
// separately. The canonical `inputTokens` represents the full prompt count, so
// we add cache tokens back in. message_start carries input + cache; message_delta
// only refreshes output_tokens (and may omit input fields entirely).
export function normalizeAnthropicUsage(raw) {
  if (!raw) return null
  const uncached = raw.input_tokens ?? 0
  const cacheRead = raw.cache_read_input_tokens ?? 0
  const cacheCreate = raw.cache_creation_input_tokens ?? 0
  const hasInputFields = raw.input_tokens != null || raw.cache_read_input_tokens != null || raw.cache_creation_input_tokens != null
  const inputTokens = hasInputFields ? uncached + cacheRead + cacheCreate : 0
  const outputTokens = raw.output_tokens ?? 0
  const out = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, raw }
  if (raw.cache_read_input_tokens != null) out.cachedInputTokens = cacheRead
  if (raw.cache_creation_input_tokens != null) out.cacheCreationInputTokens = cacheCreate
  return out
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

const EPHEMERAL_CACHE = { type: 'ephemeral' }

// Tag the largest STABLE prefixes of an Anthropic request so repeated calls
// (every iteration of a tool-use agent loop, and subsequent runs within the
// ~5-minute TTL) read them from cache instead of re-billing full input price.
// Anthropic's cache prefix order is tools → system → messages, so:
//   1. A breakpoint at the end of `system` caches [tools + system] together.
//      When there's no system message, fall back to the last tool definition.
//      This is applied to EVERY Claude request — the prefix recurs identically.
//   2. A rolling breakpoint on the last block of the final message caches the
//      growing transcript: each request caches its whole conversation, and the
//      next iteration reads that back as a prefix (incremental conversation
//      caching). This only pays off when the conversation is re-sent across
//      turns, so it's gated behind options.cacheTranscript (set by the agent
//      loop). A single completion would just eat the 1.25x write premium.
// We spend at most 2 of the 4 available breakpoints. Mutates `request` (its
// system/messages/tools are freshly built by the converters above, so the
// caller's original messages are never touched).
function applyPromptCaching(request, options) {
  if (request.system) {
    request.system = systemToCachedBlocks(request.system)
  } else if (Array.isArray(request.tools) && request.tools.length) {
    const last = request.tools.length - 1
    request.tools[last] = { ...request.tools[last], cache_control: EPHEMERAL_CACHE }
  }
  if (options?.cacheTranscript) {
    const msgs = request.messages
    if (Array.isArray(msgs) && msgs.length) {
      const last = msgs[msgs.length - 1]
      last.content = tagLastBlock(last.content)
    }
  }
  return request
}

// `system` may be a plain string or an array of content blocks; cache_control
// can only ride on a block, so normalize to blocks and tag the last one.
function systemToCachedBlocks(system) {
  let blocks
  if (typeof system === 'string') {
    blocks = [{ type: 'text', text: system }]
  } else if (Array.isArray(system) && system.length) {
    blocks = system.map(b => (typeof b === 'string' ? { type: 'text', text: b } : { ...b }))
  } else {
    return system
  }
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL_CACHE }
  return blocks
}

// Attach cache_control to the final content block of a message. Message content
// can be a string (wrap it) or an array of blocks (text / tool_use /
// tool_result — all accept cache_control).
function tagLastBlock(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: EPHEMERAL_CACHE }]
  }
  if (Array.isArray(content) && content.length) {
    const copy = content.slice()
    const lastIdx = copy.length - 1
    const block = copy[lastIdx]
    copy[lastIdx] = typeof block === 'string'
      ? { type: 'text', text: block, cache_control: EPHEMERAL_CACHE }
      : { ...block, cache_control: EPHEMERAL_CACHE }
    return copy
  }
  return content
}
