# @anvaka/vue-llm (WIP)

Browser-only LLM client + Vue 3 plugin, provider adapters, and lightweight components.

## Features
- Provider factory with 10 built-in providers (OpenAI, Anthropic, AWS, Grok, Gemini, Ollama, Llama Server, OpenRouter, DeepSeek, Custom) – extend with `registerProvider()`
- **AWS** runs on the Bedrock Mantle endpoint and exposes the entire catalog (Claude, GPT-OSS, Qwen, Mistral, Gemma, …) from one model list — each request is routed to the right API surface automatically (Claude → Anthropic Messages, everything else → OpenAI Chat Completions)
- LocalStorage-based config store (custom storage adapter supported)
- Streaming + promise requests via `llmClient.stream()`
- Normalized usage + USD cost on every response (override built-in rates per app or per model)
- Automatic prompt caching for Claude (Anthropic + Bedrock) — caches the system+tools prefix, plus the rolling conversation in agent loops; opt out with `promptCache: false`
- Vue plugin for dependency injection
- `useLLM()` composable with reactive streaming state
- Ready-to-use components: `ProviderSelector`, `LLMConfigModal`, `StoredKeysManager`
- CSS variable theming (`--llm-*` tokens)

## Quick Start
```js
import { createApp } from 'vue'
import App from './App.vue'
import { LLMPlugin } from '@anvaka/vue-llm'
import '@anvaka/vue-llm/styles/variables.css'

createApp(App)
  .use(LLMPlugin, { autoInit: false, namespace: 'myllm' })
  .mount('#app')
```

## Components

### ProviderSelector
Dropdown to switch between configured providers.
```vue
<script setup>
import { ProviderSelector } from '@anvaka/vue-llm'
</script>
<template>
  <ProviderSelector @changed="onProviderChanged" @open-config="showModal = true" />
</template>
```

### LLMConfigModal
Full configuration modal for managing providers (add, edit, test, delete).
```vue
<script setup>
import { ref } from 'vue'
import { LLMConfigModal } from '@anvaka/vue-llm'
const showConfig = ref(false)
</script>
<template>
  <LLMConfigModal 
    :is-visible="showConfig" 
    @close="showConfig = false"
    @config-changed="onConfigChanged" 
  />
</template>
```

Props:
- `isVisible` (Boolean) – controls modal visibility
- `editTarget` (Object) – optional config to edit directly
- `showJudge` (Boolean) – enable judge mode UI
- `showAllMode` (Boolean) – show all providers including disabled

Events:
- `close` – emitted when modal closes
- `configChanged` – emitted when a provider config is saved/deleted

### StoredKeysManager
Manage stored API keys separately from provider configs.
```vue
<script setup>
import { StoredKeysManager } from '@anvaka/vue-llm'
</script>
<template>
  <StoredKeysManager @close="closeManager" @keysUpdated="refreshUI" />
</template>
```

## useLLM Composable
Access the LLM client, config store, and key store with reactive helpers.
```js
import { useLLM } from '@anvaka/vue-llm'

const {
  // Core objects
  client,              // LLMClient instance
  configStore,         // ConfigStore instance
  keyStore,            // KeyStore instance

  // Streaming with reactive state
  stream,              // (messages, options) => Promise - stream with reactive updates
  isStreaming,         // ref<boolean>
  streamContent,       // ref<string> - accumulated response
  streamThinking,      // ref<string> - accumulated thinking content

  // Config management
  getEnabledConfigs,   // () => config[] - enabled providers only
  getAllConfigs,       // () => config[] - all providers including disabled
  getActiveConfig,     // () => config | null
  getActiveProviderId, // () => string | null
  setActiveProviderId, // (id) => boolean
  saveConfig,          // (id, config) => boolean
  deleteConfig,        // (id) => boolean
  enableProvider,      // (id) => boolean
  disableProvider,     // (id) => boolean
  getAvailableModels,  // (providerType, config) => Promise<string[]>
  testConnection,      // (config) => Promise<string>
  refresh,             // () => Promise<void>

  // Key management
  getStoredKey,        // (id) => string | null
  storeKey,            // (id, apiKey, options) => boolean
  deleteStoredKey,     // (id) => boolean
  hasStoredKey,        // (providerType) => boolean
  getAllStoredKeys,    // () => Record<string, KeyData>
  getStoredKeyMeta     // (id) => KeyMeta | null
} = useLLM()
```

