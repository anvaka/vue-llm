<script setup>
import { ref, computed, onMounted } from 'vue'
import { useLLM, ProviderSelector, LLMConfigModal } from '@lib/vue/index.js'
import { effortLevelsFor } from '@lib/providers/reasoningPolicy.js'
import { shellLabels, reseedFromShell } from './preconfig.js'

const { client, getActiveConfig } = useLLM()

// Labels of providers seeded from the shell at dev time (see demo/preconfig.js).
const shellLoaded = shellLabels

const showConfig = ref(false)
const activeConfig = ref(null)
const capabilities = ref([])

const prompt = ref(
  'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. ' +
  'How much does the ball cost? Show your reasoning, then give two other puzzles ' +
  'people get wrong the same way and explain the trap in each.'
)
const enableThinking = ref(false)
const effort = ref('medium')
const maxTokens = ref(2000)
const temperature = ref(0.7)

const busy = ref(false)
const answer = ref('')
const thinking = ref('')
const metrics = ref(null)   // { latencyMs, usage, cost }
const wire = ref(null)      // reasoning-related slice of the last request body
const sweepRows = ref([])
const errorMsg = ref('')

// Effort levels the active model accepts (empty => no graded effort control).
const effortLevels = computed(() =>
  activeConfig.value ? (effortLevelsFor(activeConfig.value.model) || []) : []
)
const supportsEffort = computed(() => effortLevels.value.length > 0)

async function syncActive() {
  errorMsg.value = ''
  try { await client.ensureInitialized() } catch { /* not configured yet */ }
  activeConfig.value = getActiveConfig()
  capabilities.value = client.getCapabilities?.() || []
  const c = activeConfig.value
  if (c) {
    enableThinking.value = !!c.enableThinking
    const lv = effortLevels.value
    effort.value = lv.includes(c.reasoningEffort)
      ? c.reasoningEffort
      : (lv.includes('medium') ? 'medium' : (lv[0] || 'medium'))
    if (c.maxTokens) maxTokens.value = c.maxTokens
    if (c.temperature != null) temperature.value = c.temperature
  }
}
onMounted(syncActive)

const reseedMsg = ref('')
// Overwrite the shell-seeded providers back to current shell values (fresh
// keys), then re-init the active provider — no reload needed.
async function reseed() {
  reseedFromShell()
  try { await client.refresh() } catch { /* not configured */ }
  await syncActive()
  reseedMsg.value = 'Reseeded from shell'
  setTimeout(() => { reseedMsg.value = '' }, 2500)
}

// The reasoning field is spelled differently per provider — capture whichever
// one the request actually carried so you can SEE effort land on the wire.
function pickWire(body) {
  const out = { model: body.model }
  if (body.reasoning_effort !== undefined) out.reasoning_effort = body.reasoning_effort
  if (body.reasoning !== undefined) out.reasoning = body.reasoning
  if (body.output_config !== undefined) out.output_config = body.output_config
  if (body.thinking !== undefined) out.thinking = body.thinking
  if (body.temperature !== undefined) out.temperature = body.temperature
  return out
}
async function withWireCapture(fn) {
  const real = window.fetch
  let captured = null
  window.fetch = (url, opts) => {
    try { if (opts?.body) captured = pickWire(JSON.parse(opts.body)) } catch { /* non-JSON */ }
    return real(url, opts)
  }
  try { return await fn() }
  finally { window.fetch = real; wire.value = captured }
}

function messages() { return [{ role: 'user', content: prompt.value }] }

function payload(effortLevel, thinkingOn) {
  return {
    messages: messages(),
    model: activeConfig.value.model,
    enableThinking: thinkingOn,
    reasoningEffort: effortLevel,
    maxTokens: Number(maxTokens.value),
    temperature: Number(temperature.value)
  }
}

