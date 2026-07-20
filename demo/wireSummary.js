// Summarize the image payloads in a prepared request body.
//
// The same attachment lands on the wire in a different shape for every provider
// family — that divergence is the whole reason src/providers/imageContent.js
// exists, so the playground shows it rather than describing it.
//
// Payloads are reported by SIZE, never inlined: a base64 image is megabytes of
// noise that would bury every other field in the panel.

export function fmtBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function b64Bytes(b64) {
  if (typeof b64 !== 'string') return 0
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(b64.length * 3 / 4) - padding)
}

function describeUrl(url) {
  if (typeof url !== 'string') return { note: 'unreadable' }
  const m = /^data:([^;,]+)/.exec(url)
  return m
    ? { mime: m[1], size: fmtBytes(b64Bytes(url.slice(url.indexOf(',') + 1))) }
    : { url }
}

// Walks a JSON-derived request body (no cycles possible — it came from
// JSON.parse of the outgoing fetch body).
export function summarizeImages(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) summarizeImages(item, found)
    return found
  }
  if (!node || typeof node !== 'object') return found

  // OpenAI / Grok / OpenRouter / llama.cpp / Custom: {type:'image_url', image_url:{url}}
  if (node.type === 'image_url' && node.image_url) {
    const url = typeof node.image_url === 'string' ? node.image_url : node.image_url.url
    found.push({ as: 'image_url', ...describeUrl(url) })
    return found
  }
  // Bedrock Responses: {type:'input_image', image_url:'<url>'}
  if (node.type === 'input_image' && node.image_url) {
    found.push({ as: 'input_image', ...describeUrl(node.image_url) })
    return found
  }
  // Anthropic: {type:'image', source:{type:'base64', media_type, data}}
  if (node.type === 'image' && node.source) {
    found.push(node.source.type === 'base64'
      ? { as: 'source.base64', mime: node.source.media_type, size: fmtBytes(b64Bytes(node.source.data)) }
      : { as: `source.${node.source.type}`, url: node.source.url })
    return found
  }
  // Gemini: {inlineData:{mimeType, data}}
  if (node.inlineData) {
    found.push({ as: 'inlineData', mime: node.inlineData.mimeType, size: fmtBytes(b64Bytes(node.inlineData.data)) })
    return found
  }
  // Ollama: images ride OUTSIDE content, as bare base64 strings.
  if (Array.isArray(node.images) && node.images.length && typeof node.images[0] === 'string') {
    for (const b64 of node.images) {
      found.push({ as: 'message.images[]', mime: '(sniffed)', size: fmtBytes(b64Bytes(b64)) })
    }
  }
  for (const value of Object.values(node)) summarizeImages(value, found)
  return found
}
