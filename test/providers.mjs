#!/usr/bin/env node
// Integration test for every provider with a key in the environment.
//
// For each provider it: (1) discovers available models, picks the first one
// matching a per-provider hint list, (2) runs LLMClient.runAgentLoop with a
// `multiply(a,b)` tool and asks for 7 * 11, (3) verifies the model actually
// called the tool, the loop terminated cleanly, and the final answer contains
// 77. This exercises message conversion, tool serialization, streamed tool-
// call extraction, multi-turn history including the DeepSeek reasoning_content
// round-trip, and the batched toolCallDeltas path for Ollama / Gemini.
//
// Run:
//   node test/providers.mjs                  — all providers, both scenarios
//   PROVIDER=deepseek node test/providers.mjs — one provider, both scenarios
//   SCENARIO=pro node test/providers.mjs      — only the pro/thinking pass
//   PROVIDER=deepseek,gemini SCENARIO=pro node test/providers.mjs

import { LLMClient } from '../src/core/LLMClient.js'
import { createProvider, DEFAULT_CONFIGS, PROVIDERS } from '../src/providers/factory.js'
import { formatCost } from '../src/pricing/index.js'

// Per provider: a `fast` (cheap baseline) and a `pro` (heavyweight, often
// reasoning-enabled) model. Pro hints are tried with enableThinking=true so we
// exercise the reasoning_content / reasoning_effort code paths. Providers that
// don't recognize the capability ignore the flag — that's intentional, the
// pro run still validates the bigger model works for tool calls.
const SPECS = [
  {
    id: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    providerType: PROVIDERS.OPENAI,
    fastHints: ['gpt-4o-mini', 'gpt-5-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    proHints: ['gpt-5', 'o3', 'o3-mini', 'o4-mini', 'o1']
  },
  {
    id: 'anthropic',
    keyEnv: 'ANTHROPIC_KEY',
    providerType: PROVIDERS.ANTHROPIC,
    fastHints: ['claude-haiku-4-5', 'claude-3-5-haiku', 'claude-3-haiku'],
    // Run pro twice: once on opus-4-7 (temperature deprecated) and once on
    // sonnet-4-6 (temperature still required) so both branches of the new
    // prepareRequest gate get exercised.
    proHints: ['claude-opus-4-7'],
    extraHints: ['claude-sonnet-4-6']
  },
  {
    id: 'bedrock',
    keyEnv: 'BEDROCK_KEY',
    providerType: PROVIDERS.BEDROCK,
    fastHints: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
    proHints: ['claude-opus-4-7'],
    extraHints: ['claude-sonnet-4-6']
  },
  {
    id: 'grok',
    keyEnv: 'GROK_KEY',
    providerType: PROVIDERS.GROK,
    fastHints: ['grok-4-fast', 'grok-4', 'grok-3-mini', 'grok-3', 'grok-2', 'grok-beta'],
    proHints: ['grok-4', 'grok-3', 'grok-2']
  },
  {
    id: 'gemini',
    keyEnv: 'GEMINI_KEY',
    providerType: PROVIDERS.GEMINI,
    fastHints: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash'],
    proHints: ['gemini-2.5-pro', 'gemini-pro-latest', 'gemini-2.0-pro', 'gemini-1.5-pro']
  },
  {
    id: 'openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
    providerType: PROVIDERS.OPENROUTER,
    fastHints: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'google/gemini-flash-1.5', 'anthropic/claude-3-haiku'],
    proHints: ['anthropic/claude-opus-4', 'openai/o3', 'openai/gpt-5', 'google/gemini-2.5-pro']
  },
  {
    id: 'deepseek',
    keyEnv: 'DEEPSEEK_KEY',
    providerType: PROVIDERS.DEEPSEEK,
    fastHints: ['deepseek-v4-flash', 'deepseek-v4', 'deepseek-chat'],
    proHints: ['deepseek-v4-pro', 'deepseek-reasoner']
  }
]

const SCENARIOS = [
  { name: 'fast',  hintsKey: 'fastHints',  enableThinking: false, maxTokens: 800 },
  // Reasoning models burn tokens internally before they answer — give them
  // enough headroom that the tool call + answer doesn't get truncated.
  { name: 'pro',   hintsKey: 'proHints',   enableThinking: true,  maxTokens: 8000 },
  // `extra` is opt-in per spec (most providers don't define extraHints) — used
  // to exercise a second model on a single provider, e.g. Anthropic's
  // sonnet-4-6 to verify temperature still flows when opus-4-7 wouldn't.
  { name: 'extra', hintsKey: 'extraHints', enableThinking: true,  maxTokens: 8000 }
]

