# @anvaka/vue-llm (WIP)

Browser-only LLM client + Vue 3 plugin, provider adapters, and lightweight components.

## Features
- Provider factory with 8 built-in providers (OpenAI, Anthropic, Grok, Gemini, Ollama, Llama Server, OpenRouter, Custom) – extend with `registerProvider()`
- LocalStorage-based config store (custom storage adapter supported)
- Streaming + promise requests via `llmClient.stream()`
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
await llmClient.stream({ messages: [...] }, chunk => console.log(chunk.fullContent))

// Manage configs
configStore.saveConfig('my-provider', { ... })
configStore.setActiveProviderId('my-provider')
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
  PROVIDERS,           // { OPENAI, ANTHROPIC, GROK, GEMINI, OLLAMA, LLAMA_SERVER, OPENROUTER, CUSTOM }
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
