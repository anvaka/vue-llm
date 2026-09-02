import { createProviderFlexible, isKnownProviderType } from '../providers/factory.js'
import { calculateCost } from '../pricing/calculate.js'
import { fitImageParts } from '../providers/imageFit.js'

// One canonical image part, in the shape fitImageParts and every provider
// adapter already understand. Both spellings of image_url are accepted here
// because both are accepted there.
function isImagePart(part) {
  if (part?.type !== 'image_url') return false
  const raw = part.image_url
  return typeof (typeof raw === 'string' ? raw : raw?.url) === 'string'
}

export class LLMClient {
  constructor({ configStore, logger, pricing } = {}) {
    this.configStore = configStore
    this.logger = logger || console
    this.config = null
    this.provider = null
    this.usageTracker = null
    // Optional per-instance pricing override map. Shape:
    //   { providerType: { modelId: { input, output, cachedInput?, cacheCreation? } } }
    // Takes priority over registerPricing() globals and the built-in table.
    this.pricing = pricing || null
  }

  // Compute USD cost for a usage object using this client's active provider /
  // model + any per-instance overrides. Returns null when rates are unknown.
  // Exposed so consumers can re-cost historical usage objects without
  // reaching into the pricing module directly.
  costFor(usage, { provider, model } = {}) {
    return calculateCost(usage, {
      provider: provider || this.config?.provider,
      model: model || this.config?.model,
      pricing: this.pricing
    })
  }

  async initialize(tempConfig = null) {
    this.config = tempConfig || this.configStore.getActiveConfig()
    if (!this.config) {
      throw new Error('LLM not configured')
    }
    // Say WHICH config is broken and what to do about it. The factory's own
    // message interpolates the bad type, so a config saved without one reads
    // "Unknown provider type:" — a sentence that ends in a colon and leaves the
    // user with nowhere to go, especially since the config at fault is usually
    // not the one they were just working on.
    if (!isKnownProviderType(this.config.provider)) {
      const name = this.config.name || 'unnamed'
      throw new Error(
        `Provider config "${name}" does not name a usable provider ` +
        `(provider is ${JSON.stringify(this.config.provider)}). ` +
        `Open the provider list and re-select its type, or delete it.`
      )
    }
    this.provider = createProviderFlexible(this.config.provider, this.config)
    await this.provider.initialize()
    this.usageTracker = this._createUsageTracker()
  }

  async ensureInitialized() {
    if (!this.provider) await this.initialize()
  }

  async refresh() {
    // Restore on failure. Clearing both fields first and letting initialize()
    // throw left the client with NO provider at all — strictly worse than the
    // stale one it was replacing, and the next ensureInitialized() then threw
    // the same error again from an unrelated stack. A failed refresh should be
    // a no-op, not a downgrade.
    const previousConfig = this.config
    const previousProvider = this.provider
    this.config = null
    this.provider = null
    try {
      await this.initialize()
    } catch (error) {
      this.config = previousConfig
      this.provider = previousProvider
      throw error
    }
  }

  async testConnection(tempConfig) {
    const originalConfig = this.config
    const originalProvider = this.provider
    try {
      await this.initialize(tempConfig)
      const messages = [
        { role: 'system', content: 'Respond with exactly "pong"' },
        { role: 'user', content: 'ping' }
      ]
      const validated = this.validateCapabilities({
        model: this.config.model,
        enableThinking: false,
        temperature: tempConfig.temperature ?? 0.1,
        maxTokens: 10,
        stream: false
      })
      const request = this.provider.prepareRequest(messages, validated)
      const response = await this.provider.makeRequest(request)
      const processed = this.provider.processResponse(response)
      return processed.content?.trim()
    } finally {
      this.config = originalConfig
      this.provider = originalProvider
    }
  }

  _createUsageTracker() {
    const tracker = {
      totalTokens: 0,
      totalCost: 0,
      recordUsage: (_request, response) => {
        if (response?.usage?.totalTokens != null) tracker.totalTokens += response.usage.totalTokens
      },
      recordPartialUsage: (usage) => {
        if (usage?.totalTokens != null) tracker.totalTokens += usage.totalTokens
      }
    }
    return tracker
  }

