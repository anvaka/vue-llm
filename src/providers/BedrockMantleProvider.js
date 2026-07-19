import { BaseProvider } from './BaseProvider.js'
import { OpenAIProvider } from './OpenAIProvider.js'
import { AnthropicProvider } from './AnthropicProvider.js'
import { normalizeImagePart } from './imageContent.js'

// Offline fallback for discovery failures. The live /v1/models call returns the
// full catalog; this is only used when that call can't be made.
export const BEDROCK_MANTLE_CLAUDE_MODELS = [
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-7',
  'anthropic.claude-sonnet-5',
  'anthropic.claude-fable-5',
  'anthropic.claude-haiku-4-5'
]

// On Mantle each model accepts exactly one API family, and /v1/models does NOT
// advertise which — verified live:
//   Claude               -> /anthropic/v1/messages   (only)
//   gpt-5.x / codex       -> /openai/v1/responses      (Responses only)
//   gpt-oss & most others -> /v1/chat/completions      (some also /v1/responses)
// So the router picks a candidate order per model and falls back on the
// "does not support the '<path>' API" 400.
export function isMantleClaudeModel(model) {
  return typeof model === 'string' && model.includes('anthropic.claude')
}
function isFrontierOpenAIModel(model) {
  return typeof model === 'string' && (/openai\.gpt-5/.test(model) || /codex/.test(model))
}
function isUnsupportedApiError(e) {
  return /does not support the '[^']*' API/i.test(e?.message || '')
}
// Turn account-entitlement failures into an actionable message.
function friendlyError(e) {
  const msg = e?.message || ''
  if (/not available for this account|Berm is not enabled|access_denied|permission_(error|denied)/i.test(msg)) {
    const fe = new Error(`This model isn't enabled for your AWS account — request access in the Amazon Bedrock console, then try again. (${msg})`)
    fe.cause = e
    return fe
  }
  return e
}

// ---- Claude: Anthropic Messages API (keeps caching/tools/vision/SSE) --------
class MantleClaudeProvider extends AnthropicProvider {
  getApiPath() { return '/anthropic/v1/messages' }
  // Claude routed through AWS accepts base64 image sources ONLY — the native
  // API's `url` and `file` sources are rejected here. (The 5 MB per-image cap is
  // measured on the base64 string, so the effective file limit is ~3.75 MB.)
  imageSourceMode() { return 'inline' }
  buildHeaders() {
    const h = super.buildHeaders()
    delete h['anthropic-dangerous-direct-browser-access'] // Mantle allows all origins
    return h
  }
}

// ---- Most models: OpenAI Chat Completions -----------------------------------
class MantleChatProvider extends OpenAIProvider {
  // /v1/chat/completions + Bearer + /v1/models are inherited. Only discovery
  // differs: list EVERY available model so the single dropdown offers the whole
  // catalog (the router, not this class, decides each model's transport).
  async detectCapabilities() {
    await super.detectCapabilities()
    // Mantle's chat surface supports function calling across the whole catalog
    // (verified live: gpt-oss/qwen/mistral all return tool_calls), but their ids
    // (openai.gpt-oss, qwen.*, mistral.*) don't match OpenAIProvider's gpt-4/5
    // heuristic, so declare it here. OpenAIProvider already handles the wire format.
    this.capabilities.add('tools')
    // Same reasoning for images: the Mantle catalog spans Nova, Gemma and Qwen
    // ids that no OpenAI-shaped policy would recognize. This surface takes an
    // `image_url` holding a base64 data: URL (or an s3:// URI) — arbitrary
    // public https image URLs are NOT supported here.
    this.capabilities.add('vision')
  }
  parseModelsResponse(data) {
    return (data?.data || [])
      .filter(m => m && typeof m.id === 'string' && (m.status == null || m.status === 'available'))
      .map(m => m.id)
      .sort()
  }
}

// ---- Frontier / responses-only models: OpenAI Responses API -----------------
const RESPONSES_MIN_OUTPUT_TOKENS = 16

