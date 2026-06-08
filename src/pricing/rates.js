// Built-in pricing table. All values are USD per 1,000,000 tokens.
// Sourced from public provider pricing pages in May 2026. These rates WILL
// drift — use registerPricing() or the LLMClient `pricing` option to override
// per-app without forking. Local/self-hosted providers price at zero.
//
// Per-rate keys:
//   input         — uncached input (and the fallback rate when cachedInput is
//                   not set, so omitting cachedInput just disables the
//                   cache discount instead of pricing it as free)
//   output        — generated tokens (includes reasoning tokens for the
//                   providers that fold them into output_tokens, namely
//                   OpenAI and Gemini)
//   cachedInput   — prompt-cache hits (Anthropic cache_read_input_tokens,
//                   OpenAI prompt_tokens_details.cached_tokens,
//                   Gemini cachedContentTokenCount,
//                   DeepSeek prompt_cache_hit_tokens)
//   cacheCreation — Anthropic-only: cache_creation_input_tokens (one-time
//                   write premium, typically ~1.25× input)

export const DEFAULT_RATES = {
  openai: {
    // Flagship + workhorse (April–May 2026 lineup)
    'gpt-5.5-pro':  { input: 5.00,  output: 30.00, cachedInput: 0.50 },
    'gpt-5.5':      { input: 5.00,  output: 30.00, cachedInput: 0.50 },
    'gpt-5.4-pro':  { input: 30.00, output: 180.00 },
    'gpt-5.4':      { input: 2.50,  output: 15.00, cachedInput: 0.25 },
    'gpt-5.4-mini': { input: 0.75,  output:  4.50, cachedInput: 0.075 },
    'gpt-5.4-nano': { input: 0.20,  output:  1.25, cachedInput: 0.02 },
    // GPT-5.x family — still widely deployed
    'gpt-5.3':      { input: 1.75,  output: 14.00, cachedInput: 0.175 },
    'gpt-5.2-pro':  { input: 10.50, output: 84.00 },
    'gpt-5.2':      { input: 1.75,  output: 14.00, cachedInput: 0.175 },
    'gpt-5.1':      { input: 0.625, output:  5.00, cachedInput: 0.125 },
    'gpt-5-chat':   { input: 1.25,  output: 10.00, cachedInput: 0.125 },
    'gpt-5':        { input: 0.625, output:  5.00, cachedInput: 0.125 },
    'gpt-5-mini':   { input: 0.25,  output:  2.00, cachedInput: 0.025 },
    'gpt-5-nano':   { input: 0.05,  output:  0.40, cachedInput: 0.005 },
    // Reasoning models
    'o4-mini':      { input: 1.10,  output:  4.40, cachedInput: 0.275 },
    'o3':           { input: 2.00,  output:  8.00, cachedInput: 0.50 },
    'o3-mini':      { input: 1.10,  output:  4.40, cachedInput: 0.55 },
    // Codex variants
    'gpt-5.1-codex':       { input: 1.25,  output: 10.00, cachedInput: 0.125 },
    'gpt-5.1-codex-mini':  { input: 0.25,  output:  2.00, cachedInput: 0.025 },
    'gpt-5-codex':         { input: 1.25,  output: 10.00, cachedInput: 0.125 }
  },

  anthropic: {
    'claude-opus-4-8':   { input: 5.00, output: 25.00, cachedInput: 0.50, cacheCreation: 6.25 },
    'claude-opus-4-7':   { input: 5.00, output: 25.00, cachedInput: 0.50, cacheCreation: 6.25 },
    'claude-opus-4-6':   { input: 5.00, output: 25.00, cachedInput: 0.50, cacheCreation: 6.25 },
    'claude-sonnet-4-6': { input: 3.00, output: 15.00, cachedInput: 0.30, cacheCreation: 3.75 },
    'claude-sonnet-4-5': { input: 3.00, output: 15.00, cachedInput: 0.30, cacheCreation: 3.75 },
    'claude-haiku-4-5':  { input: 1.00, output:  5.00, cachedInput: 0.10, cacheCreation: 1.25 }
  },

  // Bedrock charges the same per-token rates as Anthropic direct for the
  // Claude inference profiles; the model IDs differ (us.anthropic.* prefix).
  bedrock: {
    'us.anthropic.claude-opus-4-8':   { input: 5.00, output: 25.00, cachedInput: 0.50, cacheCreation: 6.25 },
    'us.anthropic.claude-opus-4-7':   { input: 5.00, output: 25.00, cachedInput: 0.50, cacheCreation: 6.25 },
    'us.anthropic.claude-opus-4-6':   { input: 5.00, output: 25.00, cachedInput: 0.50, cacheCreation: 6.25 },
    'us.anthropic.claude-sonnet-4-6': { input: 3.00, output: 15.00, cachedInput: 0.30, cacheCreation: 3.75 },
    'us.anthropic.claude-sonnet-4-5': { input: 3.00, output: 15.00, cachedInput: 0.30, cacheCreation: 3.75 },
    'us.anthropic.claude-haiku-4-5':  { input: 1.00, output:  5.00, cachedInput: 0.10, cacheCreation: 1.25 }
  },

  gemini: {
    // Gemini 3.x — current lineup (May 2026)
    'gemini-3.5-flash':              { input: 1.50, output:  9.00, cachedInput: 0.15 },
    'gemini-3.1-pro-preview':        { input: 2.00, output: 12.00, cachedInput: 0.20 },
    'gemini-3.1-flash-lite-preview': { input: 0.25, output:  1.50, cachedInput: 0.025 },
    'gemini-3-pro-preview':          { input: 2.00, output: 12.00 },
    'gemini-3-flash-preview':        { input: 0.50, output:  3.00, cachedInput: 0.05 },
    // Gemini 2.5 — still in active use
    'gemini-2.5-pro':                { input: 1.00, output: 10.00, cachedInput: 0.125 },
    'gemini-2.5-flash':              { input: 0.30, output:  2.50, cachedInput: 0.03 },
    'gemini-2.5-flash-lite':         { input: 0.10, output:  0.40, cachedInput: 0.01 }
  },

  grok: {
    // Grok 4.3 (April 30, 2026 release) — current primary, 1M context
    'grok-4.3':                       { input: 1.25, output: 2.50, cachedInput: 0.20 },
    'grok-4.20-0309-reasoning':       { input: 1.25, output: 2.50, cachedInput: 0.20 },
    'grok-4.20-0309-non-reasoning':   { input: 1.25, output: 2.50, cachedInput: 0.20 },
    'grok-4.20-multi-agent-0309':     { input: 1.25, output: 2.50, cachedInput: 0.20 },
    'grok-4.20':                      { input: 1.25, output: 2.50, cachedInput: 0.20 },
    'grok-build-0.1':                 { input: 1.00, output: 2.00 },
    // Cheap fast tier
    'grok-4-fast':                    { input: 0.20, output: 0.50 },
    'grok-code-fast-1':               { input: 0.20, output: 1.50 }
  },

  deepseek: {
    'deepseek-v4-pro':      { input: 0.435, output: 0.87,  cachedInput: 0.0036 },
    'deepseek-v4-flash':    { input: 0.10,  output: 0.20,  cachedInput: 0.0028 },
    'deepseek-v3.2':        { input: 0.252, output: 0.378, cachedInput: 0.0252 },
    'deepseek-v3.2-thinking': { input: 0.252, output: 0.378, cachedInput: 0.0252 },
    'deepseek-chat':        { input: 0.014, output: 0.028 },
    'deepseek-reasoner':    { input: 0.55,  output: 2.00 }
  },

  // OpenRouter prices vary per upstream model and include their own margin —
  // ship empty; callers can either register their own rates or use
  // OpenRouterProvider.discoverModelsWithMetadata() (which returns pricing).
  openrouter: {},

  // Local inference — free at the per-token layer.
  ollama: {},
  'llama-server': {},

  // Custom OpenAI-compatible endpoints: unknown by definition.
  custom: {}
}
