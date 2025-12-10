<template>
  <div class="llm-stored-keys-manager">
    <div class="llm-manager-header">
      <h3>Stored API Keys</h3>
      <button class="llm-btn llm-btn--ghost llm-btn--sm llm-close-btn" @click="$emit('close')">×</button>
    </div>
    
    <div class="llm-manager-body">
      <div class="llm-scrollable-content">
        <div v-if="Object.keys(storedKeys).length === 0 && !showAddForm" class="llm-empty-keys">
          <p>No API keys stored yet.</p>
          <small>Keys are automatically stored when you save a provider configuration.</small>
        </div>
        
        <div v-if="Object.keys(storedKeys).length > 0 || showAddForm" class="llm-keys-list">
          <div 
            v-for="(keyData, keyId) in storedKeys" 
            :key="keyId"
            class="llm-key-item"
          >
            <div class="llm-key-header">
              <div class="llm-provider-info">
                <div class="llm-provider-header">
                  <div class="llm-provider-name">{{ getProviderDisplayName(keyId) }}</div>
                  <span class="llm-stored-date">{{ formatDate(keyData.storedAt) }}</span>
                </div>
                <div v-if="keyData.serviceEndpoint" class="llm-service-endpoint">
                  <small>{{ keyData.serviceEndpoint }}</small>
                </div>
                <div class="llm-key-input-row">
                  <input 
                    v-model="editValues[keyId]"
                    :type="showKeys[keyId] ? 'text' : 'password'"
                    class="llm-form-control llm-key-input-inline"
                    :placeholder="keyData.maskedKey"
                    @keyup.enter="saveKey(keyId)"
                    @keyup.escape="cancelEdit(keyId)"
                    @blur="saveKey(keyId)"
                  />
                  <button 
                    type="button"
                    class="llm-btn llm-btn--ghost llm-btn--sm"
                    @click="toggleKeyVisibility(keyId)"
                    :title="showKeys[keyId] ? 'Hide key' : 'Show key'"
                  >
                    {{ showKeys[keyId] ? 'Hide' : 'Show' }}
                  </button>
                  <button 
                    class="llm-btn llm-btn--sm llm-btn--danger"
                    @click="confirmDeleteKey(keyId)"
                    title="Delete key"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Add New Key Item -->
          <div v-if="showAddForm" class="llm-key-item">
            <div class="llm-key-header">
              <div class="llm-provider-info">
                <div class="llm-provider-header">
                  <select v-model="newKeyProvider" class="llm-form-control llm-provider-select">
                    <option value="">Select provider type...</option>
                    <option 
                      v-for="(config, key) in PROVIDER_CONFIGS" 
                      :key="key" 
                      :value="key"
                      :disabled="key !== 'custom' && hasStoredKeyForType(key)"
                    >
                      {{ config.name }} {{ (key !== 'custom' && hasStoredKeyForType(key)) ? '(already stored)' : '' }}
                    </option>
                  </select>
                </div>
                <div class="llm-key-input-row">
                  <input 
                    v-model="newKeyValue"
                    :type="showNewKey ? 'text' : 'password'"
                    class="llm-form-control llm-key-input-inline"
                    placeholder="Enter API key"
                    @keyup.enter="addNewKey"
                    @keyup.escape="cancelAddKey"
                  />
                  <button 
                    type="button"
                    class="llm-btn llm-btn--ghost llm-btn--sm"
                    @click="showNewKey = !showNewKey"
                    :title="showNewKey ? 'Hide key' : 'Show key'"
                  >
                    {{ showNewKey ? 'Hide' : 'Show' }}
                  </button>
                  <button 
                    class="llm-btn llm-btn--sm llm-btn--danger"
                    @click="cancelAddKey"
                    title="Cancel"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="llm-manager-footer">
      <button 
        class="llm-btn llm-btn--secondary"
        @click="startAddNewKey"
      >
        Add New Key
      </button>
      <div class="llm-footer-spacer"></div>
      <button class="llm-btn llm-btn--ghost" @click="$emit('close')">
        Close
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useLLM } from '../useLLM.js'
import { DEFAULT_CONFIGS } from '../../providers/factory.js'
import { maskApiKey } from '../../core/keyStore.js'

