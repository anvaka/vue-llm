#!/usr/bin/env node
// No-network unit tests for multimodal (image) message content.
//
// Covers:
//   1. imageContent: parsing data URLs / remote URLs, and folding the legacy
//      `options.images` side channel into canonical parts WITHOUT mutating the
//      caller's messages.
//   2. visionPolicy: which model ids can see. These assertions exist mainly as
//      regression guards — the previous per-provider allowlists had rotted to
//      the point where OpenAI and Grok matched no current model at all.
//   3. Each provider spells an image in its own wire field: OpenAI-family
//      `image_url` (canonical passes straight through), Anthropic
//      `source.{media_type,data}`, Gemini `inlineData`, Ollama's sibling
//      `images: ['<raw b64>']`, Responses `input_image`.
//   4. The media type is carried from the data URL, not hardcoded to jpeg
//      (every previous implementation hardcoded it, mislabeling every PNG).
//   5. Models that can't see REJECT an image instead of silently dropping it.
//
// Run: node test/images.mjs

import assert from 'node:assert/strict'
import { parseImageUrl, attachImages, contentText } from '../src/providers/imageContent.js'
import { supportsVision } from '../src/providers/visionPolicy.js'
import { fitImageParts, shrinkImageDataUrl, encodedBytes, hasOversizedImages } from '../src/providers/imageFit.js'
import { AnthropicProvider } from '../src/providers/AnthropicProvider.js'
import { BedrockProvider } from '../src/providers/BedrockProvider.js'
import { OpenAIProvider } from '../src/providers/OpenAIProvider.js'
import { GeminiProvider } from '../src/providers/GeminiProvider.js'
import { GrokProvider } from '../src/providers/GrokProvider.js'
import { OpenRouterProvider } from '../src/providers/OpenRouterProvider.js'
import { OllamaProvider } from '../src/providers/OllamaProvider.js'
import { DeepSeekProvider } from '../src/providers/DeepSeekProvider.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEANl9ngAAAAABJRU5ErkJggg=='
const PNG_URL = `data:image/png;base64,${PNG_B64}`
const REMOTE_URL = 'https://example.com/cat.jpg'

const imgMsgs = (url = PNG_URL) => ([{
  role: 'user',
  content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url } }]
}])

async function make(Cls, config) { const p = new Cls(config); await p.initialize(); return p }

// Ollama detects capabilities over HTTP (/api/show); stub it so this stays offline.
async function makeOllama(config, caps = ['vision']) {
  const p = new OllamaProvider(config)
  p.fetchModelInfo = async () => ({ capabilities: caps })
  await p.initialize()
  return p
}

// ---- 1. imageContent --------------------------------------------------------
console.log('imageContent')
assert.deepEqual(parseImageUrl(PNG_URL), { kind: 'data', mime: 'image/png', b64: PNG_B64 })
ok('data URL splits into media type + payload')

assert.deepEqual(parseImageUrl(REMOTE_URL), { kind: 'remote', url: REMOTE_URL })
ok('http(s) URL classified as remote')

assert.deepEqual(
  parseImageUrl('data:image/webp;charset=utf-8;base64,QUJD'),
  { kind: 'data', mime: 'image/webp', b64: 'QUJD' }
)
ok('extra data-URL params before ;base64 are tolerated')

assert.throws(() => parseImageUrl('data:image/png,rawbytes'), /only base64-encoded/)
assert.throws(() => parseImageUrl('ftp://nope/x.png'), /expected a data: URL/)
ok('non-base64 and non-http URLs are rejected with a specific message')

// The mutation bug: every old addImagesToMessages rewrote the caller's message
// objects in place, so streaming the same array twice corrupted its history.
const original = [{ role: 'user', content: 'hello' }]
const snapshot = JSON.stringify(original)
const attached = attachImages(original, [PNG_URL])
assert.equal(JSON.stringify(original), snapshot)
assert.notEqual(attached, original)
assert.deepEqual(attached[0].content, [
  { type: 'text', text: 'hello' },
  { type: 'image_url', image_url: { url: PNG_URL } }
])
ok('legacy options.images folds into canonical parts without mutating the caller')