const TOOLS = [{
  type: 'function',
  function: {
    name: 'multiply',
    description: 'Multiply two integers and return the result as a string',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'integer', description: 'First operand' },
        b: { type: 'integer', description: 'Second operand' }
      },
      required: ['a', 'b']
    }
  }
}]

const EXECUTORS = {
  multiply: ({ a, b }) => String(Number(a) * Number(b))
}

const USER_PROMPT = 'Use the multiply tool to compute 7 times 11, then state the result in one sentence.'

function pickModel(discovered, hints) {
  if (!Array.isArray(discovered) || !discovered.length) return null
  // Try all exact matches first across the whole hint list — otherwise the
  // first hint's substring match wins before a later hint's exact match gets
  // a chance (which is how "openai/gpt-4o-mini" loses to its noisier sibling
  // "openai/gpt-4o-mini-search-preview"). Substring is a last-ditch fallback,
  // and within the substring pool we pick the shortest id.
  for (const hint of hints) {
    const exact = discovered.find(m => m === hint)
    if (exact) return exact
  }
  for (const hint of hints) {
    const h = hint.toLowerCase()
    const matches = discovered
      .filter(m => String(m).toLowerCase().includes(h))
      .sort((a, b) => a.length - b.length)
    if (matches.length) return matches[0]
  }
  return discovered[0]
}

async function runOne(spec, scenario) {
  const tag = `${spec.id}/${scenario.name}`
  const apiKey = process.env[spec.keyEnv]
  if (!apiKey) return { id: spec.id, scenario: scenario.name, status: 'skip', reason: `no ${spec.keyEnv}` }

  const hints = spec[scenario.hintsKey]
  if (!hints || !hints.length) {
    return { id: spec.id, scenario: scenario.name, status: 'skip', reason: `no ${scenario.hintsKey}` }
  }

  const base = { ...DEFAULT_CONFIGS[spec.providerType], apiKey }

  let model = null
  try {
    const discoveryProvider = createProvider(spec.providerType, base)
    const discovered = await discoveryProvider.discoverModels(15000)
    model = pickModel(discovered, hints)
    if (!model) throw new Error(`no model matched hints (got ${discovered.length} models)`)
  } catch (e) {
    model = hints[0]
    console.log(`  [${tag}] discovery failed (${e.message}); falling back to ${model}`)
  }
  console.log(`  [${tag}] model = ${model}`)

  const config = { ...base, provider: spec.providerType, model }
  const client = new LLMClient({ logger: { warn: () => {}, error: () => {} } })
  await client.initialize(config)

  const events = []
  const onEvent = (ev) => {
    events.push(ev)
    if (ev.type === 'tool-call') {
      console.log(`  [${tag}]   tool-call -> ${ev.name}(${JSON.stringify(ev.args)})`)
    } else if (ev.type === 'tool-result') {
      console.log(`  [${tag}]   tool-result <- ${ev.content}`)
    } else if (ev.type === 'assistant-message' && ev.thinking) {
      const preview = String(ev.thinking).slice(0, 80).replace(/\s+/g, ' ')
      console.log(`  [${tag}]   thinking (${ev.thinking.length} chars): ${preview}${ev.thinking.length > 80 ? '…' : ''}`)
    }
  }

  const t0 = Date.now()
  let result
  try {
    result = await client.runAgentLoop({
      messages: [{ role: 'user', content: USER_PROMPT }],
      tools: TOOLS,
      executors: EXECUTORS,
      onEvent,
      maxIters: 4,
      maxTokens: scenario.maxTokens,
      enableThinking: scenario.enableThinking,
      temperature: 0
    })
  } catch (e) {
    return { id: spec.id, scenario: scenario.name, status: 'fail', model, error: e.message, durationMs: Date.now() - t0 }
  }

  const durationMs = Date.now() - t0
  const finalAssistant = [...result.messages].reverse().find(m => m.role === 'assistant' && !m.tool_calls)
  const finalText = String(finalAssistant?.content || '').trim()
  const calledMultiply = events.some(e => e.type === 'tool-call' && e.name === 'multiply')
  // Accept "77" in digits, or the spelled-out form ("seventy-seven", with or
  // without the hyphen). Reasoning models in particular like to spell numbers.
  const lower = finalText.toLowerCase()
  const has77 = finalText.includes('77') || /seventy[\s-]?seven/.test(lower)
  const sawThinking = events.some(e => e.type === 'assistant-message' && e.thinking)

  console.log(`  [${tag}]   final: ${finalText.slice(0, 160)}${finalText.length > 160 ? '…' : ''}`)

  const usage = result.usage || null
  const cost = result.cost || null

  if (!calledMultiply) {
    return { id: spec.id, scenario: scenario.name, status: 'fail', model, error: 'model never called multiply', stopReason: result.stopReason, durationMs, usage, cost }
  }
  if (!has77) {
    return { id: spec.id, scenario: scenario.name, status: 'fail', model, error: 'final answer missing "77"', finalText, durationMs, usage, cost }
  }
  return { id: spec.id, scenario: scenario.name, status: 'pass', model, iterations: result.iterations, stopReason: result.stopReason, durationMs, sawThinking, usage, cost }
}

