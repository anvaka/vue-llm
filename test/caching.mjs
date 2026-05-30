#!/usr/bin/env node
// No-network unit tests for Anthropic/Bedrock prompt caching.
//
// Covers two things the live provider integration test (providers.mjs) can't
// assert offline:
//   1. The assembled request body carries `cache_control: {type:'ephemeral'}`
//      in the right positions (static system+tools prefix + rolling transcript),
//      that Bedrock inherits it, and that promptCache:false suppresses it.
//   2. cache_creation (iteration 1) / cache_read (iteration >=2) usage flows
//      through runAgentLoop's aggregated usage and into calculate.js cost.
//
// Run: node test/caching.mjs

import assert from 'node:assert/strict'
import { AnthropicProvider, normalizeAnthropicUsage } from '../src/providers/AnthropicProvider.js'
import { BedrockProvider } from '../src/providers/BedrockProvider.js'
import { LLMClient } from '../src/core/LLMClient.js'

const TOOLS = [{
  type: 'function',
  function: {
    name: 'multiply',
    description: 'Multiply two numbers',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
  }
}]

// A system message plus a settled tool round-trip, so the final message is a
// tool_result block (the realistic shape mid agent-loop).
const CONVERSATION = [
  { role: 'system', content: 'You are a calculator.' },
  { role: 'user', content: 'What is 7 * 11?' },
  { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'multiply', args: { a: 7, b: 11 } }] },
  { role: 'tool', tool_call_id: 't1', content: '77' }
]

const isEphemeral = (b) => b && b.cache_control && b.cache_control.type === 'ephemeral'
let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

async function makeProvider(Cls, model) {
  const p = new Cls({ provider: Cls === BedrockProvider ? 'bedrock' : 'anthropic', model, apiKey: 'x', baseUrl: 'https://example.invalid' })
  await p.initialize()
  return p
}

// 1. Anthropic: system+tools static prefix, plus the rolling transcript
//    breakpoint when cacheTranscript is set (the agent-loop case).
{
  const anth = await makeProvider(AnthropicProvider, 'claude-sonnet-4-6')
  const req = anth.prepareRequest(CONVERSATION, { model: 'claude-sonnet-4-6', tools: TOOLS, maxTokens: 100, cacheTranscript: true })

  assert.ok(Array.isArray(req.system), 'system is normalized to content blocks')
  assert.ok(isEphemeral(req.system[req.system.length - 1]), 'last system block is cached')
  ok('system prefix carries a cache breakpoint')

  // With a system message present, the breakpoint sits on system (which already
  // includes tools in the prefix) — tools themselves are not separately tagged.
  assert.ok(req.tools.every(t => !t.cache_control), 'tools not separately tagged when system exists')
  ok('tools are not double-tagged when a system breakpoint covers them')

  const lastMsg = req.messages[req.messages.length - 1]
  const lastBlock = lastMsg.content[lastMsg.content.length - 1]
  assert.ok(isEphemeral(lastBlock), 'last block of final message is cached (rolling transcript breakpoint)')
  assert.equal(lastBlock.type, 'tool_result', 'rolling breakpoint rides the tool_result block')
  ok('rolling transcript breakpoint sits on the final message when cacheTranscript is set')

  // Breakpoint budget: at most 2 used (system + rolling), well under Anthropic's 4.
  const count = countBreakpoints(req)
  assert.ok(count <= 4 && count >= 2, `breakpoint count within budget (got ${count})`)
  ok('breakpoint count stays within budget')
}

// 1b. Without cacheTranscript (a single completion), only the static prefix is
//     tagged — the transcript breakpoint would pay a write premium with no read.
{
  const anth = await makeProvider(AnthropicProvider, 'claude-sonnet-4-6')
  const req = anth.prepareRequest(CONVERSATION, { model: 'claude-sonnet-4-6', tools: TOOLS, maxTokens: 100 })
  assert.ok(isEphemeral(req.system[req.system.length - 1]), 'static system prefix still cached')
  const lastMsg = req.messages[req.messages.length - 1]
  assert.ok(lastMsg.content.every(b => !isEphemeral(b)), 'no rolling transcript breakpoint without cacheTranscript')
  assert.equal(countBreakpoints(req), 1, 'single completions get exactly one (static) breakpoint')
  ok('single completions get only the static prefix breakpoint')
}

// 2. No system message -> fall back to tagging the last tool definition.
{
  const anth = await makeProvider(AnthropicProvider, 'claude-sonnet-4-6')
  const req = anth.prepareRequest(
    [{ role: 'user', content: 'hi' }],
    { model: 'claude-sonnet-4-6', tools: TOOLS, maxTokens: 100 }
  )
  assert.equal(req.system, undefined, 'no system field when no system message')
  assert.ok(isEphemeral(req.tools[req.tools.length - 1]), 'last tool is cached as the static prefix')
  ok('falls back to tagging the last tool when there is no system message')
}

