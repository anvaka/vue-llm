// Base provider class for all LLM providers (browser-only)

import { samplingModeFor, samplingKey, recordSamplingConstraint, classifyTemperatureError, SAMPLING_MODE } from './samplingPolicy.js'
import { resolveEffort, DEFAULT_EFFORT } from './reasoningPolicy.js'

export class BaseProvider {
  constructor(config) {
    this.config = config
    this.capabilities = new Set()
    this.activeRequests = new Map() // Track active requests for cancellation
  }

  async initialize() {
    await this.detectCapabilities()
  }

  async detectCapabilities() {
    // Override in subclasses
  }

  prepareRequest(messages, options) {
    throw new Error('prepareRequest must be implemented by subclass')
  }

  processResponse(response) {
    throw new Error('processResponse must be implemented by subclass')
  }

  // Set (or omit) `request.temperature` per the model's sampling policy. Every
  // provider whose wire format carries a top-level temperature calls this after
  // building the request literal, instead of hand-writing
  // `temperature: options.temperature ?? 0.7`. Centralizes the policy so it
  // travels across transports and stays in one place. Returns `request`.
  applySamplingParams(request, options = {}) {
    const model = request.model || this.config?.model || ''
    const requested = options.temperature ?? this.config?.temperature ?? 0.7
    const mode = samplingModeFor(this.#samplingKey(model), model)
    if (mode === SAMPLING_MODE.OMIT) delete request.temperature
    else request.temperature = mode === SAMPLING_MODE.ONE ? 1 : requested
    return request
  }

  // Resolve the reasoning-effort level to send for this request, or null when
  // none should be sent. Effort is a SUB-SETTING of thinking (it replaces the
  // old hand-written `if (enableThinking) request.reasoning_effort = ...` gate):
  // no thinking, no effort. When thinking is on, the requested level (per-call
  // option, else the model's config, else the default) is clamped to what the
  // model actually accepts — a model with no effort control returns null.
  reasoningEffortFor(request, options = {}) {
    if (!options.enableThinking) return null
    const model = request.model || this.config?.model || ''
    const requested = options.reasoningEffort ?? this.config?.reasoningEffort ?? DEFAULT_EFFORT
    return resolveEffort(requested, model)
  }

  // Write the model's reasoning-effort field onto the request. This default is
  // the OpenAI Chat Completions spelling (`reasoning_effort`, shared by the
  // native OpenAI, OpenRouter, and Mantle-chat transports). Providers whose
  // wire format spells effort differently override this: the Responses API uses
  // `reasoning.effort`, the Anthropic Messages API uses `output_config.effort`.
  // Returns `request`.
  applyReasoningParams(request, options = {}) {
    const level = this.reasoningEffortFor(request, options)
    if (level) request.reasoning_effort = level
    return request
  }

  #samplingKey(model) {
    const endpoint = this.getEndpoint()
    // Prefer the URL host so every path on the same endpoint shares one memo
    // entry. When getEndpoint() isn't an absolute URL (a relative/empty
    // baseUrl), fall back to the raw endpoint string rather than '' — otherwise
    // two unrelated relative-URL gateways serving the same model id would
    // collapse to one key and cross-contaminate each other's learned constraint.
    let host = endpoint || ''
    try { host = new URL(endpoint).host } catch { /* non-URL endpoint: keep raw */ }
    return samplingKey(host, model)
  }

