<script setup>
import { ref, computed, onMounted } from 'vue'
import { useLLM, ProviderSelector, LLMConfigModal } from '@lib/vue/index.js'
import { effortLevelsFor } from '@lib/providers/reasoningPolicy.js'
import { shellLabels, reseedFromShell } from './preconfig.js'
import { summarizeImages, fmtBytes } from './wireSummary.js'

const { client, getActiveConfig } = useLLM()

// Labels of providers seeded from the shell at dev time (see demo/preconfig.js).
const shellLoaded = shellLabels

const showConfig = ref(false)
const activeConfig = ref(null)
const capabilities = ref([])

// A genuinely hard prompt so adaptive thinking actually engages — trivial
// prompts (e.g. the bat-and-ball) are answered without thinking, leaving the
// Thinking panel empty and making it look like reasoning is missing.
const DEFAULT_PROMPT =
  'You have 12 identical-looking coins; exactly one is counterfeit and differs in ' +
  'weight (you do NOT know whether it is heavier or lighter). Using a balance scale ' +
  'only 3 times, give a complete decision procedure that always identifies the fake ' +
  'coin AND whether it is heavy or light. Enumerate every weighing and branch.'
// Swapped in on the first attachment, but only while the prompt is still the
// untouched default — asking a coin-weighing riddle about a screenshot makes the
// image path look broken when it is working fine.
const VISION_PROMPT = 'Describe this image in detail. What text, objects and colors do you see?'
const prompt = ref(DEFAULT_PROMPT)
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
const supportsVision = computed(() => capabilities.value.includes('vision'))

// ---- Image attachments ------------------------------------------------------
// A browser file input yields a `data:` URL, which is exactly what the library's
// canonical image part wants — each provider's converter decides whether to pass
// it through whole or split it into base64 + media type.
const attachments = ref([])   // { id, name, mime, url, bytes, note }
const dragging = ref(false)
let nextAttachmentId = 1

// Anthropic caps an image at 5 MB and measures the BASE64 STRING, not the
// decoded file — the 400 names the field it counted
// (`content.1.image.source.base64: ... 6755172 bytes > 5242880 bytes`).
// Base64 inflates by 4/3, so a 4.8 MB photo is a 6.4 MB payload: comparing
// file.size against this cap lets everything between 3.75 MB and 5 MB through.
// Always measure the encoded length.
const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024

// Bytes of base64 payload in a data URL — the number providers actually count.
function encodedBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? 0 : dataUrl.length - comma - 1
}

const oversized = computed(() => attachments.value.filter(a => a.bytes > IMAGE_LIMIT_BYTES))
const resized = computed(() => attachments.value.filter(a => a.note))

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = src
  })
}

// Scale an over-cap image down until its base64 payload fits. Re-encodes as
// JPEG because that alone usually wins more than the resize does (a screenshot
// PNG can be 10x its JPEG equivalent). Returns null if it can't get under.
async function shrinkToLimit(dataUrl, limitBytes) {
  const img = await loadImage(dataUrl)
  let scale = 1
  for (let attempt = 0; attempt < 8; attempt++) {
    // First pass re-encodes at full size; later passes also shrink dimensions.
    if (attempt > 0) scale *= 0.75
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    // JPEG has no alpha; fill white so transparent areas don't come out black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const out = canvas.toDataURL('image/jpeg', 0.85)
    if (encodedBytes(out) <= limitBytes) {
      return { url: out, mime: 'image/jpeg', width: canvas.width, height: canvas.height }
    }
  }
  return null
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

async function addFiles(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  const rejected = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) { rejected.push(file.name); continue }
    try {
      let url = await readAsDataURL(file)
      let mime = file.type
      let note = null
      const encoded = encodedBytes(url)
      if (encoded > IMAGE_LIMIT_BYTES) {
        const shrunk = await shrinkToLimit(url, IMAGE_LIMIT_BYTES)
        if (shrunk) {
          note = `resized from ${fmtBytes(encoded)} → ${shrunk.width}×${shrunk.height} jpeg`
          url = shrunk.url
          mime = shrunk.mime
        }
      }
      attachments.value = [...attachments.value, {
        id: nextAttachmentId++, name: file.name, mime, url, bytes: encodedBytes(url), note
      }]
    } catch (e) {
      rejected.push(file.name)
    }
  }
  if (rejected.length) errorMsg.value = `Skipped (not a readable image): ${rejected.join(', ')}`
  if (attachments.value.length && prompt.value === DEFAULT_PROMPT) prompt.value = VISION_PROMPT
}