  validateCapabilities(options) {
    if (!this.provider) return options
    const shouldEnableThinking = options.enableThinking !== undefined
      ? options.enableThinking
      : this.config?.enableThinking || false
    // Effort mirrors enableThinking's resolution: a per-call value wins, else
    // the active config's. Providers clamp it to the model and gate it behind
    // thinking, so passing it through unconditionally is safe.
    const resolvedEffort = options.reasoningEffort !== undefined
      ? options.reasoningEffort
      : this.config?.reasoningEffort
    return {
      ...options,
      enableThinking: shouldEnableThinking && this.provider.hasCapability('thinking'),
      reasoningEffort: resolvedEffort,
      images: options.images && this.provider.hasCapability('vision') ? options.images : null,
      tools: options.tools && this.provider.hasCapability('tools') ? options.tools : null
    }
  }

  // Shrink any image that exceeds the active provider's cap before sending.
  //
  // Compressing beats failing: providers reject an oversized image outright, and
  // a phone photo is routinely over the limit, so the alternative is a request
  // that always errors when a re-encode would have worked. No-ops when the
  // provider publishes no cap, when nothing is over it, or off-DOM (canvas is
  // browser-only) — so this is free for text-only calls.
  //
  // Pass `resizeImages: false` to send originals untouched and let the provider
  // decide, or `onImageResize` to observe what was changed.
  async fitImages(messages, options = {}) {
    if (options.resizeImages === false || this.config?.resizeImages === false) return messages
    return fitImageParts(messages, {
      maxBytes: this.provider?.maxImageBytes,
      quality: options.imageQuality ?? this.config?.imageQuality,
      onResize: (info) => {
        this.logger?.debug?.('Resized image to fit provider limit', info)
        options.onImageResize?.(info)
      }
    })
  }

  async ping() {
    await this.ensureInitialized()
    const messages = [
      { role: 'system', content: 'Respond with exactly "pong"' },
      { role: 'user', content: 'ping' }
    ]
    const validated = this.validateCapabilities({
      model: this.config.model,
      temperature: this.config.temperature ?? 0.1,
      maxTokens: 10,
      stream: false
    })
    const request = this.provider.prepareRequest(messages, validated)
    const response = await this.provider.makeRequest(request)
    const processed = this.provider.processResponse(response)
    return processed.content?.trim()
  }

  async stream(payload, onChunk) {
    await this.ensureInitialized()
    const validated = this.validateCapabilities({ ...payload, stream: true, model: payload.model || this.config.model, requestId: this.generateRequestId() })
    const messages = await this.fitImages(payload.messages, payload)
    let fullContent = ''
    let fullThinking = ''
    let lastUsage = null
    await this.provider.streamRequest(messages, validated, (chunk) => {
      fullContent = chunk.fullContent
      // Carry the reasoning text through to the result too — the per-chunk
      // callback already sees chunk.fullThinking, but callers that only await
      // the returned promise (e.g. the sweep) would otherwise lose it.
      if (chunk.fullThinking) fullThinking = chunk.fullThinking
      if (chunk.fullUsage) lastUsage = chunk.fullUsage
      // Annotate each chunk with running cost when rates are known. Consumers
      // can ignore it (cost is null when no rates table entry matches) or
      // display a live $ counter.
      const enriched = chunk.fullUsage
        ? { ...chunk, cost: this.costFor(chunk.fullUsage, { provider: this.config.provider, model: validated.model }) }
        : chunk
      onChunk && onChunk(enriched)
    })
    return { content: fullContent, thinking: fullThinking, usage: lastUsage, cost: this.costFor(lastUsage, { provider: this.config.provider, model: validated.model }) }
  }

