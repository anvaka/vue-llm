import { BaseProvider } from './BaseProvider.js'

export class GeminiProvider extends BaseProvider {
  async detectCapabilities() {
    if (!this.config.model) return
    if (this.config.model.includes('gemini-pro-vision') || this.config.model.includes('gemini-1.5') || this.config.model.includes('gemini-2.0')) {
      this.capabilities.add('vision')
    }
    if (this.config.model.includes('gemini-pro') || this.config.model.includes('gemini-1.5') || this.config.model.includes('gemini-2.0')) {
      this.capabilities.add('tools')
    }
    if (this.config.model.includes('gemini-2.0')) {
      this.capabilities.add('thinking')
    }
  }

  prepareRequest(messages, options) {
    const processed = this.processMessages(messages, options)
    const request = {
      contents: this.convertToGeminiFormat(processed),
      generationConfig: {
        temperature: options.temperature || this.config.temperature || 0.7,
        maxOutputTokens: options.maxTokens || this.config.maxTokens || 1000,
        topP: 0.8,
        topK: 10
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    }
    const systemMessage = messages.find(m => m.role === 'system')
    if (systemMessage) request.systemInstruction = { parts: [{ text: systemMessage.content }] }
    if (options.tools && this.capabilities.has('tools')) request.tools = this.convertToolsToGeminiFormat(options.tools)
    return request
  }

  convertToGeminiFormat(messages) {
    const contents = []
    for (const message of messages) {
      if (message.role === 'system') continue
      const role = message.role === 'assistant' ? 'model' : 'user'
      if (Array.isArray(message.content)) {
        const parts = message.content.map(part => {
          if (part.type === 'text') return { text: part.text }
          if (part.type === 'image') return { inlineData: { mimeType: part.source?.media_type || 'image/jpeg', data: part.source?.data || part.data } }
          if (part.type === 'image_url') return { inlineData: { mimeType: 'image/jpeg', data: part.image_url.url.split(',')[1] } }
          return { text: String(part) }
        })
        contents.push({ role, parts })
      } else {
        contents.push({ role, parts: [{ text: message.content }] })
      }
    }
    return contents
  }

  processMessages(messages, options) {
    if (options.images && this.capabilities.has('vision')) return this.addImagesToMessages(messages, options.images)
    return messages
  }

  addImagesToMessages(messages, images) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage && lastMessage.role === 'user') {
      const content = [{ type: 'text', text: lastMessage.content }]
      images.forEach(img => content.push({ type: 'image', data: typeof img === 'string' ? img : img.data, mimeType: 'image/jpeg' }))
      lastMessage.content = content
    }
    return messages
  }

  convertToolsToGeminiFormat(tools) {
    return tools.map(tool => ({ functionDeclarations: [{ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }] }))
  }

  processResponse(response) {
    const result = { content: '', usage: null, finishReason: null }
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0]
      if (candidate.content?.parts) {
        result.content = candidate.content.parts.filter(p => p.text).map(p => p.text).join('')
      }
      if (candidate.content?.parts) {
        const functionCalls = candidate.content.parts.filter(p => p.functionCall)
        if (functionCalls.length > 0) result.functionCalls = functionCalls
      }
      if (candidate.finishReason) result.finishReason = mapFinishReason(candidate.finishReason)
    }
    if (response.usageMetadata) {
      result.usage = {
        promptTokens: response.usageMetadata.promptTokenCount,
        completionTokens: response.usageMetadata.candidatesTokenCount,
        totalTokens: response.usageMetadata.totalTokenCount
      }
    }
    return result
  }

  async streamRequest(messages, options, onChunk) {
    const request = this.prepareRequest(messages, options)
    const abortController = new AbortController()
    const requestId = options.requestId || this.generateRequestId()
    this.activeRequests.set(requestId, abortController)
    try {
      const response = await this.makeStreamingRequest(request, abortController.signal)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullContent = ''
      let fullThinking = ''
      let buffer = ''
      let objectDepth = 0
      let currentObjectStart = 0
      let inString = false
      let escaped = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (let i = currentObjectStart; i < buffer.length; i++) {
          const char = buffer[i]
          if (escaped) { escaped = false; continue }
          if (char === '\\' && inString) { escaped = true; continue }
          if (char === '"') { inString = !inString; continue }
          if (!inString) {
            if (char === '{') { if (objectDepth === 0) currentObjectStart = i; objectDepth++ }
            else if (char === '}') { objectDepth--; if (objectDepth === 0) { const jsonStr = buffer.slice(currentObjectStart, i + 1); try { const parsed = JSON.parse(jsonStr); const result = this.extractStreamingContent(parsed); if (result) { if (result.content) fullContent += result.content; if (result.thinking) fullThinking += result.thinking; onChunk({ content: result.content || '', thinking: result.thinking || '', fullContent, fullThinking, done: result.done || false, usage: result.usage || null, finishReason: result.finishReason || null }); if (result.done) return fullContent } } catch {} currentObjectStart = i + 1 } }
          }
        }
        if (objectDepth === 0 && currentObjectStart < buffer.length) { buffer = buffer.slice(currentObjectStart); currentObjectStart = 0 }
      }
      return fullContent
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Request cancelled')
      throw error
    } finally { this.activeRequests.delete(requestId) }
  }

  extractStreamingContent(parsed) {
    if (!parsed?.candidates?.length) return null
    const candidate = parsed.candidates[0]
    let content = ''
    let thinking = ''
    let done = false
    let finishReason = null
    if (candidate.content?.parts) {
      content = candidate.content.parts.filter(p => p.text).map(p => p.text).join('')
    }
    if (candidate.finishReason) { done = true; finishReason = mapFinishReason(candidate.finishReason) }
    if (parsed.usageMetadata?.thoughtsTokenCount > 0) { thinking = `[Thinking: ${parsed.usageMetadata.thoughtsTokenCount} tokens]` }
    return { content, thinking, done, usage: parsed.usageMetadata ? { promptTokens: parsed.usageMetadata.promptTokenCount, completionTokens: parsed.usageMetadata.candidatesTokenCount, totalTokens: parsed.usageMetadata.totalTokenCount } : null, finishReason }
  }

  getApiPath() { const model = this.config.model || 'gemini-pro'; return `/v1beta/models/${model}:generateContent` }
  getStreamingEndpoint() { const model = this.config.model || 'gemini-pro'; return `${this.config.baseUrl}/v1beta/models/${model}:streamGenerateContent` }
  requiresAuth() { return !!this.config.apiKey }
  getAuthHeaderName() { return 'x-goog-api-key' }
  getAuthHeaderValue() { return this.config.apiKey }
  buildHeaders() { return super.buildHeaders() }
  getModelsEndpoint() { return `${this.config.baseUrl}/v1beta/models` }
  parseModelsResponse(data) { return data.models?.filter(m => { const name = m.name.toLowerCase(); return name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent') }).map(m => m.name.split('/').pop()).sort() || [] }
}

function mapFinishReason(reason) {
  if (!reason) return null
  const r = String(reason).toLowerCase()
  if (r.includes('max') && r.includes('token')) return 'length'
  return r
}
