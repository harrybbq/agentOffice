// Spike 1 — runs inside Electron utilityProcess.fork(). Loads node-pty, runs commands, reports back.
const path = require('node:path')
const port = process.parentPort
const log = (msg) => port.postMessage({ type: 'log', msg })

port.on('message', async (e) => {
  const { cases } = e.data
  log(`versions electron=${process.versions.electron} node=${process.versions.node} napi=${process.versions.napi} modules=${process.versions.modules} arch=${process.arch}`)
  let pty, utils
  try {
    utils = require('node-pty/lib/utils')
    const probe = utils.loadNativeModule('conpty')
    log(`loadNativeModule('conpty') dir=${probe.dir} (relative to node-pty/lib)`)
    pty = require('node-pty')
    log(`node-pty loaded from ${path.dirname(require.resolve('node-pty'))}`)
  } catch (err) {
    log(`LOAD FAILED: ${err && err.stack}`)
    port.postMessage({ type: 'done' })
    return
  }
  for (const c of cases) {
    await new Promise((resolve) => {
      const t0 = Date.now()
      let out = ''
      let p
      try {
        p = pty.spawn(c.file, c.args, { name: 'xterm-256color', cols: 100, rows: 20, cwd: process.cwd(), env: c.env, useConptyDll: c.useConptyDll })
      } catch (err) {
        log(`[${c.label}] spawn threw: ${err.message}`)
        return resolve()
      }
      log(`[${c.label}] pid=${p.pid} useConptyDll=${c.useConptyDll}`)
      p.onData((d) => (out += d))
      const kill = setTimeout(() => { log(`[${c.label}] timeout, killing`); p.kill() }, 20000)
      p.onExit(({ exitCode, signal }) => {
        clearTimeout(kill)
        const plain = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]/g, '').trim()
        log(`[${c.label}] exit=${exitCode} signal=${signal} ms=${Date.now() - t0} text=${JSON.stringify(plain)} rawLen=${out.length} rawHead=${JSON.stringify(out.slice(0, 80))}`)
        resolve()
      })
    })
  }
  port.postMessage({ type: 'done' })
})
