import { DEFAULT_RATES } from './rates.js'

// Per-app overrides registered at runtime. Shape mirrors DEFAULT_RATES:
//   { providerType: { modelId: { input, output, cachedInput?, cacheCreation? } } }
const _overrides = {}

// Override or add a single model's rates. `provider` must match the provider
// type used in createProvider (e.g. 'openai', 'anthropic', 'bedrock'). `model`
// is matched first as an exact id, then as a prefix of the model returned by
// the provider, so registering 'gpt-4o' will catch 'gpt-4o-2024-08-06' too
// (but not 'gpt-4o-mini', which has a longer matching key in the table).
export function registerPricing(provider, model, rates) {
  if (typeof provider !== 'string' || typeof model !== 'string' || !rates) {
    throw new Error('registerPricing(provider, model, rates) requires strings and a rates object')
  }
  if (!_overrides[provider]) _overrides[provider] = {}
  _overrides[provider][model] = { ...rates }
}

export function clearPricingOverrides(provider, model) {
  if (provider == null) { for (const k of Object.keys(_overrides)) delete _overrides[k]; return }
  if (model == null) { delete _overrides[provider]; return }
  if (_overrides[provider]) delete _overrides[provider][model]
}

// Lookup rates for a given provider+model. Resolution order:
//   1. instance-level overrides passed in (optional `pricing` arg)
//   2. global registerPricing() overrides
//   3. built-in DEFAULT_RATES table
// Within each table, exact model match wins; otherwise the longest table key
// that is a prefix of the model id wins (handles dated suffixes like
// "claude-haiku-4-5-20251001" -> "claude-haiku-4-5").
export function lookupRates(provider, model, pricing = null) {
  if (!provider || !model) return null
  return (
    findRates(pricing?.[provider], model) ||
    findRates(_overrides[provider], model) ||
    findRates(DEFAULT_RATES[provider], model) ||
    null
  )
}

function findRates(table, model) {
  if (!table) return null
  if (table[model]) return table[model]
  let bestKey = null
  for (const key of Object.keys(table)) {
    if (model.startsWith(key)) {
      if (bestKey == null || key.length > bestKey.length) bestKey = key
    }
  }
  return bestKey ? table[bestKey] : null
}

// Compute USD cost from a canonical usage object. Returns null when rates are
// unknown so callers can render "—" rather than a misleading $0. Returns
// `{ total, input, cachedInput, cacheCreation, output, currency, rates }` —
// all dollar amounts as floats. `inputTokens` in the usage is the full prompt
// (including cached), so we subtract cached & cache-creation before applying
// the input rate.
export function calculateCost(usage, { provider, model, pricing = null } = {}) {
  if (!usage) return null
  const rates = lookupRates(provider, model, pricing)
  if (!rates) return null

  const inputTokens         = usage.inputTokens         ?? 0
  const outputTokens        = usage.outputTokens        ?? 0
  const cachedInputTokens   = usage.cachedInputTokens   ?? 0
  const cacheCreationTokens = usage.cacheCreationInputTokens ?? 0
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens)

  const inputRate         = rates.input         ?? 0
  const outputRate        = rates.output        ?? 0
  const cachedInputRate   = rates.cachedInput   ?? inputRate
  const cacheCreationRate = rates.cacheCreation ?? inputRate

  const input         = (uncachedInputTokens * inputRate)         / 1_000_000
  const cachedInput   = (cachedInputTokens   * cachedInputRate)   / 1_000_000
  const cacheCreation = (cacheCreationTokens * cacheCreationRate) / 1_000_000
  const output        = (outputTokens        * outputRate)        / 1_000_000

  return {
    total: input + cachedInput + cacheCreation + output,
    input, cachedInput, cacheCreation, output,
    currency: 'USD',
    rates
  }
}

// Small UX helper for displaying costs — fractions of a cent need more digits
// or they read as "$0.00" and look broken.
export function formatCost(amount, { currency = 'USD' } = {}) {
  if (amount == null || Number.isNaN(amount)) return '—'
  const symbol = currency === 'USD' ? '$' : ''
  if (amount === 0) return `${symbol}0.00`
  const abs = Math.abs(amount)
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return `${symbol}${amount.toFixed(digits)}`
}
