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

console.log(`\n${passed} checks passed`)
