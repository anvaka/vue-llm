import { createApp } from 'vue'
import App from './App.vue'
import { LLMPlugin } from '@lib/vue/index.js'
import '@lib/styles/variables.css'
import '@lib/styles/components.css'

// autoInit so the client picks up whatever provider was configured last run.
// Keys live in localStorage (entered via the config modal) — nothing is baked in.
createApp(App)
  .use(LLMPlugin, { namespace: 'llm', autoInit: true })
  .mount('#app')
