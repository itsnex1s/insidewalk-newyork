#!/usr/bin/env node
// Films the walk (dev server running) frame by frame in headless Chrome and cuts the shots into one video:
//
//   node scripts/film.mjs [scripts/film.json] [--board] [--shots greene,gay] [--fresh] [--encode-only]
//
// Each shot is a camera move along a street (scripts/film.json): a smooth curve through `path` (metres, as ?at= has
// them), eased at both ends, looking `ahead` metres along it, turned by `pan` and tilted by `pitch` (degrees, from
// start to end), at `height` metres. Every frame waits for all the camera sees to be built, so nothing streams in on
// screen. Frames are drawn at `scale` × the size and piped straight into each shot's clip (clipWriter); the clips
// crossfade into the video. --board draws only the first, middle and last frame of each
// shot, small, into film/board/index.html, to look the moves over before the long render. A render stopped halfway
// goes on from the first shot not yet in film/clips/; --fresh draws the named shots again. Needs ffmpeg.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openPage } from './chrome.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const specPath = args.find((a) => a.endsWith('.json')) ?? 'scripts/film.json'
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const board = args.includes('--board')
const only = opt('--shots', '')?.split(',').filter(Boolean)
const base = opt('--base', 'http://localhost:5240')
const shots = spec.shots.filter((s) => !only.length || only.includes(s.name))
const BOARD = 'film/board'
const CLIPS = 'film/clips'

// The camera's way: a Catmull-Rom curve through the path's points, measured along its length.
function curve(points) {
  if (points.length === 1) return { length: 0, at: () => points[0] }
  const p = [points[0].map((v, i) => 2 * v - points[1][i]), ...points, points.at(-1).map((v, i) => 2 * v - points.at(-2)[i])]
  const samples = []
  for (let k = 1; k < p.length - 2; k++) {
    for (let j = 0; j < 64; j++) {
      const t = j / 64
      const [a, b, c, d] = [p[k - 1], p[k], p[k + 1], p[k + 2]]
      samples.push([0, 1].map((i) => 0.5 * (2 * b[i] + (c[i] - a[i]) * t + (2 * a[i] - 5 * b[i] + 4 * c[i] - d[i]) * t * t + (3 * b[i] - a[i] - 3 * c[i] + d[i]) * t * t * t)))
    }
  }
  samples.push(points.at(-1))
  const lengths = [0]
  for (let i = 1; i < samples.length; i++) lengths.push(lengths[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]))
  const length = lengths.at(-1)
  /** The point `s` metres along; past either end, straight on along the end's direction. */
  const at = (s) => {
    if (s <= 0 || s >= length) {
      const [a, b] = s <= 0 ? [samples[1], samples[0]] : [samples.at(-2), samples.at(-1)]
      const over = s <= 0 ? -s : s - length
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      return [b[0] + ((b[0] - a[0]) / d) * over, b[1] + ((b[1] - a[1]) / d) * over]
    }
    let i = 1
    while (lengths[i] < s) i++
    const f = (s - lengths[i - 1]) / (lengths[i] - lengths[i - 1] || 1)
    return [0, 1].map((k) => samples[i - 1][k] + (samples[i][k] - samples[i - 1][k]) * f)
  }
  return { length, at }
}

const lerp = (range, t) => (Array.isArray(range) ? range[0] + (range[1] - range[0]) * t : range)
/** Eased at both ends, as a dolly starts and stops: `ease` 0 is constant speed, 1 smootherstep. */
const eased = (t, ease) => t + (t * t * t * (t * (t * 6 - 15) + 10) - t) * ease

/** The camera `t` (0 to 1) through `shot`: x, y, z, yaw and pitch (radians) and the field of view. */
function pose(shot, t) {
  const way = (shot.way ??= curve(shot.path))
  const u = eased(t, shot.ease ?? 0.6)
  const [x, z] = way.at(u * way.length)
  let bearing
  if (shot.bearing !== undefined) bearing = lerp(shot.bearing, u)
  else {
    const [ax, az] = way.at(u * way.length + (shot.ahead ?? 20))
    bearing = (Math.atan2(ax - x, -(az - z)) * 180) / Math.PI
  }
  bearing += lerp(shot.pan ?? 0, u)
  return { x, y: lerp(shot.height ?? 1.9, u), z, yaw: (-bearing * Math.PI) / 180, pitch: (lerp(shot.pitch ?? 0, u) * Math.PI) / 180, fov: lerp(shot.fov ?? 50, u) }
}

