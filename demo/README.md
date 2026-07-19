# Provider playground

A local dev app for exercising the library against real providers — pick a model, toggle thinking, sweep effort levels, attach images, and watch tokens / cost / latency plus the exact reasoning and image fields sent on the wire. It runs against the library **source** (`@lib` → `../src`), so edits to `src/` hot-reload here with no rebuild.

## Run it

```bash
npm run demo          # dev server on http://localhost:5178
npm run demo:build    # production build (no keys inlined — see below)
```

Then open the app, keep **Enable thinking** on, pick an effort level, and hit **Run** — or **Sweep all effort levels** to compare spend across levels.

## Images

Drop an image on the **Images** box, paste one into the prompt, or use **Add image…**. It's read as a `data:` URL and sent as a canonical image content part; the **vision** pill shows whether the active model can accept it (attaching one to a text-only model fails before the request is sent).

The wire panel summarizes the image payloads by size rather than inlining them. Re-run the same attachment against different providers to watch one part become `image_url` (OpenAI-family), `source.base64` (Anthropic), `inlineData` (Gemini) or `message.images[]` (Ollama).

Sizes shown are the **base64 payload** — the number providers actually measure (~4/3 of the file size). Claude caps an image at 5 MB, so the effective file limit is ~3.75 MB.

Over-cap images are compressed by the **library**, not the demo: `LLMClient` re-encodes anything above the active provider's `maxImageBytes` before sending, and the demo just reports what it did under the Images box after a Run. Switch providers to see the cap change. Claude via AWS Bedrock additionally rejects remote image URLs.

## Providers & keys

You configure providers two ways; keys live only in your browser's `localStorage` and are **never committed**:

1. **Configure providers** button → add a provider, paste a key. Standard path.
2. **Auto-seed from your shell** (dev convenience). On `npm run demo`, `vite.config.js` reads keys from `~/.config/zsh/secrets.zsh` (override the path with `DEMO_SECRETS_FILE`) and from `process.env`, and hands them to the app through a `virtual:demo-preconfig` module (`preconfig.js` seeds them into `localStorage` before mount). See `PRESET_DEFS` in `vite.config.js` for which env var feeds which provider.

Key resolution for a raw name (e.g. `BEDROCK_KEY`) is **file first, then `process.env`** — so editing the secrets file wins over a stale key a shell exported earlier. A `DEMO_<NAME>` env var (e.g. `DEMO_BEDROCK_KEY=… npm run demo`) is an explicit one-off override that beats both.

Seeding is **seed-if-absent**: your in-app edits survive reloads. Rotated a key in the shell? Click **Reseed from shell** (in the banner) to overwrite the seeded providers with current shell values — no reload, no manual delete.

**Keys never ship:** they exist only in the running dev server, the dev-served bundle, and `localStorage`. `demo:build` inlines none (`command === 'serve'` gates the seeding). Don't paste keys into any committed file.

## Seeing reasoning text

The default prompt (12-coin balance puzzle) is deliberately hard so **adaptive thinking actually engages** — a trivial prompt is answered without thinking and the Thinking panel stays empty (you'll see a note explaining why).

- **Claude / AWS Bedrock**: reasoning text shows because the library sends `thinking.display: 'summarized'`. Without it, Opus 4.7+ returns an empty thinking block + encrypted signature. `haiku-4-5` doesn't support thinking at all (correctly gated — no toggle).
- **DeepSeek reasoner**: returns reasoning text.
- The "reasoning tok" column is blank for providers that don't report a separate count.

See `../CLAUDE.md` for the architecture and the gotchas behind all of this.
