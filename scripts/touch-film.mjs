#!/usr/bin/env node
// A short film of the touch controls, as a screen recording on a tablet (dev server running): the walk on an iPad Pro
// 13" held sideways, driven by fingers as a player's would be, the touches shown as circles as the iPad's own
// recording can show them, and the app's hint line saying what each does. The walker is moved by its real controls
// (touch.ts) a sixtieth of a second a frame, so it walks, runs, jumps and flies as it would by hand.
//
//   node scripts/touch-film.mjs [--board]
//
// --board draws a frame every second, small, into film/touch-board.jpg, to look the moves over before the long render.
// The film is film/touch-ipad.mp4 at the iPad's 2064 × 1548 points × 1.5, and film/touch-ipad-x.mp4 at 1600 × 1200
// for X; both with a silent stereo track. Needs ffmpeg (and ImageMagick for the board).
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openPage } from './chrome.mjs'

const args = process.argv.slice(2)
const board = args.includes('--board')
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:5240'
const DIR = 'film/touch'
/** The iPad Pro 13" sideways, in CSS pixels, and the film's own frame rate (two frames blended into each of 30). */
const [W, H] = [1376, 1032]
const FPS = 60
const SECONDS = 20
const START = '55,97,33'

/**
 * The fingers: a path of [seconds, x, y] on the screen while down (eased from key to key), or a button held from the
 * first time to the last. Ids as a browser numbers touches.
 */
const FINGERS = [
  // The left thumb: lands, walks, pushes on past the rim to run, and back to walking.
  { id: 1, path: [[1.4, 196, 840], [1.8, 196, 840], [2.4, 196, 796], [5.2, 196, 796], [5.7, 200, 762], [8.6, 200, 762], [9.0, 196, 798], [13.2, 196, 798]] },
  // The right thumb looks round while the left walks: right, up, and back.
  { id: 2, path: [[8.6, 1000, 600], [8.8, 1000, 600], [9.8, 1120, 590], [10.5, 1120, 540], [11.2, 1040, 580], [11.4, 1040, 580]] },
  { id: 3, button: 'jump', path: [[11.9], [12.05]] },
  { id: 4, button: 'fly', path: [[13.6], [13.75]] },
  // Straight up, clear of the roofs, before going on.
  { id: 5, button: 'rise', path: [[14.3], [16.4]] },
  { id: 6, path: [[16.6, 196, 840], [17.0, 196, 800], [20, 196, 800]] },
  // Looking down onto the roofs.
  { id: 7, path: [[16.9, 1000, 520], [17.1, 1000, 520], [18.1, 1000, 590], [18.3, 1000, 590]] },
]

/** The app's hint line: [from, to, words]. The first is its own, as it greets a first visit. */
const CAPTIONS = [
  [0.3, 2.0, 'Left thumb to walk · right thumb to look'],
  [2.2, 5.1, 'A stick wherever the left thumb lands'],
  [5.4, 8.4, 'Push past the rim to run'],
  [8.7, 11.6, 'The right thumb looks round'],
  [11.8, 13.3, 'Jump'],
  [13.5, 14.9, 'Fly, and land again'],
  [15.0, 17.5, 'Hold Up to rise, Down to come down'],
  [17.7, 20, 'newyork.insidewalk.app'],
]

/** The page's side: each frame, the fingers down, moved or lifted as the time asks, and the hint line's words. */
const DEMO = `(() => {
  const fingers = ${JSON.stringify(FINGERS)}, captions = ${JSON.stringify(CAPTIONS)}
  const style = document.createElement('style')
  // Frame by frame, a transition would run on the clock's time, not the film's.
  style.textContent = '*, *::before, *::after { transition: none !important; }' +
    // The hint line a size larger than the app's, to be read in a film watched on a phone.
    '#coach { font-size: 19px; padding: 12px 22px; }' +
    '.finger { position: fixed; z-index: 9; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; pointer-events: none; background: rgba(255,255,255,0.32); box-shadow: inset 0 0 0 2px rgba(255,255,255,0.75), 0 2px 10px rgba(0,0,0,0.25); display: none; }'
  document.head.append(style)
  const canvas = city.renderer.domElement
  const coach = document.getElementById('coach')
  const dots = new Map(fingers.map((f) => { const el = document.createElement('div'); el.className = 'finger'; document.body.append(el); return [f.id, el] }))
  const held = new Map()
  const ease = (u) => u * u * (3 - 2 * u)
  const where = (f, t) => {
    if (f.button) { const r = document.getElementById(f.button).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] }
    let i = 1
    while (i < f.path.length - 1 && f.path[i][0] < t) i++
    const [a, b] = [f.path[i - 1], f.path[i]]
    const u = ease(Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0] || 1))))
    return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
  }
  const send = (type, f, [x, y]) => (f.button ? document.getElementById(f.button) : canvas).dispatchEvent(new PointerEvent(type, { pointerId: f.id, pointerType: 'touch', isPrimary: f.id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true }))
  return (t) => {
    for (const f of fingers) {
      const down = t >= f.path[0][0] && t <= f.path.at(-1)[0]
      const dot = dots.get(f.id)
      if (down) {
        const at = where(f, t)
        send(held.has(f.id) ? 'pointermove' : 'pointerdown', f, at)
        held.set(f.id, at)
        Object.assign(dot.style, { display: 'block', left: at[0] + 'px', top: at[1] + 'px' })
      } else if (held.has(f.id)) {
        send('pointerup', f, held.get(f.id))
        held.delete(f.id)
        dot.style.display = 'none'
      }
    }
    const line = captions.find(([from, to]) => t >= from && t <= to)
    coach.className = 'ctl'
    if (line) {
      coach.textContent = line[2]
      coach.style.opacity = ease(Math.min(1, (t - line[0]) / 0.3, (line[1] - t) / 0.3))
    } else coach.style.opacity = 0
  }
})()`