// Same request/response/stream shape on both /v1/responses (gpt-oss et al.) and
// /openai/v1/responses (gpt-5.x); only the path differs, so it's a ctor arg.
class MantleResponsesProvider extends BaseProvider {
  constructor(config, apiPath) {
    super(config)
    this._apiPath = apiPath || '/v1/responses'
  }
  getApiPath() { return this._apiPath }
  requiresAuth() { return !!this.config.apiKey } // Bearer (BaseProvider default)

  async detectCapabilities() {
    const id = (this.config.model || '').toLowerCase()
    // The Responses API supports function calling for the whole Mantle catalog
    // (verified live on /v1/responses and /openai/v1/responses).
    this.capabilities.add('tools')
    // The Responses API carries images as `input_image` parts; as on the chat
    // surface, the catalog is too broad for an id-keyed guess to help.
    this.capabilities.add('vision')
    if (id.includes('gpt-5') || id.includes('codex') || /(^|\.)o[13]/.test(id)) {
      this.capabilities.add('thinking')
    }
  }

  prepareRequest(messages, options) {
    const model = options.model || this.config.model
    const req = {
      model,
      input: messagesToResponsesInput(this.processMessages(messages, options)),
      // The Responses API rejects max_output_tokens < 16 (Chat Completions and
      // Messages accept less), so clamp — e.g. testConnection sends 10.
      max_output_tokens: Math.max(RESPONSES_MIN_OUTPUT_TOKENS, options.maxTokens || 1000),
      stream: options.stream || false
    }
    // Responses uses a flattened tool shape ({type,name,description,parameters}),
    // unlike Chat Completions' nested {type,function:{...}}. Convert if present.
    const tools = toolsToResponsesFormat(options.tools)
    if (tools) req.tools = tools
    // Reasoning models on this path reject a custom temperature, so we omit it.
    // Reasoning effort per the model's policy (only when thinking is on).
    this.applyReasoningParams(req, options)
    return req
  }

  // The Responses API expresses effort as a nested `reasoning: { effort }`
  // object (unlike Chat Completions' top-level `reasoning_effort`), so override
  // the BaseProvider default.
  applyReasoningParams(request, options = {}) {
    const level = this.reasoningEffortFor(request, options)
    if (level) request.reasoning = { ...(request.reasoning || {}), effort: level }
    return request
  }

  processResponse(response) {
    let content = '', thinking = ''
    const toolCalls = []
    for (const item of (response.output || [])) {
      if (item.type === 'message') {
        for (const c of (item.content || [])) if (c.type === 'output_text') content += c.text || ''
      } else if (item.type === 'reasoning') {
        for (const c of (item.content || [])) if (c.type === 'reasoning_text') thinking += c.text || ''
      } else if (item.type === 'function_call') {
        toolCalls.push({ id: item.call_id || item.id, name: item.name, args: safeParse(item.arguments) })
      }
    }
    const out = {
      content,
      usage: normalizeResponsesUsage(response.usage),
      finishReason: mapResponsesStatus(response.status)
    }
    if (thinking) out.thinking = thinking
    if (toolCalls.length) out.toolCalls = toolCalls
    return out
  }

  // Responses streams plain `data: {json}` SSE (no [DONE]); events carry a
  // `type`. AnthropicProvider/OpenAIProvider use the same `data: ` line format.
  parseStreamingLine(line) {
    if (!line.startsWith('data: ')) return null
    const data = line.slice(6).trim()
    if (data === '[DONE]') return { done: true }
    try { return JSON.parse(data) } catch { return null }
  }

