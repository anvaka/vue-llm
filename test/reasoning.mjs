#!/usr/bin/env node
// No-network unit tests for the reasoning-effort policy and its per-provider
// wire formats.
//
// Covers:
//   1. reasoningPolicy: which models expose a graded effort control, the level
//      set per family, and clamping a requested level to a model's range.
//   2. Each provider spells effort in its own wire field — OpenAI Chat
//      `reasoning_effort`, OpenRouter nested `reasoning.effort`, Anthropic
//      `output_config.effort` (+ adaptive thinking) — and only when thinking is on.
//   3. LLMClient.validateCapabilities resolves reasoningEffort (per-call over
//      config) the same way it resolves enableThinking.
//
// Run: node test/reasoning.mjs

import assert from 'node:assert/strict'
import { effortLevelsFor, resolveEffort, clampEffort, supportsReasoningEffort } from '../src/providers/reasoningPolicy.js'
import { AnthropicProvider } from '../src/providers/AnthropicProvider.js'
import { OpenAIProvider } from '../src/providers/OpenAIProvider.js'
import { OpenRouterProvider } from '../src/providers/OpenRouterProvider.js'
import { LLMClient } from '../src/core/LLMClient.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const MSGS = [{ role: 'user', content: 'hi' }]
async function make(Cls, config) { const p = new Cls(config); await p.initialize(); return p }

