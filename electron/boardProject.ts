// Which repository a session works in: the key that scopes the office board (electron/board.ts).
// Sessions in different folders, branches or worktrees of ONE repository share a project; sessions
// in unrelated folders never see each other's rows.
//
// No Electron imports. `git` is asked once per session start, with a short timeout; without git (or
// outside a repository) the working folder itself is the project.
import { execFile } from 'node:child_process'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

export const GIT_TIMEOUT_MS = 2000

export interface BoardProject {
  /** The git common dir (shared by all worktrees of a repository), else the working folder. Normalised. */
  project: string
  /** The repository's folder name. */
  projectLabel: string
  /** The session's working tree (git top level), else its folder: changed files are named relative to it. */
  root: string
}

/** One spelling per folder: forward slashes, no trailing slash, lower case on Windows. */
export function projectKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? p.toLowerCase() : p
}

/** The answer for a folder that is not in a git repository (or when git can't be asked). */
export function folderProject(cwd: string, platform: NodeJS.Platform = process.platform): BoardProject {
  return { project: projectKey(cwd, platform), projectLabel: basename(cwd) || cwd, root: cwd }
}

/** `git rev-parse --git-common-dir --show-toplevel` output -> the project. Null if it isn't usable. */
export function projectFromGit(cwd: string, stdout: string, platform: NodeJS.Platform = process.platform): BoardProject | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 2 || lines.some((l) => l.length > 1024 || l.includes('\0'))) return null
  // Often relative (".git"); a worktree gets the absolute path of the main repository's .git.
  const common = isAbsolute(lines[0]) ? resolve(lines[0]) : resolve(cwd, lines[0])
  const top = isAbsolute(lines[1]) ? resolve(lines[1]) : resolve(cwd, lines[1])
  // "<repo>/.git" -> "<repo>"; a bare repository's common dir is the repository itself.
  const repo = basename(common).toLowerCase() === '.git' ? dirname(common) : common
  return { project: projectKey(common, platform), projectLabel: (basename(repo) || basename(top) || repo).replace(/\.git$/i, ''), root: top }
}

/** Never rejects: any failure (no git, not a repository, timeout) falls back to the folder. */
export function resolveBoardProject(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<BoardProject> {
  return new Promise((done) => {
    const fallback = folderProject(cwd)
    try {
      execFile(
        'git',
        ['rev-parse', '--git-common-dir', '--show-toplevel'],
        // No prompts, no pager, no optional locks: this must never hang or change anything.
        { cwd, timeout: timeoutMs, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 },
        (err, stdout) => done(err ? fallback : (projectFromGit(cwd, String(stdout)) ?? fallback))
      )
    } catch {
      done(fallback)
    }
  })
}
