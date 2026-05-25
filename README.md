# @anvaka/vue-llm (WIP)

Browser-only LLM client + Vue 3 plugin, provider adapters, and lightweight components.

## Features
- Provider factory with 10 built-in providers (OpenAI, Anthropic, Bedrock, Grok, Gemini, Ollama, Llama Server, OpenRouter, DeepSeek, Custom) – extend with `registerProvider()`
- LocalStorage-based config store (custom storage adapter supported)
- Streaming + promise requests via `llmClient.stream()`
- Normalized usage + USD cost on every response (override built-in rates per app or per model)
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
