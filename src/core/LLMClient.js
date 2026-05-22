import { createProviderFlexible } from '../providers/factory.js'

export class LLMClient {
  constructor({ configStore, logger } = {}) {
    this.configStore = configStore
    this.logger = logger || console
    this.config = null
    this.provider = null
    this.usageTracker = null
  }

  async initialize(tempConfig = null) {
    this.config = tempConfig || this.configStore.getActiveConfig()
    if (!this.config) {
      throw new Error('LLM not configured')
    }
    this.provider = createProviderFlexible(this.config.provider, this.config)
    await this.provider.initialize()
    this.usageTracker = this._createUsageTracker()
  }

  async ensureInitialized() {
    if (!this.provider) await this.initialize()
  }

  async refresh() {
    this.config = null
    this.provider = null
    await this.initialize()
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
    return {
      totalTokens: 0,
      totalCost: 0,
      recordUsage: (request, response) => {
        if (response.usage?.tokens) {
          this.totalTokens += response.usage.tokens
        }
        // Cost calculation can be added later
      },
      recordPartialUsage: (usage) => {
        if (usage?.tokens) {
          this.totalTokens += usage.tokens
        }
      }
    }
  }

  validateCapabilities(options) {
    if (!this.provider) return options
    const shouldEnableThinking = options.enableThinking !== undefined
      ? options.enableThinking
      : this.config?.enableThinking || false
    return {
      ...options,
      enableThinking: shouldEnableThinking && this.provider.hasCapability('thinking'),
      images: options.images && this.provider.hasCapability('vision') ? options.images : null,
      tools: options.tools && this.provider.hasCapability('tools') ? options.tools : null
    }
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
    const messages = payload.messages
    let fullContent = ''
    await this.provider.streamRequest(messages, validated, (chunk) => {
      fullContent = chunk.fullContent
      onChunk && onChunk(chunk)
    })
    return fullContent
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
  async runAgentLoop({
    messages,
    tools,
    executors,
    onEvent,
    maxIters = 10,
    temperature,
    model,
    maxTokens,
    enableThinking
  } = {}) {
    await this.ensureInitialized()
    if (!this.provider.hasCapability('tools')) {
      throw new Error('Configured provider does not support tools')
    }
    const conversation = messages.slice()
    let iter = 0
    let stopReason = null
    while (iter < maxIters) {
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
        requestId: this.generateRequestId()
      })
      const result = await this.provider.streamRequest(conversation, validated, (chunk) => {
        if (chunk.content) onEvent && onEvent({ type: 'text-delta', text: chunk.content })
        if (chunk.toolCallDelta) onEvent && onEvent({ type: 'tool-call-delta', delta: chunk.toolCallDelta })
      })
      const textContent = result?.content || ''
      const toolCalls = result?.toolCalls || []

      const assistantMsg = { role: 'assistant', content: textContent }
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls
      conversation.push(assistantMsg)
      onEvent && onEvent({ type: 'assistant-message', content: textContent, toolCalls })

      if (!toolCalls.length) {
        stopReason = 'no-tool-calls'
        break
      }

      for (const tc of toolCalls) {
        onEvent && onEvent({ type: 'tool-call', id: tc.id, name: tc.name, args: tc.args })
        const exec = executors && executors[tc.name]
        let resultText
        if (!exec) {
          resultText = `Error: unknown tool '${tc.name}'`
        } else {
          try {
            const out = await exec(tc.args || {})
            resultText = typeof out === 'string' ? out : JSON.stringify(out ?? '')
          } catch (err) {
            resultText = `Error: ${err?.message || String(err)}`
          }
        }
        conversation.push({ role: 'tool', tool_call_id: tc.id, content: resultText })
        onEvent && onEvent({ type: 'tool-result', id: tc.id, name: tc.name, content: resultText })
      }
    }
    if (!stopReason) stopReason = 'max-iters'
    onEvent && onEvent({ type: 'stop', reason: stopReason, iterations: iter })
    return { messages: conversation, iterations: iter, stopReason }
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

    const baseOptions = {
      model: this.options.model || config.model,
      temperature: this.options.temperature ?? config.temperature,
      maxTokens: this.options.maxTokens ?? config.maxTokens,
      enableThinking: this.options.enableThinking,
      requestId: this.client.generateRequestId(),
      ...(this.options.images ? { images: this.options.images } : {}),
      ...(this.options.tools ? { tools: this.options.tools } : {})
    }

    try {
      if (this.targetNode) {
        const streamOpts = validateCapabilities({ ...baseOptions, stream: true })
        return await this._streamIntoTarget(messages, streamOpts, provider, config)
      }
      const nonStreaming = validateCapabilities({ ...baseOptions, stream: false })
      return await this._promiseResponse(messages, nonStreaming, provider, config)
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
    let totalTokens = 0

    try {
      await provider.streamRequest(messages, opts, chunk => {
        if (chunk.content) {
          fullContent = chunk.fullContent
          targetNode.setText?.(fullContent)
        }
        if (chunk.usage?.tokens) totalTokens += chunk.usage.tokens
        if (chunk.finishReason) finishReason = chunk.finishReason
        if (chunk.done) {
          targetNode.setStreamingState?.(false)
          targetNode._activeRequestId = null
        }
      })
      targetNode.addLLMLog?.((this.operationName || 'streaming-request') + '-response', { requestId: opts.requestId }, { content: fullContent, usage: { tokens: totalTokens } })
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