  // Multi-turn tool-calling loop. Each iteration:
  //  1) stream a model response (text + accumulated tool_calls)
  //  2) append the assistant message to the conversation
  //  3) if no tool calls → stop (the model is done)
  //  4) otherwise execute each tool via `executors[name](args)` and append
  //     a tool message per call, then loop
  //
  // `tools` is OpenAI-style ([{type:'function', function:{name, description, parameters}}]).
  // Providers translate to native format. The caller passes `executors` as a
  // `{ name -> async (args) => result }` map. Results are stringified into the
  // tool message content (or used verbatim if the executor already returns a
  // string).
  //
  // `onEvent` (optional) fires for: iter-start, text-delta, tool-call-delta,
  // assistant-message, tool-call, tool-result, stop. Use it to drive a trace UI.
  // `signal` (optional AbortSignal) stops the loop. It is the only way to end a
  // run that is mid-stream: every other exit is the model's decision (it stopped
  // calling tools) or a backstop (maxIters). Cancelling aborts the in-flight
  // fetch, so it stops the spend immediately rather than asking the model to
  // wind down — which would cost another full round-trip per iteration.
  //
  // Every abort path leaves `messages` VALID to resume from, which is the whole
  // design constraint here: cancel during the stream and we break before the
  // assistant message is appended; cancel during tool execution and we still
  // record a result for every tool_call. A transcript carrying tool_calls with
  // no matching tool result is a 400 on the next request — a "stop" that
  // stranded the conversation would be worse than no stop at all.
  async runAgentLoop({
    messages,
    tools,
    executors,
    onEvent,
    maxIters = 10,
    temperature,
    model,
    maxTokens,
    enableThinking,
    reasoningEffort,
    signal,
    resizeImages,
    imageQuality,
    onImageResize
  } = {}) {
    await this.ensureInitialized()
    if (!this.provider.hasCapability('tools')) {
      throw new Error('Configured provider does not support tools')
    }
    // Fit once up front: the loop re-sends the whole transcript every iteration,
    // so shrinking here means an oversized image is re-encoded once rather than
    // on each turn (and the cached prefix stays byte-identical between turns).
    const conversation = (await this.fitImages(messages, { resizeImages, imageQuality, onImageResize })).slice()
    let iter = 0
    let stopReason = null
    // Aggregate usage across all iterations of the agent loop — a single
    // user prompt can incur many model calls (each tool round-trip is one).
    // Consumers usually want the total cost of the whole task, not per-iter.
    const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 }
    let usageSeen = false
    while (iter < maxIters) {
      if (signal?.aborted) { stopReason = 'aborted'; break }
      iter++
      onEvent && onEvent({ type: 'iter-start', iter })
      const validated = this.validateCapabilities({
        messages: conversation,
        tools,
        stream: true,
        model: model || this.config.model,
        temperature: temperature ?? this.config.temperature,
        maxTokens: maxTokens ?? this.config.maxTokens ?? 4096,
        enableThinking: enableThinking ?? false,
        reasoningEffort,
        // Re-sends the whole growing conversation each turn, so cache the
        // rolling transcript prefix (Anthropic-family providers honor this).
        cacheTranscript: true,
        requestId: this.generateRequestId(),
        // validateCapabilities spreads its input, so this reaches streamRequest,
        // which links it to the fetch's own controller.
        signal
      })
      let result
      try {
        result = await this.provider.streamRequest(conversation, validated, (chunk) => {
          if (chunk.content) onEvent && onEvent({ type: 'text-delta', text: chunk.content })
          if (chunk.toolCallDelta) onEvent && onEvent({ type: 'tool-call-delta', delta: chunk.toolCallDelta })
        })
      } catch (err) {
        // Cancelled mid-stream: a clean stop, not a failure. Breaking here —
        // before the assistant message is appended — cuts the transcript on the
        // user/tool message that prompted it, which is exactly where a resume
        // wants to pick up. The partial text is dropped on purpose.
        if (signal?.aborted || err?.name === 'AbortError') { stopReason = 'aborted'; break }
        throw err
      }
      const textContent = result?.content || ''
      const toolCalls = result?.toolCalls || []
      const thinking = result?.thinking || ''
      const iterUsage = result?.usage || null
      if (iterUsage) {
        usageSeen = true
        for (const k of Object.keys(totalUsage)) {
          if (iterUsage[k] != null) totalUsage[k] += iterUsage[k]
        }
        onEvent && onEvent({ type: 'usage', usage: iterUsage, cost: this.costFor(iterUsage, { provider: this.config.provider, model: validated.model }) })
      }

      const assistantMsg = { role: 'assistant', content: textContent }
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls
      // Some providers (e.g. DeepSeek's thinking-mode models) reject subsequent
      // requests unless the prior assistant reasoning is echoed back. Stash it
      // on the message; providers decide whether to serialize it on the wire.
      if (thinking) assistantMsg.thinking = thinking
      conversation.push(assistantMsg)
      onEvent && onEvent({ type: 'assistant-message', content: textContent, toolCalls, thinking })

      if (!toolCalls.length) {
        stopReason = 'no-tool-calls'
        break
      }

      // Pictures a tool produced this iteration. They cannot ride the tool
      // results themselves — those are strings, below — so they are collected
      // here and delivered once, after every call has been answered.
      const pendingImages = []

      for (const tc of toolCalls) {
        onEvent && onEvent({ type: 'tool-call', id: tc.id, name: tc.name, args: tc.args })
        const exec = executors && executors[tc.name]
        let resultText
        if (signal?.aborted) {
          // Stop RUNNING tools, but keep answering them. Skipping the result
          // outright would leave a tool_calls message with a hole in it, and the
          // next request on this transcript would 400 — so a cancelled run could
          // never be resumed or continued.
          resultText = 'Error: cancelled by the user.'
        } else if (!exec) {
          resultText = `Error: unknown tool '${tc.name}'`
        } else {
          try {
            const out = await exec(tc.args || {})
            // A tool that has BYTES worth looking at returns `{ text, images }`.
            //
            // Both fields are required to opt in, so this can never be confused
            // with an ordinary object result that happens to have one of them.
            // The text still answers the call — a tool result is a string on the
            // wire and several providers reject anything else in a `tool`
            // message — and the pictures are delivered separately below.
            if (out && typeof out === 'object' && typeof out.text === 'string' && Array.isArray(out.images)) {
              resultText = out.text
              for (const part of out.images) if (isImagePart(part)) pendingImages.push(part)
            } else {
              resultText = typeof out === 'string' ? out : JSON.stringify(out ?? '')
            }
          } catch (err) {
            resultText = `Error: ${err?.message || String(err)}`
          }
        }
        conversation.push({ role: 'tool', tool_call_id: tc.id, content: resultText })
        onEvent && onEvent({ type: 'tool-result', id: tc.id, name: tc.name, content: resultText })
      }

      // The pictures, as their own message, AFTER every tool call has been
      // answered. Three things about the shape are deliberate.
      //
      // A `user` message, not the tool result: an image part inside a `tool`
      // message is accepted by some providers here and rejected by others,
      // while a user message carrying image parts is the one form all of them
      // take. It also leaves the tool_calls/tool pairing exactly as it was — a
      // hole there 400s the next request, so a run that grew one could never be
      // resumed.
      //
      // A bracketed note rather than no text: the message is in the USER's
      // voice by necessity, and a model that reads an unannounced photograph
      // there will answer as though the person had just sent it.
      //
      // And fitted, like every other image. `fitImages` runs once up front on
      // the caller's messages precisely because the loop re-sends the whole
      // transcript; one arriving mid-loop would otherwise be the single
      // unresized picture in the conversation, against a provider limit that
      // exists because pictures are large.
      if (pendingImages.length && !signal?.aborted) {
        const note = `[${pendingImages.length} image${pendingImages.length === 1 ? '' : 's'} returned by the tool call above]`
        const carrier = { role: 'user', content: [{ type: 'text', text: note }, ...pendingImages] }
        let delivered = carrier
        try {
          const [fitted] = await this.fitImages([carrier], { resizeImages, imageQuality, onImageResize })
          if (fitted) delivered = fitted
        } catch {
          // Resizing is an optimisation; failing it must not lose the picture
          // the tool was called to fetch.
        }
        conversation.push(delivered)
        onEvent && onEvent({ type: 'tool-images', count: pendingImages.length })
      }

      if (signal?.aborted) { stopReason = 'aborted'; break }
    }
    if (!stopReason) stopReason = 'max-iters'
    const finalUsage = usageSeen ? totalUsage : null
    const finalCost = this.costFor(finalUsage, { provider: this.config.provider, model: model || this.config.model })
    onEvent && onEvent({ type: 'stop', reason: stopReason, iterations: iter, usage: finalUsage, cost: finalCost })
    return { messages: conversation, iterations: iter, stopReason, usage: finalUsage, cost: finalCost }
  }

  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  getCapabilities() {
    return this.provider ? Array.from(this.provider.capabilities) : []
  }

  getUsageStats() {
    return {
      totalTokens: this.usageTracker?.totalTokens || 0,
      totalCost: this.usageTracker?.totalCost || 0
    }
  }

  async discoverModels() {
    await this.ensureInitialized()
    return this.provider.discoverModels()
  }

  getConfigByName(displayName) {
    if (!displayName || !this.configStore?.getEnabledConfigs) return null
    const normalized = displayName.trim()
    const matches = this.configStore.getEnabledConfigs()
      .filter(cfg => this._matchesDisplayName(cfg, normalized))
    if (matches.length === 0) return null
    if (matches.length > 1) {
      const ids = matches.map(cfg => cfg.id).join(', ')
      throw new Error(`Multiple provider presets share the name '${displayName}'. Conflicting ids: ${ids}`)
    }
    return matches[0]
  }

  _matchesDisplayName(cfg, name) {
    if (!cfg || !name) return false
    return cfg.name === name || this._formatDisplayName(cfg) === name
  }

  _formatDisplayName(cfg) {
    const providerLabel = cfg?.provider || 'provider'
    const baseUrl = cfg?.baseUrl || 'n/a'
    return cfg?.name || `${providerLabel} (${baseUrl})`
  }

  // Compatibility wrapper replicating old createLLMWrapper() dual streaming/promise API.
  // Provides llm(prompt, opts).into(target, attrs?) and .withOperation(name) chain.
  createLLMWrapper(contextNode, originatingCode = null, defaultProviderName = null) {
    const client = this
    function llm(prompt, options = {}) {
      return new StreamablePromise(client, contextNode, prompt, options, originatingCode, defaultProviderName)
    }
    return llm
  }
}

