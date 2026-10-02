import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // ptyHost runs in an Electron utilityProcess and owns every terminal / agent process.
    // node-pty must stay external: it loads native prebuilds and a worker by relative path.
    build: {
      rollupOptions: {
        input: { index: resolve('electron/main.ts'), ptyHost: resolve('electron/ptyHost.ts') },
        external: ['node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed preloads must be CommonJS even though the package is ESM.
    build: {
      rollupOptions: {
        input: { index: resolve('electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve('src/index.html') } } }
  }
})
