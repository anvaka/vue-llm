// Shrink over-cap images so a request fits the provider's limit.
//
// Providers reject an oversized image outright, and the limit is measured on the
// BASE64 STRING, not the decoded file — Anthropic's 400 names the field it
// counted (`content.1.image.source.base64: image exceeds 5 MB maximum:
// 6755172 bytes > 5242880 bytes`). Base64 inflates by 4/3, so a 4.8 MB photo is
// a 6.4 MB payload: any check against `file.size` lets a whole band of files
// through. Everything here measures the encoded length.
//
// Compressing rather than erroring is the useful default — a phone photo is
// routinely over the cap, and the caller almost never wants the request to fail
// when a re-encode would have worked. LLMClient applies this automatically using
// the active provider's `maxImageBytes`.
//
// Browser-only (canvas). In Node — tests, SSR — the environment check fails and
// messages pass through untouched, so nothing throws off-DOM.

import { toParts, parseImageUrl } from './imageContent.js'

const DEFAULT_QUALITY = 0.85
const MAX_ATTEMPTS = 8
// Shrink by 25% per attempt after the first re-encode.
const SCALE_STEP = 0.75

// Bytes of base64 payload in a data URL — the number providers actually count.
export function encodedBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? 0 : dataUrl.length - comma - 1
}

// DOM primitives are injectable so the logic is testable off-DOM.
const domEnv = {
  isSupported: () => typeof document !== 'undefined' && typeof Image !== 'undefined',
  loadImage: (src) => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = src
  }),
  encode: (img, width, height, quality) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    // JPEG has no alpha channel; fill white first so transparent regions don't
    // come out black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', quality)
  }
}

// Re-encode a data URL until its base64 payload fits `maxBytes`.
//
// The first attempt re-encodes at FULL resolution: switching a screenshot PNG to
// JPEG often wins more than any resize would, so it's worth trying before giving
// up pixels. Later attempts also scale the dimensions down.
//
// Returns { url, mime, width, height, fromBytes, toBytes }, or null when the
// input already fits, isn't inline, or can't be brought under the cap.
export async function shrinkImageDataUrl(dataUrl, maxBytes, { quality = DEFAULT_QUALITY, env = domEnv } = {}) {
  if (!maxBytes || !env.isSupported()) return null
  const fromBytes = encodedBytes(dataUrl)
  if (fromBytes <= maxBytes) return null
  // Remote URLs have no payload for us to compress — the provider fetches them.
  let parsed
  try { parsed = parseImageUrl(dataUrl) } catch { return null }
  if (parsed.kind !== 'data') return null

  const img = await env.loadImage(dataUrl)
  const baseWidth = img.naturalWidth || img.width
  const baseHeight = img.naturalHeight || img.height
  if (!baseWidth || !baseHeight) return null

  let scale = 1
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) scale *= SCALE_STEP
    const width = Math.max(1, Math.round(baseWidth * scale))
    const height = Math.max(1, Math.round(baseHeight * scale))
    const url = env.encode(img, width, height, quality)
    const toBytes = encodedBytes(url)
    if (toBytes <= maxBytes) {
      return { url, mime: 'image/jpeg', width, height, fromBytes, toBytes }
    }
  }
  return null
}

// Walk a canonical message list and shrink every inline image part over the cap.
// Non-mutating: only the messages and parts that actually change are rebuilt.
//
// `onResize({ messageIndex, partIndex, fromBytes, toBytes, width, height, mime })`
// fires per image so a UI can report what happened.
export async function fitImageParts(messages, { maxBytes, quality, onResize, env = domEnv } = {}) {
  if (!maxBytes || !Array.isArray(messages) || !env.isSupported()) return messages
  let out = messages
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (!Array.isArray(message?.content)) continue
    let parts = message.content
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]
      if (part?.type !== 'image_url') continue
      const raw = part.image_url
      const url = typeof raw === 'string' ? raw : raw?.url
      if (typeof url !== 'string') continue

      let shrunk = null
      try {
        shrunk = await shrinkImageDataUrl(url, maxBytes, { quality, env })
      } catch {
        // A decode failure shouldn't take down the whole request — let the
        // original through and give the provider the final say.
        shrunk = null
      }
      if (!shrunk) continue

      if (parts === message.content) parts = parts.slice()
      parts[partIndex] = typeof raw === 'string'
        ? { ...part, image_url: shrunk.url }
        : { ...part, image_url: { ...raw, url: shrunk.url } }
      onResize && onResize({ messageIndex, partIndex, ...shrunk })
    }
    if (parts !== message.content) {
      if (out === messages) out = messages.slice()
      out[messageIndex] = { ...message, content: parts }
    }
  }
  return out
}

// True when any message carries an inline image whose payload exceeds the cap.
export function hasOversizedImages(messages, maxBytes) {
  if (!maxBytes || !Array.isArray(messages)) return false
  return messages.some(m => toParts(m?.content).some(p => {
    if (p?.type !== 'image_url') return false
    const raw = p.image_url
    const url = typeof raw === 'string' ? raw : raw?.url
    return typeof url === 'string' && url.startsWith('data:') && encodedBytes(url) > maxBytes
  }))
}
