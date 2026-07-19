import { BaseProvider } from './BaseProvider.js'
import { normalizeImagePart, requireInlineImage } from './imageContent.js'

export class GeminiProvider extends BaseProvider {
  async detectCapabilities() {
    const id = this.config.model
    if (!id) return
    // Every modern Gemini family member (1.5, 2.0, 2.5, …) supports tools and
    // vision. Match the version with a regex instead of an enumerated list so
    // new releases don't silently lose capabilities.
    const versionMatch = id.match(/gemini-(\d+)\.(\d+)/)
    const major = versionMatch ? Number(versionMatch[1]) : null
    const minor = versionMatch ? Number(versionMatch[2]) : null
    const atLeast = (M, m) => major != null && (major > M || (major === M && minor >= m))
    if (id.includes('gemini-pro-vision') || atLeast(1, 5)) this.capabilities.add('vision')
    if (id.includes('gemini-pro') || atLeast(1, 5)) this.capabilities.add('tools')
    if (atLeast(2, 0)) this.capabilities.add('thinking')
  }

  // Gemini caps the WHOLE inline request (prompt + system + image bytes) at
  // 20 MB; above that it wants the Files API. Applied per image, which is the
  // conservative reading — a single part can't exceed the request budget.
  get maxImageBytes() { return 20 * 1024 * 1024 }

  prepareRequest(messages, options) {
    const processed = this.processMessages(messages, options)
    const request = {
      contents: this.convertToGeminiFormat(processed),
      generationConfig: {
        temperature: options.temperature ?? this.config.temperature ?? 0.7,
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

  // Build a {tool_call_id -> function name} index from prior assistant
  // messages so tool-result messages can be reshaped into Gemini's
  // functionResponse (which requires the function name to match).
  buildToolCallNameIndex(messages) {
    const index = new Map()
    for (const m of messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.id) index.set(tc.id, tc.name)
        }
      }
    }
    return index
  }

