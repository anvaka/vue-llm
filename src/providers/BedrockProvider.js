import { BaseProvider } from './BaseProvider.js'
import { AnthropicProvider } from './AnthropicProvider.js'

// Static list of Anthropic Claude inference profiles on Bedrock, used as the
// default dropdown and as the offline fallback for discovery. Live discovery
// against the control plane IS possible with a Bedrock API key (see
// discoverModels below) but is opt-in; this list keeps the dropdown populated
// without a network call. Users can also paste any inference-profile id into
// the model field directly.
export const BEDROCK_CLAUDE_MODELS = [
  'us.anthropic.claude-opus-4-8',
  'us.anthropic.claude-opus-4-7',
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'us.anthropic.claude-opus-4-1-20250805-v1:0'
]

export class BedrockProvider extends AnthropicProvider {
  prepareRequest(messages, options) {
    const request = super.prepareRequest(messages, options)
    // Bedrock InvokeModel expects the model in the URL path, not the body,
    // and a fixed anthropic_version tag instead of the live API version.
    // We leave `model` on the request object here and strip it inside
    // make[Streaming]Request so the URL builder can read it back.
    delete request.stream
    request.anthropic_version = 'bedrock-2023-05-31'
    return request
  }

  buildHeaders() {
    // Skip AnthropicProvider's headers (anthropic-version, dangerous-direct-
    // browser-access) — Bedrock doesn't accept them.
    return BaseProvider.prototype.buildHeaders.call(this)
  }

  getAuthHeaderName() { return 'Authorization' }
  getAuthHeaderValue() { return `Bearer ${this.config.apiKey}` }
  requiresAuth() { return !!this.config.apiKey }

