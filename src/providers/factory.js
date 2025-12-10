import { OpenAIProvider } from './OpenAIProvider.js'
import { AnthropicProvider } from './AnthropicProvider.js'
import { GrokProvider } from './GrokProvider.js'
import { GeminiProvider } from './GeminiProvider.js'
import { OllamaProvider } from './OllamaProvider.js'
import { LlamaServerProvider } from './LlamaServerProvider.js'
import { OpenRouterProvider } from './OpenRouterProvider.js'
import { CustomProvider } from './CustomProvider.js'

export const PROVIDERS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GROK: 'grok',
  GEMINI: 'gemini',
  OLLAMA: 'ollama',
  LLAMA_SERVER: 'llama-server',
  OPENROUTER: 'openrouter',
  CUSTOM: 'custom'
}

export const DEFAULT_CONFIGS = {
  [PROVIDERS.OPENAI]: { name: 'OpenAI', baseUrl: 'https://api.openai.com', requiresApiKey: true },
  [PROVIDERS.ANTHROPIC]: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', requiresApiKey: true },
  [PROVIDERS.GROK]: { name: 'Grok', baseUrl: 'https://api.x.ai', requiresApiKey: true },
  [PROVIDERS.GEMINI]: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', requiresApiKey: true },
  [PROVIDERS.OLLAMA]: { name: 'Ollama (Native)', baseUrl: 'http://localhost:11434', requiresApiKey: false },
  [PROVIDERS.LLAMA_SERVER]: { name: 'Local Llama Server', baseUrl: 'http://localhost:8080', requiresApiKey: false },
  [PROVIDERS.OPENROUTER]: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', requiresApiKey: true },
  [PROVIDERS.CUSTOM]: { name: 'Custom OpenAI Compatible', baseUrl: '', requiresApiKey: false }
}

export function createProvider(providerType, config) {
  switch (providerType) {
    case PROVIDERS.OPENAI: return new OpenAIProvider(config)
    case PROVIDERS.ANTHROPIC: return new AnthropicProvider(config)
    case PROVIDERS.GROK: return new GrokProvider(config)
    case PROVIDERS.GEMINI: return new GeminiProvider(config)
    case PROVIDERS.OLLAMA: return new OllamaProvider(config)
    case PROVIDERS.LLAMA_SERVER: return new LlamaServerProvider(config)
    case PROVIDERS.OPENROUTER: return new OpenRouterProvider(config)
    case PROVIDERS.CUSTOM: return new CustomProvider(config)
    default: throw new Error(`Unknown provider type: ${providerType}`)
  }
}

// Allow runtime registration of custom providers
const _customProviders = new Map()

export function registerProvider(type, providerClass) {
  if (typeof type !== 'string' || !providerClass) {
    throw new Error('registerProvider requires a type string and a class reference')
  }
  _customProviders.set(type, providerClass)
}

export function createProviderFlexible(providerType, config) {
  if (_customProviders.has(providerType)) {
    const ProviderClass = _customProviders.get(providerType)
    return new ProviderClass(config)
  }
  return createProvider(providerType, config)
}