async function main() {
  const only = process.env.PROVIDER ? process.env.PROVIDER.split(',').map(s => s.trim()) : null
  const scenarioFilter = process.env.SCENARIO ? process.env.SCENARIO.split(',').map(s => s.trim()) : null
  const targets = only ? SPECS.filter(s => only.includes(s.id)) : SPECS
  const scenarios = scenarioFilter ? SCENARIOS.filter(s => scenarioFilter.includes(s.name)) : SCENARIOS
  if (only && !targets.length) {
    console.error(`No matching providers for PROVIDER=${only.join(',')}`)
    process.exit(2)
  }
  if (scenarioFilter && !scenarios.length) {
    console.error(`No matching scenarios for SCENARIO=${scenarioFilter.join(',')}`)
    process.exit(2)
  }

  const results = []
  for (const spec of targets) {
    for (const scenario of scenarios) {
      const tag = `${spec.id}/${scenario.name}`
      console.log(`\n=== ${tag} ===`)
      try {
        const r = await runOne(spec, scenario)
        results.push(r)
        if (r.status === 'pass') {
          const tFlag = r.sawThinking ? ' +thinking' : ''
          const usageStr = r.usage ? ` ${r.usage.inputTokens ?? 0}→${r.usage.outputTokens ?? 0} tok` : ''
          const costStr = r.cost ? ` ${formatCost(r.cost.total)}` : ''
          console.log(`  [${tag}] PASS (${r.durationMs}ms, iters=${r.iterations}${tFlag}${usageStr}${costStr})`)
        } else if (r.status === 'skip') console.log(`  [${tag}] SKIP (${r.reason})`)
        else console.log(`  [${tag}] FAIL — ${r.error}`)
      } catch (e) {
        results.push({ id: spec.id, scenario: scenario.name, status: 'fail', error: e.stack || e.message })
        console.log(`  [${tag}] FAIL — ${e.message}`)
      }
    }
  }

  console.log('\n\nSUMMARY')
  console.log('-------')
  for (const r of results) {
    const status = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL'
    const tFlag = r.sawThinking ? ' +think' : ''
    const costStr = r.cost ? ` ${formatCost(r.cost.total).padStart(10)}` : (r.usage ? '   (no rates)' : '')
    const detail = r.status === 'pass' ? `${r.model} (${r.durationMs}ms, iters=${r.iterations}${tFlag})${costStr}`
                 : r.status === 'skip' ? r.reason
                 : `${r.model || '?'} — ${r.error}`
    console.log(`  ${r.id.padEnd(11)} ${r.scenario.padEnd(5)} ${status}  ${detail}`)
  }
  const failed = results.filter(r => r.status === 'fail')
  const passed = results.filter(r => r.status === 'pass')
  const skipped = results.filter(r => r.status === 'skip')
  // Sum cost across all priced runs so we know what a full pass actually
  // burns. Missing rates ('no rates' below) are excluded — the printed total
  // is a lower bound when any model lacks a price entry.
  const totalCost = results.reduce((acc, r) => acc + (r.cost?.total || 0), 0)
  const pricedCount = results.filter(r => r.cost).length
  const unpricedCount = results.filter(r => r.usage && !r.cost).length
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
  console.log(`total cost: ${formatCost(totalCost)} (${pricedCount} priced, ${unpricedCount} unpriced)`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
