import { createApp } from 'vue'
import App from './App.vue'
import { LLMPlugin } from '@lib/vue/index.js'
import { seedFromShell } from './preconfig.js'
import '@lib/styles/variables.css'
import '@lib/styles/components.css'

// Seed provider configs from shell secrets (dev only) BEFORE the plugin reads
// storage, so autoInit picks up a ready-to-use active provider. Keys live in
// localStorage / the dev-served bundle only — nothing is baked into source.
const loaded = seedFromShell()
if (loaded.length) console.info('[demo] providers from shell:', loaded.join(', '))

createApp(App)
  .use(LLMPlugin, { namespace: 'llm', autoInit: true })
  .mount('#app')
