// Zero-quota probe: does `--add-dir <session folder>` honour a `.agents/settings.json` with permissions.allow?
// Compares `agy -p /config` with and without the session folder. No model turn is run.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const exe = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
const root = path.join(os.tmpdir(), 'ao-agy-settings-probe')
const project = path.join(root, 'project')
const session = path.join(root, 'session')
fs.mkdirSync(project, { recursive: true })
fs.mkdirSync(path.join(session, '.agents'), { recursive: true })

const variants = {
  'settings.json': { permissions: { allow: ['command(*)'] }, toolPermission: 'always-proceed' },
  'config.json': { permissions: { allow: ['command(*)'] }, toolPermission: 'always-proceed' }
}
const run = (args) => {
  const r = spawnSync(exe, args, { cwd: project, encoding: 'utf8', timeout: 60000, windowsHide: true })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim().slice(0, 600) }
}
const show = (label, r) => {
  console.log(`\n## ${label} (exit ${r.code})`)
  try { console.log(JSON.parse(r.out).response) } catch { console.log(r.out.slice(0, 3000)) }
  if (r.err) console.log('stderr:', r.err)
}

show('baseline /config', run(['-p', '/config', '--output-format', 'json']))
show('baseline /permissions', run(['-p', '/permissions', '--output-format', 'json']))
for (const [file, body] of Object.entries(variants)) {
  for (const f of Object.keys(variants)) fs.rmSync(path.join(session, '.agents', f), { force: true })
  fs.writeFileSync(path.join(session, '.agents', file), JSON.stringify(body, null, 2))
  show(`/config with --add-dir session/.agents/${file}`, run(['-p', '/config', '--output-format', 'json', '--add-dir', session]))
  show(`/permissions with --add-dir session/.agents/${file}`, run(['-p', '/permissions', '--output-format', 'json', '--add-dir', session]))
}
// Also try the session folder as the cwd's own .agents (workspace-level settings).
fs.mkdirSync(path.join(project, '.agents'), { recursive: true })
fs.writeFileSync(path.join(project, '.agents', 'settings.json'), JSON.stringify(variants['settings.json'], null, 2))
show('/config with <cwd>/.agents/settings.json', run(['-p', '/config', '--output-format', 'json']))
show('/permissions with <cwd>/.agents/settings.json', run(['-p', '/permissions', '--output-format', 'json']))
fs.rmSync(path.join(project, '.agents'), { recursive: true, force: true })