const emit = defineEmits(['close', 'keysUpdated'])

const PROVIDER_CONFIGS = DEFAULT_CONFIGS

const { 
  getAllStoredKeys, 
  getStoredKey, 
  storeKey, 
  deleteStoredKey, 
  hasStoredKey 
} = useLLM()

// Reactive data
const storedKeys = ref({})
const editValues = ref({})
const showKeys = ref({})
const showAddForm = ref(false)
const newKeyProvider = ref('')
const newKeyValue = ref('')
const showNewKey = ref(false)

// Methods
const hasStoredKeyForType = (type) => hasStoredKey(type)

const refreshStoredKeys = () => {
  const allKeys = getAllStoredKeys()
  const formattedKeys = {}
  
  for (const [keyId, keyData] of Object.entries(allKeys)) {
    let displayName = keyId
    let providerType = keyData.providerType || keyId
    
    if (keyData.providerType === 'custom') {
      if (keyData.providerName) {
        displayName = keyData.providerName
      } else if (keyData.serviceEndpoint) {
        try {
          displayName = `Custom (${new URL(keyData.serviceEndpoint).hostname})`
        } catch {
          displayName = 'Custom Provider'
        }
      } else {
        displayName = 'Custom Provider'
      }
    } else if (PROVIDER_CONFIGS[providerType]) {
      displayName = PROVIDER_CONFIGS[providerType].name
    }
    
    formattedKeys[keyId] = {
      maskedKey: maskApiKey(keyData.apiKey),
      storedAt: keyData.storedAt,
      providerType: keyData.providerType || keyId,
      serviceEndpoint: keyData.serviceEndpoint,
      providerName: keyData.providerName,
      displayName
    }
    
    if (!editValues.value[keyId]) {
      editValues.value[keyId] = ''
    }
    if (showKeys.value[keyId] === undefined) {
      showKeys.value[keyId] = false
    }
  }
  
  storedKeys.value = formattedKeys
}

const getProviderDisplayName = (keyId) => {
  const keyData = storedKeys.value[keyId]
  return keyData?.displayName || PROVIDER_CONFIGS[keyId]?.name || keyId
}

const formatDate = (dateString) => {
  return new Date(dateString).toLocaleDateString()
}

const toggleKeyVisibility = (keyId) => {
  showKeys.value[keyId] = !showKeys.value[keyId]
  if (showKeys.value[keyId] && !editValues.value[keyId]) {
    editValues.value[keyId] = getStoredKey(keyId) || ''
  }
}

const saveKey = (keyId) => {
  const newValue = editValues.value[keyId]
  if (!newValue || !newValue.trim()) {
    editValues.value[keyId] = ''
    return
  }
  
  const currentKey = getStoredKey(keyId)
  if (newValue !== currentKey) {
    const keyData = storedKeys.value[keyId]
    const options = {
      providerType: keyData.providerType,
      ...(keyData.serviceEndpoint && { serviceEndpoint: keyData.serviceEndpoint }),
      ...(keyData.providerName && { providerName: keyData.providerName })
    }
    const success = storeKey(keyId, newValue, options)
    if (success) {
      refreshStoredKeys()
      emit('keysUpdated')
    }
  }
}

const cancelEdit = (keyId) => {
  editValues.value[keyId] = ''
  showKeys.value[keyId] = false
}

const confirmDeleteKey = (keyId) => {
  const providerName = getProviderDisplayName(keyId)
  if (confirm(`Delete stored API key for ${providerName}?\n\nThis action cannot be undone.`)) {
    const success = deleteStoredKey(keyId)
    if (success) {
      refreshStoredKeys()
      emit('keysUpdated')
    }
  }
}