  // On a 400 whose body complains about `temperature`, correct the request in
  // place (drop it, or pin it to 1). Returns the applied SAMPLING_MODE (a truthy
  // string) if the request was adjusted and is worth retrying once, else null.
  // NOTE: this does NOT record the learned constraint — the caller does that only
  // after the corrected request actually succeeds, so a transient 400 whose retry
  // also fails can't permanently poison the memo for this (host, model).
  #adjustForTemperatureError(request, errorText) {
    if (!('temperature' in request)) return null
    const mode = classifyTemperatureError(errorText)
    if (!mode) return null
    if (mode === SAMPLING_MODE.OMIT) delete request.temperature
    else request.temperature = 1
    return mode
  }

  // Send `request` via the given closure; on a temperature-related 400, correct
  // the request in place, retry once, and — only when that corrected retry
  // succeeds — memoize the constraint for this (host, model). Shared by the JSON
  // and streaming paths (and reused by BedrockProvider's URL-in-path override),
  // so the recovery ladder lives in exactly one place. `errorLabel` prefixes the
  // thrown message so each transport keeps its own wording. Returns the ok
  // Response; throws on any unrecoverable error.
  async _sendWithTemperatureRetry(send, request, errorLabel = 'LLM API Error') {
    let response = await send()
    if (response.ok) return response
    const errorText = await response.text()
    const mode = response.status === 400
      ? this.#adjustForTemperatureError(request, errorText)
      : null
    if (!mode) throw new Error(`${errorLabel} (${response.status}): ${errorText}`)

    response = await send()
    if (!response.ok) {
      throw new Error(`${errorLabel} (${response.status}): ${await response.text()}`)
    }
    recordSamplingConstraint(this.#samplingKey(request.model || this.config?.model || ''), mode)
    return response
  }

  async streamRequest(messages, options, onChunk) {
    const request = this.prepareRequest(messages, options)
    const abortController = new AbortController()

    // Store request for cancellation
    const requestId = options.requestId || this.generateRequestId()
    this.activeRequests.set(requestId, abortController)

    // An optional caller-supplied signal is the second way to cancel this
    // stream. It exists because the id-keyed route above only helps a caller
    // that KNOWS the id, and runAgentLoop mints its own id per iteration and
    // never surfaces it — leaving an agent loop with no way to stop. Linked to
    // our own controller rather than replacing it, so cancelRequest(requestId)
    // and cancelAllRequests() keep working exactly as before.
    const onExternalAbort = () => abortController.abort()
    if (options.signal) {
      if (options.signal.aborted) abortController.abort()
      else options.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const response = await this.makeStreamingRequest(request, abortController.signal)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullContent = ''
      let fullThinking = ''
      let fullUsage = null
      let buffer = ''
      // Per-call accumulator for tool calls, keyed by index (both Anthropic
      // and OpenAI/OpenRouter index content blocks by position). Providers
      // surface `toolCallDelta: {index, id?, name?, argsTextDelta?}` from
      // extractStreamingContent; we stitch the args text fragments here and
      // parse JSON once the stream finishes.
      const toolCallsByIndex = new Map()

      const finalizeToolCalls = () => {
        const arr = Array.from(toolCallsByIndex.values())
          .sort((a, b) => a.index - b.index)
          .map(t => {
            let args = {}
            if (t.argsText) {
              try { args = JSON.parse(t.argsText) }
              catch { args = { __parseError: true, raw: t.argsText } }
            }
            return { id: t.id, name: t.name, args }
          })
        return arr
      }

      const handleLine = (line) => {
        if (!line.trim()) return null
        const parsed = this.parseStreamingLine(line)
        if (!parsed) return null
        const result = this.extractStreamingContent(parsed)
        if (!result) return null
        if (result.content) fullContent += result.content
        if (result.thinking) fullThinking += result.thinking
        if (result.usage) fullUsage = mergeUsage(fullUsage, result.usage)
        // Providers can return a single `toolCallDelta` (OpenAI-style streaming
        // chunks) or a batch `toolCallDeltas` array (Ollama delivers all
        // tool_calls in one final chunk).
        const deltas = Array.isArray(result.toolCallDeltas)
          ? result.toolCallDeltas
          : (result.toolCallDelta ? [result.toolCallDelta] : [])
        for (const d of deltas) {
          let entry = toolCallsByIndex.get(d.index)
          if (!entry) {
            entry = { index: d.index, id: d.id || null, name: d.name || '', argsText: '' }
            toolCallsByIndex.set(d.index, entry)
          } else {
            if (d.id) entry.id = d.id
            if (d.name) entry.name = d.name
          }
          if (d.argsTextDelta) entry.argsText += d.argsTextDelta
        }
        const isDone = result.done || false
        const fullToolCalls = isDone ? finalizeToolCalls() : null
        onChunk({
          content: result.content || '',
          thinking: result.thinking || '',
          fullContent,
          fullThinking,
          done: isDone,
          usage: result.usage || null,
          fullUsage,
          finishReason: result.finishReason || null,
          toolCallDelta: result.toolCallDelta || null,
          toolCalls: fullToolCalls
        })
        return isDone ? 'done' : null
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          // Flush any trailing line that wasn't terminated by a newline
          if (buffer.length > 0) handleLine(buffer)
          break
        }

        buffer += decoder.decode(value, { stream: true })

        // Process all complete lines; keep the trailing partial line in buffer.
        let newlineIdx
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx)
          buffer = buffer.slice(newlineIdx + 1)
          if (handleLine(line) === 'done') {
            return { content: fullContent, thinking: fullThinking, toolCalls: finalizeToolCalls(), usage: fullUsage }
          }
        }
      }

      return { content: fullContent, thinking: fullThinking, toolCalls: finalizeToolCalls(), usage: fullUsage }
    } catch (error) {
      if (error.name === 'AbortError') {
        // Keep the historical message, but carry the name through: rewriting a
        // cancellation into a bare Error made it indistinguishable from a real
        // failure, so callers had to string-match to tell "the user stopped it"
        // from "the request broke".
        const cancelled = new Error('Request cancelled')
        cancelled.name = 'AbortError'
        throw cancelled
      }
      throw error
    } finally {
      this.activeRequests.delete(requestId)
      options.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  async makeRequest(request, signal, requestId) {
    const abortController = signal ? { signal } : new AbortController()
    
    if (!signal) {
      // Store request for cancellation if not provided
      requestId = requestId || this.generateRequestId()
      this.activeRequests.set(requestId, abortController)
    }

    try {
      const headers = this.buildHeaders()
      const activeSignal = abortController.signal || signal
      const send = () => fetch(this.getEndpoint(), {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: activeSignal
      })

      const response = await this._sendWithTemperatureRetry(send, request)
      return response.json()
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request cancelled')
      }
      throw error
    } finally {
      if (!signal && requestId) {
        this.activeRequests.delete(requestId)
      }
    }
  }

  async makeStreamingRequest(request, signal) {
    const headers = this.buildHeaders()
    const send = () => fetch(this.getStreamingEndpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal
    })
    // A temperature 400 is recoverable: correct the request and retry once.
    return this._sendWithTemperatureRetry(send, request)
  }

  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' }
    
    if (this.requiresAuth()) {
      headers[this.getAuthHeaderName()] = this.getAuthHeaderValue()
    }
    
    return headers
  }

  getStreamingEndpoint() {
    return `${this.config.baseUrl}${this.getApiPath()}`
  }

  getEndpoint() {
    return `${this.config.baseUrl}${this.getApiPath()}`
  }

  parseStreamingLine(_line) {
    throw new Error('parseStreamingLine must be implemented by subclass')
  }

  extractStreamingContent(_parsed) {
    throw new Error('extractStreamingContent must be implemented by subclass')
  }

  getApiPath() {
    throw new Error('getApiPath must be implemented by subclass')
  }

  requiresAuth() {
    return false
  }

  getAuthHeaderName() {
    return 'Authorization'
  }

  getAuthHeaderValue() {
    return `Bearer ${this.config.apiKey}`
  }

  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  // Cancel all active requests
  cancelAllRequests() {
    for (const [, controller] of this.activeRequests) {
      controller.abort()
    }
    this.activeRequests.clear()
  }

  // Cancel specific request
  cancelRequest(requestId) {
    const controller = this.activeRequests.get(requestId)
    if (controller) {
      controller.abort()
      this.activeRequests.delete(requestId)
    }
  }

  // Check if provider has capability
  hasCapability(capability) {
    return this.capabilities.has(capability)
  }

  // Discover available models (override in subclass if needed)
  async discoverModels(timeoutMs = 10000) {
    try {
      const headers = this.buildHeaders()
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(this.getModelsEndpoint(), {
        method: 'GET',
        headers,
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      return this.parseModelsResponse(data)
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Model discovery timeout - please check your connection')
      } else {
        throw error
      }
    }
  }

  getModelsEndpoint() {
    throw new Error('getModelsEndpoint must be implemented by subclass')
  }

  parseModelsResponse(_data) {
    throw new Error('parseModelsResponse must be implemented by subclass')
  }
}

// Merge a usage update into the running accumulator. Each field updates
// independently — providers stream different fields in different chunks
// (Anthropic emits input/cache at message_start and refreshes output_tokens
// per message_delta; OpenAI usually delivers a single usage block at stream
// end). We take max() across updates so a late chunk that omits a previously-
// reported field can't reset it to zero, but a higher running count wins.
function mergeUsage(prev, next) {
  if (!next) return prev
  if (!prev) return { ...next }
  const merged = { ...prev }
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens']
  for (const f of fields) {
    if (next[f] != null) {
      merged[f] = prev[f] != null ? Math.max(prev[f], next[f]) : next[f]
    }
  }
  if (next.raw) merged.raw = next.raw
  // Recompute totalTokens if the provider didn't supply one but we have both halves.
  if (merged.totalTokens == null && merged.inputTokens != null && merged.outputTokens != null) {
    merged.totalTokens = merged.inputTokens + merged.outputTokens
  }
  return merged
}
