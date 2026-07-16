#!/usr/bin/env node
// Offline regression tests — NO API keys, no network. Unlike providers.mjs
// (which needs a key per provider), this runs anywhere, so it can guard the two
// failure modes that are invisible until a real run is already spending money:
//
//  1. CAPABILITY DETECTION saying "this model can't call tools" about a model
//     that can. Silent: runAgentLoop just refuses to start, naming no model.
//  2. ABORT leaving a transcript that can't be resumed. Silent until the NEXT
//     request 400s on a tool_call with no matching tool_result.
//
// Both are tested WITH a control that reproduces the original bug, because a
// green assertion on a path the bug never touched proves nothing.
//
// Run: node test/capabilities-and-abort.mjs

import { AnthropicProvider } from '../src/providers/AnthropicProvider.js'
import { BedrockMantleProvider } from '../src/providers/BedrockMantleProvider.js'
import { CustomProvider } from '../src/providers/CustomProvider.js'
import { LLMClient } from '../src/core/LLMClient.js'

let failures = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// ── 1. Claude capability detection ─────────────────────────────────────────
// claude-fable-5 matched none of the old allowlist's family names
// ('claude-3'/'claude-sonnet'/'claude-opus'/'claude-haiku') and so came up with
// neither tools nor vision. The list could only ever name families that already
// existed, so it failed closed on every future one.
console.log('\nClaude capability detection')

const TOOL_CAPABLE = [
  'claude-fable-5', 'anthropic.claude-fable-5', 'us.anthropic.claude-fable-5',
  'global.anthropic.claude-fable-5',
  'claude-3-haiku-20240307', 'claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219',
  'claude-sonnet-4-20250514', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5',
  'claude-haiku-4-5-20251001', 'anthropic.claude-opus-4-8', 'us.anthropic.claude-sonnet-5',
  // Families that don't exist yet must default OPEN — the whole point.
  'claude-fable-6', 'claude-parable-7', 'claude-9-quux-20301231',
  '', undefined,   // unset → prepareRequest falls back to claude-3-sonnet, which has both
]
const PRE_TOOL = [
  'claude-2', 'claude-2.0', 'claude-2.1',
  'anthropic.claude-v2', 'anthropic.claude-v2:1', 'us.anthropic.claude-v2:1',
  'claude-instant-1', 'claude-instant-1.2', 'anthropic.claude-instant-v1',
]

const capsOf = async (model) => {
  const p = new AnthropicProvider({ model })
  await p.initialize()
  return p
}
let capsOk = true
for (const model of TOOL_CAPABLE) {
  const p = await capsOf(model)
  if (!p.hasCapability('tools') || !p.hasCapability('vision')) {
    capsOk = false
    console.log(`       ${JSON.stringify(model)} lost a capability`)
  }
}
check(`${TOOL_CAPABLE.length} current + not-yet-invented Claude ids keep tools + vision`, capsOk)

let legacyOk = true
for (const model of PRE_TOOL) {
  const p = await capsOf(model)
  if (p.hasCapability('tools') || p.hasCapability('vision')) {
    legacyOk = false
    console.log(`       ${JSON.stringify(model)} wrongly gained a capability`)
  }
}
check(`${PRE_TOOL.length} pre-3 ids (claude-2.x / instant) stay capability-free`, legacyOk)

// CONTROL: the old allowlist must fail this, or the two checks above are vacuous.
const oldAllowlist = (m) => !!(m?.includes('claude-3') || m?.includes('claude-sonnet') ||
                               m?.includes('claude-opus') || m?.includes('claude-haiku'))
const missedByOldLogic = TOOL_CAPABLE.filter(m => typeof m === 'string' && m && !oldAllowlist(m))
check('control: the old allowlist denies tools to fable (bug reproduces)',
  missedByOldLogic.some(m => m.includes('fable')), `${missedByOldLogic.length} ids it wrongly denied`)

// ── 2. Mantle router: capabilities survive a transport fallback ─────────────
// _active() is _order()[0], and _order() changes once _runWithFallback caches a
// winning sub — at a sub initialize() never touched, whose capability set is the
// empty one from the ctor.
console.log('\nMantle router capability staleness')
{
  const cfg = { model: 'openai.gpt-oss-120b', baseUrl: 'https://example.invalid', apiKey: 'k' }

  const control = new BedrockMantleProvider(cfg)
  const firstCandidate = control._order(cfg.model)[0]
  await firstCandidate.initialize()           // exactly what the old initialize() did
  control._resolved.set(cfg.model, control._responses)   // what a fallback caches
  check('control: old init loses tools after a fallback (bug reproduces)',
    control.hasCapability('tools') === false)

  const p = new BedrockMantleProvider(cfg)
  await p.initialize()
  p._chat.streamRequest = async () => { throw new Error("This model does not support the 'chat/completions' API") }
  p._responses.streamRequest = async () => ({ content: 'ok', toolCalls: [], usage: null })
  await p.streamRequest([{ role: 'user', content: 'hi' }], { model: cfg.model }, () => {})
  check('fallback actually happened', p._resolved.get(cfg.model) === p._responses)
  check('tools survive the fallback', p.hasCapability('tools'))
  check('the shared capability set follows the winning transport', p.capabilities.has('tools'))
}

