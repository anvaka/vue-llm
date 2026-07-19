import { BaseProvider } from './BaseProvider.js'
import { supportsReasoningEffort } from './reasoningPolicy.js'
import { normalizeImagePart, parseImageUrl, requireInlineImage } from './imageContent.js'
// The Claude-5 / Opus-4.7+ "no sampling params" rule now lives in the shared,
// provider-agnostic policy module (samplingPolicy.js), applied via
// BaseProvider.applySamplingParams so it covers every transport (OpenRouter,
// custom gateways) that may carry a Claude id — not just this native provider.

// Pre-3 Claude (claude-2.x, claude-instant) has neither tool use nor vision;
// every model since claude-3 has both. Matching the LEGACY set and defaulting
// open is the only form that survives a new family: the old allowlist named the
// families that existed when it was written ('claude-3', 'claude-sonnet',
// 'claude-opus', 'claude-haiku'), so claude-fable-5 matched nothing and silently
// came up with no tools and no vision — a false "this provider can't call tools"
// that surfaces as runAgentLoop refusing to start, with no hint that a NAME was
// the problem. An allowlist fails closed on everything not yet invented, which
// is exactly backwards for a list that must predict future releases.
// GeminiProvider already reached this conclusion ("so new releases don't
// silently lose capabilities"); this is the same rule for Claude.
//
// Substring match, so bare ids (claude-2.1), Bedrock ids (anthropic.claude-v2:1)
// and inference-profile prefixes (us.anthropic.claude-v2) are all covered. The
// \b keeps `claude-2` from matching a dated id that merely starts with 2.
const PRE_TOOL_CLAUDE = /claude-(instant|v?2)\b/

export class AnthropicProvider extends BaseProvider {
  async detectCapabilities() {
    // No model configured → prepareRequest falls back to claude-3-sonnet, which
    // has both; so the default-open answer is also the correct one here.
    if (PRE_TOOL_CLAUDE.test(this.config.model || '')) return
    this.capabilities.add('vision')
    this.capabilities.add('tools')
    // Claude models with a graded reasoning-effort control (Opus 4.6+, the
    // Claude-5 generation) run adaptive thinking; expose the capability so the
    // config UI offers the "Enable Thinking" toggle and the effort selector.
    // Older Claude (claude-3, Sonnet/Haiku 4.5) has no effort control and stays
    // thinking-less here.
    if (supportsReasoningEffort(this.config.model)) this.capabilities.add('thinking')
  }

  prepareRequest(messages, options) {
    const converted = convertMessagesToAnthropic(this.processMessages(messages, options), this.imageSourceMode())
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
    // Reasoning effort per the model's policy (only when thinking is on).
    this.applyReasoningParams(request, options)
    const systemMessage = messages.find(msg => msg.role === 'system')
    if (systemMessage) request.system = systemMessage.content
    if (options.tools && this.capabilities.has('tools')) {
      request.tools = convertToolsToAnthropic(options.tools)
      if (options.tool_choice) request.tool_choice = options.tool_choice
    }
    if (this.promptCachingEnabled(options)) applyPromptCaching(request, options)
    return request
  }

  // The Anthropic Messages API expresses reasoning effort as
  // `output_config.effort`, and it only bites when adaptive thinking is on —
  // so we enable `thinking: {type:'adaptive'}` alongside it. (Opus 4.7+ and the
  // Claude-5 generation removed the old `budget_tokens` knob; `output_config.effort`
  // is the current control, and it also caps overall token spend.) Bedrock Mantle
  // Claude inherits this via MantleClaudeProvider.
  //
  // `display: 'summarized'` is REQUIRED to get readable thinking text back:
  // Opus 4.7+ / Claude-5 default `thinking.display` to 'omitted', which returns
  // an empty thinking block with only an encrypted signature (Opus 4.6 defaulted
  // to 'summarized'). Without this, extended thinking is invisible even though it
  // runs and is billed. ('full' needs special Anthropic access; 'summarized' is
  // the generally-available readable mode.)
  applyReasoningParams(request, options = {}) {
    const level = this.reasoningEffortFor(request, options)
    if (!level) return request
    request.thinking = { type: 'adaptive', display: 'summarized' }
    request.output_config = { ...(request.output_config || {}), effort: level }
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

  // Which `image.source` types this transport accepts. The native API takes
  // base64, a remote URL, or a Files-API id; Claude routed through AWS or GCP
  // takes base64 ONLY — `url` and `file` sources are rejected there — so the
  // Bedrock subclasses override this to 'inline'.
  imageSourceMode() { return 'any' }

  // 5 MB per image, measured on the base64 string rather than the decoded file
  // — verified live: a 4.8 MB photo is rejected as
  // "image exceeds 5 MB maximum: 6755172 bytes > 5242880 bytes". Base64 inflates
  // by 4/3, so the effective FILE limit is ~3.75 MB. Inherited by Bedrock and
  // Mantle-Claude, which enforce the same cap.
  get maxImageBytes() { return 5 * 1024 * 1024 }

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
      // Extended-thinking text streams as `thinking_delta`; without this the
      // reasoning is silently dropped (signature_delta carries no text).
      if (parsed.delta?.type === 'thinking_delta') {
        return { content: '', thinking: parsed.delta?.thinking || '', done: false, usage: null, finishReason: null }
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
  // Bedrock (and newer Anthropic) report the thinking-token count here — a
  // subset of output_tokens. Surface it so callers can show reasoning usage
  // even when the reasoning text itself is redacted (Bedrock only returns an
  // encrypted signature block, never streamed thinking text).
  const reasoning = raw.output_tokens_details?.thinking_tokens
  if (reasoning != null) out.reasoningTokens = reasoning
  return out
}

// Canonical in-memory message shape (OpenAI-flavored):
//   { role: 'system' | 'user' | 'assistant' | 'tool',
//     content: string | Array<ContentPart>,
//     tool_calls?: [{ id, name, args }],   // on assistant
//     tool_call_id?: string }              // on tool
// where ContentPart is { type:'text', text } or
// { type:'image_url', image_url:{ url } } — see imageContent.js.
// Anthropic wants assistant tool_use blocks and tool_result inside user messages,
// and has no system role inside the messages array.
function convertMessagesToAnthropic(messages, imageSourceMode = 'any') {
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
    out.push({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(p => toAnthropicBlock(p, imageSourceMode)) : m.content
    })
  }
  return out
}

// Canonical content part -> Anthropic content block. Blocks that are already in
// Anthropic's own shape (tool_use, tool_result, a pre-built image block) pass
// through untouched, so a caller who hand-writes native blocks isn't punished.
function toAnthropicBlock(part, imageSourceMode) {
  if (part?.type === 'text') return { type: 'text', text: part.text ?? '' }
  if (part?.type !== 'image_url') return part
  const { url } = normalizeImagePart(part)
  const img = imageSourceMode === 'inline'
    ? requireInlineImage(url, 'Claude on Bedrock')
    : parseImageUrl(url)
  return img.kind === 'data'
    ? { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } }
    : { type: 'image', source: { type: 'url', url: img.url } }
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
