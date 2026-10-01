// Headless Chrome with WebGPU over the DevTools protocol, for scripts/still.mjs and scripts/film.mjs.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Opens `url` in a fresh headless Chrome of `width` × `height` CSS pixels at `scale` device pixels each (a phone's
 * touch screen with `touch`), and waits for the walk to report ready (body[data-ready]). `send` speaks the protocol;
 * `evaluate` awaits an expression's value on the page; `close` quits Chrome and removes its profile.
 */
export async function openPage(url, { width, height, scale = 1, touch = false }) {
  const profile = mkdtempSync(join(tmpdir(), 'city-chrome-'))
  const port = 9300 + Math.floor(Math.random() * 500)
  const chrome = spawn(CHROME, ['--headless=new', '--enable-unsafe-webgpu', '--hide-scrollbars', '--no-first-run', '--disable-component-update', '--disable-background-networking', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' })
  const close = async () => {
    // Gone before its profile is removed (it writes into it until it exits): a profile left behind is 150 MB.
    const exited = new Promise((done) => chrome.once('exit', done))
    chrome.kill()
    await Promise.race([exited, wait(5000)])
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
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
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
      return result.value
    }
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: touch })
    if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    const t0 = Date.now()
    await send('Page.navigate', { url })
    const ok = await evaluate(`new Promise((res) => { const t0 = Date.now(); const p = () => document.body.hasAttribute('data-ready') ? res(true) : Date.now() - t0 > 180000 ? res(false) : setTimeout(p, 200); p() })`)
    if (!ok) throw new Error('the walk never reported ready')
    console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    return {
      send,
      evaluate,
      close: async () => {
        ws.close()
        await close()
      },
    }
  } catch (e) {
    await close()
    throw e
  }
}
