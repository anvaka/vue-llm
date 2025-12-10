import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.js'),
        'vue/index': resolve(__dirname, 'src/vue/index.js'),
        'providers/index': resolve(__dirname, 'src/providers/index.js')
      },
      formats: ['es']
    },
    rollupOptions: {
      external: ['vue'],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js'
      }
    },
    outDir: 'dist',
    emptyDirBeforeWrite: true
  }
})
