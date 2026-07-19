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
npm run test:images    # no-network unit tests for image input (wire formats per provider)
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

## Images (vision)

Same split as reasoning: **which models can see is a MODEL property; how an image
is spelled on the wire is a TRANSPORT property.**

- `src/providers/visionPolicy.js` — the model side. `supportsVision(model)` is
  **deny-listed**, not allow-listed, and handles the native / Bedrock
  (`anthropic.claude-*`, `us.anthropic.*`) / OpenRouter (`anthropic/claude-*`)
  id forms.
- `src/providers/imageContent.js` — the shared normalizer. Canonical content is
  either a string or an array of OpenAI-flavored parts (`{type:'text'}` /
  `{type:'image_url', image_url:{url}}`). `parseImageUrl` splits a `data:` URL
  into `{mime, b64}` for the providers that need the halves separately.
- `BaseProvider.processMessages` — every `prepareRequest` calls it FIRST. It folds
  the legacy `options.images` side channel into canonical parts and throws when a
  model that can't see is handed an image.

### Gotchas

1. **Canonical parts ARE the OpenAI wire format.** OpenAI/Grok/OpenRouter/Custom/
   llama-server need no image conversion at all. Only Anthropic, Gemini, Ollama
   and the Responses transport convert.
2. **Anthropic and Gemini want RAW base64 + a separate media type**, not a data
   URL. Ollama wants raw base64 in a sibling `images` array *outside* `content`.
   Never hand any of them the `data:` prefix.
3. **Claude via Bedrock/Mantle accepts base64 sources ONLY** — the native API's
   `source.type:'url'` and `'file'` are rejected there. That's what
   `imageSourceMode()` is for; `BedrockProvider` and `MantleClaudeProvider`
   override it to `'inline'`.
   **The 5 MB per-image cap is measured on the BASE64 STRING**, not the decoded
   file (verified live: `content.1.image.source.base64: image exceeds 5 MB
   maximum: 6755172 bytes > 5242880 bytes` for a 4.8 MB file). Base64 inflates by
   4/3, so the effective file limit is ~3.75 MB. Any size check must measure the
   encoded length — the demo's first attempt compared `file.size` and let
   everything between 3.75 MB and 5 MB through.
4. **Don't hardcode `image/jpeg`.** Every pre-rewrite implementation did, which
   mislabeled every PNG screenshot. The media type comes from the data URL.
5. **Don't mutate the caller's messages.** The old `addImagesToMessages` methods
   assigned to `lastMessage.content` in place, so streaming the same conversation
   twice corrupted its history. `attachImages` copies.
6. **Vision detection must default open.** The old OpenAI rule
   (`gpt-4` && `vision`) matched no current model, so vision was silently dead;
   Grok's `grok-2` check had rotted the same way. Add to the denylist, not an
   allowlist.
7. **Image generation is deliberately NOT supported.** Claude can't do it at all
   and Bedrock's image models aren't reachable from a browser; every provider that
   can generate does so on a separate endpoint with a non-text response, which
   nothing in `processResponse`/`streamRequest` is shaped for.

`npm run test:images` covers all of the above offline.

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
