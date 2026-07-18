import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { homedir } from 'os'

// Standalone dev server for the playground. Runs against the library SOURCE
// (via the `@lib` alias) so edits to src/ hot-reload here with no rebuild.
//
// Convenience: on `npm run demo` it reads provider API keys from your shell
// secrets file (default ~/.config/zsh/secrets.zsh, override with
// DEMO_SECRETS_FILE) plus process.env, and hands them to the app via a
// compile-time global so the playground boots with providers already set up.
//
// SECURITY: keys are only injected in dev (`command === 'serve'`) and live only
// in the running dev server's memory / the dev-served JS. They are NEVER
// written to any tracked file, and `demo:build` omits them entirely.

// Parse `export NAME=value` lines out of a shell rc file. Values may be quoted;
// take everything after the first `=` (base64 keys legitimately contain `=`).
function parseShellEnv(path) {
  const out = {}
  let text
  try { text = readFileSync(path, 'utf8') } catch { return out }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    } else {
      val = val.split(/\s+#/)[0].trim() // drop trailing unquoted comment
    }
    if (val) out[m[1]] = val
  }
  return out
}

// Which shell env var names feed which provider preset. First present key wins.
// Models are effort-capable defaults so the playground is interesting on boot;
// change them (or add providers) via the Configure modal at runtime.
const PRESET_DEFS = [
  { id: 'shell-openai', label: 'OpenAI', keys: ['OPENAI_API_KEY', 'OPENAI_KEY'],
    config: { provider: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-5' } },
  { id: 'shell-anthropic', label: 'Anthropic', keys: ['ANTHROPIC_KEY', 'ANTHROPIC_API_KEY'],
    config: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-8' } },
  { id: 'shell-openrouter', label: 'OpenRouter', keys: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
    config: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-opus-4.7' } },
  { id: 'shell-bedrock', label: 'AWS Bedrock (Mantle)', keys: ['DEMO_BEDROCK_KEY', 'BEDROCK_KEY'],
    config: { provider: 'bedrock', backend: 'mantle', region: 'us-east-1',
              baseUrl: 'https://bedrock-mantle.us-east-1.api.aws', model: 'anthropic.claude-opus-4-8' } },
  { id: 'shell-deepseek', label: 'DeepSeek', keys: ['DEEPSEEK_KEY', 'DEEPSEEK_API_KEY'],
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' } }
]

function buildPreconfig() {
  const secretsPath = process.env.DEMO_SECRETS_FILE || resolve(homedir(), '.config/zsh/secrets.zsh')
  const fileEnv = parseShellEnv(secretsPath)
  // process.env takes priority so `DEMO_BEDROCK_KEY=... npm run demo` overrides.
  const lookup = (name) => process.env[name] || fileEnv[name] || null

  const presets = []
  for (const def of PRESET_DEFS) {
    let apiKey = null
    for (const k of def.keys) { apiKey = lookup(k); if (apiKey) break }
    if (!apiKey) continue
    presets.push({
      id: def.id,
      label: def.label,
      config: { ...def.config, apiKey, enableThinking: true, reasoningEffort: 'medium' }
    })
  }
  return presets
}

// Expose the presets to the app as a virtual ES module (reliable in dev and
// build, unlike `define` string replacement). The app imports
// `virtual:demo-preconfig`; in a production build presets is [] so no keys ship.
function preconfigPlugin(presets) {
  const virtualId = 'virtual:demo-preconfig'
  const resolvedId = '\0' + virtualId
  return {
    name: 'demo-preconfig',
    resolveId(id) { if (id === virtualId) return resolvedId },
    load(id) { if (id === resolvedId) return `export default ${JSON.stringify(presets)}` }
  }
}

export default defineConfig(({ command }) => {
  // Only expose keys to the dev server; a production build must never inline them.
  const presets = command === 'serve' ? buildPreconfig() : []
  if (presets.length) {
    console.log(`[demo] pre-loaded providers from shell: ${presets.map(p => p.label).join(', ')}`)
  }
  return {
    root: __dirname,
    plugins: [vue(), preconfigPlugin(presets)],
    resolve: {
      alias: { '@lib': resolve(__dirname, '../src') }
    },
    server: {
      port: 5178,
      open: false,
      // Allow importing the library source, which lives outside the demo root.
      fs: { allow: [resolve(__dirname, '..')] }
    }
  }
})
