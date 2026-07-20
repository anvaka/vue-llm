// Multimodal message content — the one place the image wire formats diverge.
//
// A message's `content` is either a plain string or an ARRAY OF PARTS spelled
// the OpenAI Chat Completions way, which is the same flavor the rest of the
// canonical message shape already uses (see convertMessagesToAnthropic's header):
//
//   { type: 'text', text: string }
//   { type: 'image_url', image_url: { url: string, detail?: string } }
//
// `url` is either a `data:` URL — what a browser <input type="file"> hands you —
// or a remote http(s) URL.
//
// Providers split into two camps on the wire, and that split is the whole reason
// this module exists:
//   * take the data URL verbatim — OpenAI, Grok, OpenRouter, llama.cpp, Custom,
//     and Bedrock's OpenAI-compatible surfaces
//   * want the base64 payload and its media type as SEPARATE fields — Anthropic
//     (`source.media_type`/`source.data`), Gemini (`inlineData.mimeType`/`.data`),
//     Ollama (`images: ['<raw b64>']`)
// parseImageUrl() resolves that split once so a new provider never re-derives it,
// and so nobody hardcodes `image/jpeg` again — the previous per-provider copies
// each did, which silently mislabeled every PNG screenshot.

// data:<mime>[;param...];base64,<payload>. The payload runs to end-of-string and
// may contain newlines, hence the `s` flag.
const DATA_URL_RE = /^data:([^;,]+)(;[^,]*)?,(.*)$/s

// Pull `{ url, detail }` out of a canonical image part. Tolerates the flat
// `image_url: '<url>'` spelling (the Responses API uses it) alongside the
// nested `{ url }` object, since callers copy from whichever provider doc they
// happened to read.
export function normalizeImagePart(part) {
  const raw = part?.image_url
  const url = typeof raw === 'string' ? raw : raw?.url
  if (typeof url !== 'string' || !url) {
    throw new Error('Invalid image part: expected { type: "image_url", image_url: { url } }')
  }
  const detail = (raw && typeof raw === 'object' ? raw.detail : undefined) ?? part.detail
  return detail ? { url, detail } : { url }
}

// Classify an image reference: an inline base64 data URL (decomposed into its
// media type and payload) or a remote URL the provider must fetch itself.
export function parseImageUrl(url) {
  const m = DATA_URL_RE.exec(url)
  if (!m) {
    if (/^https?:\/\//i.test(url)) return { kind: 'remote', url }
    throw new Error(`Unsupported image URL — expected a data: URL or an http(s) URL, got "${String(url).slice(0, 40)}"`)
  }
  const mime = m[1] || 'image/jpeg'
  const params = m[2] || ''
  if (!params.includes('base64')) {
    throw new Error(`Unsupported image data URL — only base64-encoded data URLs are supported (got "data:${mime}${params}")`)
  }
  return { kind: 'data', mime, b64: m[3] }
}

// For providers that cannot dereference a remote URL themselves (Anthropic on
// Bedrock, Gemini, Ollama). Fetching it here on the caller's behalf is not an
// option: this library is browser-only, so an arbitrary image host would have to
// opt into CORS for it to work at all.
export function requireInlineImage(url, providerLabel) {
  const parsed = parseImageUrl(url)
  if (parsed.kind !== 'data') {
    throw new Error(`${providerLabel} requires inline image data — remote image URLs are not supported. Fetch the image yourself and pass a base64 data: URL.`)
  }
  return parsed
}

// Content as an array of parts, whatever form it arrived in.
export function toParts(content) {
  if (Array.isArray(content)) return content
  if (content == null) return []
  return [{ type: 'text', text: String(content) }]
}

// The text of a message, dropping any non-text parts. Used by providers whose
// wire format carries images OUTSIDE the content field (Ollama).
export function contentText(content) {
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content.filter(p => p?.type === 'text').map(p => p?.text ?? '').join('')
}

export function hasImageContent(content) {
  return Array.isArray(content) && content.some(p => p?.type === 'image_url')
}

export function messagesHaveImages(messages) {
  return Array.isArray(messages) && messages.some(m => hasImageContent(m?.content))
}

export function imagesUnsupportedError(model, provider) {
  const where = provider ? ` on provider '${provider}'` : ''
  return new Error(
    `Model '${model || 'unknown'}'${where} does not support image input. ` +
    'Remove the image parts from the conversation or switch to a vision-capable model.'
  )
}

// Back-compat for the pre-multimodal `options.images` side channel: fold that
// array onto the last user message as canonical image parts.
//
// NON-MUTATING by design. Every previous per-provider implementation rewrote the
// caller's message objects in place, so streaming the same conversation twice
// rewrote its history — and the second pass re-wrapped the already-converted
// array as `{type:'text', text: '[object Object]'}`.
export function attachImages(messages, images) {
  if (!Array.isArray(images) || !images.length || !Array.isArray(messages)) return messages
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { idx = i; break }
  }
  if (idx === -1) return messages
  const target = messages[idx]
  const copy = messages.slice()
  copy[idx] = { ...target, content: [...toParts(target.content), ...images.map(toImagePart)] }
  return copy
}

function toImagePart(img) {
  if (typeof img === 'string') return { type: 'image_url', image_url: { url: img } }
  if (img && typeof img === 'object') {
    if (img.type === 'image_url') return img
    // The legacy side channel accepted `{url}` (OpenAI-flavored callers) and
    // `{data, mimeType}` (Anthropic/Gemini-flavored ones) interchangeably.
    if (img.url) return { type: 'image_url', image_url: { url: img.url } }
    if (img.data) {
      const mime = img.mimeType || img.media_type || 'image/jpeg'
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${img.data}` } }
    }
  }
  throw new Error('Unsupported image reference — pass a data: URL, an http(s) URL, or { data, mimeType }')
}