  convertToGeminiFormat(messages) {
    const nameIndex = this.buildToolCallNameIndex(messages)
    const contents = []
    for (const message of messages) {
      if (message.role === 'system') continue

      if (message.role === 'tool') {
        const fnName = message.name || nameIndex.get(message.tool_call_id) || 'unknown'
        // Gemini's functionResponse.response must be a Struct (object). Parse
        // strings to JSON when possible, but always wrap primitives/arrays in
        // `{result: <value>}` so the proto schema accepts them.
        let response = message.content
        if (typeof response === 'string') {
          try {
            const parsed = JSON.parse(response)
            response = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
              ? parsed
              : { result: parsed }
          } catch {
            response = { result: message.content }
          }
        } else if (response === null || typeof response !== 'object' || Array.isArray(response)) {
          response = { result: response }
        }
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: fnName, response } }]
        })
        continue
      }

      if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const parts = []
        if (message.content) parts.push({ text: String(message.content) })
        for (const tc of message.tool_calls) {
          parts.push({ functionCall: { name: tc.name, args: typeof tc.args === 'string' ? safeParse(tc.args) : (tc.args || {}) } })
        }
        contents.push({ role: 'model', parts })
        continue
      }

      const role = message.role === 'assistant' ? 'model' : 'user'
      if (Array.isArray(message.content)) {
        contents.push({ role, parts: message.content.map(toGeminiPart) })
      } else {
        contents.push({ role, parts: [{ text: message.content }] })
      }
    }
    return contents
  }

  convertToolsToGeminiFormat(tools) {
    return tools.map(tool => ({ functionDeclarations: [{ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }] }))
  }

  processResponse(response) {
    const result = { content: '', usage: null, finishReason: null }
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0]
      const parts = candidate.content?.parts || []
      result.content = parts.filter(p => p.text).map(p => p.text).join('')
      const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall)
      if (fnCalls.length) {
        result.toolCalls = fnCalls.map((fc, i) => ({
          id: synthId(i),
          name: fc.name,
          args: fc.args || {}
        }))
      }
      if (candidate.finishReason) result.finishReason = mapFinishReason(candidate.finishReason)
    }
    result.usage = normalizeGeminiUsage(response.usageMetadata)
    return result
  }

  parseStreamingLine(line) {
    // Gemini's streamGenerateContent with ?alt=sse emits SSE events: `data: {...}`.
    // There is no `[DONE]` sentinel — the stream just closes when the candidate's
    // finishReason has been delivered.
    if (!line.startsWith('data: ')) return null
    const data = line.slice(6).trim()
    if (!data) return null
    try { return JSON.parse(data) } catch { return null }
  }

  extractStreamingContent(parsed) {
    if (!parsed?.candidates?.length) {
      return { content: '', thinking: '', done: false }
    }
    const candidate = parsed.candidates[0]
    let content = ''
    let thinking = ''
    let done = false
    let finishReason = null
    const parts = candidate.content?.parts || []
    content = parts.filter(p => p.text).map(p => p.text).join('')
    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall)
    if (candidate.finishReason) { done = true; finishReason = mapFinishReason(candidate.finishReason) }
    if (parsed.usageMetadata?.thoughtsTokenCount > 0) { thinking = `[Thinking: ${parsed.usageMetadata.thoughtsTokenCount} tokens]` }
    const out = {
      content,
      thinking,
      done,
      usage: normalizeGeminiUsage(parsed.usageMetadata),
      finishReason
    }
    if (fnCalls.length) {
      // Gemini delivers each functionCall fully formed (not character-streamed).
      // Emit them as batch deltas so BaseProvider's accumulator can build the
      // canonical toolCalls array. JSON-stringify args because the accumulator
      // parses argsText back into an object.
      out.toolCallDeltas = fnCalls.map((fc, i) => ({
        index: i,
        id: synthId(i),
        name: fc.name || '',
        argsTextDelta: JSON.stringify(fc.args ?? {})
      }))
    }
    return out
  }

  getApiPath() { const model = this.config.model || 'gemini-pro'; return `/v1beta/models/${model}:generateContent` }
  getStreamingEndpoint() { const model = this.config.model || 'gemini-pro'; return `${this.config.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse` }
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

function synthId(i) { return `gemini_call_${i}` }

// Canonical content part -> Gemini part. Gemini wants the base64 payload and its
// media type in separate fields (`inlineData`), and only dereferences a URI when
// it points at its own Files API — an arbitrary https image URL is not accepted,
// so requireInlineImage says so plainly instead of sending a request that 400s.
function toGeminiPart(part) {
  if (part?.type === 'image_url') {
    const { mime, b64 } = requireInlineImage(normalizeImagePart(part).url, 'Gemini')
    return { inlineData: { mimeType: mime, data: b64 } }
  }
  if (part?.type === 'text') return { text: part.text ?? '' }
  return { text: String(part?.text ?? part ?? '') }
}

// Gemini's usageMetadata: promptTokenCount is the full prompt (cachedContent
// is a subset), candidatesTokenCount includes thoughtsTokenCount on the
// Gemini API (Vertex behaves differently — we target Gemini API here).
export function normalizeGeminiUsage(raw) {
  if (!raw) return null
  const inputTokens = raw.promptTokenCount ?? 0
  const outputTokens = raw.candidatesTokenCount ?? 0
  const totalTokens = raw.totalTokenCount ?? (inputTokens + outputTokens)
  const out = { inputTokens, outputTokens, totalTokens, raw }
  if (raw.cachedContentTokenCount != null) out.cachedInputTokens = raw.cachedContentTokenCount
  if (raw.thoughtsTokenCount != null) out.reasoningTokens = raw.thoughtsTokenCount
  return out
}

function safeParse(text) {
  try { return JSON.parse(text) } catch { return {} }
}