async function run() {
  if (!activeConfig.value) { errorMsg.value = 'Pick and configure a provider first.'; return }
  errorMsg.value = ''; answer.value = ''; thinking.value = ''; metrics.value = null; wire.value = null
  busy.value = true
  const t0 = performance.now()
  try {
    const res = await withWireCapture(() => client.stream(
      payload(effort.value, enableThinking.value),
      (c) => { answer.value = c.fullContent || ''; thinking.value = c.fullThinking || '' }
    ))
    metrics.value = { latencyMs: Math.round(performance.now() - t0), usage: res.usage, cost: res.cost }
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function sweep() {
  if (!activeConfig.value) { errorMsg.value = 'Pick and configure a provider first.'; return }
  if (!supportsEffort.value) { errorMsg.value = 'This model has no effort levels to sweep.'; return }
  errorMsg.value = ''; sweepRows.value = []; busy.value = true
  for (const lv of effortLevels.value) {
    const t0 = performance.now()
    try {
      // Force thinking on so effort actually bites regardless of the toggle.
      const res = await client.stream(payload(lv, true), () => {})
      sweepRows.value = [...sweepRows.value, {
        level: lv,
        latencyMs: Math.round(performance.now() - t0),
        output: res.usage?.outputTokens ?? null,
        reasoning: res.usage?.reasoningTokens ?? null,
        total: res.usage?.totalTokens ?? null,
        cost: res.cost ?? null,
        ok: true
      }]
    } catch (e) {
      sweepRows.value = [...sweepRows.value, { level: lv, ok: false, error: e?.message || String(e) }]
    }
  }
  busy.value = false
}

function fmtCost(c) { return (c == null) ? '—' : '$' + Number(c).toFixed(5) }
function fmtNum(n) { return (n == null) ? '—' : n }
</script>

<template>
  <div class="wrap">
    <header class="head">
      <div>
        <h1>vue-llm · reasoning effort playground</h1>
        <p class="sub">Test the <code>reasoningEffort</code> config across providers. Keys stay in your browser.</p>
      </div>
    </header>

    <p v-if="shellLoaded.length" class="shell-note">
      Auto-loaded from your shell: <b>{{ shellLoaded.join(', ') }}</b>. Keys stay local (never committed).
      <button class="reseed-btn" type="button" @click="reseed"
              title="Re-read keys from your shell and overwrite these providers (picks up a rotated key)">
        Reseed from shell
      </button>
      <span v-if="reseedMsg" class="reseed-ok">{{ reseedMsg }}</span>
    </p>

    <section class="bar">
      <ProviderSelector @changed="syncActive" @open-config="showConfig = true" />
      <button class="llm-btn llm-btn--secondary" @click="showConfig = true">Configure providers</button>
    </section>

    <section v-if="activeConfig" class="active">
      <span class="pill">{{ activeConfig.provider }}</span>
      <span class="pill pill--muted">{{ activeConfig.model || 'no model' }}</span>
      <span class="pill" :class="capabilities.includes('thinking') ? 'pill--on' : 'pill--off'">thinking</span>
      <span class="pill" :class="capabilities.includes('tools') ? 'pill--on' : 'pill--off'">tools</span>
      <span v-if="supportsEffort" class="pill pill--info">effort: {{ effortLevels.join(' · ') }}</span>
      <span v-else class="pill pill--off">no effort control</span>
    </section>
    <section v-else class="active">
      <span class="pill pill--off">No active provider — click “Configure providers”, add one, then select it.</span>
    </section>

    <section class="grid">
      <div class="panel">
        <label class="lbl">Prompt</label>
        <textarea v-model="prompt" rows="5" class="ta"></textarea>

        <div class="controls">
          <label class="chk">
            <input type="checkbox" v-model="enableThinking" /> Enable thinking
          </label>
          <label class="fld">
            Effort
            <select v-model="effort" :disabled="!supportsEffort" class="sel">
              <option v-if="!supportsEffort" value="">n/a</option>
              <option v-for="lv in effortLevels" :key="lv" :value="lv">{{ lv }}</option>
            </select>
          </label>
          <label class="fld">
            Max tokens
            <input type="number" v-model.number="maxTokens" min="1" class="num" />
          </label>
          <label class="fld">
            Temp
            <input type="number" v-model.number="temperature" min="0" max="2" step="0.1" class="num" />
          </label>
        </div>

        <div class="actions">
          <button class="llm-btn llm-btn--primary" :disabled="busy" @click="run">
            {{ busy ? 'Running…' : 'Run' }}
          </button>
          <button class="llm-btn llm-btn--secondary" :disabled="busy || !supportsEffort" @click="sweep"
                  :title="supportsEffort ? 'Run the prompt at every effort level' : 'Model has no effort levels'">
            Sweep all effort levels
          </button>
        </div>

        <p v-if="errorMsg" class="err">{{ errorMsg }}</p>

        <div v-if="wire" class="wire">
          <label class="lbl">Reasoning fields sent on the wire</label>
          <pre>{{ JSON.stringify(wire, null, 2) }}</pre>
        </div>
      </div>

      <div class="panel">
        <div v-if="metrics" class="metrics">
          <div class="metric"><span>latency</span><b>{{ metrics.latencyMs }} ms</b></div>
          <div class="metric"><span>input</span><b>{{ fmtNum(metrics.usage?.inputTokens) }}</b></div>
          <div class="metric"><span>output</span><b>{{ fmtNum(metrics.usage?.outputTokens) }}</b></div>
          <div class="metric"><span>reasoning</span><b>{{ fmtNum(metrics.usage?.reasoningTokens) }}</b></div>
          <div class="metric"><span>cost</span><b>{{ fmtCost(metrics.cost) }}</b></div>
        </div>

        <template v-if="thinking">
          <label class="lbl">Thinking</label>
          <pre class="think">{{ thinking }}</pre>
        </template>

        <label class="lbl">Answer</label>
        <div class="answer" :class="{ empty: !answer }">{{ answer || '—' }}</div>
      </div>
    </section>

    <section v-if="sweepRows.length" class="panel">
      <label class="lbl">Effort sweep</label>
      <table class="sweep">
        <thead>
          <tr><th>effort</th><th>output tok</th><th>reasoning tok</th><th>total tok</th><th>latency</th><th>cost</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in sweepRows" :key="r.level">
            <td><b>{{ r.level }}</b></td>
            <template v-if="r.ok">
              <td>{{ fmtNum(r.output) }}</td>
              <td>{{ fmtNum(r.reasoning) }}</td>
              <td>{{ fmtNum(r.total) }}</td>
              <td>{{ r.latencyMs }} ms</td>
              <td>{{ fmtCost(r.cost) }}</td>
            </template>
            <td v-else colspan="5" class="err">{{ r.error }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">Higher effort should trend toward more output/reasoning tokens, latency, and cost.</p>
    </section>

    <LLMConfigModal :is-visible="showConfig" @close="showConfig = false" @config-changed="syncActive" />
  </div>
</template>

<style scoped>
.wrap { max-width: 1040px; margin: 0 auto; padding: 24px 20px 64px; color: var(--llm-text, #e6e8ea); font-family: system-ui, sans-serif; }
.head h1 { font-size: 1.3rem; margin: 0; }
.sub { margin: 4px 0 0; color: var(--llm-text-dim, #9aa0a6); font-size: 0.85rem; }
.sub code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; }
.shell-note { margin: 12px 0 0; padding: 8px 12px; font-size: 0.8rem; color: #cdd3da; background: rgba(126,226,184,0.08); border: 1px solid rgba(126,226,184,0.25); border-radius: 8px; }
.reseed-btn { margin-left: 8px; padding: 3px 10px; font: inherit; font-size: 0.76rem; color: #cdd3da; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; cursor: pointer; }
.reseed-btn:hover { background: rgba(255,255,255,0.13); border-color: rgba(255,255,255,0.32); }
.reseed-ok { margin-left: 8px; font-size: 0.76rem; color: #7ee2b8; }
.bar { display: flex; gap: 10px; align-items: center; margin: 18px 0 12px; flex-wrap: wrap; }
.active { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
.pill { font-size: 0.72rem; padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.1); }
.pill--muted { color: var(--llm-text-dim, #9aa0a6); }
.pill--on { color: #7ee2b8; border-color: rgba(126,226,184,0.4); }
.pill--off { color: #9aa0a6; }
.pill--info { color: #8ab4ff; border-color: rgba(138,180,255,0.4); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 780px) { .grid { grid-template-columns: 1fr; } }
.panel { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 14px; margin-bottom: 16px; }
.lbl { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--llm-text-dim, #9aa0a6); margin-bottom: 6px; }
.ta { width: 100%; box-sizing: border-box; background: var(--llm-input-bg, #12151a); color: inherit; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 10px; font: inherit; resize: vertical; }
.controls { display: flex; gap: 14px; align-items: end; flex-wrap: wrap; margin: 12px 0; }
.chk { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 0.72rem; color: var(--llm-text-dim, #9aa0a6); }
.sel, .num { background: var(--llm-input-bg, #12151a); color: var(--llm-text, #e6e8ea); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 6px 8px; font-size: 0.85rem; }
.num { width: 90px; }
.actions { display: flex; gap: 10px; }
.err { color: #ff8f8f; font-size: 0.82rem; margin-top: 10px; }
.wire { margin-top: 14px; }
.wire pre, .think { background: #0c0f13; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px; font-size: 0.78rem; overflow-x: auto; white-space: pre-wrap; }
.think { max-height: 200px; overflow-y: auto; color: #b9c0c8; }
.metrics { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.metric { display: flex; flex-direction: column; background: rgba(255,255,255,0.05); border-radius: 8px; padding: 8px 12px; min-width: 74px; }
.metric span { font-size: 0.66rem; text-transform: uppercase; color: var(--llm-text-dim, #9aa0a6); }
.metric b { font-size: 0.95rem; }
.answer { white-space: pre-wrap; line-height: 1.5; font-size: 0.9rem; min-height: 60px; }
.answer.empty { color: var(--llm-text-dim, #9aa0a6); }
.sweep { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.sweep th, .sweep td { text-align: left; padding: 7px 10px; border-bottom: 1px solid rgba(255,255,255,0.07); }
.sweep th { color: var(--llm-text-dim, #9aa0a6); font-weight: 500; }
.hint { color: var(--llm-text-dim, #9aa0a6); font-size: 0.78rem; margin: 8px 0 0; }
</style>
