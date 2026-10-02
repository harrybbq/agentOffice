// Phase C spike: everything about `agy` that needs NO model turn (no quota): version, login detection,
// model list, the print-mode slash commands (/usage, /model, /hooks, …), where hooks.json is discovered,
// custom agents, the idle stream-json process, credentials.
//
//   node scripts/spikes/agy/probe.cjs [--root <scratch dir>] [--only version,login,slash,hooks,agents,idle,modes,creds]
//
// Writes logs/probe.log (one JSON line per step). Creates files only under --root (default: %TEMP%\ao-agy-spike).
// It never writes to ~/.gemini; agy itself creates its own state there on first run.
'use strict'
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { findAgyExecutable, scrubbedEnv, Logger, runOnce, AgySession, peSubsystem, processTree, parseArgs, redact } = require('./lib.cjs')

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(args.root || path.join(os.tmpdir(), 'ao-agy-spike'))
const only = typeof args.only === 'string' ? args.only.split(',') : null
const want = (name) => !only || only.includes(name)
const HOOK = path.join(__dirname, 'hook.cjs')
const log = new Logger(path.join(__dirname, 'logs', 'probe.log'))

const EVENTS = ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']

/** A hooks.json that sends every event to hook.cjs. `timeout` is in seconds. */
function hooksJson(name, timeout) {
  const handler = (ev) => ({ type: 'command', command: `node hook.cjs ${ev}`, timeout })
  const spec = {}
  for (const ev of EVENTS) spec[ev] = ev.endsWith('ToolUse') ? [{ matcher: '*', hooks: [handler(ev)] }] : [handler(ev)]
  return JSON.stringify({ [name]: spec }, null, 2)
}