// 3. promptCache:false suppresses every marker, leaving the legacy shape intact.
{
  const anth = await makeProvider(AnthropicProvider, 'claude-sonnet-4-6')
  const req = anth.prepareRequest(CONVERSATION, { model: 'claude-sonnet-4-6', tools: TOOLS, promptCache: false })
  assert.equal(typeof req.system, 'string', 'system stays a plain string when disabled')
  assert.equal(countBreakpoints(req), 0, 'no cache_control anywhere when disabled')
  ok('promptCache:false produces an unmarked request')
}

// 4. Bedrock inherits the markers (its transport tweaks must not strip them).
{
  const bed = await makeProvider(BedrockProvider, 'us.anthropic.claude-sonnet-4-6')
  const req = bed.prepareRequest(CONVERSATION, { model: 'us.anthropic.claude-sonnet-4-6', tools: TOOLS, stream: true, cacheTranscript: true })
  assert.ok(Array.isArray(req.system) && isEphemeral(req.system[req.system.length - 1]), 'bedrock system cached')
  const lastMsg = req.messages[req.messages.length - 1]
  assert.ok(isEphemeral(lastMsg.content[lastMsg.content.length - 1]), 'bedrock rolling breakpoint present')
  assert.equal(req.anthropic_version, 'bedrock-2023-05-31', 'bedrock transport fields still applied')
  assert.equal(req.stream, undefined, 'bedrock strips stream from the body')
  ok('Bedrock inherits cache markers and keeps its transport tweaks')
}

// 5. cache_creation / cache_read usage propagates through runAgentLoop + cost.
{
  const config = { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'x', baseUrl: 'https://example.invalid' }
  const client = new LLMClient({ configStore: { getActiveConfig: () => config } })
  await client.initialize()

  let calls = 0
  let sawCacheTranscript = false
  client.provider.streamRequest = async (_messages, options, onChunk) => {
    calls++
    if (options && options.cacheTranscript) sawCacheTranscript = true
    if (calls === 1) {
      // First iteration writes the cache: cache_creation tokens, no read yet.
      const usage = normalizeAnthropicUsage({ input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 20 })
      onChunk && onChunk({ content: '', done: false, fullUsage: usage })
      return { content: '', thinking: '', toolCalls: [{ id: 't1', name: 'multiply', args: { a: 7, b: 11 } }], usage }
    }
    // Second iteration reads the cache: cache_read tokens, no creation.
    const usage = normalizeAnthropicUsage({ input_tokens: 50, cache_read_input_tokens: 1100, cache_creation_input_tokens: 0, output_tokens: 30 })
    onChunk && onChunk({ content: 'The answer is 77', done: true, fullUsage: usage })
    return { content: 'The answer is 77', thinking: '', toolCalls: [], usage }
  }

  const res = await client.runAgentLoop({
    messages: [{ role: 'system', content: 'calc' }, { role: 'user', content: '7*11?' }],
    tools: TOOLS,
    executors: { multiply: ({ a, b }) => a * b }
  })

  assert.equal(res.iterations, 2, 'loop ran two iterations')
  assert.ok(sawCacheTranscript, 'runAgentLoop opts into the rolling transcript breakpoint')
  ok('runAgentLoop sets cacheTranscript on its requests')
  assert.equal(res.usage.cacheCreationInputTokens, 1000, 'cache-creation tokens aggregated from iteration 1')
  assert.equal(res.usage.cachedInputTokens, 1100, 'cache-read tokens aggregated from iteration 2')
  ok('runAgentLoop aggregates cache_creation and cache_read across iterations')

  assert.ok(res.cost, 'cost computed (rates known for claude-sonnet-4-6)')
  assert.ok(res.cost.cacheCreation > 0, 'cost reflects the cache-creation charge')
  assert.ok(res.cost.cachedInput > 0, 'cost reflects the discounted cache-read charge')
  // Cache reads must be cheaper per token than uncached input at the same count.
  assert.ok(res.cost.rates.cachedInput < res.cost.rates.input, 'cache-read rate is below the uncached input rate')
  ok('calculate.js splits cached vs uncached cost')
}

function countBreakpoints(req) {
  let n = 0
  const scanBlocks = (blocks) => { if (Array.isArray(blocks)) for (const b of blocks) if (isEphemeral(b)) n++ }
  if (Array.isArray(req.system)) scanBlocks(req.system)
  if (Array.isArray(req.tools)) for (const t of req.tools) if (isEphemeral(t)) n++
  if (Array.isArray(req.messages)) for (const m of req.messages) scanBlocks(m.content)
  return n
}

console.log(`\n${passed} assertions passed.`)
