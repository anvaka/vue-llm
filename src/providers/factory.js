import { OpenAIProvider } from './OpenAIProvider.js'
import { AnthropicProvider } from './AnthropicProvider.js'
import { BedrockProvider } from './BedrockProvider.js'
import { BedrockMantleProvider } from './BedrockMantleProvider.js'
import { GrokProvider } from './GrokProvider.js'
import { GeminiProvider } from './GeminiProvider.js'
import { OllamaProvider } from './OllamaProvider.js'
import { LlamaServerProvider } from './LlamaServerProvider.js'
import { OpenRouterProvider } from './OpenRouterProvider.js'
import { DeepSeekProvider } from './DeepSeekProvider.js'
import { CustomProvider } from './CustomProvider.js'

export const PROVIDERS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  BEDROCK: 'bedrock',
  GROK: 'grok',
  GEMINI: 'gemini',
  OLLAMA: 'ollama',
  LLAMA_SERVER: 'llama-server',
  OPENROUTER: 'openrouter',
  DEEPSEEK: 'deepseek',
  CUSTOM: 'custom'
}

export const DEFAULT_CONFIGS = {
  [PROVIDERS.OPENAI]: { name: 'OpenAI', baseUrl: 'https://api.openai.com', requiresApiKey: true },
  [PROVIDERS.ANTHROPIC]: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', requiresApiKey: true },
  [PROVIDERS.BEDROCK]: {
    name: 'AWS',
    // Two backends, chosen by a UI toggle. Mantle (default) serves the whole
    // catalog behind one model list via BedrockMantleProvider's auto-routing
    // (Claude -> Anthropic Messages, the rest -> OpenAI Chat Completions).
    // Bedrock is the classic Claude-only bedrock-runtime transport. `baseUrl`
    // is derived from (backend, region) via the templates below, and
    // `createProvider` picks the class from `config.backend`. The region list
    // is valid on both.
    baseUrl: 'https://bedrock-mantle.us-east-1.api.aws',
    baseUrlTemplate: 'https://bedrock-mantle.{region}.api.aws',
    defaultBackend: 'mantle',
    backends: {
      mantle:  { label: 'Mantle',  baseUrlTemplate: 'https://bedrock-mantle.{region}.api.aws' },
      runtime: { label: 'Bedrock', baseUrlTemplate: 'https://bedrock-runtime.{region}.amazonaws.com' }
    },
    regions: [
      'us-east-1', 'us-east-2', 'us-west-2',
      'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-north-1', 'eu-south-1',
      'ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3',
      'sa-east-1'
    ],
    defaultRegion: 'us-east-1',
    requiresApiKey: true
  },
  [PROVIDERS.GROK]: { name: 'Grok', baseUrl: 'https://api.x.ai', requiresApiKey: true },
  [PROVIDERS.GEMINI]: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', requiresApiKey: true },
  [PROVIDERS.OLLAMA]: { name: 'Ollama (Native)', baseUrl: 'http://localhost:11434', requiresApiKey: false },
  [PROVIDERS.LLAMA_SERVER]: { name: 'Local Llama Server', baseUrl: 'http://localhost:8080', requiresApiKey: false },
  [PROVIDERS.OPENROUTER]: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', requiresApiKey: true },
  [PROVIDERS.DEEPSEEK]: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', requiresApiKey: true },
  [PROVIDERS.CUSTOM]: { name: 'Custom OpenAI Compatible', baseUrl: '', requiresApiKey: false }
}

export function createProvider(providerType, config) {
  switch (providerType) {
    case PROVIDERS.OPENAI: return new OpenAIProvider(config)
    case PROVIDERS.ANTHROPIC: return new AnthropicProvider(config)
    case PROVIDERS.BEDROCK:
      // Default is the Mantle router (all models, one list). The classic
      // bedrock-runtime provider is opt-in via `backend: 'runtime'`.
      return config?.backend === 'runtime'
        ? new BedrockProvider(config)
        : new BedrockMantleProvider(config)
    case PROVIDERS.GROK: return new GrokProvider(config)
    case PROVIDERS.GEMINI: return new GeminiProvider(config)
    case PROVIDERS.OLLAMA: return new OllamaProvider(config)
    case PROVIDERS.LLAMA_SERVER: return new LlamaServerProvider(config)
    case PROVIDERS.OPENROUTER: return new OpenRouterProvider(config)
    case PROVIDERS.DEEPSEEK: return new DeepSeekProvider(config)
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
