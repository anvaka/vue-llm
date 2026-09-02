#!/usr/bin/env node
// A tool that produced a PICTURE.
//
// A tool result is a string, and was unconditionally stringified:
//
//     resultText = typeof out === 'string' ? out : JSON.stringify(out ?? '')
//
// so an executor holding bytes worth looking at had no way to put them in front
// of the model. `conversation` is a private slice(), so the caller could not
// reach in either. The only door was the caller's own next turn — which is a
// turn later than the tool call that fetched the picture, and by then the model
// has already answered without it.
//
// Executors may now return `{ text, images }`. The text still answers the call;
// the pictures arrive as one user message after every result, which is the one
// shape every vision-capable provider here accepts.
//
// Run: node test/tool-images.mjs

import { LLMClient } from '../src/core/LLMClient.js'

let failures = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEANl9ngAAAAABJRU5ErkJggg=='
const part = (url = PNG) => ({ type: 'image_url', image_url: { url } })
const call = (id, name) => ({ id, name, args: {} })

// Every request the loop makes, so we can ask what the model was actually SENT
// rather than only what the transcript ended up holding.
function scripted(steps) {
  const sent = []
  const c = new LLMClient({})
  c.ensureInitialized = async () => {}
  c.validateCapabilities = (o) => o
  c.costFor = () => null
  c.config = { model: 'stub-1', provider: 'stub' }
  let i = 0
  c.provider = {
    hasCapability: () => true,
    // No DOM in node, so fitImages is a real no-op here. That is the honest
    // shape: this test is about DELIVERY, and resizing has its own file.
    maxImageBytes: 0,
    streamRequest: async (conversation) => {
      sent.push(conversation.map((m) => ({ role: m.role, content: m.content, tool_calls: m.tool_calls })))
      return steps[i++] || { content: 'done', toolCalls: [], usage: null }
    }
  }
  return { c, sent }
}

const TOOLS = [{ name: 'look', description: 'x', parameters: { type: 'object', properties: {} } }]
const run = (c, executors, extra = {}) => c.runAgentLoop({
  messages: [{ role: 'user', content: 'what is in the file?' }],
  tools: TOOLS, executors, maxIters: 4, ...extra
})

// ── 1. the picture arrives, and the model is sent it ───────────────────────
console.log('\ndelivery')
{
  const { c, sent } = scripted([{ content: '', toolCalls: [call('t1', 'look')], usage: null }])
  const r = await run(c, { look: async () => ({ text: 'Opened /memory/portrait.png.', images: [part()] }) })

  const toolMsg = r.messages.find((m) => m.role === 'tool')
  check('the tool result is still the TEXT, and still a string',
    toolMsg?.content === 'Opened /memory/portrait.png.', `content=${JSON.stringify(toolMsg?.content)}`)

  const carrier = r.messages[r.messages.indexOf(toolMsg) + 1]
  check('the picture follows the result, as its own user message',
    carrier?.role === 'user' && Array.isArray(carrier.content), `role=${carrier?.role}`)
  check('and it carries the image part',
    carrier?.content?.some((p) => p.type === 'image_url' && p.image_url.url === PNG))

  // The message is in the USER's voice by necessity. Unannounced, a model reads
  // a photograph there as one the person just sent.
  check('with a bracketed note saying where it came from',
    carrier?.content?.[0]?.type === 'text' && /^\[1 image returned by the tool call above\]$/.test(carrier.content[0].text),
    JSON.stringify(carrier?.content?.[0]?.text))

  // The whole point: the NEXT request has to contain it, or nothing was
  // delivered and the transcript is just a nicer-looking log.
  const second = sent[1] || []
  check('the model is actually sent the picture on the next iteration',
    second.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url')),
    `iterations captured=${sent.length}`)
}