// Internal wrapper class (simplified vs legacy but preserves external contract)
class StreamablePromise {
  constructor(client, contextNode, prompt, options, originatingCode, defaultPresetName) {
    this.client = client
    this.contextNode = contextNode
    this.prompt = prompt
    this.options = options || {}
    this.originatingCode = originatingCode
    this.defaultPresetName = defaultPresetName
    this.targetNode = null
    this.targetAttributes = {}
    this.operationName = null
    this._executed = false
    this._promise = null
  }

  withOperation(name) { this.operationName = name; return this }
  into(target, attrs = {}) { this.targetNode = target; this.targetAttributes = attrs; this._ensureExecution(); return this }
  then(f, r) { this._ensureExecution(); return this._promise.then(f, r) }
  catch(r) { this._ensureExecution(); return this._promise.catch(r) }
  finally(f) { this._ensureExecution(); return this._promise.finally(f) }

  _ensureExecution() { if (!this._executed) { this._executed = true; this._promise = this._run() } }

  async _run() {
    const execCtx = await this._createExecutionContext()
    const { provider, config } = execCtx
    if (!provider || !config) throw new Error('LLM not configured')

    const validateCapabilities = this.client.validateCapabilities.bind({ provider, config })
    const messages = []
    if (this.options.system) messages.push({ role: 'system', content: this.options.system })
    messages.push({ role: 'user', content: this.prompt })
    // Same image fitting as LLMClient.stream — bound to THIS execution context's
    // provider, which may be a preset rather than the client's active one.
    const fitted = await this.client.fitImages.call(
      { provider, config, logger: this.client.logger }, messages, this.options
    )

    const baseOptions = {
      model: this.options.model || config.model,
      temperature: this.options.temperature ?? config.temperature,
      maxTokens: this.options.maxTokens ?? config.maxTokens,
      enableThinking: this.options.enableThinking,
      reasoningEffort: this.options.reasoningEffort,
      requestId: this.client.generateRequestId(),
      ...(this.options.images ? { images: this.options.images } : {}),
      ...(this.options.tools ? { tools: this.options.tools } : {})
    }

    try {
      if (this.targetNode) {
        const streamOpts = validateCapabilities({ ...baseOptions, stream: true })
        return await this._streamIntoTarget(fitted, streamOpts, provider, config)
      }
      const nonStreaming = validateCapabilities({ ...baseOptions, stream: false })
      return await this._promiseResponse(fitted, nonStreaming, provider, config)
    } finally {
      execCtx.cleanup?.()
    }
  }