async function film() {
  const scale = board ? 0.5 : 2
  const page = await openPage(`${base}/?ratio=${scale}&at=${START}`, { width: W, height: H, scale: board ? 1 : scale, touch: true })
  mkdirSync(DIR, { recursive: true })
  const out = board ? null : clipWriter(join(DIR, 'screen.mp4'))
  try {
    await page.evaluate('city.film.stop()')
    await page.evaluate(`window.demo = ${DEMO}; true`)
    const [x, z] = START.split(',').map(Number)
    await page.evaluate(`city.film.shot(${x}, ${z}, [${x}, 2, ${z}])`)
    const count = SECONDS * FPS
    const t0 = Date.now()
    for (let k = 0; k <= count; k++) {
      await page.evaluate(`demo(${k / FPS}); city.film.step(${1 / FPS}); city.film.frame()`)
      if (board && k % FPS) continue
      const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: board ? 80 : 92 })
      const jpeg = Buffer.from(data, 'base64')
      if (out) await out.write(jpeg)
      else writeFileSync(join(DIR, `board-${String(k / FPS).padStart(2, '0')}.jpg`), jpeg)
      if (k % 30 === 0) process.stdout.write(`\r${k}/${count}  ${((Date.now() - t0) / (k + 1)) | 0} ms a frame   `)
    }
    if (out) await out.done()
    console.log(`\r${count + 1} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s                `)
  } finally {
    await page.close()
  }
}

/** The screen drawn at twice the points, as the iPad's own: its frames piped into ffmpeg, two of the 60 blended into each of 30, and scaled down to 1.5 × the points. */
const SCREEN = [W * 1.5, H * 1.5]
function clipWriter(file) {
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-vf', `tmix=frames=2,select='not(mod(n\\,2))',setpts=N/30/TB,scale=${SCREEN[0]}:${SCREEN[1]}:flags=lanczos,format=yuv420p`, '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', file], { stdio: ['pipe', 'inherit', 'inherit'] })
  const exited = new Promise((done, fail) => ffmpeg.once('exit', (code) => (code ? fail(new Error(`ffmpeg exited ${code}`)) : done())))
  return {
    write: (jpeg) => (ffmpeg.stdin.write(jpeg) ? Promise.resolve() : new Promise((done) => ffmpeg.stdin.once('drain', done))),
    async done() {
      ffmpeg.stdin.end()
      await exited
    },
  }
}

/** The recording: in from black and out to it, at the iPad's size and at X's, with a silent track. */
function encode() {
  const h264 = ['-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', '-shortest']
  const fades = `fade=t=in:st=0:d=0.4,fade=t=out:st=${SECONDS - 0.6}:d=0.6`
  for (const [file, size, crf] of [['film/touch-ipad.mp4', SCREEN, 16], ['film/touch-ipad-x.mp4', [1600, 1200], 19]]) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(DIR, 'screen.mp4'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-vf', `${fades},scale=${size[0]}:${size[1]}:flags=lanczos`, ...h264, '-crf', String(crf), file], { stdio: 'inherit' })
    console.log(file)
  }
}

/** The board: a frame a second, with its time, on one sheet. */
function sheet() {
  const frames = [...Array(SECONDS + 1).keys()].map((s) => join(DIR, `board-${String(s).padStart(2, '0')}.jpg`))
  execFileSync('montage', [...frames, '-tile', '4x', '-geometry', '560x420+6+6', '-background', '#141517', '-fill', '#eee', '-font', '/System/Library/Fonts/Supplemental/Arial.ttf', '-pointsize', '18', '-set', 'label', '%t', 'film/touch-board.jpg'])
  for (const f of frames) rmSync(f)
  console.log('film/touch-board.jpg')
}

await film()
if (board) sheet()
else encode()