  async makeRequest(request, signal, requestId) {
    const model = request.model
    const url = `${this.config.baseUrl}/model/${encodeURIComponent(model)}/invoke`

    const abortController = signal ? { signal } : new AbortController()
    if (!signal) {
      requestId = requestId || this.generateRequestId()
      this.activeRequests.set(requestId, abortController)
    }
    // Re-snapshot the body per attempt so the temperature self-heal (which
    // mutates `request` in place) is picked up on retry. `model` lives in the URL,
    // not the body.
    const send = () => {
      const body = { ...request }
      delete body.model
      return fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: abortController.signal || signal
      })
    }
    try {
      const response = await this._sendWithTemperatureRetry(send, request, 'Bedrock API Error')
      return response.json()
    } finally {
      if (!signal && requestId) this.activeRequests.delete(requestId)
    }
  }

  async makeStreamingRequest(request, signal) {
    const model = request.model
    const url = `${this.config.baseUrl}/model/${encodeURIComponent(model)}/invoke-with-response-stream`
    const send = () => {
      const body = { ...request }
      delete body.model
      return fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal
      })
    }

    const upstream = await this._sendWithTemperatureRetry(send, request, 'Bedrock API Error')

    // Wrap the binary event-stream body in a ReadableStream that emits
    // SSE-formatted text lines. AnthropicProvider.parseStreamingLine already
    // understands `data: {json}` lines, so the inherited streamRequest pipeline
    // works unchanged.
    const reader = upstream.body.getReader()
    const decoder = new EventStreamDecoder()
    const encoder = new TextEncoder()

    const sseBody = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          const events = decoder.feed(value)
          for (const evt of events) {
            if (evt.kind === 'error') {
              controller.error(new Error(evt.message))
              return
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt.payload)}\n`))
          }
        } catch (err) {
          controller.error(err)
        }
      },
      cancel(reason) {
        try { reader.cancel(reason) } catch { /* ignore */ }
      }
    })

    return new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  // Live discovery is opt-in via config.liveModelDiscovery. A Bedrock API key
  // authenticates against the control plane with Bearer auth (no SigV4), and
  // the control-plane host returns permissive CORS headers, so a browser fetch
  // works. When disabled (default) or on any failure, fall back to the static
  // list — existing apps keep working with zero surprise network calls.
  // `force` is set when the user explicitly clicks Refresh in the UI; it
  // bypasses the opt-in `liveModelDiscovery` gate so the button actually queries
  // the control plane. Automatic loads (provider change / edit) leave `force`
  // unset and keep the "no surprise network calls" default.
  async discoverModels(timeoutMs = 10000, { force = false } = {}) {
    if ((!force && !this.config.liveModelDiscovery) || !this.getModelsEndpoint()) {
      return BEDROCK_CLAUDE_MODELS.slice()
    }
    try {
      const models = await super.discoverModels(timeoutMs)
      return models.length ? models : BEDROCK_CLAUDE_MODELS.slice()
    } catch {
      return BEDROCK_CLAUDE_MODELS.slice()
    }
  }

  // The control plane lives at the same host with the `-runtime` segment
  // stripped: bedrock-runtime.{region}.amazonaws.com (invoke) ->
  // bedrock.{region}.amazonaws.com (ListInferenceProfiles). Returns null when
  // no distinct control-plane host can be derived (custom/relative baseUrl),
  // which disables live discovery and leaves the static fallback in place.
  getModelsEndpoint() {
    const base = this.config.baseUrl || ''
    const controlPlane = base.replace('bedrock-runtime.', 'bedrock.')
    if (!controlPlane || controlPlane === base) return null
    return `${controlPlane}/inference-profiles`
  }

  // ListInferenceProfiles returns
  //   { inferenceProfileSummaries: [{ inferenceProfileId, ... }] }
  // Keep only Anthropic Claude profiles (us.* and global.*) — those ids are
  // exactly what InvokeModel expects in the URL path.
  parseModelsResponse(data) {
    const summaries = data?.inferenceProfileSummaries
    if (!Array.isArray(summaries)) return BEDROCK_CLAUDE_MODELS.slice()
    const ids = summaries
      .map(p => p?.inferenceProfileId)
      .filter(id => typeof id === 'string' && id.includes('anthropic.claude'))
    return ids.length ? ids : BEDROCK_CLAUDE_MODELS.slice()
  }
}

// Parser for AWS event-stream framing (application/vnd.amazon.eventstream).
// Frame layout (big-endian):
//   4B total_len | 4B headers_len | 4B prelude_crc | headers | payload | 4B msg_crc
// Headers are a packed sequence of: 1B name_len | name | 1B value_type | value.
// For Bedrock streaming we only need value_type 7 (utf-8 string); other types
// are skipped by terminating the header loop, which is safe because we only
// read header keys to detect exception frames.
class EventStreamDecoder {
  constructor() {
    this.buf = new Uint8Array(0)
    this.textDecoder = new TextDecoder()
  }

  feed(chunk) {
    if (chunk && chunk.length) {
      const next = new Uint8Array(this.buf.length + chunk.length)
      next.set(this.buf, 0)
      next.set(chunk, this.buf.length)
      this.buf = next
    }
    const events = []
    while (this.buf.length >= 12) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
      const totalLen = view.getUint32(0, false)
      const headersLen = view.getUint32(4, false)
      if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
        throw new Error(`Bedrock event stream: invalid frame length ${totalLen}`)
      }
      if (this.buf.length < totalLen) break

      const headersStart = 12
      const headersEnd = headersStart + headersLen
      const payloadStart = headersEnd
      const payloadEnd = totalLen - 4
      const headers = parseEventStreamHeaders(this.buf.subarray(headersStart, headersEnd))
      const payloadText = this.textDecoder.decode(this.buf.subarray(payloadStart, payloadEnd))
      this.buf = this.buf.subarray(totalLen)

      let parsed
      try { parsed = JSON.parse(payloadText) } catch { parsed = null }

      const messageType = headers[':message-type']
      const exceptionType = headers[':exception-type']
      if (messageType === 'exception' || exceptionType) {
        const name = exceptionType || headers[':event-type'] || 'BedrockStreamException'
        const msg = parsed?.message || payloadText || 'unknown error'
        events.push({ kind: 'error', message: `${name}: ${msg}` })
        continue
      }

      if (parsed && typeof parsed.bytes === 'string') {
        try {
          const decoded = decodeBase64Utf8(parsed.bytes)
          const inner = JSON.parse(decoded)
          events.push({ kind: 'event', payload: inner })
        } catch (e) {
          events.push({ kind: 'error', message: `Bedrock event-stream decode failed: ${e.message}` })
        }
      }
    }
    return events
  }
}

function parseEventStreamHeaders(bytes) {
  const headers = {}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dec = new TextDecoder()
  let p = 0
  while (p < bytes.length) {
    const nameLen = bytes[p]; p += 1
    if (p + nameLen > bytes.length) break
    const name = dec.decode(bytes.subarray(p, p + nameLen))
    p += nameLen
    if (p >= bytes.length) break
    const valueType = bytes[p]; p += 1
    if (valueType === 7) {
      if (p + 2 > bytes.length) break
      const valueLen = view.getUint16(p, false); p += 2
      if (p + valueLen > bytes.length) break
      headers[name] = dec.decode(bytes.subarray(p, p + valueLen))
      p += valueLen
    } else {
      // Unsupported type for our use — bail to avoid misalignment.
      break
    }
  }
  return headers
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
