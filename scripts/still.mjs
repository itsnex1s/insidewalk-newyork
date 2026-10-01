#!/usr/bin/env node
// Draws the walk (dev server running) in headless Chrome and saves the frame as a PNG.
//
//   node scripts/still.mjs "<query>" <out.png> [--base http://localhost:5240] [--w 1600] [--h 1000]
//   e.g. "at=0.5,-6,29" (x, z, bearing, pitch, height: see main.ts), "at=0,0,29,-35,250&rich"
//   --profile <ms> prints the main thread's costliest functions over that long after ready.
//   --during <expression> is started (not awaited) as the profile begins.
//   --eval "<expression>" prints what it evaluates to on the page once it is ready (window.city has the scene).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [query = '', out] = process.argv.slice(2)
const opt = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback)
const base = opt('--base', 'http://localhost:5240')
const [width, height] = [Number(opt('--w', 1600)), Number(opt('--h', 1000))]
if (!out) {
  console.error('usage: still.mjs "<query>" <out.png>')
  process.exit(1)
}
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'city-still-'))
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, ['--headless=new', '--enable-unsafe-webgpu', '--hide-scrollbars', '--no-first-run', '--disable-component-update', '--disable-background-networking', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' })
try {
  let targets
  for (let i = 0; i < 50 && !targets; i++) {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null)
    if (!targets) await wait(100)
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data)
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) console.error(`page ${m.params.type}:`, m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 400))
    if (m.method === 'Runtime.exceptionThrown') console.error('page exception:', m.params.exceptionDetails.exception?.description?.slice(0, 600))
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  const t0 = Date.now()
  await send('Page.navigate', { url: `${base}/?${query}` })
  const ok = (await send('Runtime.evaluate', { expression: `new Promise((res) => { const t0 = Date.now(); const p = () => document.body.hasAttribute('data-ready') ? res(true) : Date.now() - t0 > 180000 ? res(false) : setTimeout(p, 200); p() })`, awaitPromise: true, returnByValue: true })).result.value
  if (!ok) throw new Error('the walk never reported ready')
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  const profileFor = Number(opt('--profile', 0))
  if (profileFor) {
    // The main thread's time for that long after ready, by function (self time), the costliest first.
    await send('Profiler.enable')
    await send('Profiler.setSamplingInterval', { interval: 500 })
    await send('Profiler.start')
    // Something to profile, started and left running: a walk, a turn.
    const during = opt('--during', '')
    if (during) send('Runtime.evaluate', { expression: during })
    await wait(profileFor)
    const { profile: cpu } = await send('Profiler.stop')
    const dt = new Map(cpu.nodes.map((n) => [n.id, 0]))
    cpu.samples.forEach((id, i) => dt.set(id, dt.get(id) + (cpu.timeDeltas[i] ?? 0)))
    const self = new Map()
    for (const n of cpu.nodes) {
      const { functionName, url, lineNumber } = n.callFrame
      const key = `${functionName || '(anonymous)'} ${url.split('/').pop().split('?')[0]}:${lineNumber + 1}`
      self.set(key, (self.get(key) ?? 0) + dt.get(n.id) / 1000)
    }
    for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${ms.toFixed(0).padStart(7)} ms  ${key}`)
  }
  const expression = opt('--eval', '')
  if (expression) console.log('eval:', (await send('Runtime.evaluate', { expression: `Promise.resolve(${expression}).then((v) => JSON.stringify(v))`, awaitPromise: true, returnByValue: true })).result.value)
  await wait(400)
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`${out}: ${width}×${height}`)
  ws.close()
} finally {
  // Gone before its profile is removed (it writes into it until it exits): a profile left behind is 150 MB.
  const exited = new Promise((done) => chrome.once('exit', done))
  chrome.kill()
  await Promise.race([exited, wait(5000)])
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