function mkdir(...parts) {
  const dir = path.join(root, ...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function main() {
  const exe = findAgyExecutable()
  if (!exe) {
    log.note('agy not found (looked at AGY_PATH, %LOCALAPPDATA%\\agy\\bin, ~/.local/bin, PATH)')
    return
  }
  const env = scrubbedEnv()
  const plain = mkdir('ws-plain')
  const run = (argv, opts = {}) => runOnce(exe, argv, { cwd: plain, env, log, timeoutMs: 60_000, ...opts })
  let loggedIn = false
  let slashSafe = false

  if (want('version')) {
    const v = await run(['--version'])
    log.note({ exe, version: v.stdout.trim(), sizeMb: Math.round(fs.statSync(exe).size / 1048576), peSubsystem: process.platform === 'win32' ? peSubsystem(exe) : null })
    await run(['--help'])
  }

  if (want('login') || want('slash') || want('hooks') || want('idle') || want('modes')) {
    // The login probe: exit 1 + "Please sign in to view available models" when logged out.
    const m = await run(['models'])
    loggedIn = m.code === 0
    log.note({ loggedIn, models: m.stdout.split(/\r?\n/).filter(Boolean) })
  }

  if (want('slash') || want('hooks')) {
    // Print mode answers these itself, "without starting an agent turn, spending quota or leaving a
    // conversation behind" (changelog 1.1.11/1.1.12). Guard: if the first one reports token usage, a
    // model turn ran after all, and no further slash command is tried.
    const u = await run(['-p', '/usage', '--output-format', 'json'])
    let parsed = null
    try {
      parsed = JSON.parse(u.stdout)
    } catch {
      // not JSON
    }
    const tokens = parsed?.usage?.total_tokens ?? 0
    slashSafe = u.code === 0 && tokens === 0
    log.note({ slashSafe, usageTokens: tokens, hint: slashSafe ? 'slash commands cost nothing' : 'STOP: /usage ran a model turn or failed' })
  }

  if (want('slash') && slashSafe) {
    await run(['-p', '/usage'])
    await run(['-p', '/usage', '--output-format', 'stream-json'])
    for (const cmd of ['/model', '/credits', '/effort', '/permissions', '/config', '/hooks', '/skills']) await run(['-p', cmd, '--output-format', 'json'])
    await run(['-p', '/help'])
  }

  if (want('hooks') && slashSafe) {
    // Where is hooks.json picked up from? `/hooks` lists the loaded hooks without a model turn.
    const list = (argv, opts) => run(['-p', '/hooks', '--output-format', 'json', ...argv], opts)
    const wsHooks = mkdir('ws-hooks')
    fs.writeFileSync(path.join(mkdir('ws-hooks', '.agents'), 'hooks.json'), hooksJson('ao-ws', 600))
    fs.copyFileSync(HOOK, path.join(mkdir('ws-hooks', '.agents'), 'hook.cjs'))
    const side = mkdir('side')
    fs.writeFileSync(path.join(mkdir('side', '.agents'), 'hooks.json'), hooksJson('ao-side', 600))
    fs.copyFileSync(HOOK, path.join(mkdir('side', '.agents'), 'hook.cjs'))
    const nested = mkdir('ws-hooks', 'sub', 'deeper')

    log.note('hooks A: baseline, no hooks.json anywhere')
    await list([])
    log.note('hooks B: cwd has .agents/hooks.json (timeout 600 s)')
    await list([], { cwd: wsHooks })
    log.note('hooks C: cwd is a subfolder of the folder with .agents/hooks.json (no .git anywhere)')
    await list([], { cwd: nested })
    log.note('hooks D: cwd is plain, --add-dir points at the folder with .agents/hooks.json')
    await list(['--add-dir', side])
    log.note('hooks E: inverted: cwd is the app-owned folder with .agents/hooks.json, the project comes in through --add-dir')
    await list(['--add-dir', plain], { cwd: side })

    // A private home: does agy still find its login, and does it read <home>/.gemini/config/hooks.json?
    const home = mkdir('home')
    fs.writeFileSync(path.join(mkdir('home', '.gemini', 'config'), 'hooks.json'), hooksJson('ao-home', 600))
    fs.copyFileSync(HOOK, path.join(mkdir('home', '.gemini', 'config'), 'hook.cjs'))
    const homeEnv = { ...env, USERPROFILE: home, HOME: home }
    log.note('hooks F: USERPROFILE/HOME redirected to a scratch home with .gemini/config/hooks.json')
    const fm = await run(['models'], { env: homeEnv })
    log.note({ loggedInWithRedirectedHome: fm.code === 0 })
    if (fm.code === 0) await list([], { env: homeEnv })
    log.note({ scratchHomeGemini: fs.existsSync(path.join(home, '.gemini', 'antigravity-cli')) })
  }

  if (want('agents')) {
    const ws = mkdir('ws-agent')
    const dir = mkdir('ws-agent', '.agents', 'agents', 'ao-office')
    fs.writeFileSync(
      path.join(dir, 'agent.md'),
      ['---', 'name: ao-office', 'description: Default agent plus the Agent Office briefing.', '---', 'You are running inside Agent Office. The office code word is ao-brief-7.', ''].join('\n')
    )
    log.note('agents: default list, then with .agents/agents/ao-office/agent.md in the cwd, then through --add-dir')
    await run(['agents'])
    await run(['agents'], { cwd: ws })
    await run(['--add-dir', ws, 'agents'])
  }

  if (want('idle') && loggedIn) {
    // Does `init` arrive before the first prompt? What runs, and how big is it? What does closing stdin do?
    const s = new AgySession(exe, [], { cwd: plain, env, log })
    const init = await s.waitFor((e) => e.event === 'init', 20_000)
    log.note({ initBeforePrompt: !!init, initAfterMs: init?._t ?? null })
    log.note({ processTree: processTree(s.child.pid) })
    const t = Date.now()
    s.closeStdin()
    const exited = await Promise.race([s.done, new Promise((r) => setTimeout(() => r(null), 20_000))])
    log.note({ exitAfterStdinClose: exited, ms: Date.now() - t })
    if (!exited) s.kill()

    log.note('idle: an unknown --conversation id')
    const s2 = new AgySession(exe, ['--conversation', '00000000-0000-4000-8000-000000000000'], { cwd: plain, env, log })
    await s2.waitFor((e) => e.event === 'init' || e.event === 'result', 15_000)
    s2.closeStdin()
    const ex2 = await Promise.race([s2.done, new Promise((r) => setTimeout(() => r(null), 15_000))])
    if (!ex2) s2.kill()
  }

  if (want('modes') && loggedIn) {
    // What each per-invocation switch does to `init.permission_mode` (no prompt is sent), and whether a
    // private settings.json (redirected USERPROFILE) is honoured. Stderr is logged too (sandbox warnings).
    const home = mkdir('home-modes')
    const initOf = async (label, argv, envExtra = {}) => {
      const s = new AgySession(exe, [...argv, '--log-file', path.join(root, `agy-modes-${label}.log`)], { cwd: plain, env: { ...env, ...envExtra }, log })
      const init = await s.waitFor((e) => e.event === 'init', 20_000)
      log.note({ label, permission_mode: init?.init?.permission_mode ?? null, initKeys: init ? Object.keys(init.init) : null, stderr: s.stderrLines.map((l) => l.line) })
      s.closeStdin()
      if (!(await Promise.race([s.done, new Promise((r) => setTimeout(() => r(null), 15_000))]))) s.kill()
    }
    await initOf('default', [])
    await initOf('mode-accept-edits', ['--mode', 'accept-edits'])
    await initOf('mode-plan', ['--mode', 'plan'])
    await initOf('sandbox', ['--sandbox'])
    for (const toolPermission of ['strict', 'proceed-in-sandbox']) {
      fs.writeFileSync(path.join(mkdir('home-modes', '.gemini', 'antigravity-cli'), 'settings.json'), JSON.stringify({ toolPermission, enableTerminalSandbox: toolPermission === 'proceed-in-sandbox' }))
      await initOf(`private-home-${toolPermission}`, [], { USERPROFILE: home, HOME: home })
    }
  }

  if (want('creds') && process.platform === 'win32') {
    // Names of matching Windows Credential Manager entries only (cmdkey never prints secrets).
    try {
      const out = execFileSync('cmdkey', ['/list'], { encoding: 'utf8', windowsHide: true })
      const targets = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^Target:/i.test(l) && /antigravity|gemini|agy|jetski/i.test(l))
      log.note({ credentialManagerTargets: targets.map(redact) })
    } catch (err) {
      log.note({ credentialManager: String(err).slice(0, 200) })
    }
    const dir = path.join(os.homedir(), '.gemini', 'antigravity-cli')
    try {
      log.note({ antigravityCliDir: fs.readdirSync(dir) })
    } catch {
      log.note({ antigravityCliDir: null })
    }
  }
}

main()
  .catch((err) => log.note({ fatal: String(err && err.stack ? err.stack : err) }))
  .finally(() => log.close())
