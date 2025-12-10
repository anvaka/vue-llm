# @anvaka/vue-llm Development Guide

## Architecture Overview

Browser-only LLM client library with Vue 3 integration. No Node.js runtime dependencies.

### Layer Structure
```
src/
├── core/           # Framework-agnostic: LLMClient, ConfigStore, KeyStore, StorageAdapter
├── providers/      # LLM provider implementations extending BaseProvider
└── vue/            # Vue plugin, useLLM composable, UI components
```

**Data flow**: Vue components → `useLLM()` composable → `LLMClient` → Provider → HTTP fetch

### Key Design Decisions
- **Browser-only**: Uses `fetch` directly, localStorage for persistence. No SDK dependencies.
- **Provider abstraction**: All providers extend `BaseProvider` implementing: `prepareRequest()`, `processResponse()`, `parseStreamingLine()`, `extractStreamingContent()`
- **Capability detection**: Providers declare capabilities (`thinking`, `vision`, `tools`) in `detectCapabilities()`. Client auto-validates before requests.
- **Dual usage**: Vue apps use `LLMPlugin` + `useLLM()`. Non-Vue scripts use singleton exports (`llmClient`, `configStore`, `keyStore`).

## Build & Development

```bash
npm install
npm run build        # Vite library build → dist/
npm run dev          # Watch mode
```

Output preserves module structure for tree-shaking. CSS stays in `src/styles/`.

## Provider Implementation Pattern

New providers must extend `BaseProvider` and implement these methods:

```javascript
// src/providers/MyProvider.js
import { BaseProvider } from './BaseProvider.js'

export class MyProvider extends BaseProvider {
  async detectCapabilities() {
    // Set this.capabilities based on model
    if (this.config.model?.includes('vision')) this.capabilities.add('vision')
  }
  
  getEndpoint() { return `${this.config.baseUrl}/v1/chat/completions` }
  getStreamingEndpoint() { return this.getEndpoint() }
  getAuthHeaderName() { return 'Authorization' }
  getAuthHeaderValue() { return `Bearer ${this.config.apiKey}` }
  
  prepareRequest(messages, options) { /* Return API-specific request body */ }
  processResponse(response) { /* Return { content, thinking?, usage? } */ }
  parseStreamingLine(line) { /* Parse SSE line, return parsed object or null */ }
  extractStreamingContent(parsed) { /* Return { content?, thinking?, done?, usage? } */ }
}
```

Register in `src/providers/factory.js` switch statement and `PROVIDERS`/`DEFAULT_CONFIGS` constants.

## Vue Component Conventions

- Components use `llm-` CSS class prefix for scoping
- Props follow `:is-visible` pattern (not `v-if` on component)
- Events: `@close`, `@changed`, `@config-changed`, `@keysUpdated`
- All styling via `--llm-*` CSS variables (see `src/styles/variables.css`)

## Storage Architecture

`ConfigStore` and `KeyStore` use `StorageAdapter` abstraction:
- Default: `LocalStorageAdapter` with namespace prefix
- Configs stored as JSON under `{namespace}-configs`
- Active provider ID under `{namespace}-active-provider`
- API keys under `{namespace}-stored-keys` with metadata (masking, timestamps)

## Testing Patterns

Test provider connections via `LLMClient.testConnection(config)` - sends "ping" message expecting "pong" response.
