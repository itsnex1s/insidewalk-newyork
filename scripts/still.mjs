#!/usr/bin/env node
// Draws the walk (dev server running) in headless Chrome and saves the frame as a PNG.
//
//   node scripts/still.mjs "<query>" <out.png> [--base http://localhost:5240] [--w 1600] [--h 1000]
//   e.g. "at=0.5,-6,29" (x, z, bearing, pitch, height: see main.ts), "at=0,0,29,-35,250&rich"
//   --profile <ms> prints the main thread's costliest functions over that long after ready.
//   --during <expression> is started (not awaited) as the profile begins.
//   --eval "<expression>" prints what it evaluates to on the page once it is ready (window.city has the scene).
import { writeFileSync } from 'node:fs'
import { openPage, wait } from './chrome.mjs'

const [query = '', out] = process.argv.slice(2)
const opt = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback)
const base = opt('--base', 'http://localhost:5240')
const [width, height] = [Number(opt('--w', 1600)), Number(opt('--h', 1000))]
if (!out) {
  console.error('usage: still.mjs "<query>" <out.png>')
  process.exit(1)
}
const { send, close } = await openPage(`${base}/?${query}`, { width, height })
try {
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
} finally {
  await close()
}
