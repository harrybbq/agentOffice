// Phase B spike harness: `codex app-server` over stdio, everything logged both ways.
// None of these scenarios runs a model turn that could succeed, and none logs in.
//
//   node scripts/spikes/codex/harness.cjs <scenario> [--home <dir>|default] [--root <scratch dir>] [--no-shim-env]
//
// Scenarios
//   probe    initialize + read-only calls: account/read, account/rateLimits/read, model/list, thread/list,
//            config/read, windowsSandbox/readiness, permissionProfile/list. Safe on the default home.
//   login    account/login/start {type:"chatgpt"} -> what comes back, is a browser opened, is a port
//            listening; then account/login/cancel. Then the same for {type:"chatgptDeviceCode"}.
//            Use a scratch home, so nothing can touch the real login.
//   thread   thread/start with each sandbox mode (what policy comes back), thread/list, thread/read,
//            turn/start (fails without a login: the error shape), turn/steer + turn/interrupt with no
//            active turn (their error shapes), thread/resume in a second process.
//            Use a scratch home.
//   sandbox  thread/start {ephemeral:true} with each sandbox mode and report the policy the server
//            really applied, plus windowsSandbox/readiness. No turn is run and nothing is persisted, so
//            it is safe on the default home too. `--windows-sandbox elevated|unelevated` passes
//            `-c windows.sandbox="<mode>"` on the command line (for a scratch home with no sandbox set up).
//            `--server-args '["--disable","plugins"]'` appends any other app-server arguments.
//
// --home default  uses the user's real ~/.codex (only for `probe`).
// Logs: scripts/spikes/codex/logs/<scenario>[-<tag>].log (JSON lines: t, dir, msg). *.log is git-ignored.
'use strict'
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CodexRpc, findCodexExecutable, sleep } = require('./rpc.cjs')

const argv = process.argv.slice(2)
const scenario = argv[0]
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const root = path.resolve(flag('--root') ?? path.join(os.tmpdir(), 'ao-codex-spike'))
const homeArg = flag('--home')
const codexHome = homeArg === 'default' ? undefined : path.resolve(homeArg ?? path.join(root, 'codex-home'))
const tag = flag('--tag') ?? (codexHome ? 'scratch' : 'default')
const logFile = path.join(__dirname, 'logs', `${scenario}-${tag}.log`)
const workdir = path.join(root, 'ws')

function rpc(extra = {}) {
  if (codexHome) fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(workdir, { recursive: true })
  return new CodexRpc({ logFile: extra.logFile ?? logFile, codexHome, cwd: workdir, mimicShim: !argv.includes('--no-shim-env'), ...extra }).start()
}

/** Titles of visible top-level windows (to notice a browser tab opened by the login flow). */
function windowTitles() {
  if (process.platform !== 'win32') return []
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName + ' | ' + $_.MainWindowTitle }"],
      { encoding: 'utf8', windowsHide: true }
    )
    return out.split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

function listening(port) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    return out.split(/\r?\n/).filter((l) => l.includes('LISTENING') && new RegExp(`:${port}\\s`).test(l))
  } catch {
    return null
  }
}

async function probe() {
  const c = rpc()
  try {
    await c.initialize()
    await c.try('account/read', { refreshToken: false })
    await c.try('account/rateLimits/read')
    await c.try('model/list', { limit: 50 })
    await c.try('thread/list', { limit: 5 })
    await c.try('thread/list', { limit: 5, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] })
    await c.try('config/read', { includeLayers: false, cwd: workdir })
    await c.try('windowsSandbox/readiness')
    await c.try('permissionProfile/list', {})
    await c.try('experimentalFeature/list', { limit: 200 })
    // A method behind capabilities.experimentalApi, to see how the server refuses it.
    await c.try('collaborationMode/list', {})
    await sleep(1500)
  } finally {
    await c.stop()
  }
}

async function login() {
  if (!codexHome) throw new Error('run the login scenario with a scratch home (omit --home default)')
  const c = rpc()
  try {
    await c.initialize()
    await c.try('account/read', { refreshToken: false })

    const before = windowTitles()
    const started = await c.try('account/login/start', { type: 'chatgpt' })
    if (started.result) {
      const authUrl = new URL(started.result.authUrl)
      const redirect = authUrl.searchParams.get('redirect_uri')
      const port = redirect ? new URL(redirect).port : ''
      c.record('--', { note: 'authUrl parts', host: authUrl.host, pathname: authUrl.pathname, params: [...authUrl.searchParams.keys()], redirect_uri: redirect })
      await sleep(4000)
      const after = windowTitles()
      c.record('--', { note: 'windows that appeared within 4 s of login/start', appeared: after.filter((t) => !before.includes(t)) })
      if (port) c.record('--', { note: `listeners on port ${port} while login is pending`, lines: listening(port) })
      await c.try('account/read', { refreshToken: false })
      const done = c.waitFor('account/login/completed', 5000)
      await c.try('account/login/cancel', { loginId: started.result.loginId })
      c.record('--', { note: 'account/login/completed after cancel', notification: await done })
      if (port) c.record('--', { note: `listeners on port ${port} after cancel`, lines: listening(port) })
      await c.try('account/login/cancel', { loginId: started.result.loginId })
    }

    const before2 = windowTitles()
    const device = await c.try('account/login/start', { type: 'chatgptDeviceCode' }, 20_000)
    if (device.result) {
      await sleep(3000)
      c.record('--', { note: 'windows that appeared within 3 s of device-code login/start', appeared: windowTitles().filter((t) => !before2.includes(t)) })
      const done = c.waitFor('account/login/completed', 5000)
      await c.try('account/login/cancel', { loginId: device.result.loginId })
      c.record('--', { note: 'account/login/completed after device-code cancel', notification: await done })
    }
    await c.try('account/logout')
    await sleep(500)
  } finally {
    await c.stop()
  }
}