const addNewKey = () => {
  if (!newKeyProvider.value || !newKeyValue.value.trim()) return
  
  const keyId = newKeyProvider.value === 'custom' 
    ? `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    : newKeyProvider.value
  
  const options = { providerType: newKeyProvider.value }
  
  const success = storeKey(keyId, newKeyValue.value, options)
  if (success) {
    refreshStoredKeys()
    emit('keysUpdated')
    
    newKeyProvider.value = ''
    newKeyValue.value = ''
    showNewKey.value = false
    showAddForm.value = false
  }
}

const cancelAddKey = () => {
  newKeyProvider.value = ''
  newKeyValue.value = ''
  showNewKey.value = false
  showAddForm.value = false
}

const startAddNewKey = () => {
  showAddForm.value = true
  nextTick(() => {
    const newKeyElement = document.querySelector('.llm-key-item:last-child')
    if (newKeyElement) {
      newKeyElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })
}

// Auto-save when both provider and key are filled
watch([newKeyProvider, newKeyValue], ([provider, key]) => {
  if (provider && key && key.trim()) {
    setTimeout(() => {
      if (newKeyProvider.value === provider && newKeyValue.value === key) {
        addNewKey()
      }
    }, 500)
  }
})

onMounted(() => {
  refreshStoredKeys()
})
</script>

<style scoped>
.llm-stored-keys-manager {
  background: var(--llm-bg, #181a1f);
  border-radius: var(--llm-radius-md, 8px);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  color: var(--llm-text, #e6e8ea);
}

.llm-manager-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid var(--llm-border, #33383f);
  flex-shrink: 0;
}

.llm-manager-header h3 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--llm-text, #e6e8ea);
}

.llm-close-btn {
  font-size: 1.5rem;
  line-height: 1;
}

.llm-close-btn:hover {
  opacity: 0.7;
}

.llm-manager-body {
  flex: 1;
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.llm-scrollable-content {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  min-height: 0;
}

.llm-empty-keys {
  text-align: center;
  padding: 2rem 1rem;
  color: var(--llm-text-dim, #9aa0a6);
}

.llm-empty-keys p {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
  font-weight: 500;
}

.llm-empty-keys small {
  font-size: 0.9rem;
  opacity: 0.7;
}

.llm-keys-list {
  margin-bottom: 1rem;
}

.llm-key-item {
  border: 1px solid var(--llm-border, #33383f);
  border-radius: var(--llm-radius-sm, 6px);
  margin-bottom: 0.75rem;
  background: var(--llm-bg-soft, #1f2228);
  overflow: hidden;
}

.llm-key-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 0.75rem;
}

.llm-provider-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.llm-provider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.llm-provider-name {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--llm-text, #e6e8ea);
}

.llm-service-endpoint {
  margin-top: 0.25rem;
}

.llm-service-endpoint small {
  color: var(--llm-text-dim, #9aa0a6);
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
  font-size: 0.75rem;
}

.llm-provider-select {
  font-weight: 600;
  font-size: 0.9rem;
  min-width: 200px;
}

.llm-key-input-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.llm-key-input-inline {
  flex: 1;
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
  font-size: 0.8rem;
  padding: 0.4rem 0.6rem;
}

.llm-stored-date {
  font-size: 0.75rem;
  color: var(--llm-text-dim, #9aa0a6);
}

.llm-manager-footer {
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

/* Buttons (same as LLMConfigModal) */
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

.llm-btn--sm {
  padding: 0.25rem 0.5rem;
  font-size: var(--llm-font-size-xs, 0.75rem);
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

/* Form control */
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

/* Responsive */
@media (max-width: 768px) {
  .llm-manager-header,
  .llm-manager-footer {
    padding: 1rem;
  }
  
  .llm-scrollable-content {
    padding: 1rem;
  }
  
  .llm-key-header {
    flex-direction: column;
    align-items: stretch;
    gap: 1rem;
    padding: 0.75rem;
  }
  
  .llm-key-input-row {
    flex-direction: column;
    align-items: stretch;
  }
  
  .llm-provider-select {
    min-width: auto;
  }
}

@media (max-width: 480px) {
  .llm-manager-header h3 {
    font-size: 1.1rem;
  }
}
</style>