  extractStreamingContent(parsed) {
    if (parsed.done) return { done: true }
    switch (parsed.type) {
      case 'response.output_text.delta':
        return { content: parsed.delta || '', done: false }
      case 'response.reasoning_text.delta':
        return { thinking: parsed.delta || '', done: false }
      // A function_call item opens with output_item.added (carrying the call_id
      // and name), then streams its JSON arguments as function_call_arguments.delta
      // fragments. We seed id/name on `added` and stitch arg text on each delta;
      // BaseProvider's accumulator keys them by output_index and parses at done.
      case 'response.output_item.added': {
        const it = parsed.item
        if (it && it.type === 'function_call') {
          return { content: '', done: false, toolCallDelta: { index: parsed.output_index ?? 0, id: it.call_id, name: it.name, argsTextDelta: '' } }
        }
        return null
      }
      case 'response.function_call_arguments.delta':
        return { content: '', done: false, toolCallDelta: { index: parsed.output_index ?? 0, argsTextDelta: parsed.delta || '' } }
      case 'response.completed':
        return { done: true, usage: normalizeResponsesUsage(parsed.response?.usage), finishReason: mapResponsesStatus(parsed.response?.status) }
      case 'response.incomplete':
      case 'response.failed':
        return { done: true, usage: normalizeResponsesUsage(parsed.response?.usage), finishReason: mapResponsesStatus(parsed.response?.status) }
      default:
        return null
    }
  }
}

// ---- Router: one AWS provider, one model list, per-model transport ----------
export class BedrockMantleProvider extends BaseProvider {
  constructor(config) {
    super(config)
    this._claude = new MantleClaudeProvider(config)
    this._chat = new MantleChatProvider(config)
    this._responses = new MantleResponsesProvider(config, '/v1/responses')
    this._openaiResponses = new MantleResponsesProvider(config, '/openai/v1/responses')
    this._resolved = new Map() // model -> winning sub (learned via fallback)
  }

  _subs() { return [this._claude, this._chat, this._responses, this._openaiResponses] }

  // Ordered candidate transports for a model; first that isn't rejected with
  // "does not support" wins and is cached.
  _order(model) {
    const m = model || this.config.model || ''
    if (isMantleClaudeModel(m)) return [this._claude]
    const cached = this._resolved.get(m)
    if (cached) return [cached]
    if (isFrontierOpenAIModel(m)) return [this._openaiResponses, this._responses, this._chat]
    return [this._chat, this._responses, this._openaiResponses]
  }

  _active() { return this._order(this.config.model)[0] }

  // Detect on EVERY sub, not just the active one. _active() is not stable: the
  // first successful request caches its winning transport in _resolved, which
  // re-points _order() — and so _active() — at a sub that initialize() never
  // touched. Its capability set would still be the empty one from the ctor, so
  // hasCapability('tools') would answer false for a model that had just
  // finished calling tools, and the NEXT agent turn would refuse to start.
  // These detectCapabilities are pure id matching with no network, so covering
  // all four transports costs nothing.
  async initialize() {
    await Promise.all(this._subs().map(s => s.initialize()))
    this.capabilities = this._active().capabilities // share the active sub's set
  }
  async detectCapabilities() {
    await Promise.all(this._subs().map(s => s.detectCapabilities()))
    this.capabilities = this._active().capabilities
  }
  hasCapability(cap) { return this._active().hasCapability(cap) }

  // Defer real preparation to makeRequest/streamRequest so we can fall back
  // across API surfaces (a model's supported API isn't advertised anywhere).
  prepareRequest(messages, options) {
    return { __mantle: { messages, options } }
  }

  async makeRequest(request, signal, requestId) {
    if (request && request.__mantle) {
      const { messages, options } = request.__mantle
      return this._runWithFallback(sub => sub.makeRequest(sub.prepareRequest(messages, options), signal, requestId), options?.model)
    }
    // Already-prepared request of unknown origin: route by shape, no fallback.
    return this._subForShape(request).makeRequest(request, signal, requestId)
  }

  async streamRequest(messages, options, onChunk) {
    // "does not support" is a 400 at the initial fetch — before any chunk — so
    // falling back to another transport never double-emits.
    return this._runWithFallback(sub => sub.streamRequest(messages, options, onChunk), options?.model)
  }