/** The closing title over the last shot, in the page's own type; its opacity is set frame by frame. */
const TITLE = `(() => {
  const el = document.createElement('div')
  el.id = 'film-title'
  el.innerHTML = '<div class="t-brand"><svg viewBox="0 0 24 24"><path d="M12 21h9V3H3v18M12 21v-9" /><path class="swing" d="M12 12a9 9 0 0 0-9 9" /></svg><span>Inside<b>Walk</b></span></div><h1>Lower <em>Manhattan</em></h1><p>Walk it in your browser · newyork.insidewalk.app</p>'
  const style = document.createElement('style')
  style.textContent = '#film-title { position: fixed; inset: 0; display: grid; place-content: center; justify-items: center; gap: 0; text-align: center; color: #f6f1ea; opacity: 0; background: radial-gradient(ellipse at center, rgba(14,15,17,0.5), rgba(14,15,17,0.15) 70%); pointer-events: none; }' +
    '#film-title .t-brand { display: inline-flex; align-items: center; gap: 0.5vw; font: 600 1.6vw/1 var(--sans); letter-spacing: -0.015em; margin-bottom: 1.6vw; filter: drop-shadow(0 1px 6px rgba(0,0,0,0.45)); }' +
    '#film-title svg { width: 2vw; height: 2vw; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; } #film-title .swing { stroke: var(--accent); stroke-width: 1.6; } #film-title b { font-weight: inherit; color: var(--accent); }' +
    '#film-title h1 { margin: 0; font: 400 7vw/0.95 var(--serif); letter-spacing: -0.02em; text-shadow: 0 2px 30px rgba(0,0,0,0.4); } #film-title em { font-style: italic; }' +
    '#film-title p { margin: 1.8vw 0 0; font: 500 1.25vw/1.4 var(--sans); letter-spacing: 0.04em; opacity: 0.9; text-shadow: 0 1px 8px rgba(0,0,0,0.5); }'
  document.head.append(style)
  document.body.append(el)
  return document.fonts.ready.then(() => true)
})()`

/** The frames each shot's clip is drawn at: `fps` per second of it, and one more blended into the last. */
const framesOf = (shot) => Math.round(shot.seconds * spec.fps)

async function film() {
  const [width, height] = board ? [1280, 720] : [spec.width, spec.height]
  const scale = board ? 1 : spec.scale
  const page = await openPage(`${base}/?bare&ratio=${scale}&${spec.query ?? ''}&at=${spec.shots[0].path[0].join(',')},0`, { width, height, scale })
  try {
    await page.evaluate('city.film.stop()')
    await page.evaluate(TITLE)
    for (const shot of shots) {
      if (!board && args.includes('--fresh')) rmSync(clipOf(shot), { force: true })
      if (!board && existsSync(clipOf(shot))) continue
      const count = framesOf(shot)
      const wanted = board ? [0, Math.floor(count / 2), count] : [...Array(count + 1).keys()]
      const out = board ? null : clipWriter(shot)
      const t0 = Date.now()
      const set = (p) => page.evaluate(`city.film.pose(${p.x}, ${p.y}, ${p.z}, ${p.yaw}, ${p.pitch}, ${p.fov})`)
      // The light and the reflections for the whole shot, from its middle: they stay put while the camera moves.
      await set(pose(shot, 0))
      const middle = pose(shot, 0.5)
      await page.evaluate(`city.film.shot(${middle.x}, ${middle.z}, [${middle.x}, ${middle.y}, ${middle.z}])`)
      for (const k of wanted) {
        const t = k / count
        await set(pose(shot, t))
        const title = shot.title === undefined ? 0 : Math.min(1, Math.max(0, (t * shot.seconds - shot.title) / 1.2))
        await page.evaluate(`document.getElementById('film-title').style.opacity = ${title * title * (3 - 2 * title)}`)
        await page.evaluate('city.film.frame()')
        const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: board ? 85 : 92 })
        const jpeg = Buffer.from(data, 'base64')
        if (out) await out.write(jpeg)
        else {
          mkdirSync(BOARD, { recursive: true })
          writeFileSync(join(BOARD, `${shot.name}-${k}.jpg`), jpeg)
        }
        if (!board && k % 30 === 0) process.stdout.write(`\r${shot.name}: ${k}/${count}  ${((Date.now() - t0) / (k + 1)) | 0} ms a frame   `)
      }
      if (out) await out.done()
      console.log(`\r${shot.name}: ${wanted.length} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s                `)
    }
  } finally {
    await page.close()
  }
}