async function thread() {
  if (!codexHome) throw new Error('run the thread scenario with a scratch home (omit --home default)')
  let threadId
  const c = rpc()
  try {
    await c.initialize()
    for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
      const r = await c.try('thread/start', { cwd: workdir, sandbox, approvalPolicy: 'on-request', ephemeral: true })
      if (r.result) await c.try('thread/unsubscribe', { threadId: r.result.thread.id })
    }
    // No overrides: the server's defaults.
    const dflt = await c.try('thread/start', { cwd: workdir })
    threadId = dflt.result?.thread.id
    if (threadId) {
      await c.try('thread/list', { limit: 5 })
      await c.try('thread/loaded/list', {})
      // No active turn: error shapes of steer and interrupt.
      await c.try('turn/steer', { threadId, expectedTurnId: 'no-such-turn', input: [{ type: 'text', text: 'steer with no turn', text_elements: [] }] })
      await c.try('turn/interrupt', { threadId, turnId: 'no-such-turn' })
      // A turn without a login.
      const done = c.waitFor((m) => m.method === 'turn/completed' || m.method === 'error', 45_000)
      const turn = await c.try('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the single word: ok', text_elements: [] }] })
      if (turn.result) {
        await done
        await c.waitFor('turn/completed', 20_000)
      }
      await sleep(1000)
      await c.try('thread/list', { limit: 5, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] })
      await c.try('thread/read', { threadId, includeTurns: true })
    }
  } finally {
    await c.stop()
  }
  if (!threadId) return
  // "App restart": a new process resumes the thread by id.
  const c2 = rpc({ logFile: logFile.replace(/\.log$/, '-resume.log') })
  try {
    await c2.initialize()
    await c2.try('thread/list', { limit: 5, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] })
    await c2.try('thread/resume', { threadId, cwd: workdir })
    await c2.try('thread/resume', { threadId: '00000000-0000-7000-8000-000000000000' })
    await sleep(500)
  } finally {
    await c2.stop()
  }
}

async function sandbox() {
  const mode = flag('--windows-sandbox')
  // --server-args '["--disable","plugins"]': extra `codex app-server` arguments (config overrides).
  const extra = flag('--server-args') ? JSON.parse(flag('--server-args')) : []
  const c = rpc({ args: [...(mode ? ['-c', `windows.sandbox="${mode}"`] : []), ...extra] })
  try {
    await c.initialize()
    await c.try('windowsSandbox/readiness')
    for (const params of [
      { sandbox: 'read-only', approvalPolicy: 'on-request' },
      { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
      { sandbox: 'workspace-write', approvalPolicy: 'untrusted' },
      { sandbox: 'workspace-write', approvalPolicy: 'never' },
      { sandbox: 'danger-full-access', approvalPolicy: 'on-request' },
      {}
    ]) {
      const r = await c.try('thread/start', { cwd: workdir, ephemeral: true, ...params })
      if (r.result) {
        const { approvalPolicy, approvalsReviewer, sandbox: applied, activePermissionProfile, model } = r.result
        c.record('--', { asked: params, applied: { approvalPolicy, approvalsReviewer, sandbox: applied, activePermissionProfile, model } })
        await c.try('thread/unsubscribe', { threadId: r.result.thread.id })
      }
    }
    await sleep(500)
  } finally {
    await c.stop()
  }
}

async function main() {
  const found = findCodexExecutable()
  console.log(`codex executable: ${found ? found.exe : 'NOT FOUND'}`)
  console.log(`CODEX_HOME: ${codexHome ?? '(default)'}\nlog: ${logFile}\n`)
  const run = { probe, login, thread, sandbox }[scenario]
  if (!run) {
    console.error('usage: node harness.cjs <probe|login|thread|sandbox> [--home <dir>|default] [--root <dir>] [--no-shim-env] [--tag <name>] [--windows-sandbox elevated|unelevated]')
    process.exit(2)
  }
  await run()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
