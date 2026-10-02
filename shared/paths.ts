// Path display helpers shared by the main process and the renderer. Pure string work: no node:path,
// because the renderer has none and a session's paths may use either separator.

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

/**
 * `path` as seen from the folder `base`: "src\app.ts" for a file under it, "." for the folder
 * itself, and `path` unchanged for anything outside it (or when there is no base). Windows paths
 * are compared without regard to case or to which separator is used.
 */
export function relativeTo(path: string, base: string | undefined | null): string {
  if (!path || !base) return path
  const win = isWindowsPath(base)
  const norm = (p: string): string => (win ? p.replace(/\//g, '\\').toLowerCase() : p)
  const sep = win ? '\\' : '/'
  let root = norm(base)
  while (root.length > 1 && root.endsWith(sep)) root = root.slice(0, -1)
  // A drive root ("C:") or "/" as base would make every path "relative": keep those absolute.
  if (root === '' || root === sep || /^[a-z]:$/.test(root)) return path
  const full = norm(path)
  if (full === root) return '.'
  if (!full.startsWith(root + sep)) return path
  const rest = path.slice(root.length + 1)
  return rest.length > 0 ? rest : '.'
}