// ---- 1. Policy --------------------------------------------------------------
console.log('reasoningPolicy')
assert.deepEqual(effortLevelsFor('claude-opus-4-8'), ['low', 'medium', 'high', 'xhigh', 'max'])
assert.deepEqual(effortLevelsFor('anthropic.claude-sonnet-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
ok('Claude 4.7+/5 (native + Bedrock id) => full range incl xhigh/max')

assert.deepEqual(effortLevelsFor('claude-opus-4-6'), ['low', 'medium', 'high', 'max'])
ok('Claude Opus 4.6 => no xhigh')

assert.equal(effortLevelsFor('claude-opus-4-5'), null)
assert.equal(effortLevelsFor('claude-haiku-4-5'), null)
assert.equal(effortLevelsFor('claude-3-sonnet-20240229'), null)
ok('Opus 4.5 / Haiku 4.5 / claude-3 => no effort control')

assert.deepEqual(effortLevelsFor('gpt-5'), ['minimal', 'low', 'medium', 'high'])
assert.deepEqual(effortLevelsFor('o3-mini'), ['low', 'medium', 'high'])
assert.equal(effortLevelsFor('gpt-5-chat'), null)
assert.equal(effortLevelsFor('gpt-4o'), null)
ok('gpt-5 (+minimal), o-series (low..high), gpt-5-chat/gpt-4o none')

assert.deepEqual(effortLevelsFor('anthropic/claude-opus-4.7'), ['low', 'medium', 'high', 'xhigh', 'max'])
ok('proxy dot-form id (OpenRouter) resolves same as native')

assert.equal(resolveEffort('max', 'gpt-5'), 'high', 'max clamps to high on gpt-5')
assert.equal(resolveEffort('minimal', 'claude-sonnet-5'), 'low', 'minimal clamps to low on Claude')
assert.equal(resolveEffort('xhigh', 'claude-opus-4-6'), 'high', 'xhigh clamps to high on Opus 4.6')
assert.equal(resolveEffort('high', 'gpt-4o'), null, 'no effort model => null')
assert.equal(resolveEffort(undefined, 'claude-opus-4-8'), 'medium', 'default is medium')
assert.equal(clampEffort('bogus', ['low', 'medium', 'high']), 'medium', 'unknown level => medium')
assert.equal(supportsReasoningEffort('claude-opus-4-8'), true)
assert.equal(supportsReasoningEffort('gpt-4o'), false)
ok('resolveEffort / clampEffort / supportsReasoningEffort')

// ---- 2. Per-provider wire formats ------------------------------------------
console.log('provider request bodies')

// Anthropic: output_config.effort + adaptive thinking, sampling params dropped.
const claude = await make(AnthropicProvider, { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'x', baseUrl: 'https://example.invalid' })
let req = claude.prepareRequest(MSGS, { model: 'claude-opus-4-8', enableThinking: true, reasoningEffort: 'xhigh', maxTokens: 100 })
assert.deepEqual(req.output_config, { effort: 'xhigh' })
// display:'summarized' is required for readable thinking text — Opus 4.7+ /
// Claude-5 default it to 'omitted' (empty block + signature only).
assert.deepEqual(req.thinking, { type: 'adaptive', display: 'summarized' })
assert.ok(!('temperature' in req), 'Claude-5 drops temperature')
ok('Anthropic thinking+xhigh => output_config.effort + adaptive thinking (display: summarized)')

req = claude.prepareRequest(MSGS, { model: 'claude-opus-4-8', enableThinking: false, reasoningEffort: 'xhigh', maxTokens: 100 })
assert.ok(!('output_config' in req) && !('thinking' in req), 'no effort when thinking off')
ok('Anthropic thinking OFF => no effort/thinking (effort is a sub-setting)')

const claude3 = await make(AnthropicProvider, { provider: 'anthropic', model: 'claude-3-sonnet-20240229', apiKey: 'x', baseUrl: 'https://example.invalid' })
req = claude3.prepareRequest(MSGS, { model: 'claude-3-sonnet-20240229', enableThinking: true, reasoningEffort: 'high', maxTokens: 100 })
assert.ok(!('output_config' in req), 'legacy Claude gets no effort even with thinking on')
ok('legacy Claude => no effort control')

// OpenAI: reasoning_effort, clamped.
const oai = await make(OpenAIProvider, { provider: 'openai', model: 'o3-mini', apiKey: 'x', baseUrl: 'https://example.invalid' })
req = oai.prepareRequest(MSGS, { model: 'o3-mini', enableThinking: true, reasoningEffort: 'max', maxTokens: 100 })
assert.equal(req.reasoning_effort, 'high', 'max clamped to high for o-series')
ok('OpenAI o3-mini thinking+max => reasoning_effort:high (clamped)')

const oai4o = await make(OpenAIProvider, { provider: 'openai', model: 'gpt-4o', apiKey: 'x', baseUrl: 'https://example.invalid' })
req = oai4o.prepareRequest(MSGS, { model: 'gpt-4o', enableThinking: true, reasoningEffort: 'high', maxTokens: 100 })
assert.ok(!('reasoning_effort' in req), 'gpt-4o has no effort control')
ok('OpenAI gpt-4o => no reasoning_effort')

// OpenRouter: nested reasoning.effort, and Claude/gpt-5 recognized as reasoning.
const orouter = await make(OpenRouterProvider, { provider: 'openrouter', model: 'anthropic/claude-opus-4.7', apiKey: 'x', baseUrl: 'https://example.invalid' })
assert.ok(orouter.hasCapability('thinking'), 'proxied Claude recognized as thinking-capable')
req = orouter.prepareRequest(MSGS, { model: 'anthropic/claude-opus-4.7', enableThinking: true, reasoningEffort: 'medium', maxTokens: 100 })
assert.deepEqual(req.reasoning, { enabled: true, effort: 'medium' })
ok('OpenRouter proxied Claude => reasoning:{enabled,effort}')

// ---- 3. LLMClient threading -------------------------------------------------
console.log('LLMClient.validateCapabilities')
const client = new LLMClient({ configStore: { getActiveConfig: () => null } })
client.config = { provider: 'anthropic', model: 'claude-opus-4-8', enableThinking: true, reasoningEffort: 'high' }
client.provider = { hasCapability: (c) => c === 'thinking' }

let v = client.validateCapabilities({ model: 'claude-opus-4-8' })
assert.equal(v.reasoningEffort, 'high', 'falls back to config.reasoningEffort')
assert.equal(v.enableThinking, true)
ok('validateCapabilities inherits config.reasoningEffort')

v = client.validateCapabilities({ model: 'claude-opus-4-8', reasoningEffort: 'low' })
assert.equal(v.reasoningEffort, 'low', 'per-call value overrides config')
ok('validateCapabilities per-call effort overrides config')

console.log(`\n${passed} checks passed`)