function removeAttachment(id) { attachments.value = attachments.value.filter(a => a.id !== id) }
function clearAttachments() { attachments.value = [] }

function onPickFiles(e) { addFiles(e.target.files); e.target.value = '' }
function onDrop(e) { dragging.value = false; addFiles(e.dataTransfer?.files) }
function onPaste(e) {
  const files = e.clipboardData?.files
  if (files?.length) { e.preventDefault(); addFiles(files) }
}


// Explain an empty Thinking panel after a Run that requested thinking. With
// display:'summarized' the Claude/Bedrock path now returns readable thinking
// text, so an empty panel means the model spent no reasoning tokens (adaptive
// thinking skipped it) or the provider genuinely returned none.
const thinkingNote = computed(() => {
  if (!ranWithThinking.value || thinking.value) return ''
  const rt = metrics.value?.usage?.reasoningTokens
  if (rt > 0) return `${rt} reasoning tokens were spent but no reasoning text came back for this request.`
  if (rt === 0) return 'Adaptive thinking chose not to think on this prompt — try a harder question or higher effort.'
  return 'No reasoning was returned for this request.'
})

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
  const images = summarizeImages(body)
  if (images.length) out.images = images
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

// With no attachments, content stays a plain string — the canonical part array
// is only used when it earns its keep.
function messages() {
  if (!attachments.value.length) return [{ role: 'user', content: prompt.value }]
  return [{
    role: 'user',
    content: [
      { type: 'text', text: prompt.value },
      ...attachments.value.map(a => ({ type: 'image_url', image_url: { url: a.url } }))
    ]
  }]
}

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

// Remember whether the last Run asked for thinking, so the output panel can
// explain an empty thinking box (e.g. Bedrock redacts reasoning text).
const ranWithThinking = ref(false)

