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
    build: {
      externalizeDeps: { exclude: ['electron-store'] },
      // The search worker is a second entry (out/main/search-worker.js), forked as a utilityProcess (SS·T11).
      rollupOptions: {
        input: { index: 'src/main/index.ts', 'search-worker': 'src/main/search/worker-entry.ts' }
      }
    }
  },
  preload: {
    resolve: { alias: shared },
    // The hidden recorder window has its own preload (out/preload/recorder.js) (RC·T6). A sandboxed preload can't
    // require() a split chunk, so the two must share no runtime import (see RECORDER_IPC).
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          recorder: 'src/preload/recorder.ts',
          // The recording mini-toolbar (RC·T29), sandboxed like the recorder.
          toolbar: 'src/preload/toolbar.ts',
          // The meeting prompt (MD·T14), sandboxed like the toolbar.
          prompt: 'src/preload/prompt.ts'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src'),
        ...shared
      }
    },
    plugins: [react(), tailwindcss()],
    // The hidden recorder window is a second, React-free page (out/renderer/recorder.html) (RC·T6).
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          recorder: resolve('src/renderer/recorder.html'),
          toolbar: resolve('src/renderer/toolbar.html'),
          // The meeting prompt card (MD·T14), React-free like the toolbar.
          prompt: resolve('src/renderer/prompt.html')
        }
      }
    }
  }
})
