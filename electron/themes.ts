// Theme discovery, loading and the theme:// protocol.
//   theme://<name>/<path>  ->  <themeDir>/<name>/<path>
// Search order: <userData>/themes/ (user overrides), then the bundled <appPath>/themes/.
import { app, net, protocol } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LoadedTheme, ThemeInfo } from '../shared/ipc'
import type { ThemeManifest } from '../shared/theme'

export const THEME_SCHEME = 'theme'
const NAME_RE = /^[a-z0-9_-]+$/

/** Must be called before app 'ready'. */
export function registerThemeScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: THEME_SCHEME,
      // corsEnabled: the renderer (http://localhost in dev, file:// in prod) fetches theme://
      // cross-origin, and WebGL needs CORS-clean images.
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/** Computed lazily: userData is only final after config.ts has run. */
export function themeRoots(): string[] {
  return [join(app.getPath('userData'), 'themes'), join(app.getAppPath(), 'themes')]
}

export function isValidThemeName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 64 && NAME_RE.test(name)
}

/** Resolves `rel` inside `base`, or null if it would escape it. */
function safeJoin(base: string, rel: string): string | null {
  if (rel.includes('\0')) return null
  const target = resolve(base, '.' + (rel.startsWith('/') ? '' : '/') + rel)
  const r = relative(base, target)
  if (r === '' || r.startsWith('..') || isAbsolute(r)) return null
  return target
}

function findThemeDir(name: string): string | null {
  if (!isValidThemeName(name)) return null
  for (const root of themeRoots()) {
    const dir = join(root, name)
    if (existsSync(join(dir, 'theme.json'))) return dir
  }
  return null
}

export async function listThemes(): Promise<ThemeInfo[]> {
  const seen = new Map<string, ThemeInfo>()
  for (const root of themeRoots()) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const name of entries) {
      if (seen.has(name) || !isValidThemeName(name)) continue
      const dir = join(root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
        const manifestPath = join(dir, 'theme.json')
        if (!existsSync(manifestPath)) continue
        const m = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<ThemeManifest>
        seen.set(name, { name, displayName: typeof m.displayName === 'string' ? m.displayName : name })
      } catch (err) {
        console.warn(`[agent-office] skipping theme ${dir}:`, (err as Error).message)
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export async function loadTheme(name: unknown): Promise<LoadedTheme> {
  if (!isValidThemeName(name)) throw new Error('invalid theme name')
  const dir = findThemeDir(name)
  if (!dir) throw new Error(`theme not found: ${name}`)
  const manifest = JSON.parse(await readFile(join(dir, 'theme.json'), 'utf8')) as ThemeManifest
  if (typeof manifest.map !== 'string') throw new Error(`theme ${name}: "map" missing`)
  const mapPath = safeJoin(dir, manifest.map)
  if (!mapPath) throw new Error(`theme ${name}: map path escapes the theme folder`)
  const map: unknown = JSON.parse(await readFile(mapPath, 'utf8'))
  return { manifest, map, baseUrl: `${THEME_SCHEME}://${name}/` }
}

const notFound = () => new Response('not found', { status: 404 })

/** Must be called after app 'ready'. */
export function registerThemeProtocol(): void {
  console.log(`[agent-office] theme dirs: ${themeRoots().join(' ; ')}`)
  protocol.handle(THEME_SCHEME, async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return notFound()
      const url = new URL(request.url)
      const dir = findThemeDir(url.hostname)
      if (!dir) return notFound()
      const file = safeJoin(dir, decodeURIComponent(url.pathname))
      if (!file || !existsSync(file) || !statSync(file).isFile()) return notFound()
      const res = await net.fetch(pathToFileURL(file).href)
      const headers = new Headers(res.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Cache-Control', 'no-cache')
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return notFound()
    }
  })
}
