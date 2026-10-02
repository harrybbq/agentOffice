// DEV / PREVIEW ONLY. A fake `preview` bridge for running the renderer in a plain browser: there is
// no server to show, so the pane gets a small built-in page (PreviewBridge.demoDoc, shown through
// the frame's `srcdoc`), a detected address, and a "files changed" hint every few seconds.
import { parsePreviewUrl, type PreviewBridge, type PreviewInfo } from '../../shared/preview'

const DEMO_URL = 'http://localhost:5173/'
const RELOAD_EVERY_MS = 6000
const TASKS = ['Wire up the sign-in form', 'Style the pricing table', 'Add the dark theme', 'Fix the mobile menu', 'Write the empty states']

/** The demo page after `edits` changes. No scripts: the app's content security policy applies to it. */
export function demoPage(edits: number, title = 'Acme dashboard'): string {
  const done = Math.min(TASKS.length, 1 + (edits % (TASKS.length + 1)))
  const hue = (210 + edits * 37) % 360
  const items = TASKS.map((t, i) => `<li class="${i < done ? 'done' : ''}">${t}</li>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1c1e26;background:#f4f5f9}
header{padding:20px 24px;color:#fff;background:linear-gradient(120deg,hsl(${hue} 70% 46%),hsl(${(hue + 40) % 360} 70% 56%))}
h1{margin:0;font-size:22px}header p{margin:4px 0 0;opacity:.85}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;padding:18px 24px}
.card{padding:14px 16px;border-radius:10px;background:#fff;box-shadow:0 1px 3px rgba(20,24,40,.12)}
.card b{display:block;font-size:26px}
ul{margin:0;padding:0;list-style:none}li{padding:6px 0;border-bottom:1px solid #eceef4}li.done{color:#8a8fa0;text-decoration:line-through}
footer{padding:0 24px 20px;color:#8a8fa0;font-size:12px}
</style></head><body><header><h1>${title}</h1><p>Built by the team, live as they type.</p></header>
<main><div class="card"><span>Tasks done</span><b>${done} / ${TASKS.length}</b></div><div class="card"><span>Edits so far</span><b>${edits}</b></div>
<div class="card" style="grid-column:1/-1"><ul>${items}</ul></div></main><footer>Demo page of the browser preview (no server behind it).</footer></body></html>`
}

export function createPreviewStub(liveSessionIds: () => string[]): PreviewBridge {
  const infos = new Map<string, PreviewInfo>()
  const edits = new Map<string, number>()
  const changed = new Set<(i: PreviewInfo) => void>()
  const reload = new Set<(id: string) => void>()
  const detected = new Set<(id: string) => void>()
  const wait = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const live = (id: string): void => {
    if (!liveSessionIds().includes(id)) throw new Error('That session is not running.')
  }
  const set = (info: PreviewInfo): PreviewInfo => {
    infos.set(info.sessionId, info)
    for (const cb of changed) cb({ ...info })
    return { ...info }
  }

  // The "team" keeps editing: every open preview gets a new version of the page.
  setInterval(() => {
    for (const [id, info] of infos) {
      if (info.status !== 'ready') continue
      edits.set(id, (edits.get(id) ?? 0) + 1)
      for (const cb of reload) cb(id)
    }
  }, RELOAD_EVERY_MS)
  // A moment after the page opened, the first session "starts a dev server".
  setTimeout(() => {
    const first = liveSessionIds()[0]
    if (first) for (const cb of detected) cb(first)
  }, 3000)

  return {
    get: async (id) => (infos.has(id) ? { ...infos.get(id)! } : null),
    suggestions: async (id) => (liveSessionIds()[0] === id ? [{ url: DEMO_URL, source: 'terminal' }] : []),
    open: async (id, url) => {
      live(id)
      const parsed = parsePreviewUrl(url)
      if (!parsed.ok) throw new Error(parsed.error)
      set({ sessionId: id, url: parsed.url, kind: parsed.url === DEMO_URL ? 'dev-server' : 'manual', status: 'starting', ...(parsed.url === DEMO_URL ? { detectedFrom: 'terminal' } : {}) })
      await wait(400)
      // Port 9: nothing ever answers there (to see the fallback).
      if (parsed.port === 9) return set({ ...infos.get(id)!, status: 'unreachable', note: 'Nothing answers at this address.' })
      return set({ ...infos.get(id)!, status: 'ready', title: 'Acme dashboard' })
    },
    staticEntries: async (id) => (liveSessionIds().indexOf(id) <= 1 ? ['index.html'] : []),
    serveFolder: async (id) => {
      live(id)
      await wait()
      return set({ sessionId: id, url: 'http://127.0.0.1:49152/', kind: 'static', status: 'ready', title: 'Acme dashboard', detectedFrom: 'this folder' })
    },
    scripts: async (id) => (liveSessionIds().indexOf(id) === 0 ? ['dev', 'preview', 'storybook'] : []),
    run: async (id, name) => {
      live(id)
      set({ sessionId: id, url: '', kind: 'dev-server', status: 'starting', script: name, detectedFrom: `npm run ${name}` })
      setTimeout(() => {
        const cur = infos.get(id)
        if (cur?.script === name && cur.status === 'starting') set({ ...cur, url: DEMO_URL, status: 'ready', title: 'Acme dashboard' })
      }, 2500)
      return { ...infos.get(id)! }
    },
    log: async (id) => {
      const info = infos.get(id)
      return info?.script ? `> npm run ${info.script}\n\n  VITE v7.3.6  ready in 412 ms\n\n  ➜  Local:   ${DEMO_URL}\n  ➜  Network: use --host to expose\n` : ''
    },
    stop: async (id) => {
      const info = infos.get(id)
      if (!info) return
      infos.delete(id)
      for (const cb of changed) cb({ ...info, status: 'stopped' })
    },
    onChanged: (cb) => (changed.add(cb), () => changed.delete(cb)),
    onReload: (cb) => (reload.add(cb), () => reload.delete(cb)),
    onDetected: (cb) => (detected.add(cb), () => detected.delete(cb)),
    onBlocked: () => () => undefined,
    demoDoc: (id) => (infos.get(id)?.status === 'ready' ? demoPage(edits.get(id) ?? 0) : null)
  }
}
