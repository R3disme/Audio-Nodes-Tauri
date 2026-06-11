import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true
  }
})