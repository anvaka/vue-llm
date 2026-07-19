// Provider-agnostic reasoning-effort policy.
//
// "How hard should this model think?" is expressed with a DIFFERENT wire field
// on every transport:
//   OpenAI Chat Completions   -> `reasoning_effort: 'low'|'medium'|...`
//   OpenAI Responses API      -> `reasoning: { effort: '...' }`
//   Anthropic Messages        -> `output_config: { effort: '...' }` (native + Bedrock Mantle Claude)
// The FIELD is a property of the transport, so each provider writes its own
// (BaseProvider.applyReasoningParams is the OpenAI-style default; the Responses
// and Anthropic providers override it).
//
// But the *set of levels a model accepts* is a property of the MODEL, and it
// travels across transports — a `claude-opus-4-8` reached through OpenRouter or
// a custom OpenAI-compatible gateway accepts the same low..max range as the
// native Anthropic path. That model -> levels map lives here, mirroring the
// model-keyed sampling policy in samplingPolicy.js. Keeping it in one place
// means the effort UI, request building, and clamping all agree on what a given
// model supports regardless of which provider class carries it.

import { isOpenAIReasoningModel } from './samplingPolicy.js'

// Canonical ordering, weakest -> strongest. Used to snap a requested level to
// the nearest one a model actually supports (clampEffort). `minimal` is
// OpenAI-only (gpt-5); `xhigh`/`max` are Anthropic-only.
const CANONICAL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const DEFAULT_EFFORT = 'medium'

// The ordered list of effort levels a model accepts, or null when the model has
// no reasoning-effort control at all (a plain chat model, or a thinking model
// that only exposes an on/off flag like Ollama). Substring match so bare ids
// (`claude-opus-4-8`), Bedrock Mantle ids (`anthropic.claude-opus-4-8`), and
// proxy ids (`anthropic/claude-opus-4.8`, `openai/o3-mini`) are all covered.
export function effortLevelsFor(model) {
  const m = String(model || '').toLowerCase()

  // ---- Anthropic Claude (native + Bedrock Mantle + proxied) ----------------
  // Effort is `output_config.effort` and pairs with adaptive thinking, which
  // arrived on Opus 4.6. Opus 4.7 added `xhigh`. The Claude-5 generation
  // (sonnet/opus/fable) carries the full range. Matched with `[-.]` on the
  // minor separator so proxy dot-forms (claude-opus-4.7) work too. Haiku is
  // excluded — Haiku 4.5 rejects the effort parameter.
  if (/claude-opus-4[-.][789]/.test(m) || /claude-(?:sonnet|opus|fable)-5(?!\d)/.test(m)) {
    return ['low', 'medium', 'high', 'xhigh', 'max']
  }
  if (/claude-opus-4[-.]6/.test(m)) return ['low', 'medium', 'high', 'max'] // no xhigh before 4.7

  // ---- OpenAI reasoning line (native, Responses, Mantle, OpenRouter) --------
  // gpt-5 added the `minimal` rung; the o-series (o1..o9) tops out at high.
  if (isOpenAIReasoningModel(m)) {
    return m.includes('gpt-5') ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high']
  }

  return null
}

// True when the model exposes a graded reasoning-effort control (so the config
// UI should show the effort selector, and providers should declare `thinking`).
export function supportsReasoningEffort(model) {
  return !!effortLevelsFor(model)
}

// Snap a requested level to the nearest one this list supports. An exact match
// passes through; otherwise the closest rung on the CANONICAL scale wins (so
// `max` -> `high` on an OpenAI model, `minimal` -> `low` on a Claude model). An
// unrecognized level falls back to `medium` (or the list's midpoint).
export function clampEffort(level, levels) {
  if (!levels || !levels.length) return null
  const l = String(level || '').toLowerCase()
  if (levels.includes(l)) return l
  const want = CANONICAL.indexOf(l)
  if (want === -1) {
    return levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : levels[Math.floor((levels.length - 1) / 2)]
  }
  let best = levels[0]
  let bestDist = Infinity
  for (const cand of levels) {
    const d = Math.abs(CANONICAL.indexOf(cand) - want)
    if (d < bestDist) { bestDist = d; best = cand }
  }
  return best
}

// Resolve the effort level to actually send for (requested, model): the
// requested value clamped to what the model supports, or null when the model
// has no effort control (nothing to send). `requested` falls back to the
// default when empty.
export function resolveEffort(requested, model) {
  const levels = effortLevelsFor(model)
  if (!levels) return null
  return clampEffort(requested || DEFAULT_EFFORT, levels)
}

export { CANONICAL as EFFORT_SCALE }