// ── 2. the transcript stays resumable ──────────────────────────────────────
// A tool_calls message with an unanswered id 400s the NEXT request, which is how
// this would surface: not here, but on the turn after.
{
  const { c } = scripted([{ content: '', toolCalls: [call('t1', 'look'), call('t2', 'look')], usage: null }])
  const r = await run(c, { look: async () => ({ text: 'ok', images: [part()] }) })
  const answered = new Set(r.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  const dangling = r.messages.flatMap((m) => (m.tool_calls || []).map((tc) => tc.id)).filter((id) => !answered.has(id))
  check('every tool call still has its result', dangling.length === 0, `dangling=${dangling}`)

  // Two calls, two pictures, ONE message — delivery is per iteration, not per
  // call, or a wave of tools interleaves pictures between results.
  const carriers = r.messages.filter((m) => m.role === 'user' && Array.isArray(m.content))
  check('two tools returning pictures deliver ONE message', carriers.length === 1, `carriers=${carriers.length}`)
  check('holding both pictures', carriers[0]?.content.filter((p) => p.type === 'image_url').length === 2)
  check('and the note counts them', /^\[2 images returned/.test(carriers[0]?.content[0]?.text || ''))

  const idx = r.messages.indexOf(carriers[0])
  const lastTool = r.messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0).pop()
  check('after ALL the results, never between them', idx > lastTool, `carrier=${idx} lastTool=${lastTool}`)
}

// ── 3. nothing else changes ────────────────────────────────────────────────
// The overwhelmingly common case is a tool returning a string, and it has to be
// byte-identical to what it was — this loop re-sends the whole transcript and
// the prefix is cached.
console.log('\nthe ordinary case is untouched')
{
  const { c } = scripted([{ content: '', toolCalls: [call('t1', 'look')], usage: null }])
  const r = await run(c, { look: async () => 'just a sentence' })
  check('a string result is the result', r.messages.find((m) => m.role === 'tool')?.content === 'just a sentence')
  check('and nothing is appended after it',
    !r.messages.some((m) => m.role === 'user' && Array.isArray(m.content)))
}
{
  // An object WITHOUT both fields is not the opt-in, and must still stringify.
  // Requiring both is what keeps this from colliding with an ordinary result
  // that happens to have a `text` key.
  const { c } = scripted([{ content: '', toolCalls: [call('t1', 'look')], usage: null }])
  const r = await run(c, { look: async () => ({ text: 'hi', note: 'no images key' }) })
  check('an object result without `images` is still JSON',
    r.messages.find((m) => m.role === 'tool')?.content === JSON.stringify({ text: 'hi', note: 'no images key' }))
}
{
  const { c } = scripted([{ content: '', toolCalls: [call('t1', 'look')], usage: null }])
  const r = await run(c, { look: async () => ({ images: [part()] }) })
  check('…and so is one without `text`',
    typeof r.messages.find((m) => m.role === 'tool')?.content === 'string'
    && !r.messages.some((m) => m.role === 'user' && Array.isArray(m.content)))
}

// ── 4. junk in the images array ────────────────────────────────────────────
{
  const { c } = scripted([{ content: '', toolCalls: [call('t1', 'look')], usage: null }])
  const r = await run(c, {
    look: async () => ({ text: 'ok', images: [null, { type: 'text', text: 'no' }, { type: 'image_url' }, part()] })
  })
  const carrier = r.messages.find((m) => m.role === 'user' && Array.isArray(m.content))
  check('only real image parts get through', carrier?.content.filter((p) => p.type === 'image_url').length === 1)
}
{
  // Filtered down to nothing means no message at all, rather than a user turn
  // that says "1 image" and carries none.
  const { c } = scripted([{ content: '', toolCalls: [call('t1', 'look')], usage: null }])
  const r = await run(c, { look: async () => ({ text: 'ok', images: [null, 'nope'] }) })
  check('all-junk delivers nothing, and claims nothing',
    !r.messages.some((m) => m.role === 'user' && Array.isArray(m.content)))
}

// ── 5. abort ───────────────────────────────────────────────────────────────
// Cancelling stops the SPEND. A carrier pushed after the abort would be a
// picture nobody asked for on a transcript nobody is going to send.
{
  const { c } = scripted([{ content: '', toolCalls: [call('t1', 'look')], usage: null }])
  const ac = new AbortController()
  const r = await run(c, { look: async () => { ac.abort(); return { text: 'ok', images: [part()] } } }, { signal: ac.signal })
  check('an aborted iteration delivers no picture',
    !r.messages.some((m) => m.role === 'user' && Array.isArray(m.content)), `stopReason=${r.stopReason}`)
  const answered = new Set(r.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  check('but still answers the call, so the transcript resumes',
    r.messages.flatMap((m) => (m.tool_calls || []).map((tc) => tc.id)).every((id) => answered.has(id)))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