  async _runWithFallback(attempt, model) {
    const m = model || this.config.model
    let lastErr
    for (const sub of this._order(m)) {
      try {
        const result = await attempt(sub)
        // Caching the winner can re-point _order()/_active() at `sub`, so
        // re-derive the shared set or getCapabilities() keeps describing the
        // transport we just stopped using. When m isn't the configured model
        // _active() is unchanged and this re-assigns the same set.
        this._resolved.set(m, sub)
        this.capabilities = this._active().capabilities
        return result
      } catch (e) {
        if (isUnsupportedApiError(e)) { lastErr = e; continue }
        throw friendlyError(e)
      }
    }
    throw lastErr || new Error(`No compatible Mantle API for model '${m}'`)
  }

  processResponse(response) {
    return this._subForShape(response).processResponse(response)
  }
  _subForShape(r) {
    if (r?.choices) return this._chat
    if (r?.output || r?.status) return this._responses
    if (Array.isArray(r?.content) || r?.stop_reason) return this._claude
    return this._active()
  }

  async discoverModels(timeoutMs = 10000, opts) {
    try {
      const models = await this._chat.discoverModels(timeoutMs, opts)
      return models.length ? models : BEDROCK_MANTLE_CLAUDE_MODELS.slice()
    } catch {
      return BEDROCK_MANTLE_CLAUDE_MODELS.slice()
    }
  }

  cancelAllRequests() { for (const s of this._subs()) s.cancelAllRequests() }
  cancelRequest(id) { for (const s of this._subs()) s.cancelRequest(id) }
}

// ---- helpers ----------------------------------------------------------------
function messagesToResponsesInput(messages) {
  // Map the canonical message list to the Responses `input` array. System is a
  // regular role here (verified accepted). Tool round-trips use the Responses
  // typed items (verified live): an assistant tool call becomes a `function_call`
  // item and a tool result becomes a `function_call_output`, both matched by
  // call_id — the same id the canonical `{id,name,args}` tool call carries.
  const input = []
  for (const m of messages) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content ?? '') })
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {})
        })
      }
      continue
    }
    input.push({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(toResponsesPart) : m.content
    })
  }
  return input
}

// Canonical content part -> Responses typed input part. Note the Responses API
// spells the image reference as a FLAT string (`image_url: '<url>'`), unlike
// Chat Completions' nested `{ url }` object.
function toResponsesPart(part) {
  if (part?.type === 'text') return { type: 'input_text', text: part.text ?? '' }
  if (part?.type !== 'image_url') return part
  const { url, detail } = normalizeImagePart(part)
  const out = { type: 'input_image', image_url: url }
  if (detail) out.detail = detail
  return out
}

// Tool definitions arrive in OpenAI Chat Completions shape
// ({type:'function', function:{name, description, parameters}}); the Responses
// API wants those fields flattened ({type:'function', name, description,
// parameters}). Non-function tools (built-ins) and already-flat entries pass
// through untouched.
function toolsToResponsesFormat(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  return tools.map(t => {
    if (t && t.type === 'function' && t.function) {
      const f = t.function
      return { type: 'function', name: f.name, description: f.description, parameters: f.parameters }
    }
    return t
  })
}

function mapResponsesStatus(status) {
  if (status === 'completed') return 'stop'
  if (status === 'incomplete') return 'length'
  return status || null
}

export function normalizeResponsesUsage(raw) {
  if (!raw) return null
  const inputTokens = raw.input_tokens ?? 0
  const outputTokens = raw.output_tokens ?? 0
  const out = { inputTokens, outputTokens, totalTokens: raw.total_tokens ?? (inputTokens + outputTokens), raw }
  const cached = raw.input_tokens_details?.cached_tokens
  const reasoning = raw.output_tokens_details?.reasoning_tokens
  if (cached != null) out.cachedInputTokens = cached
  if (reasoning != null) out.reasoningTokens = reasoning
  return out
}

function safeParse(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { __parseError: true, raw: text } }
}
