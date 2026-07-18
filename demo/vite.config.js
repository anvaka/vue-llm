import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// Standalone dev server for the playground. Runs against the library SOURCE
// (via the `@lib` alias) so edits to src/ hot-reload here with no rebuild.
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  resolve: {
    alias: { '@lib': resolve(__dirname, '../src') }
  },
  server: {
    port: 5178,
    open: false,
    // Allow importing the library source, which lives outside the demo root.
    fs: { allow: [resolve(__dirname, '..')] }
  }
})
