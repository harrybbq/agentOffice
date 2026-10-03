// The web build: the renderer alone, for a plain browser (no Electron, no agents). Without the
// preload's bridge the app runs on its stub (src/dev/stubBridge.ts): simulated sessions and teams.
//   npm run web          dev server with hot reload (http://localhost:5273)
//   npm run build:web    static site in dist-web/ (published to GitHub Pages by .github/workflows/pages.yml)
// `base: './'` keeps every URL relative, so the site works from any sub-folder.
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

const THEMES = resolve('themes')
const MIME: Record<string, string> = { '.png': 'image/png', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

/** The themes folder next to the page: served in dev, copied into the build. */
function themes(): Plugin {
  let outDir = ''
  return {
    name: 'agent-office-themes',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use('/themes', (req, res, next) => {
        const file = join(THEMES, decodeURIComponent((req.url ?? '').split('?')[0]))
        if (!file.startsWith(THEMES + sep) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
        res.end(readFileSync(file))
      })
    },
    closeBundle() {
      cpSync(THEMES, join(outDir, 'themes'), { recursive: true })
    }
  }
}

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react(), themes()],
  server: { port: 5273 },
  build: { outDir: '../dist-web', emptyOutDir: true }
})