// ── 3. runAgentLoop abort ──────────────────────────────────────────────────
// Only fetch is stubbed; the signal → streamRequest → fetch-controller path is real.
console.log('\nrunAgentLoop abort')

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`
const DONE = 'data: [DONE]\n\n'
const TOOLS = [{ type: 'function', function: { name: 'work', description: 'w', parameters: { type: 'object', properties: {} } } }]

function stubFetch(chunks, { gapMs = 5, instant = false } = {}) {
  const state = { emitted: 0 }
  const fn = (_url, init) => {
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        if (instant) {
          for (const c of chunks) { state.emitted++; controller.enqueue(enc.encode(c)) }
          controller.close()
          return
        }
        let i = 0
        const timer = setInterval(() => {
          if (i >= chunks.length) { clearInterval(timer); controller.close(); return }
          state.emitted++
          controller.enqueue(enc.encode(chunks[i++]))
        }, gapMs)
        init?.signal?.addEventListener('abort', () => {
          clearInterval(timer)
          const e = new Error('The operation was aborted'); e.name = 'AbortError'
          controller.error(e)
        }, { once: true })
      },
    })
    return Promise.resolve({ ok: true, status: 200, body, headers: new Headers() })
  }
  fn.state = state
  return fn
}

async function fakeClient(fetchImpl) {
  globalThis.fetch = fetchImpl
  const c = new LLMClient({})
  const p = new CustomProvider({ model: 'fake-1', baseUrl: 'https://example.invalid', apiKey: 'k' })
  await p.initialize()
  c.provider = p
  c.config = p.config
  c.ensureInitialized = async () => {}
  return c
}

// A transcript is resumable iff every assistant tool_call has a matching result.
const dangling = (messages) => {
  const answered = new Set(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id))
  return messages.flatMap(m => (m.tool_calls || []).map(tc => tc.id)).filter(id => !answered.has(id))
}

{
  const c = await fakeClient(stubFetch([sse({ choices: [{ delta: { content: 'done' } }] }), DONE], { instant: true }))
  const r = await c.runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, executors: {}, maxIters: 3 })
  check('no signal → unchanged behavior', r.stopReason === 'no-tool-calls', `stopReason=${r.stopReason}`)
}
{
  const f = stubFetch([sse({ choices: [{ delta: { content: 'x' } }] }), DONE])
  const c = await fakeClient(f)
  const ac = new AbortController(); ac.abort()
  const r = await c.runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, executors: {}, maxIters: 3, signal: ac.signal })
  check('pre-aborted → no request is made at all', r.stopReason === 'aborted' && f.state.emitted === 0 && r.iterations === 0,
    `stopReason=${r.stopReason} emitted=${f.state.emitted} iters=${r.iterations}`)
}
{
  const many = Array.from({ length: 200 }, (_, i) => sse({ choices: [{ delta: { content: `t${i} ` } }] }))
  const f = stubFetch([...many, DONE])
  const c = await fakeClient(f)
  const ac = new AbortController()
  const p = c.runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, executors: {}, maxIters: 3, signal: ac.signal })
  await new Promise(r => setTimeout(r, 60))
  const atAbort = f.state.emitted
  ac.abort()
  const r = await p
  await new Promise(r => setTimeout(r, 80))   // a live stream would add ~16 more here
  check('mid-stream → the fetch is really cut',
    r.stopReason === 'aborted' && f.state.emitted - atAbort <= 2 && f.state.emitted < 200,
    `emitted ${atAbort} at abort → ${f.state.emitted} after (of 200)`)
  check('mid-stream → cuts before the assistant message (transcript stays resumable)',
    !r.messages.some(m => m.role === 'assistant') && dangling(r.messages).length === 0)
}
{
  const c = await fakeClient(stubFetch([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'work', arguments: '{}' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'work', arguments: '{}' } }] } }] }),
    DONE,
  ], { instant: true }))
  const ac = new AbortController()
  let ran = 0
  const r = await c.runAgentLoop({
    messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, maxIters: 3, signal: ac.signal,
    executors: { work: async () => { ran++; ac.abort(); return 'did work' } },   // Stop lands during tool #1
  })
  const toolMsgs = r.messages.filter(m => m.role === 'tool')
  check('tool-phase abort → stops executing further tools', r.stopReason === 'aborted' && ran === 1, `ran ${ran}×`)
  check('tool-phase abort → every tool_call still answered (no 400 on resume)',
    dangling(r.messages).length === 0 && toolMsgs.length === 2 && /cancelled/i.test(toolMsgs[1]?.content || ''),
    `${toolMsgs.length} results, last=${JSON.stringify(toolMsgs[1]?.content)}`)
}

console.log(failures === 0 ? '\nPASS — all offline regressions green\n' : `\n${failures} FAILURE(S)\n`)
process.exit(failures ? 1 : 0)
