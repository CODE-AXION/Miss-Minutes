import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Types shared by main, preload and renderer (the worker protocol and the window.api contract).
const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    // electron-store is ESM-only; bundle it instead of require()-ing it from node_modules (so it is a devDependency).
    build: { externalizeDeps: { exclude: ['electron-store'] } }
  },
  preload: {
    resolve: { alias: shared }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src'),
        ...shared
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