async function run() {
  if (!activeConfig.value) { errorMsg.value = 'Pick and configure a provider first.'; return }
  errorMsg.value = ''; answer.value = ''; thinking.value = ''; metrics.value = null; wire.value = null
  ranWithThinking.value = enableThinking.value
  busy.value = true
  const t0 = performance.now()
  try {
    const res = await withWireCapture(() => client.stream(
      payload(effort.value, enableThinking.value),
      (c) => { answer.value = c.fullContent || ''; thinking.value = c.fullThinking || '' }
    ))
    // client cost is a breakdown object { total, input, output, ... } (or null
    // when the model has no pricing entry) — display the total.
    metrics.value = { latencyMs: Math.round(performance.now() - t0), usage: res.usage, cost: res.cost?.total ?? null }
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
        cost: res.cost?.total ?? null,
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
        <h1>vue-llm · provider playground</h1>
        <p class="sub">Test <code>reasoningEffort</code> and image input across providers. Keys stay in your browser.</p>
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
      <span class="pill" :class="supportsVision ? 'pill--on' : 'pill--off'">vision</span>
      <span v-if="supportsEffort" class="pill pill--info">effort: {{ effortLevels.join(' · ') }}</span>
      <span v-else class="pill pill--off">no effort control</span>
    </section>
    <section v-else class="active">
      <span class="pill pill--off">No active provider — click “Configure providers”, add one, then select it.</span>
    </section>

    <section class="grid">
      <div class="panel">
        <label class="lbl">Prompt</label>
        <textarea v-model="prompt" rows="5" class="ta" @paste="onPaste"></textarea>

        <div class="images"
             :class="{ 'images--drag': dragging }"
             @dragover.prevent="dragging = true"
             @dragleave.prevent="dragging = false"
             @drop.prevent="onDrop">
          <div class="images-head">
            <label class="lbl">Images</label>
            <div class="images-actions">
              <label class="file-btn">
                Add image…
                <input type="file" accept="image/*" multiple hidden @change="onPickFiles" />
              </label>
              <button v-if="attachments.length" class="file-btn" type="button" @click="clearAttachments">Clear</button>
            </div>
          </div>

          <div v-if="attachments.length" class="thumbs">
            <figure v-for="a in attachments" :key="a.id" class="thumb">
              <img :src="a.url" :alt="a.name" />
              <button class="thumb-x" type="button" :title="`Remove ${a.name}`" @click="removeAttachment(a.id)">×</button>
              <figcaption :title="a.note || 'base64 payload size — the number providers measure'">
                {{ a.mime.replace('image/', '') }} · {{ fmtBytes(a.bytes) }}<span v-if="a.note"> ·&nbsp;resized</span>
              </figcaption>
            </figure>
          </div>
          <p v-else class="images-empty">
            Drop an image here, paste one into the prompt, or use “Add image…”. Sent as a
            <code>data:</code> URL — each provider converts it to its own wire shape.
          </p>

          <p v-if="attachments.length && !supportsVision" class="images-warn">
            This model has no <b>vision</b> capability — the request will be rejected before it is sent
            (better than paying for an answer about an image the model never saw). Pick a vision-capable model.
          </p>
          <p v-else-if="oversized.length" class="images-warn">
            {{ oversized.map(a => a.name).join(', ') }} still exceeds the 5 MB cap after resizing and will be rejected.
            Claude measures the <b>base64</b> payload, which is ~4/3 of the file size.
          </p>
          <p v-else-if="resized.length" class="images-note">
            {{ resized.map(a => `${a.name}: ${a.note}`).join(' · ') }} — over the 5 MB cap, which Claude applies to the
            base64 payload (~4/3 of the file size).
          </p>
        </div>

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
          <label class="lbl">Reasoning + image fields sent on the wire</label>
          <pre>{{ JSON.stringify(wire, null, 2) }}</pre>
          <p v-if="wire.images" class="hint">
            Image payloads are shown by size, not inlined. Switch providers and re-run the same attachment to watch
            the shape change: <code>image_url</code> (OpenAI-family) vs <code>source.base64</code> (Anthropic) vs
            <code>inlineData</code> (Gemini) vs <code>message.images[]</code> (Ollama).
          </p>
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
        <template v-else-if="thinkingNote">
          <label class="lbl">Thinking</label>
          <p class="think-note">{{ thinkingNote }}</p>
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
      <p class="hint">
        Higher effort should trend toward more output tokens, latency, and cost — until output hits the Max tokens cap
        (raise it to see the spread). Claude counts thinking inside output tokens, so “reasoning tok” stays blank for it;
        it only fills in for providers that report a separate count (gpt-5, o-series, DeepSeek reasoner).
      </p>
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
.images { margin-top: 12px; padding: 10px; border: 1px dashed rgba(255,255,255,0.16); border-radius: 8px; transition: border-color 0.15s, background 0.15s; }
.images--drag { border-color: #8ab4ff; background: rgba(138,180,255,0.08); }
.images-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.images-head .lbl { margin-bottom: 0; }
.images-actions { display: flex; gap: 8px; }
.file-btn { padding: 3px 10px; font: inherit; font-size: 0.76rem; color: #cdd3da; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; cursor: pointer; }
.file-btn:hover { background: rgba(255,255,255,0.13); border-color: rgba(255,255,255,0.32); }
.images-empty { margin: 8px 0 0; font-size: 0.76rem; color: var(--llm-text-dim, #9aa0a6); }
.images-empty code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 4px; }
.images-warn { margin: 8px 0 0; font-size: 0.76rem; color: #ffcf8f; }
.images-note { margin: 8px 0 0; font-size: 0.76rem; color: #8ab4ff; }
.thumbs { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.thumb { position: relative; margin: 0; width: 84px; }
.thumb img { width: 84px; height: 64px; object-fit: cover; border-radius: 6px; border: 1px solid rgba(255,255,255,0.14); display: block; }
.thumb figcaption { margin-top: 3px; font-size: 0.64rem; color: var(--llm-text-dim, #9aa0a6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thumb-x { position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; line-height: 1; padding: 0; font-size: 0.9rem; color: #e6e8ea; background: #333a44; border: 1px solid rgba(255,255,255,0.28); border-radius: 999px; cursor: pointer; }
.thumb-x:hover { background: #4a525e; }
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
.think-note { margin: 0 0 4px; padding: 10px; font-size: 0.78rem; color: #9aa0a6; font-style: italic; background: #0c0f13; border: 1px dashed rgba(255,255,255,0.14); border-radius: 8px; }
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