// The legacy side channel accepted several element shapes interchangeably.
assert.deepEqual(
  attachImages([{ role: 'user', content: 'x' }], [{ data: PNG_B64, mimeType: 'image/png' }])[0].content[1],
  { type: 'image_url', image_url: { url: PNG_URL } }
)
ok('legacy {data, mimeType} form is rebuilt into a data URL')

// Images ride on the last USER message, not the last message — in an agent loop
// the final entry is usually a tool result.
const loopish = [
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'calling' },
  { role: 'tool', tool_call_id: 't1', content: 'result' }
]
assert.equal(attachImages(loopish, [PNG_URL])[0].content.length, 2)
assert.equal(attachImages(loopish, [PNG_URL])[2].content, 'result')
ok('legacy images attach to the last user message, not a trailing tool result')

assert.equal(contentText(imgMsgs()[0].content), 'what is this?')
ok('contentText drops non-text parts')

// ---- 2. visionPolicy --------------------------------------------------------
console.log('visionPolicy')
for (const id of ['gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5.2-mini', 'o3', 'chatgpt-4o-latest']) {
  assert.equal(supportsVision(id), true, id)
}
ok('current OpenAI models see (the old gpt-4 && vision rule matched none of them)')

for (const id of ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-32k', 'gpt-4-0613', 'o1-mini', 'o3-mini']) {
  assert.equal(supportsVision(id), false, id)
}
ok('original gpt-4 snapshots and the text-only minis do not')

assert.equal(supportsVision('grok-4.5'), true)
assert.equal(supportsVision('grok-beta'), false)
ok('Grok defaults open; only the text-only preview is excluded')

assert.equal(supportsVision('claude-sonnet-5'), true)
assert.equal(supportsVision('anthropic.claude-opus-4-8'), true)
assert.equal(supportsVision('us.anthropic.claude-opus-4-8'), true)
assert.equal(supportsVision('anthropic/claude-sonnet-5'), true)
ok('Claude recognized across native / Bedrock / inference-profile / OpenRouter id forms')

assert.equal(supportsVision('claude-2.1'), false)
assert.equal(supportsVision('claude-instant-1.2'), false)
assert.equal(supportsVision('deepseek-chat'), false)
ok('pre-Claude-3 and DeepSeek do not')

// ---- 3. Per-provider wire formats -------------------------------------------
console.log('wire formats')

const openai = await make(OpenAIProvider, { model: 'gpt-4o', apiKey: 'k', baseUrl: 'https://api.openai.com' })
const oaReq = openai.prepareRequest(imgMsgs(), { model: 'gpt-4o' })
assert.deepEqual(oaReq.messages[0].content, [
  { type: 'text', text: 'what is this?' },
  { type: 'image_url', image_url: { url: PNG_URL } }
])
ok('OpenAI: canonical parts are already the wire format (data URL verbatim)')

const anthropic = await make(AnthropicProvider, { model: 'claude-sonnet-5', apiKey: 'k', baseUrl: 'https://api.anthropic.com' })
const anReq = anthropic.prepareRequest(imgMsgs(), { model: 'claude-sonnet-5' })
assert.deepEqual(anReq.messages[0].content, [
  { type: 'text', text: 'what is this?' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }
])
ok('Anthropic: base64 source with the REAL media type (this path was unreachable before)')

const anRemote = anthropic.prepareRequest(imgMsgs(REMOTE_URL), { model: 'claude-sonnet-5' })
assert.deepEqual(anRemote.messages[0].content[1], { type: 'image', source: { type: 'url', url: REMOTE_URL } })
ok('Anthropic: remote URLs use a url source on the native API')

