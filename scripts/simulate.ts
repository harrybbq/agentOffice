// Sends fake agent events to a running Agent Office so you can watch characters move.
//
//   npm run simulate                 # 2 teams, loops forever
//   npm run simulate -- --teams 3 --speed 2 --once
//
// Reads the port + token from the app's config file (created on the app's first run).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Activity, AgentEvent } from '../shared/events'

function configPath(): string {
  if (process.env.AGENT_OFFICE_CONFIG) return process.env.AGENT_OFFICE_CONFIG
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  return join(base, 'agent-office', 'config.json')
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}

const teams = arg('teams', 2)
const speed = arg('speed', 1)
const once = process.argv.includes('--once')

let cfg: { token: string; port: number }
try {
  cfg = JSON.parse(readFileSync(configPath(), 'utf8'))
} catch {
  console.error(`Could not read ${configPath()}. Start the app once (npm run dev) so it creates its config.`)
  process.exit(1)
}
const url = `http://127.0.0.1:${cfg.port}/events`

async function send(e: Omit<AgentEvent, 'ts' | 'provider'> & { provider?: string }) {
  const body: AgentEvent = { provider: 'simulate', ts: Date.now(), ...e }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Office-Token': cfg.token },
      body: JSON.stringify(body)
    })
    if (!res.ok) console.error(`HTTP ${res.status} ${await res.text()}`)
    else console.log(`${body.displayName.padEnd(14)} ${body.activity.padEnd(8)} ${body.detail}`)
  } catch (err) {
    console.error(`Can't reach ${url}: is the app running?`, (err as Error).message)
    process.exit(1)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms / speed))
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]
const rand = (a: number, b: number) => a + Math.random() * (b - a)

const WORK: { activity: Activity; details: string[] }[] = [
  { activity: 'read', details: ['src/app.ts', 'package.json', 'README.md', 'src/lib/db.ts'] },
  { activity: 'write', details: ['src/app.ts', 'src/routes/users.ts', 'tests/app.test.ts'] },
  { activity: 'exec', details: ['npm test', 'git status', 'npm run build', 'tsc --noEmit'] },
  { activity: 'web', details: ['https://nodejs.org/api/fs.html', 'https://developer.mozilla.org/'] },
  { activity: 'capture', details: ['screenshot localhost:5173', 'screenshot login page'] }
]
const ROLES = ['Explorer', 'Planner', 'Tester', 'Reviewer', 'Researcher', 'Builder']

async function worker(sessionId: string, n: number) {
  const agentId = `${sessionId}-sub${n}`
  const displayName = `${pick(ROLES)} ${n}`
  const steps = Math.floor(rand(4, 9))
  for (let i = 0; i < steps; i++) {
    // A burst of fast tool calls, like a real agent reading several files in a row.
    const w = pick(WORK)
    const burst = Math.random() < 0.3 ? 3 : 1
    for (let b = 0; b < burst; b++) {
      await send({ agentId, parentId: sessionId, displayName, activity: w.activity, detail: pick(w.details) })
      await sleep(rand(50, 400))
    }
    if (Math.random() < 0.12) {
      await send({ agentId, parentId: sessionId, displayName, activity: 'waiting', detail: 'Bash: rm -rf dist' })
      await sleep(rand(5000, 9000)) // the CEO "approves" eventually
    }
    await sleep(rand(1500, 4000))
  }
  await send({ agentId, parentId: sessionId, displayName, activity: 'done', detail: 'Report ready' })
}

async function session(t: number) {
  const sessionId = `sim-${t}-${Math.random().toString(36).slice(2, 7)}`
  const displayName = `Team ${String.fromCharCode(65 + t)}`
  const main = (activity: Activity, detail = '') => send({ agentId: sessionId, parentId: null, displayName, activity, detail })

  await main('idle', 'Session started')
  await sleep(2000)
  await main('read', 'CLAUDE.md')
  await sleep(1500)
  if (Math.random() < 0.5) {
    await main('waiting', 'Edit: src/config.ts')
    await sleep(6000)
  }
  // Spawn subagents in parallel, staggered.
  const count = Math.floor(rand(2, 4.99))
  const jobs: Promise<void>[] = []
  for (let n = 1; n <= count; n++) {
    jobs.push(worker(sessionId, n))
    await sleep(rand(800, 2500))
  }
  await main('exec', 'waiting for subagents')
  await Promise.all(jobs)
  await main('write', 'src/app.ts')
  await sleep(2500)
  await main('idle', 'Turn finished')
  await sleep(4000)
  await main('done', 'Session ended')
}

async function run() {
  console.log(`Simulating ${teams} team(s) against ${url} (speed x${speed})`)
  do {
    await Promise.all(Array.from({ length: teams }, (_, t) => sleep(t * 3000).then(() => session(t))))
    await sleep(3000)
  } while (!once)
}

run()