  async _createExecutionContext() {
    const presetName = this._resolvePresetName()
    if (!presetName) {
      await this.client.ensureInitialized()
      return { provider: this.client.provider, config: this.client.config, cleanup: () => {} }
    }

    if (!this.client.configStore) {
      throw new Error('Provider presets require a configured ConfigStore instance')
    }

    const config = this.client.getConfigByName?.(presetName)
    if (!config) {
      const available = (this.client.configStore.getEnabledConfigs?.() || [])
        .map(cfg => cfg.name || `${cfg.provider} (${cfg.baseUrl})`)
        .filter(Boolean)
      const suffix = available.length ? ` Available presets: ${available.join(', ')}` : ' No configured providers found.'
      throw new Error(`Provider preset '${presetName}' not found.${suffix}`)
    }

    const provider = createProviderFlexible(config.provider, config)
    await provider.initialize()
    return { provider, config, cleanup: () => provider.cancelAllRequests?.() }
  }

  _resolvePresetName() {
    const explicit = typeof this.options.preset === 'string' ? this.options.preset : null
    const fallback = typeof this.defaultPresetName === 'string' ? this.defaultPresetName : null
    const candidate = explicit || fallback
    return candidate ? candidate.trim() : null
  }

  _applyAttributes(node) {
    for (const [k,v] of Object.entries(this.targetAttributes || {})) {
      try {
        node.setAttribute(k, v)
      } catch (error) {
        this.client.logger?.warn?.('Failed to set attribute on target node', { key: k, value: v, error })
      }
    }
  }

