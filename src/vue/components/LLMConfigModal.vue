<template>
  <div v-if="isVisible" class="llm-modal-overlay" @click="closeModal">
    <div class="llm-modal" @click.stop>
      <div class="llm-modal-header">
        <h2>
          Manage LLM Providers
          <span v-if="isEditing">{{ editingProviderId ? ' - Edit' : ' - Add' }}</span>
        </h2>
        <button class="llm-btn llm-btn--ghost llm-btn--sm llm-close-btn" @click="closeModal">×</button>
      </div>
      
      <div class="llm-modal-body">
        <!-- Edit Provider Form -->
        <div v-if="isEditing">
          <div class="llm-form-grid">
            <label class="llm-field-label">Provider Type:</label>
            <select v-model="config.provider" @change="onProviderChange" class="llm-form-control">
              <option value="">Select a provider...</option>
              <option v-for="(providerConfig, key) in PROVIDER_CONFIGS" 
                      :key="key" 
                      :value="key">
                {{ providerConfig.name }}
              </option>
            </select>

            <template v-if="config.provider">
              <label class="llm-field-label">Provider Name:</label>
              <input 
                v-model="config.name" 
                type="text" 
                :placeholder="getProviderNamePlaceholder()"
                class="llm-form-control"
                required
              />
            </template>

            <template v-if="config.provider">
              <label class="llm-field-label">Base URL:</label>
              <input 
                v-model="config.baseUrl" 
                type="url" 
                :placeholder="selectedProviderConfig?.baseUrl"
                class="llm-form-control"
                required
              />

              <template v-if="selectedProviderConfig?.requiresApiKey || config.provider === 'custom'">
                <label class="llm-field-label">API Key:</label>
                <div class="llm-api-key-field">
                  <div class="llm-api-key-input-row">
                    <input 
                      v-model="config.apiKey" 
                      type="password" 
                      :placeholder="getApiKeyPlaceholder()"
                      class="llm-form-control"
                      :required="selectedProviderConfig?.requiresApiKey"
                    />
                    <button 
                      v-if="hasStoredKey(config.provider)" 
                      type="button"
                      class="llm-btn llm-btn--ghost llm-btn--sm"
                      @click="useStoredKey"
                      title="Use stored key"
                    >
                      Use Stored
                    </button>
                  </div>
                  <small class="llm-security-note">
                    ⚠️ API key is stored locally in your browser
                    <span v-if="config.provider === 'custom'"> (optional for custom providers)</span>
                  </small>
                </div>
              </template>

              <label class="llm-field-label">Model:</label>
              <div class="llm-model-selector">
                <select v-model="config.model" :disabled="isLoadingModels" class="llm-form-control">
                  <option value="">
                    {{ isLoadingModels ? 'Loading models...' : 'Select a model...' }}
                  </option>
                  <option v-for="model in availableModels" :key="model" :value="model">
                    {{ model }}
                  </option>
                </select>
                <button 
                  class="llm-btn llm-btn--ghost llm-btn--sm llm-refresh-btn"
                  @click="loadModels"
                  :disabled="!config.baseUrl || isLoadingModels"
                  title="Refresh models list"
                >
                  {{ isLoadingModels ? 'Loading...' : 'Refresh' }}
                </button>
                <div v-if="modelLoadError" class="llm-model-error">
                  {{ modelLoadError }}
                </div>
                
                <div v-if="supportsThinking" class="llm-thinking-toggle">
                  <label class="llm-checkbox-label">
                    <input 
                      type="checkbox" 
                      v-model="config.enableThinking"
                      class="llm-checkbox"
                    />
                    Enable Thinking: Show model's reasoning process
                  </label>
                </div>
              </div>

              <label class="llm-field-label">Temperature:</label>
              <div class="llm-temperature-field">
                <input 
                  v-model.number="config.temperature" 
                  type="number" 
                  min="0" 
                  max="2" 
                  step="0.1"
                  class="llm-form-control"
                  :disabled="isFixedTemperature"
                />
                <small v-if="!isFixedTemperature" class="llm-field-note">
                  Controls randomness: 0 = deterministic, 2 = very creative
                </small>
                <small v-else class="llm-field-note">
                  This model uses a fixed temperature of 1.
                </small>
              </div>

              <label class="llm-field-label">Max Tokens:</label>
              <input 
                v-model.number="config.maxTokens" 
                type="number" 
                min="1" 
                max="100000"
                class="llm-form-control"
                ref="maxTokensInput"
              />
            </template>
          </div>
        </div>

        <!-- Provider List (when not editing) -->
        <div v-else>
          <div class="llm-provider-list" v-if="configuredProviders.length > 0">
            <h3>Configured Providers</h3>
            <div 
              v-for="provider in configuredProviders" 
              :key="provider.id"
              class="llm-provider-item"
              :class="{ 
                active: provider.id === activeProviderId, 
                disabled: provider.enabled === false 
              }"
              @click="provider.enabled !== false ? activateProvider(provider.id) : null"
            >
              <div class="llm-provider-info">
                <div class="llm-provider-name-row">
                  <div class="llm-provider-name">
                    {{ provider.name }}
                    <span v-if="provider.enabled === false" class="llm-disabled-badge">Disabled</span>
                  </div>
                  <span v-if="provider.id === activeProviderId" class="llm-active-badge">Active</span>
                  <span 
                    v-if="showJudge && provider.id === judgeProviderId" 
                    class="llm-judge-badge"
                  >Judge</span>
                </div>
                <div class="llm-provider-details-row">
                  <button 
                    class="llm-test-status-btn" 
                    :class="getTestStatusClass(provider.id)"
                    @click.stop="testProvider(provider)"
                    :disabled="isTesting"
                  >
                    {{ getTestStatusText(provider.id) }}
                  </button>
                  <div class="llm-provider-details">
                    {{ provider.provider }} • {{ provider.baseUrl }}
                  </div>
                </div>
              </div>
              <div class="llm-provider-actions" @click.stop>
                <button 
                  v-if="showJudge && provider.enabled !== false"
                  class="llm-btn llm-btn--ghost llm-btn--sm"
                  @click="toggleJudge(provider)"
                  :title="provider.id === judgeProviderId ? 'Unset as judge' : 'Set as judge'"
                >
                  {{ provider.id === judgeProviderId ? 'Unmark Judge' : 'Mark Judge' }}
                </button>
                <button 
                  class="llm-btn llm-btn--ghost llm-btn--sm" 
                  @click="toggleProvider(provider)"
                  :title="provider.enabled === false ? 'Enable provider' : 'Disable provider'"
                >
                  {{ provider.enabled === false ? 'Enable' : 'Disable' }}
                </button>
                <button class="llm-btn llm-btn--ghost llm-btn--sm" @click="editProvider(provider)">
                  Edit
                </button>
                <button class="llm-btn llm-btn--sm llm-btn--danger" @click="deleteProvider(provider.id)">
                  Delete
                </button>
              </div>
            </div>
          </div>
          
          <div v-else class="llm-empty-state">
            <p>Connect your first AI provider to start chatting.</p>
            <p>Click "Add New Provider" below. You'll need a base URL and, for some providers, an API key.</p>
            <p class="llm-security-note">API keys are stored locally in your browser.</p>
          </div>
        </div>
        
        <!-- Stored Keys Manager Modal -->
        <div v-if="showStoredKeysManager" class="llm-keys-manager-overlay" @click="closeStoredKeysManager">
          <div class="llm-keys-manager-content" @click.stop>
            <StoredKeysManager 
              @close="closeStoredKeysManager"
              @keysUpdated="onKeysUpdated"
            />
          </div>
        </div>
      </div>

      <div class="llm-modal-footer">
        <button v-if="!isEditing" class="llm-btn llm-btn--secondary" @click="startAddProvider">
          Add New Provider
        </button>
        <button v-if="!isEditing && hasAnyStoredKeys" class="llm-btn llm-btn--ghost" @click="openStoredKeysManager">
          Manage Keys
        </button>
        <div class="llm-footer-spacer"></div>
        <button class="llm-btn llm-btn--ghost" @click="isEditing ? cancelEdit() : closeModal()">
          Close
        </button>
        <button 
          v-if="isEditing"
          class="llm-btn llm-btn--primary" 
          @click="testAndSave"
          :disabled="!isValidConfig || isTesting"
        >
          {{ isTesting ? 'Testing...' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useLLM, createDefaultConfig } from '../useLLM.js'
import { createProvider, DEFAULT_CONFIGS } from '../../providers/factory.js'
import StoredKeysManager from './StoredKeysManager.vue'

const props = defineProps({
  isVisible: Boolean,
  editTarget: Object,
  // Optional features
  showJudge: { type: Boolean, default: false },
  showAllMode: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'configChanged'])

const PROVIDER_CONFIGS = DEFAULT_CONFIGS

const { 
  client,
  configStore,
  getEnabledConfigs,
  getAllConfigs,
  getActiveProviderId,
  setActiveProviderId,
  saveConfig,
  deleteConfig,
  enableProvider,
  disableProvider,
  getAvailableModels,
  testConnection,
  refresh,
  getStoredKey,
  hasStoredKey,
  getAllStoredKeys,
  storeKey
} = useLLM()

const config = ref(createDefaultConfig(''))
const configuredProviders = ref([])
const activeProviderId = ref(null)
const judgeProviderId = ref(null)
const isEditing = ref(false)
const editingProviderId = ref(null)
const isTesting = ref(false)
const testResult = ref(null)
const availableModels = ref([])
const isLoadingModels = ref(false)
const modelLoadError = ref(null)
const testStatuses = ref(new Map())
const showStoredKeysManager = ref(false)
const storedKeysCount = ref(0)
const maxTokensInput = ref(null)

// Judge provider storage key
const JUDGE_PROVIDER_KEY = 'judge-provider'

const selectedProviderConfig = computed(() => 
  config.value.provider ? PROVIDER_CONFIGS[config.value.provider] : null
)

const modelCapabilities = ref(new Set())

const supportsThinking = computed(() => {
  return config.value.model && modelCapabilities.value.has('thinking')
})

// Fixed temperature for certain models
const isFixedTemperature = computed(() => {
  if (!config.value?.provider || !config.value?.model) return false
  if (config.value.provider !== 'openai') return false
  const id = String(config.value.model).toLowerCase()
  return (
    modelCapabilities.value.has('thinking') ||
    id.startsWith('o1') || id.startsWith('o2') || id.startsWith('o3') || id.startsWith('o-') ||
    id.includes('gpt-5') || id === 'gpt5' || id.includes('reasoning')
  )
})

const hasAnyStoredKeys = computed(() => storedKeysCount.value > 0)

const isValidConfig = computed(() => {
  if (!config.value.name || !config.value.provider || !config.value.baseUrl) return false
  if (selectedProviderConfig.value?.requiresApiKey && !config.value.apiKey) return false
  return true
})

const getTestStatusText = (providerId) => {
  const status = testStatuses.value.get(providerId)
  if (status === 'testing') return 'Testing...'
  if (status === 'success') return 'Ok'
  if (status === 'failed') return 'Failed'
  return 'Test'
}

const getTestStatusClass = (providerId) => {
  const status = testStatuses.value.get(providerId)
  return {
    'llm-test-testing': status === 'testing',
    'llm-test-success': status === 'success',
    'llm-test-failed': status === 'failed',
    'llm-test-default': !status || status === 'default'
  }
}

const refreshProviders = () => {
  configuredProviders.value = getAllConfigs()
  activeProviderId.value = getActiveProviderId() || ''
  // Read judge from localStorage if showJudge is enabled
  if (props.showJudge) {
    try {
      judgeProviderId.value = localStorage.getItem('llm:' + JUDGE_PROVIDER_KEY) || null
    } catch { judgeProviderId.value = null }
  }
}

const updateStoredKeysCount = () => {
  const allKeys = getAllStoredKeys()
  storedKeysCount.value = Object.keys(allKeys).length
}

const onProviderChange = async () => {
  const providerConfig = selectedProviderConfig.value
  if (providerConfig) {
    config.value.baseUrl = providerConfig.baseUrl
    config.value.model = ''
    config.value.enableThinking = false
    modelCapabilities.value.clear()
    
    if (!editingProviderId.value) {
      config.value.name = ''
    }
    
    const storedKey = getStoredKey(config.value.provider)
    if (storedKey && !config.value.apiKey) {
      config.value.apiKey = storedKey
    }
    
    await loadModels()
  }
  testResult.value = null
  modelLoadError.value = null
}

const loadModels = async () => {
  if (!config.value.provider || !config.value.baseUrl) {
    availableModels.value = []
    modelLoadError.value = null
    return
  }

  isLoadingModels.value = true
  modelLoadError.value = null
  
  try {
    const models = await getAvailableModels(config.value.provider, config.value)
    availableModels.value = models
    
    if (models.length > 0 && !config.value.model) {
      config.value.model = models[0]
      await detectModelCapabilities()
    }
  } catch (error) {
    console.warn('Failed to load models:', error)
    availableModels.value = []
    modelLoadError.value = error.message || 'Failed to load models'
  } finally {
    isLoadingModels.value = false
  }
}

const detectModelCapabilities = async () => {
  if (!config.value.provider || !config.value.model) {
    modelCapabilities.value.clear()
    return
  }

  try {
    const tempConfig = { ...config.value }
    const tempProvider = createProvider(tempConfig.provider, tempConfig)
    await tempProvider.initialize()
    modelCapabilities.value = new Set(tempProvider.capabilities)
    
    if (!modelCapabilities.value.has('thinking')) {
      config.value.enableThinking = false
    }
  } catch (error) {
    console.warn('Failed to detect model capabilities:', error)
    modelCapabilities.value.clear()
  }
}

const generateProviderId = () => {
  return `provider_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

const getProviderNamePlaceholder = () => {
  if (!config.value.provider) return ''
  const providerConfig = PROVIDER_CONFIGS[config.value.provider]
  return `e.g., My ${providerConfig?.name || 'Provider'}`
}

const generateProviderName = () => {
  if (!config.value.provider || !config.value.model) return ''
  
  const providerConfig = PROVIDER_CONFIGS[config.value.provider]
  const providerName = providerConfig?.name || 'Provider'
  
  let modelPart = config.value.model
  if (modelPart.includes('/')) {
    modelPart = modelPart.split('/').pop()
  }
  
  modelPart = modelPart
    .replace(/-(instruct|chat|base|completion)$/i, '')
    .replace(/^(gpt-|claude-|llama-|gemini-)/i, '')
    .replace(/-vision$/, '')
    .replace(/-\d+b?$/i, '')
  
  modelPart = modelPart
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .substring(0, 20)
  
  return `${providerName} ${modelPart}`.trim()
}

const testAndSave = async () => {
  if (!isValidConfig.value) return
  
  isTesting.value = true
  testResult.value = null
  
  try {
    await testConnection(config.value)
    
    const providerId = (isEditing.value && editingProviderId.value) 
      ? editingProviderId.value 
      : generateProviderId()
    
    const saved = saveConfig(providerId, config.value)
    
    if (saved) {
      if (!getActiveProviderId()) {
        setActiveProviderId(providerId)
        activeProviderId.value = providerId
      }
      
      await refresh()
      
      testResult.value = { 
        success: true, 
        message: isEditing.value ? 'Provider updated!' : 'Provider added!' 
      }
      
      refreshProviders()
      resetForm()
      emitConfigChanged()
      
      setTimeout(() => emit('close'), 1500)
    } else {
      testResult.value = { success: false, message: 'Failed to save configuration.' }
    }
  } catch (error) {
    console.error('LLM connection test failed:', error)
    testResult.value = { success: false, message: `Connection failed: ${error.message}` }
  } finally {
    isTesting.value = false
  }
}

const activateProvider = (providerId) => {
  const success = setActiveProviderId(providerId)
  if (success) {
    activeProviderId.value = providerId
    refresh()
    emitConfigChanged()
  }
}

const testProvider = async (provider) => {
  testStatuses.value.set(provider.id, 'testing')
  
  try {
    await testConnection(provider)
    testStatuses.value.set(provider.id, 'success')
    setTimeout(() => testStatuses.value.set(provider.id, 'default'), 3000)
  } catch (error) {
    console.error('LLM connection test failed:', error)
    testStatuses.value.set(provider.id, 'failed')
    setTimeout(() => testStatuses.value.set(provider.id, 'default'), 5000)
  }
}

const editProvider = (provider) => {
  config.value = { ...provider }
  isEditing.value = true
  editingProviderId.value = provider.id
  testResult.value = null
  loadModels().then(() => {
    if (config.value.model) detectModelCapabilities()
  })
  
  if (props.editTarget?.focusField) {
    nextTick(() => {
      if (props.editTarget.focusField === 'maxTokens' && maxTokensInput?.value) {
        maxTokensInput.value.focus()
        maxTokensInput.value.select?.()
      }
    })
  }
}

const startAddProvider = () => {
  resetForm()
  isEditing.value = true
  editingProviderId.value = null
}

const cancelEdit = () => resetForm()

const deleteProvider = (providerId) => {
  if (confirm('Are you sure you want to delete this provider?')) {
    const success = deleteConfig(providerId)
    if (success) {
      refreshProviders()
      if (providerId === editingProviderId.value) resetForm()
      refresh()
      emitConfigChanged()
    }
  }
}

const toggleProvider = (provider) => {
  const isCurrentlyEnabled = provider.enabled !== false
  const success = isCurrentlyEnabled 
    ? disableProvider(provider.id) 
    : enableProvider(provider.id)
    
  if (success) {
    refreshProviders()
    refresh()
    emitConfigChanged()
  }
}

const resetForm = () => {
  config.value = createDefaultConfig('')
  isEditing.value = false
  editingProviderId.value = null
  testResult.value = null
  availableModels.value = []
  modelLoadError.value = null
  modelCapabilities.value.clear()
}

const closeModal = () => {
  resetForm()
  emit('close')
}

const handleKeydown = (event) => {
  if (!props.isVisible) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeModal()
  }
}

const emitConfigChanged = () => {
  emit('configChanged')
  try {
    window.dispatchEvent(new CustomEvent('llm-config-changed'))
  } catch {}
}

watch(() => props.isVisible, (visible) => {
  if (visible) {
    refreshProviders()
    updateStoredKeysCount()
    resetForm()

    if (props.editTarget?.name && configuredProviders.value.length > 0) {
      const target = configuredProviders.value.find(p => p.name === props.editTarget.name)
      if (target) editProvider(target)
    }
  }
})

watch(() => config.value.model, (newModel) => {
  if (newModel) {
    detectModelCapabilities()
    
    if (!editingProviderId.value) {
      const generatedName = generateProviderName()
      if (generatedName) config.value.name = generatedName
    }
    
    if (isFixedTemperature.value) config.value.temperature = 1
  } else {
    modelCapabilities.value.clear()
    config.value.enableThinking = false
  }
})

watch(() => config.value.temperature, (t) => {
  if (isFixedTemperature.value && t !== 1) config.value.temperature = 1
})

// Stored Keys Manager
const openStoredKeysManager = () => { showStoredKeysManager.value = true }
const closeStoredKeysManager = () => { showStoredKeysManager.value = false }
const onKeysUpdated = () => { updateStoredKeysCount() }

const getApiKeyPlaceholder = () => {
  if (config.value.provider === 'custom') return 'Enter your API key (optional)'
  const hasStored = hasStoredKey(config.value.provider)
  return hasStored ? 'Using stored key (or enter new)' : 'Enter your API key'
}

const useStoredKey = () => {
  const storedKey = getStoredKey(config.value.provider)
  if (storedKey) config.value.apiKey = storedKey
}

// Judge helpers
const toggleJudge = (provider) => {
  if (!props.showJudge) return
  const newId = provider.id === judgeProviderId.value ? null : provider.id
  try {
    if (newId) localStorage.setItem('llm:' + JUDGE_PROVIDER_KEY, newId)
    else localStorage.removeItem('llm:' + JUDGE_PROVIDER_KEY)
    judgeProviderId.value = newId
    emitConfigChanged()
  } catch {}
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  updateStoredKeysCount()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
/* Modal overlay */
.llm-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.llm-modal {
  background: var(--llm-bg, #181a1f);
  border: 2px solid var(--llm-border, #33383f);
  border-radius: var(--llm-radius-md, 8px);
  width: 90%;
  max-width: 700px;
  max-height: 90%;
  position: relative;
  display: flex;
  flex-direction: column;
  color: var(--llm-text, #e6e8ea);
}

.llm-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid var(--llm-border, #33383f);
  flex-shrink: 0;
}

.llm-modal-header h2 {
  margin: 0;
  color: var(--llm-text, #e6e8ea);
  font-size: 1.25rem;
}

.llm-close-btn {
  font-size: 1.5rem;
  line-height: 1;
}

.llm-close-btn:hover {
  opacity: 0.7;
}

.llm-modal-body {
  padding: 1.5rem;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* Buttons */
.llm-btn {
  padding: 0.5rem 1rem;
  border-radius: var(--llm-radius-sm, 4px);
  border: 1px solid var(--llm-border, #33383f);
  background: var(--llm-bg-soft, #1f2228);
  color: var(--llm-text, #e6e8ea);
  cursor: pointer;
  font-size: var(--llm-font-size-sm, 0.85rem);
  transition: all 0.15s ease;
}

.llm-btn:hover:not(:disabled) {
  border-color: var(--llm-border-hover, #4b525c);
  background: var(--llm-bg-mute, #242830);
}

.llm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.llm-btn--sm {
  padding: 0.25rem 0.5rem;
  font-size: var(--llm-font-size-xs, 0.75rem);
}

.llm-btn--primary {
  background: var(--llm-accent, #6366f1);
  border-color: var(--llm-accent, #6366f1);
  color: var(--llm-bg, #181a1f);
}

.llm-btn--primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.llm-btn--secondary {
  background: var(--llm-bg-mute, #242830);
  border-color: var(--llm-accent, #6366f1);
  color: var(--llm-accent, #6366f1);
}

.llm-btn--ghost {
  background: transparent;
  border-color: transparent;
}

.llm-btn--ghost:hover:not(:disabled) {
  background: var(--llm-bg-mute, #242830);
}

.llm-btn--danger {
  background: var(--llm-error, #ef4444);
  border-color: var(--llm-error, #ef4444);
  color: #ffffff;
}

.llm-btn--danger:hover:not(:disabled) {
  filter: brightness(1.1);
}

/* Form controls */
.llm-form-control {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--llm-border, #33383f);
  border-radius: var(--llm-radius-sm, 4px);
  background: var(--llm-bg, #181a1f);
  color: var(--llm-text, #e6e8ea);
  font-size: var(--llm-font-size-sm, 0.85rem);
}

.llm-form-control:focus {
  outline: none;
  border-color: var(--llm-accent, #6366f1);
}

.llm-form-control:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Provider list */
.llm-provider-list {
  margin-bottom: 2rem;
  padding-bottom: 1.5rem;
}

.llm-provider-list:not(:last-child) {
  border-bottom: 1px solid var(--llm-border, #33383f);
}

.llm-provider-list h3 {
  margin: 0 0 1rem 0;
  color: var(--llm-text, #e6e8ea);
  font-size: 1rem;
}

.llm-provider-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  border: 1px solid var(--llm-border, #33383f);
  border-radius: var(--llm-radius-sm, 4px);
  margin-bottom: 0.5rem;
  background: var(--llm-bg-soft, #1f2228);
  cursor: pointer;
  transition: all 0.15s ease;
  position: relative;
}

.llm-provider-item:hover {
  background: var(--llm-bg-mute, #242830);
  border-color: var(--llm-border-hover, #4b525c);
}

.llm-provider-item.active {
  border-color: var(--llm-accent, #6366f1);
  background: var(--llm-bg, #181a1f);
  box-shadow: 0 0 0 1px var(--llm-border, #33383f);
}

.llm-provider-item.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.llm-provider-info {
  flex: 1;
}

.llm-provider-name-row {
  display: flex;
  align-items: center;
  margin-bottom: 0.25rem;
}

.llm-provider-name {
  font-weight: 500;
  color: var(--llm-text, #e6e8ea);
  font-size: 0.95rem;
}

.llm-active-badge, .llm-judge-badge {
  position: absolute;
  top: -12px;
  background: var(--llm-accent, #6366f1);
  color: var(--llm-bg, #181a1f);
  font-size: 0.6rem;
  font-weight: bold;
  padding: 0.2rem 0.5rem;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  z-index: 1;
}

.llm-active-badge { left: 16px; }
.llm-judge-badge { left: 80px; }

.llm-disabled-badge {
  background: var(--llm-border, #33383f);
  color: var(--llm-text, #e6e8ea);
  font-size: 0.65rem;
  font-weight: 500;
  padding: 0.1rem 0.4rem;
  border-radius: 2px;
  margin-left: 0.5rem;
  text-transform: uppercase;
}

.llm-provider-details-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.llm-test-status-btn {
  background: none;
  border: 1px solid var(--llm-border, #33383f);
  color: var(--llm-text, #e6e8ea);
  font-size: 0.7rem;
  font-weight: 500;
  padding: 0.25rem 0.5rem;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s ease;
  min-width: 60px;
  text-align: center;
}

.llm-test-status-btn.llm-test-default:hover:not(:disabled) {
  background: var(--llm-bg-mute, #242830);
  border-color: var(--llm-accent, #6366f1);
}

.llm-test-status-btn.llm-test-testing {
  border-color: var(--llm-border-hover, #4b525c);
}

.llm-test-status-btn.llm-test-success {
  border-color: var(--llm-success, #10b981);
  color: var(--llm-success, #10b981);
}

.llm-test-status-btn.llm-test-failed {
  border-color: var(--llm-error, #ef4444);
  color: var(--llm-error, #ef4444);
}

.llm-provider-details {
  font-size: 0.8rem;
  color: var(--llm-text-dim, #9aa0a6);
  flex: 1;
}

.llm-provider-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

/* Form grid */
.llm-form-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1rem;
  align-items: center;
}

.llm-field-label {
  margin-bottom: 0;
  white-space: nowrap;
  color: var(--llm-text, #e6e8ea);
  font-size: var(--llm-font-size-sm, 0.85rem);
}

/* API key field */
.llm-api-key-field {
  display: flex;
  flex-direction: column;
}

.llm-api-key-input-row {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
}

.llm-api-key-input-row .llm-form-control {
  flex: 1;
}

.llm-api-key-field .llm-security-note {
  margin-top: 0.5rem;
}

/* Model selector */
.llm-model-selector {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
  flex-wrap: wrap;
}

.llm-model-selector .llm-form-control {
  flex: 1;
}

.llm-refresh-btn {
  min-width: 4rem;
  flex-shrink: 0;
}

.llm-model-error {
  width: 100%;
  font-size: 0.75rem;
  color: var(--llm-error, #ef4444);
}

.llm-thinking-toggle {
  display: block;
  width: 100%;
  margin-top: 0.5rem;
}

/* Temperature field */
.llm-temperature-field {
  display: flex;
  flex-direction: column;
}

.llm-field-note {
  display: block;
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: var(--llm-text-dim, #9aa0a6);
  font-style: italic;
}

/* Checkbox */
.llm-checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-weight: 500;
  color: var(--llm-text, #e6e8ea);
  font-size: var(--llm-font-size-sm, 0.85rem);
}

.llm-checkbox {
  width: 1rem;
  height: 1rem;
  cursor: pointer;
}

/* Security note */
.llm-security-note {
  display: block;
  font-size: 0.75rem;
  color: var(--llm-text-dim, #9aa0a6);
}

/* Modal footer */
.llm-modal-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1.5rem;
  border-top: 1px solid var(--llm-border, #33383f);
  flex-shrink: 0;
}

.llm-footer-spacer {
  flex: 1;
}

/* Empty state */
.llm-empty-state {
  text-align: center;
  padding: 2rem;
  color: var(--llm-text-dim, #9aa0a6);
}

.llm-empty-state p {
  margin: 0.5rem 0;
  font-size: 0.9rem;
}

/* Keys manager overlay */
.llm-keys-manager-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1001;
}

.llm-keys-manager-content {
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  border: 2px solid var(--llm-border, #33383f);
  border-radius: var(--llm-radius-md, 8px);
  overflow: hidden;
}

/* Responsive */
@media (max-width: 768px) {
  .llm-modal {
    width: 95%;
    margin: 1rem;
  }
  
  .llm-modal-body,
  .llm-modal-header,
  .llm-modal-footer {
    padding: 1rem;
  }
  
  .llm-provider-item {
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
    padding: 0.75rem;
  }
  
  .llm-provider-actions {
    width: 100%;
    justify-content: flex-end;
  }
  
  .llm-form-grid {
    grid-template-columns: 1fr;
    gap: 0.5rem;
  }
  
  .llm-field-label {
    padding-top: 0;
    margin-top: 0.5rem;
  }
  
  .llm-active-badge, .llm-judge-badge {
    top: -8px;
    font-size: 0.55rem;
    padding: 0.15rem 0.4rem;
  }
  .llm-judge-badge { left: 66px; }
}

@media (max-width: 480px) {
  .llm-modal {
    width: 98%;
    margin: 0.5rem;
  }
  
  .llm-modal-body,
  .llm-modal-header,
  .llm-modal-footer {
    padding: 0.75rem;
  }
}
</style>
