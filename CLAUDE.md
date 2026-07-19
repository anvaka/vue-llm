# CLAUDE.md

Orientation for agents working on `@anvaka/vue-llm`. Covers the reasoning/thinking
subsystem in depth (it has non-obvious traps); for the rest, read `README.md` and
the code.

## What this is

A **browser-only** LLM client: provider adapters (`src/providers/`) + a small core
(`src/core/`) + Vue 3 components (`src/vue/`). No backend — requests go straight
from the browser to each provider. Vite lib-mode build (`npm run build`); ES
modules; `"type": "module"`.

## Commands

```bash
npm run build          # vite lib build → dist/
npm run demo           # playground dev server on :5178 (see demo/README.md)
npm run test:reasoning # no-network unit tests for the effort/thinking subsystem
npm run test:providers # LIVE tests — hit real providers, need keys in env
npm run test:caching   # prompt-cache tests
```

`test/*.mjs` are plain Node scripts (no framework). `test:providers` reads keys
like `OPENAI_KEY`, `BEDROCK_KEY`, … from the environment and makes real calls.
`test:reasoning` is offline and should always pass.

## Provider architecture

`BaseProvider` (`src/providers/BaseProvider.js`) defines the contract:
`prepareRequest` → `makeRequest`/`streamRequest` → `processResponse` /
`extractStreamingContent`, plus a `capabilities` Set filled by
`detectCapabilities()` (mostly offline model-id matching). `createProvider(type,
config)` in `factory.js` picks the class.

**AWS is a router.** `BedrockMantleProvider` auto-routes each model to a transport:
Claude → Anthropic Messages (`/anthropic/v1/messages`, via an inner
`MantleClaudeProvider extends AnthropicProvider`), gpt-5.x → OpenAI Responses, the
rest → OpenAI Chat Completions. So Claude-on-Bedrock inherits all AnthropicProvider
behavior. Auth is a Bearer **API key**, not SigV4.

## Reasoning effort + thinking (read before touching either)

The design mirrors `samplingPolicy.js`: **the effort _levels_ are a MODEL property;
the effort _wire field_ is a TRANSPORT property.**

- `src/providers/reasoningPolicy.js` — the model side. `effortLevelsFor(model)`
  returns the supported levels (or null) keyed on the model id, and works across
  native / Bedrock (`anthropic.claude-*`) / OpenRouter proxy (`anthropic/claude-*`)
  id forms. `resolveEffort`/`clampEffort` snap a requested level into range.
  Exports: `effortLevelsFor`, `supportsReasoningEffort`, `resolveEffort`,
  `clampEffort`, `DEFAULT_EFFORT`.
- `BaseProvider.applyReasoningParams(request, options)` — the transport side, each
  provider overrides it to spell effort in its own field: OpenAI Chat
  `reasoning_effort`; Responses `reasoning.effort`; OpenRouter
  `reasoning:{enabled,effort}`; Anthropic/Bedrock `output_config:{effort}` +
  `thinking:{type:'adaptive', display:'summarized'}`.
- **Effort is gated behind `enableThinking`.** `reasoningEffortFor` returns null
  when thinking is off, so no effort/thinking params are sent. `LLMClient`
  resolves `enableThinking` and `reasoningEffort` (per-call over config) in
  `validateCapabilities` and threads them through `stream`/`runAgentLoop`.

### Gotchas that cost real debugging time

1. **`thinking.display: 'summarized'` is REQUIRED to get readable Claude thinking
   text.** Opus 4.7+ / Claude-5 default `display` to `'omitted'`, which returns an
   empty `thinking` block with only an encrypted `signature` (Opus 4.6 defaulted to
   `'summarized'`). `AnthropicProvider.applyReasoningParams` sends it; don't remove
   it. `'full'` (raw thinking) needs special Anthropic access.
2. **Streaming thinking text arrives as `thinking_delta`** events;
   `AnthropicProvider.extractStreamingContent` must handle them (not just
   `text_delta`). Bedrock also streams a `signature_delta` (encrypted, no text) —
   ignore it.
3. **Reasoning token count** for Claude is `usage.output_tokens_details.thinking_tokens`
   (surfaced as `usage.reasoningTokens` by `normalizeAnthropicUsage`) — NOT a
   separate text stream. DeepSeek maps `reasoning_content` → `thinking`.
4. **Adaptive thinking may decline to think** on easy prompts (0 reasoning tokens,
   empty thinking) even at high effort — the model decides. Not a bug. Test with a
   hard prompt.
5. **haiku-4-5 rejects adaptive thinking** (400). It's gated: `supportsReasoningEffort`
   is false for it, so it never gets the `thinking` capability and no thinking param
   is sent. Keep that gate.
6. **`client.stream()` returns `{ content, thinking, usage, cost }`** — `cost` is a
   breakdown object `{ total, ... }`, not a number. Read `cost.total`.

See the memory note `bedrock-thinking-redacted` for the live-verified details.

## The demo

`demo/` is a standalone Vite app (own config) for exercising all of the above
against real providers, running against `src/` via the `@lib` alias. It can
auto-seed providers from your shell secrets **at dev time only** — keys never land
in a committed file or a production build. See `demo/README.md`.

## Conventions

- Match the surrounding code's style; comments explain *why*, not *what*.
- When you change a provider's wire format, update `test/reasoning.mjs` (it asserts
  exact request bodies) and prefer a live check against the real provider.
- Never commit API keys. The demo's secret handling is deliberately dev-only.
