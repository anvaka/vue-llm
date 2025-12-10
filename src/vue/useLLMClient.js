import { inject, ref } from 'vue'
import { LLM_CLIENT_SYMBOL } from './plugin.js'

export function useLLMClient() {
  const client = inject(LLM_CLIENT_SYMBOL)
  if (!client) throw new Error('LLM client not provided. Did you install the plugin?')
  const isStreaming = ref(false)
  const content = ref('')
  const thinking = ref('')
  let cancelFn = null

  async function stream(messages, options = {}) {
    isStreaming.value = true
    content.value = ''
    thinking.value = ''
    const full = await client.stream({ messages, ...options }, (chunk) => {
      content.value = chunk.fullContent
      thinking.value = chunk.fullThinking
    }).catch(e => { throw e }).finally(() => { isStreaming.value = false })
    return full
  }

  function cancel() {
    if (cancelFn) cancelFn()
  }

  return { client, stream, cancel, state: { isStreaming, content, thinking } }
}