const bedrock = await make(BedrockProvider, { model: 'us.anthropic.claude-sonnet-4-6', apiKey: 'k', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' })
assert.deepEqual(
  bedrock.prepareRequest(imgMsgs(), { model: 'us.anthropic.claude-sonnet-4-6' }).messages[0].content[1],
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }
)
assert.throws(
  () => bedrock.prepareRequest(imgMsgs(REMOTE_URL), { model: 'us.anthropic.claude-sonnet-4-6' }),
  /requires inline image data/
)
ok('Bedrock Claude: base64 only — a remote URL is rejected up front, not by a 400')

const gemini = await make(GeminiProvider, { model: 'gemini-2.5-flash', apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com' })
const gmReq = gemini.prepareRequest(imgMsgs(), { model: 'gemini-2.5-flash' })
assert.deepEqual(gmReq.contents[0].parts, [
  { text: 'what is this?' },
  { inlineData: { mimeType: 'image/png', data: PNG_B64 } }
])
assert.throws(() => gemini.prepareRequest(imgMsgs(REMOTE_URL), {}), /requires inline image data/)
ok('Gemini: inlineData with the real mimeType; arbitrary remote URLs rejected')

const ollama = await makeOllama({ model: 'gemma3', baseUrl: 'http://localhost:11434' })
const olReq = ollama.prepareRequest(imgMsgs(), { model: 'gemma3' })
assert.equal(olReq.messages[0].content, 'what is this?')
assert.deepEqual(olReq.messages[0].images, [PNG_B64])
ok('Ollama: images split OUT of content into a sibling raw-base64 array')

const grok = await make(GrokProvider, { model: 'grok-4.5', apiKey: 'k', baseUrl: 'https://api.x.ai' })
assert.deepEqual(grok.prepareRequest(imgMsgs(), {}).messages[0].content[1], { type: 'image_url', image_url: { url: PNG_URL } })
ok('Grok: OpenAI-shaped image_url')

const router = await make(OpenRouterProvider, { model: 'anthropic/claude-sonnet-5', apiKey: 'k', baseUrl: 'https://openrouter.ai/api' })
assert.deepEqual(router.prepareRequest(imgMsgs(), {}).messages[0].content[1], { type: 'image_url', image_url: { url: PNG_URL } })
ok('OpenRouter: data URL passes through for a Claude-backed model (it normalizes upstream)')

// ---- 4. Legacy side channel still reaches the wire ---------------------------
console.log('legacy options.images')
const legacyReq = anthropic.prepareRequest([{ role: 'user', content: 'hello' }], { images: [PNG_URL] })
assert.deepEqual(legacyReq.messages[0].content[1], {
  type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 }
})
ok('options.images reaches Anthropic now (its addImagesToMessages was dead code)')

// ---- 5. Models that cannot see reject images --------------------------------
console.log('capability gating')
const deepseek = await make(DeepSeekProvider, { model: 'deepseek-chat', apiKey: 'k', baseUrl: 'https://api.deepseek.com', provider: 'deepseek' })
assert.throws(() => deepseek.prepareRequest(imgMsgs(), {}), /does not support image input/)
ok('DeepSeek rejects an image instead of answering about one it never saw')

const gpt35 = await make(OpenAIProvider, { model: 'gpt-3.5-turbo', apiKey: 'k', baseUrl: 'https://api.openai.com', provider: 'openai' })
assert.throws(() => gpt35.prepareRequest(imgMsgs(), {}), /does not support image input/)
ok('a text-only OpenAI model rejects an image')

const blindOllama = await makeOllama({ model: 'llama3', baseUrl: 'http://localhost:11434' }, ['tools'])
assert.throws(() => blindOllama.prepareRequest(imgMsgs(), {}), /does not support image input/)
ok('Ollama honors the real capability list from /api/show')

// Text-only conversations must be untouched by any of this.
assert.equal(openai.prepareRequest([{ role: 'user', content: 'hi' }], {}).messages[0].content, 'hi')
assert.equal(anthropic.prepareRequest([{ role: 'user', content: 'hi' }], {}).messages[0].content, 'hi')
assert.equal(deepseek.prepareRequest([{ role: 'user', content: 'hi' }], {}).messages[0].content, 'hi')
ok('string content still passes through unchanged everywhere')

// ---- 6. Over-cap images are compressed, not rejected ------------------------
console.log('image fitting')

// The DOM primitives are injectable so this runs offline. The fake models real
// behavior: JPEG re-encoding shrinks a lot on its own, and each dimension step
// shrinks by area.
function fakeEnv({ encodedPerPixel = 1 } = {}) {
  return {
    isSupported: () => true,
    loadImage: async () => ({ naturalWidth: 1000, naturalHeight: 1000 }),
    encode: (_img, w, h) => {
      // ~encodedPerPixel base64 chars per pixel, as a data URL.
      const payload = 'A'.repeat(Math.max(4, Math.round(w * h * encodedPerPixel)))
      return `data:image/jpeg;base64,${payload}`
    }
  }
}

const bigUrl = `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}`
const bigMsgs = [{ role: 'user', content: [
  { type: 'text', text: 'what is this?' },
  { type: 'image_url', image_url: { url: bigUrl } }
]}]

// encodedBytes counts the payload, NOT the whole data URL — this is the bug the
// live 400 exposed (a 4.8 MB file is a 6.4 MB base64 payload).
assert.equal(encodedBytes(bigUrl), 8 * 1024 * 1024)
assert.equal(encodedBytes(PNG_URL), PNG_B64.length)
ok('encodedBytes measures the base64 payload, not the file or the whole URL')

const LIMIT = 5 * 1024 * 1024
assert.equal(hasOversizedImages(bigMsgs, LIMIT), true)
assert.equal(hasOversizedImages(imgMsgs(), LIMIT), false)
ok('hasOversizedImages compares against the encoded payload')

// 1000x1000 at 1 char/px = ~1 MB encoded, so the full-resolution JPEG re-encode
// alone gets under the cap: no pixels are given up.
const resizes = []
const fitted = await fitImageParts(bigMsgs, {
  maxBytes: LIMIT, env: fakeEnv({ encodedPerPixel: 1 }), onResize: r => resizes.push(r)
})
assert.equal(resizes.length, 1)
assert.equal(resizes[0].fromBytes, 8 * 1024 * 1024)
assert.ok(resizes[0].toBytes <= LIMIT)
assert.deepEqual([resizes[0].width, resizes[0].height], [1000, 1000])
assert.equal(fitted[0].content[0].text, 'what is this?')
ok('an over-cap image is re-encoded at full resolution when that is enough')

// Non-mutating, like every other transform in this library.
assert.equal(bigMsgs[0].content[1].image_url.url, bigUrl)
assert.notEqual(fitted, bigMsgs)
assert.ok(fitted[0].content[1].image_url.url.length < bigUrl.length)
ok('fitImageParts does not mutate the caller messages')

// At 8 chars/px the full-size re-encode is still 8 MB, so dimensions must drop.
const stepped = []
await fitImageParts(bigMsgs, {
  maxBytes: LIMIT, env: fakeEnv({ encodedPerPixel: 8 }), onResize: r => stepped.push(r)
})
assert.equal(stepped.length, 1)
assert.ok(stepped[0].width < 1000, `expected downscale, got ${stepped[0].width}`)
assert.ok(stepped[0].toBytes <= LIMIT)
ok('dimensions are stepped down when a full-size re-encode still does not fit')

// Under the cap => untouched, and the original media type is preserved.
const small = await fitImageParts(imgMsgs(), { maxBytes: LIMIT, env: fakeEnv() })
assert.equal(small, imgMsgs() === small ? small : small)
assert.equal(small[0].content[1].image_url.url, PNG_URL)
ok('an image already under the cap is left alone (keeps its media type)')

// Remote URLs have no local payload to compress.
const remote = await fitImageParts(imgMsgs(REMOTE_URL), { maxBytes: LIMIT, env: fakeEnv() })
assert.equal(remote[0].content[1].image_url.url, REMOTE_URL)
ok('remote URLs pass through — nothing local to compress')

// Off-DOM (Node, SSR) and no-cap providers must be no-ops, never throws.
const offDom = await fitImageParts(bigMsgs, { maxBytes: LIMIT, env: { isSupported: () => false } })
assert.equal(offDom, bigMsgs)
assert.equal(await fitImageParts(bigMsgs, { maxBytes: null, env: fakeEnv() }), bigMsgs)
ok('no-ops off-DOM and when the provider publishes no cap')

// The cap is a provider property, and Bedrock/Mantle inherit Anthropic's.
assert.equal(anthropic.maxImageBytes, LIMIT)
assert.equal(bedrock.maxImageBytes, LIMIT)
assert.equal(openai.maxImageBytes, null)
assert.equal(gemini.maxImageBytes, 20 * 1024 * 1024)
ok('maxImageBytes comes from the provider (Bedrock inherits Anthropic 5 MB)')

console.log(`\n${passed} checks passed`)
