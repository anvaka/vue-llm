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

import { isOpenAIReasoningModel, gptVersion } from './samplingPolicy.js'

// Canonical ordering, weakest -> strongest. Used to snap a requested level to
// the nearest one a model actually supports (clampEffort). `minimal` is
// OpenAI-only (gpt-5); `xhigh`/`max` are shared by Claude and gpt-5.2+/gpt-6.
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
  if (isOpenAIReasoningModel(m)) return openAIEffortLevels(m)

  return null
}

// The rungs move between OpenAI point releases, and sending one a model does not
// take is a 400 ("Unsupported value: 'minimal' is not supported with the
// 'openai.gpt-5.5' model"). Measured on Bedrock Mantle's /openai/v1/responses,
// 2026-10, one request per level:
//   gpt-5.4, gpt-5.5                    low medium high xhigh       (minimal, max: 400)
//   gpt-5.6-luna, gpt-6-*, gpt-6.1-sol  low medium high xhigh max   (minimal: 400)
// gpt-5 (`minimal` was its addition) and gpt-5.1 are not on Mantle and come from
// OpenAI's own docs. `none` is left out on purpose: it means "don't think", and
// that is `enableThinking: false` here — effort is only sent when thinking is on.
// The error's own "Supported values are: …" list is the request enum, not the
// model's: gpt-6-astra lists 'none' and then rejects it. Don't read levels off it.
// The o-series (o1..o9) tops out at high.
function openAIEffortLevels(m) {
  const v = gptVersion(m)
  if (!v || v.major < 5) return ['low', 'medium', 'high']
  if (v.major === 5 && v.minor === 0) return ['minimal', 'low', 'medium', 'high']
  if (v.major === 5 && v.minor === 1) return ['low', 'medium', 'high']
  if (v.major === 5 && v.minor <= 5) return ['low', 'medium', 'high', 'xhigh']
  return ['low', 'medium', 'high', 'xhigh', 'max']
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