## Non-Vue Usage
For scripts outside Vue components, use the singleton exports:
```js
import { llmClient, configStore, keyStore } from '@anvaka/vue-llm'

// Stream directly
const { content, usage, cost } = await llmClient.stream(
  { messages: [...] },
  chunk => console.log(chunk.fullContent)
)

// Manage configs
configStore.saveConfig('my-provider', { ... })
configStore.setActiveProviderId('my-provider')
```

## Usage & Cost

Every response carries a normalized `usage` object and a USD `cost` breakdown when the model's rates are known. Stream chunks expose a running `fullUsage` so consumers can render a live cost counter.

```js
const { content, usage, cost } = await client.stream({ messages: [...] })

usage // { inputTokens, outputTokens, totalTokens,
      //   cachedInputTokens?, cacheCreationInputTokens?, reasoningTokens?, raw }
cost  // { total, input, cachedInput, cacheCreation, output, currency, rates }
      // or null when the model isn't in the rates table
```

`runAgentLoop` aggregates usage across all iterations (each tool round-trip is one call) and emits a `usage` event per iteration:

```js
const { messages, usage, cost } = await client.runAgentLoop({
  messages: [{ role: 'user', content: '7 * 11?' }],
  tools, executors,
  onEvent: ev => {
    if (ev.type === 'usage') console.log(`iter cost: ${ev.cost?.total}`)
  }
})
```

### Prompt caching (Claude)

Anthropic and Bedrock requests are sent with `cache_control` markers by default, so repeated prefixes are read from cache instead of re-billed at full input price. Two prefixes are tagged:

- **System + tools** — on every Claude request. The static prefix recurs identically across calls and runs within the cache TTL (~5 min).
- **Rolling conversation** — added by `runAgentLoop` only, since it re-sends the whole growing transcript each turn. Iteration *N* reads iterations `1..N-1` from cache and only writes the new turn.

Cache hits and writes surface in the usual `usage` fields (`cachedInputTokens`, `cacheCreationInputTokens`) and are priced via the `cachedInput` / `cacheCreation` rate keys. No setup is required — prefixes under the model's minimum cacheable length simply aren't cached (no error).

Disable it per call or per provider config:

```js
client.stream({ messages: [...], promptCache: false })   // single request
configStore.saveConfig('claude', { ...cfg, promptCache: false }) // all requests for this provider
```

### Overriding rates

Built-in rates are sourced from public pricing pages and *will* drift. Three ways to override, in priority order:

```js
// 1. Per-instance — wins over everything
import { LLMClient } from '@anvaka/vue-llm'
const client = new LLMClient({
  pricing: {
    openai: { 'gpt-4o': { input: 1.50, output: 6.00, cachedInput: 0.75 } }
  }
})

// 2. Global runtime override
import { registerPricing } from '@anvaka/vue-llm'
registerPricing('openai', 'gpt-4o', { input: 1.50, output: 6.00 })

// 3. Inline (without LLMClient)
import { calculateCost } from '@anvaka/vue-llm/pricing'
const cost = calculateCost(usage, { provider: 'openai', model: 'gpt-4o' })
```

Rate keys: `input` (uncached prompt, per 1M tokens, USD), `output`, optional `cachedInput` (prompt-cache hits — defaults to `input` if omitted), optional `cacheCreation` (Anthropic-only cache-write premium).

Model lookup is exact match first, then longest-prefix match — so registering `claude-haiku-4-5` automatically covers `claude-haiku-4-5-20251001`.

```js
// Pricing-only import (no Vue):
import { calculateCost, formatCost, registerPricing, DEFAULT_RATES } from '@anvaka/vue-llm/pricing'
formatCost(0.00012) // "$0.000120"
```

