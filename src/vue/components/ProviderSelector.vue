<script setup>
import { ref, onMounted } from 'vue'
import { useLLM } from '../useLLM.js'

const emit = defineEmits(['changed', 'open-config'])

const { client, getEnabledConfigs, getActiveProviderId, setActiveProviderId, refresh } = useLLM()

const providers = ref([])
const activeProviderId = ref('')

const refreshProviders = () => {
  providers.value = getEnabledConfigs()
  activeProviderId.value = getActiveProviderId() || ''
}

const handleSelectionChange = async () => {
  if (activeProviderId.value === '__configure__') {
    activeProviderId.value = getActiveProviderId() || ''
    emit('open-config')
    return
  }
  if (!activeProviderId.value) return
  setActiveProviderId(activeProviderId.value)
  try { await refresh() } catch {}
  emit('changed', activeProviderId.value)
}

onMounted(() => {
  refreshProviders()
})
</script>

<template>
  <div class="llm-provider-selector">
    <select v-model="activeProviderId" @change="handleSelectionChange" class="llm-provider-select">
      <option value="" disabled>Select Provider...</option>
      <option v-for="provider in providers" :key="provider.id" :value="provider.id">
        {{ provider.name }}
      </option>
      <option value="__configure__" class="config-option">Manage Providers...</option>
    </select>
  </div>
  
</template>

<style scoped>
.llm-provider-selector { font-size: var(--llm-font-size-sm, 0.85rem); }
.llm-provider-select {
  padding: var(--llm-spacing-xs, 0.25rem) var(--llm-spacing-sm, 0.5rem);
  border: 1px solid var(--llm-border, #444);
  border-radius: var(--llm-radius-sm, 4px);
  background: var(--llm-bg, #111);
  color: var(--llm-text, #ddd);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  min-width: 120px;
  max-width: 180px;
}
.llm-provider-select:focus { outline: none; border-color: var(--llm-accent, #6c7cff); }
.llm-provider-select:hover { border-color: var(--llm-border-hover, #666); }
.config-option { font-style: italic; border-top: 1px solid var(--llm-border, #444); }
</style>