/** The board: each shot's first, middle and last frame side by side, on a page to look the cut over. */
function writeBoard() {
  const rows = spec.shots
    .filter((shot) => existsSync(join(BOARD, `${shot.name}-0.jpg`)))
    .map((shot) => {
      const count = framesOf(shot)
      const cells = [0, Math.floor(count / 2), count].map((k) => `<img src="${shot.name}-${k}.jpg" alt="">`).join('')
      return `<section><h2>${shot.name} <small>${shot.seconds} s · ${shot.note ?? ''}</small></h2><div>${cells}</div></section>`
    })
  writeFileSync(join(BOARD, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Storyboard</title><style>
body { margin: 0; padding: 24px; background: #141517; color: #eee; font: 14px/1.4 system-ui, sans-serif; }
h2 { margin: 28px 0 10px; font-size: 16px; font-weight: 600; } small { font-weight: 400; opacity: 0.6; margin-left: 8px; }
div { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; } img { width: 100%; display: block; border-radius: 4px; }
</style><h1>Lower Manhattan — storyboard</h1><p>Each shot: first, middle and last frame.</p>${rows.join('')}`)
  console.log(join(BOARD, 'index.html'))
}

const clipOf = (shot) => join(CLIPS, `${shot.name}.mp4`)

/**
 * A shot's clip, its frames piped straight into ffmpeg (supersampled frames of a whole video do not fit on a laptop's
 * disk): two frames of the double rate blended into each, the shutter open half the frame as a film camera's, and
 * scaled down to the video's size. Nearly lossless, for the cut; written under another name until it is whole.
 */
function clipWriter(shot) {
  mkdirSync(CLIPS, { recursive: true })
  const part = clipOf(shot).replace(/\.mp4$/, '.part.mp4')
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(spec.fps), '-i', '-', '-vf', `tmix=frames=2,select='not(mod(n\\,2))',setpts=N/${spec.outFps}/TB,scale=${spec.outWidth}:${spec.outHeight}:flags=lanczos,format=yuv420p`, '-r', String(spec.outFps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', part], { stdio: ['pipe', 'inherit', 'inherit'] })
  const exited = new Promise((done, fail) => ffmpeg.once('exit', (code) => (code ? fail(new Error(`ffmpeg exited ${code}`)) : done())))
  return {
    write: (jpeg) => (ffmpeg.stdin.write(jpeg) ? Promise.resolve() : new Promise((done) => ffmpeg.stdin.once('drain', done))),
    async done() {
      ffmpeg.stdin.end()
      await exited
      renameSync(part, clipOf(shot))
    },
  }
}

/** Cuts the clips into the video: crossfades, a lens's vignette and grain, in from black and out to it. */
function encode() {
  const out = spec.output
  mkdirSync(dirname(out), { recursive: true })
  const fade = spec.fade
  const inputs = []
  const filters = []
  let offset = 0
  let last = ''
  spec.shots.forEach((shot, i) => {
    inputs.push('-i', clipOf(shot))
    filters.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[c${i}]`)
    const seconds = Math.ceil((framesOf(shot) + 1) / 2) / spec.outFps
    if (i === 0) last = `c0`
    else {
      filters.push(`[${last}][c${i}]xfade=transition=fade:duration=${fade}:offset=${(offset - fade).toFixed(3)}[x${i}]`)
      last = `x${i}`
      offset -= fade
    }
    offset += seconds
  })
  filters.push(`[${last}]vignette=angle=PI/7,noise=c0s=3:c0f=t,fade=t=in:st=0:d=0.6,fade=t=out:st=${(offset - 0.7).toFixed(3)}:d=0.7[v]`)
  const h264 = ['-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(spec.outFps), '-movflags', '+faststart']
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', ...h264, '-crf', String(spec.crf ?? 17), out], { stdio: 'inherit' })
  console.log(`${out}: ${offset.toFixed(1)} s`)
  // For X (Twitter): 1920 × 1080 and a silent stereo track, which its player and its upload checks expect.
  const social = out.replace(/\.mp4$/, '-1080p.mp4')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-vf', 'scale=1920:1080:flags=lanczos', ...h264, '-crf', '19', '-maxrate', '20M', '-bufsize', '40M', '-c:a', 'aac', '-b:a', '128k', social], { stdio: 'inherit' })
  console.log(social)
}

if (!args.includes('--encode-only')) await film()
if (board) writeBoard()
else if (!only.length || args.includes('--encode-only')) encode()
else console.log(`frames of ${only.join(', ')} drawn; run again without --shots (or with --encode-only) for the video`)
