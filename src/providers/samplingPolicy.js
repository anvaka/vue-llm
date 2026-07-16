// Provider-agnostic temperature (sampling) policy.
//
// The "does this model accept a temperature?" fact is a property of the MODEL,
// not of the provider class that happens to carry it. Keeping it here — keyed on
// the model id — means the rule travels across transports: a `claude-sonnet-5`
// reached through OpenRouter or a custom OpenAI-compatible gateway gets the same
// treatment as the native Anthropic path, and a Moonshot/Kimi model rejected by
// one endpoint is remembered everywhere.
//
// Two layers cooperate:
//   1. staticSamplingMode(model) — the declarative table below (fast path, no
//      wasted round-trip for known models).
//   2. A learned memo, filled by classifyTemperatureError() when a real 400 comes
//      back, so unknown / future models self-heal after a single failed attempt.
// BaseProvider consults samplingModeFor() (memo ∪ table) when building a request
// and records into the memo when a temperature 400 is caught.

const MODE = { PASS: 'pass', OMIT: 'omit', ONE: 'one' }

// Learned constraints, keyed by samplingKey(host, model). Populated at runtime
// from actual API errors; consulted before the static table so a discovered
// constraint short-circuits the doomed first attempt on later calls.
const LEARNED = new Map()

export function samplingKey(host, model) {
  return `${host || ''}::${model || ''}`
}

export function recordSamplingConstraint(key, mode) {
  if (key && (mode === MODE.OMIT || mode === MODE.ONE)) LEARNED.set(key, mode)
}

export function learnedSamplingMode(key) {
  return LEARNED.get(key) || null
}

// The effective mode for a request: a learned constraint wins over the static
// table (it reflects ground truth from the endpoint itself).
export function samplingModeFor(key, model) {
  return LEARNED.get(key) || staticSamplingMode(model)
}

// Declarative model-id → policy table.
//   'omit' — the model rejects the temperature field entirely.
//   'one'  — the model accepts temperature but pins it to exactly 1.
//   'pass' — send the caller's temperature (or the default).
export function staticSamplingMode(model) {
  const m = String(model || '')
  if (samplingParamsRemoved(m)) return MODE.OMIT
  if (isFixedTemperatureModel(m)) return MODE.ONE
  return MODE.PASS
}

// Opus 4.7 onward and the entire Claude 5 generation removed
// temperature/top_p/top_k — sending them returns 400 ("temperature is deprecated
// for this model."). Bedrock surfaces this as `hideSamplingParameter: true` in
// the model's converse schema, confirmed live for opus-4-7/4-8, sonnet-5 and
// fable-5 (all true) and haiku-4-5 (false — a "-5" suffix that must stay allowed,
// hence the family name must sit immediately before `-5`). The opus-4-[789] range
// covers 4-7/4-8/4-9; revisit when opus-4-10 ships. Substring match so dated
// suffixes (claude-sonnet-5-20260630) and Bedrock us./global. inference-profile
// prefixes (us.anthropic.claude-sonnet-5) are covered too. The minor-version
// separator is `[-.]` so proxy id formats that use a dot (OpenRouter's
// anthropic/claude-opus-4.7) are matched as well as the native hyphen form.
export function samplingParamsRemoved(model) {
  const m = model || ''
  return /claude-opus-4[-.][789]/.test(m) || /claude-(sonnet|opus|haiku|fable)-5(?!\d)/.test(m)
}

// True for OpenAI reasoning models. Keyed on the model id so it works across
// transports (native OpenAI, OpenRouter's `openai/o3-mini`, Mantle, …):
//  - the o-series (o1…o9), covering current and future generations, anchored on
//    (^|/) so it matches `o3-mini` and `openai/o1-preview` but NOT the trailing
//    `o` in `gpt-4o`;
//  - the GPT-5 reasoning line and anything explicitly tagged `reasoning`.
// EXCLUDES `gpt-5-chat` / `gpt-5-chat-latest`, which are conversational models
// that accept an arbitrary temperature — pinning those to 1 was a regression.
export function isOpenAIReasoningModel(model) {
  const id = String(model || '').toLowerCase()
  if (/(?:^|\/)o[1-9](?:[-.]|$)/.test(id)) return true
  if (id.includes('gpt-5') && !id.includes('gpt-5-chat')) return true
  return id === 'gpt5' || id.includes('reasoning')
}

// Models that ACCEPT temperature but require it to be exactly 1:
//  - OpenAI reasoning line (see isOpenAIReasoningModel) — omitting it or sending
//    1 are the only valid choices; 1 is the safe, explicit default.
//  - Moonshot Kimi (k2 line) rejects anything but 1 ("invalid temperature: only 1
//    is allowed for this model") on its OpenAI-compatible endpoint.
export function isFixedTemperatureModel(model) {
  const id = String(model || '').toLowerCase()
  const moonshotKimi = /kimi|moonshot/.test(id)
  return isOpenAIReasoningModel(id) || moonshotKimi
}

// Inspect a 400 response body to decide whether it is complaining about the
// `temperature` field and, if so, which correction applies. Returns 'omit',
// 'one', or null (not an actionable temperature constraint — leave the original
// error to surface). We deliberately classify ONLY on phrasings that
// unambiguously describe a *constraint* on the field. A body that merely mentions
// "temperature" (an out-of-range value, a moderation block that echoes the request
// JSON, a proxy that reflects the payload) returns null, so we neither strip a
// valid field nor — via recordSamplingConstraint — poison the memo for the model.
export function classifyTemperatureError(errorText) {
  const t = String(errorText || '').toLowerCase()
  if (!t.includes('temperature')) return null
  // "invalid temperature: only 1 is allowed", "temperature must be 1", "must
  // equal 1". Anchored on word boundaries so unrelated numbers ("maximum value
  // of 1.0", "temperature=1.5") no longer match.
  if (/\bonly\s*1\b|\bmust be (?:exactly )?1\b|\bmust equal 1\b|\bequal to 1\b|\bset to 1\b/.test(t)) return MODE.ONE
  // "temperature is deprecated", "does not support temperature", "unsupported value"
  if (/deprecat|unsupported|not support|no longer|isn'?t allowed|not allowed|not permitted|unexpected (?:parameter|field)|invalid parameter/.test(t)) return MODE.OMIT
  // Mentioned temperature but not as a recognizable field constraint — surface
  // the real error rather than guessing (a guess here would be memoized).
  return null
}

export { MODE as SAMPLING_MODE }