  async _streamIntoTarget(messages, opts, provider, config) {
    let targetNode; let placeholder
    if (typeof this.targetNode === 'string') {
      placeholder = this.targetNode
      targetNode = this.contextNode.createChild(placeholder)
      targetNode.setSelected?.()
    } else {
      targetNode = this.targetNode
      placeholder = targetNode.getText?.() || ''
    }
    this._applyAttributes(targetNode)

    // Mark provider name
    const providerName = config?.name
    if (providerName && targetNode.addTag) targetNode.addTag('provider', providerName)

    targetNode.addLLMLog?.(this.operationName || 'streaming-request', {
      provider: config?.provider,
      model: config?.model,
      messages,
      options: opts
    })

    targetNode.setStreamingState?.(true)
    targetNode._activeRequestId = opts.requestId
    let fullContent = ''
    let finishReason = null
    let finalUsage = null

    try {
      await provider.streamRequest(messages, opts, chunk => {
        if (chunk.content) {
          fullContent = chunk.fullContent
          targetNode.setText?.(fullContent)
        }
        if (chunk.fullUsage) finalUsage = chunk.fullUsage
        if (chunk.finishReason) finishReason = chunk.finishReason
        if (chunk.done) {
          targetNode.setStreamingState?.(false)
          targetNode._activeRequestId = null
        }
      })
      const finalCost = this.client.costFor?.(finalUsage, { provider: config?.provider, model: opts.model })
      targetNode.addLLMLog?.((this.operationName || 'streaming-request') + '-response', { requestId: opts.requestId }, { content: fullContent, usage: finalUsage, cost: finalCost })
      if (finishReason === 'length') {
        targetNode.setAttribute?.('_truncated', true)
        targetNode.addLog?.('Response truncated. Increase Max Tokens.', 'warn', { finish_reason: 'length' })
      } else targetNode.setAttribute?.('_truncated', false)
      await targetNode.persistNow?.()
      return targetNode
    } catch (e) {
      targetNode.addLLMLog?.((this.operationName || 'streaming-request') + '-error', { requestId: opts.requestId }, null, e)
      targetNode.setStreamingState?.(false)
      targetNode._activeRequestId = null
      targetNode.setText?.(`Error: ${e.message}`)
      targetNode.setAttribute?.('_truncated', false)
      await targetNode.persistNow?.()
      throw e
    }
  }

  async _promiseResponse(messages, opts, provider, config) {
    const request = provider.prepareRequest(messages, opts)
    const raw = await provider.makeRequest(request)
    const processed = provider.processResponse(raw)
    const finishReason = processed.finishReason || raw?.choices?.[0]?.finish_reason || null
    if (finishReason === 'length') {
      try {
        this.contextNode.setAttribute('_truncated', true)
      } catch (error) {
        this.client.logger?.warn?.('Unable to mark node as truncated', { error })
      }
    } else {
      try {
        this.contextNode.setAttribute('_truncated', false)
      } catch (error) {
        this.client.logger?.warn?.('Unable to clear truncated marker on node', { error })
      }
    }
    return processed.content?.trim() || ''
  }
}

