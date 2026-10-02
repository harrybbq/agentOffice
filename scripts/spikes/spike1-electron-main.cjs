// Spike 1 — Electron main: `npx electron scripts/spikes/spike1-electron-main.cjs`
const { app, utilityProcess } = require('electron')
const path = require('node:path')

const CLAUDE = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT)/i.test(k)))
const cases = []
for (const useConptyDll of [false, true]) {
  cases.push({ label: `claude --version dll=${useConptyDll}`, file: CLAUDE, args: ['--version'], env, useConptyDll })
  cases.push({ label: `powershell echo dll=${useConptyDll}`, file: 'powershell.exe', args: ['-NoProfile', '-Command', 'echo hi'], env, useConptyDll })
}

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, 'pty-utility.cjs'), [], { serviceName: 'pty-host', stdio: 'inherit', cwd: path.resolve(__dirname, '..', '..') })
  child.on('spawn', () => { console.log('[main] utility pid', child.pid); child.postMessage({ cases }) })
  child.on('message', (m) => {
    if (m.type === 'log') console.log('[utility]', m.msg)
    if (m.type === 'done') { child.kill(); app.quit() }
  })
  child.on('exit', (code) => console.log('[main] utility exit', code))
  setTimeout(() => { console.log('[main] global timeout'); child.kill(); app.quit() }, 90000)
})
app.on('window-all-closed', () => {})
