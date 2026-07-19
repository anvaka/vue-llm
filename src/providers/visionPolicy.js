// Which models can SEE.
//
// Mirrors reasoningPolicy.js: this is the MODEL side of the split. The wire
// spelling of an image part is the TRANSPORT side and lives in each provider's
// message converter (via imageContent.js).
//
// Deliberately DENY-listed rather than allow-listed. AnthropicProvider's header
// comment already argues this at length for tools, and vision is the case that
// proves it: the old OpenAI rule was `id.includes('gpt-4') && id.includes('vision')`,
// which matches nothing in the current catalog — gpt-4o, gpt-4.1, gpt-5 and the
// o-series all fail it — so OpenAI vision had been silently dead since
// gpt-4-vision-preview was retired. Grok's `includes('grok-2')` had rotted the
// same way. An allowlist fails closed on every model released after it's
// written, and "the model can't see" is indistinguishable from a broken image
// pipeline at the call site.
//
// Matching is on the bare model id and tolerates the proxy/router id forms the
// rest of the codebase already handles: `anthropic.claude-*` (Bedrock),
// `us.anthropic.claude-*` (inference profiles), `anthropic/claude-*` (OpenRouter).

// Model families with no image input at all. Anything not listed is assumed to
// see — a wrong "yes" surfaces as a clear provider 400, a wrong "no" surfaces as
// a confusing "I don't see an image" answer that costs a full round trip.
const TEXT_ONLY = [
  // OpenAI: the original gpt-4 snapshots and everything older, plus the
  // text-only reasoning minis.
  /^gpt-3\.5/,
  /^gpt-4(-32k)?$/,
  /^gpt-4-(0314|0613|32k)/,
  /^o1-(mini|preview)/,
  /^o3-mini/,
  /^(text|davinci|babbage|curie|ada)-/,
  // Anthropic: pre-Claude-3 had no vision (same rule AnthropicProvider used).
  /claude-instant/,
  /claude-v?2/,
  // xAI: the original text-only preview model.
  /^grok-beta$/,
  // DeepSeek has no vision model on its public API as of this writing.
  /deepseek/
]

// Strip the router/proxy prefixes so one pattern list covers every id form.
function bareModelId(model) {
  if (typeof model !== 'string') return ''
  let id = model.toLowerCase().trim()
  // OpenRouter: `anthropic/claude-sonnet-5` -> `claude-sonnet-5`
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)
  // Bedrock: `us.anthropic.claude-opus-4-8` -> `claude-opus-4-8`
  id = id.replace(/^(us|eu|apac|global)\./, '').replace(/^(anthropic|openai|meta|mistral|amazon|qwen|google)\./, '')
  return id
}

export function supportsVision(model) {
  const id = bareModelId(model)
  if (!id) return false
  return !TEXT_ONLY.some(re => re.test(id))
}