## Reasoning effort

Reasoning models expose a graded **effort** control — how hard the model thinks before answering. It's a sub-setting of thinking: it only takes effect when `enableThinking` is on, and it's clamped to whatever levels the chosen model actually supports.

```js
const { content, thinking, usage } = await client.stream({
  messages: [{ role: 'user', content: 'Prove n^5 - n is divisible by 30.' }],
  enableThinking: true,      // required — effort does nothing without it
  reasoningEffort: 'high'    // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
})

thinking // the model's reasoning text, when the provider returns it (see below)
usage.reasoningTokens // reasoning-token count, when reported
```

You can also set `reasoningEffort` on a provider config (via `LLMConfigModal` or `saveConfig`) as the default for every request; a per-call value overrides it.

**Supported levels are a property of the model** (see `src/providers/reasoningPolicy.js`), and the request carries the level whichever transport reaches the model — native, Bedrock (`anthropic.claude-*`), or an OpenRouter proxy id (`anthropic/claude-*`):

| Model family | Levels |
| --- | --- |
| Claude Opus 4.7+, Sonnet/Opus/Fable 5 | `low` · `medium` · `high` · `xhigh` · `max` |
| Claude Opus 4.6 | `low` · `medium` · `high` · `max` |
| OpenAI `gpt-5` | `minimal` · `low` · `medium` · `high` |
| OpenAI o-series | `low` · `medium` · `high` |
| everything else | none (control hidden) |

A requested level outside a model's range is snapped to the nearest supported one (`max` → `high` on gpt-5, etc.). `supportsReasoningEffort(model)` / `effortLevelsFor(model)` are exported from `@anvaka/vue-llm/providers` to drive UI.

Each transport spells effort in its own wire field (handled for you): OpenAI Chat `reasoning_effort`, OpenAI Responses `reasoning.effort`, OpenRouter `reasoning: { enabled, effort }`, Anthropic/Bedrock `output_config: { effort }` alongside `thinking: { type: 'adaptive' }`.

### Seeing the reasoning text (Claude / Bedrock)

Claude only returns **readable** thinking text when the request asks for it via `thinking.display: 'summarized'` — which this library sends automatically. On Opus 4.7+ the display defaults to `omitted`, which returns an empty thinking block with only an encrypted `signature` (Opus 4.6 defaulted to `summarized`). If you build requests by hand, remember to set it or the reasoning will be invisible even though it ran and was billed.

Two more things worth knowing:

- **Adaptive thinking may skip thinking** on easy prompts (0 reasoning tokens, empty `thinking`) even at high effort — the model decides. Use a genuinely hard prompt to see it engage.
- **DeepSeek reasoner** returns reasoning text too (mapped from `reasoning_content`). Grok/Gemini/OpenAI reasoning models report token counts but not always text.

## Theming
Override any `--llm-*` CSS variable globally or per container.
```css
:root { --llm-accent: #ff7e41; }
html[data-theme='light'] { --llm-bg: #fff; }
```

## Extending Providers
```js
import { BaseProvider, registerProvider } from '@anvaka/vue-llm/providers'

class MyProvider extends BaseProvider { 
  /* implement abstract methods */ 
}
registerProvider('my-provider', MyProvider)
```

### Available Exports
```js
// From '@anvaka/vue-llm/providers'
import { 
  BaseProvider,
  PROVIDERS,           // { OPENAI, ANTHROPIC, BEDROCK, GROK, GEMINI, OLLAMA, LLAMA_SERVER, OPENROUTER, DEEPSEEK, CUSTOM }
  DEFAULT_CONFIGS,     // Default configs for each provider type
  createProvider,      // (type, config) => Provider
  registerProvider,    // (type, ProviderClass) => void
  createProviderFlexible // (type, config) => Provider (includes custom-registered)
} from '@anvaka/vue-llm/providers'

// Helper for creating config objects
import { createDefaultConfig } from '@anvaka/vue-llm'
const config = createDefaultConfig('openai') // Returns template config object
```

## License
MIT
