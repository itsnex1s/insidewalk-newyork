import * as THREE from 'three/webgpu'
import { loadIndex, type TileData } from './city/data'
import { setReflections } from './city/facades'
import { apron } from './city/streets'
import { Tiles } from './city/tiles'
import { hourOf, lookAt, type Time, TIMES } from './daytime'
import { weak } from './engine/device'
import { outdoors, picture, reflectedSky } from './engine/look'
import { lampPools } from './engine/night'
import { initTextures, mapsLoaded, startTextures } from './engine/textures'
import { cityReflections } from './engine/reflections'
import { minimap } from './minimap'
import { touchControls, touchOnly } from './touch'
import { walker } from './walk'

const params = new URLSearchParams(location.search)
const box = document.getElementById('view')!
const loader = document.getElementById('loader')!
const bar = loader.querySelector<HTMLElement>('.bar i')!
const stage = document.getElementById('stage')!
const place = document.getElementById('place')!

/** The street the walker is on and the nearest one crossing it, as "Greene St & Prince St". */
function streetLabel(streets: TileData['streets'], x: number, z: number) {
  const near = new Map<string, number>()
  for (const { name, line } of streets) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i], line[i + 1], line[i + 2], line[i + 3]]
      const [dx, dz] = [bx - ax, bz - az]
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t)
      if (d < (near.get(name) ?? Infinity)) near.set(name, d)
    }
  }
  const short = (s: string) => s.replace(/ Street$/, ' St').replace(/ Avenue$/, ' Ave').replace(/^West /, 'W ')
  const [first, second] = [...near].sort((a, b) => a[1] - b[1])
  if (!first) return ''
  return second && second[1] < 22 ? `${short(first[0])} & ${short(second[0])}` : short(first[0])
}

/** How far loading has come, `done` 0 to 1 (never back), and what it is at, on the loading screen. */
let shown = 0
function progress(text: string, done: number) {
  shown = Math.max(shown, done)
  bar.style.transform = `scaleX(${Math.max(0.03, shown)})`
  stage.textContent = text
}

/** Milliseconds from the page's start to each step of loading, for the dev readout (`city.timings`). */
const timings: Record<string, number> = {}
const mark = (step: string) => (timings[step] = Math.round(performance.now()))

/** Metres the walker goes before the sky's light is baked again round them (it covers 1800 m). */
const REBAKE = 300
/** Seconds a change of the time of day takes, the sun going down or coming up before the walker's eyes. */
const TURN = 3.5
/** Metres round the walker whose street lights' pools are drawn (night.ts's map is 1024 m wide), and how far they go before they are drawn again. */
const LAMPS = 512
const RELAMP = 200
/** Milliseconds after the loading screen goes that every frame is still drawn (see the frame loop). */
const SETTLE = 6000

async function main() {
  progress('Starting the renderer', 0.05)
  const renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance' })
  // ?ratio=3 draws three pixels to each CSS pixel whatever the screen: scripts/film.mjs supersamples so.
  renderer.setPixelRatio(Number(params.get('ratio')) || Math.min(devicePixelRatio, params.has('sharp') ? 2 : 1.5))
  renderer.setSize(box.clientWidth, box.clientHeight)
  box.appendChild(renderer.domElement)
  const [index] = await Promise.all([loadIndex(), renderer.init()])
  // Instance matrices as vertex attributes, never in a uniform array: three names each instanced mesh's array apart in
  // the shader, so every mesh (thousands as tiles stream in) would be a vertex shader of its own to compile.
  ;(renderer.backend as unknown as { capabilities: { getUniformBufferLimit(): number } }).capabilities.getUniformBufferLimit = () => 0
  initTextures(renderer)
  // The ground's maps download and transcode (in workers) while the tiles are fetched and built, as their materials ask.
  startTextures()
  mark('renderer')

  // ?at=x,z,bearing[,pitch[,height]]: metres; degrees clockwise from north and up from level; a height flies there.
  const [sx, sz, bearing, pitch = 0, height] = (params.get('at') ?? '97,43,33').split(',').map(Number)
  const scene = new THREE.Scene()
  const tiles = new Tiles(index)
  scene.add(apron(index.box), tiles.root)
  // Before any facade is built: the glass's shader looks the reflections up.
  const reflections = cityReflections(renderer, scene)
  setReflections(reflections)
  const walk = walker(renderer.domElement, tiles, { x: sx, z: sz, heading: (-bearing * Math.PI) / 180, pitch: (pitch * Math.PI) / 180, height })
  if (touchOnly()) {
    touchControls(renderer.domElement, walk.pad)
    walk.pad.onFly?.(walk.flying())
  }
  // Only the blocks round the walker and in view before the first frame; the rest of the city streams in as they look.
  await tiles.warm(walk.camera, (step, done) =>
    step === 'load' ? progress('Fetching the streets round you', 0.08 + done * 0.22) : progress('Raising the buildings', 0.3 + done * 0.3),
  )
  mark('tiles')
  progress('Setting the sun', 0.62)
  await new Promise((resolve) => setTimeout(resolve))
  // ?time=day, sunset or night, or an hour (16.5 to 22): the walk's light at that hour (daytime.ts).
  let hour = hourOf(params.get('time'))
  const { follow, reshadow, set, bake, rebake, baking } = outdoors(renderer, scene, 1800, lookAt(hour))
  bake(sx, sz)
  const baked = new THREE.Vector2(sx, sz)
  mark('light')

  const { pipeline, prepare, glow } = picture(renderer, scene, walk.camera, params.has('rich'))
  // A whole second at once: the eye straight onto the sidewalk built under it, not easing up after the reveal.
  walk.update(1)
  reflections.setSky(reflectedSky(400, lookAt(hour)))

  // The street lights' pools, drawn round the walker while the lights are on: all again once they have gone RELAMP
  // metres, and in between the lights of each tile whose data comes in, added to what is there.
  const lampsAt = new THREE.Vector2(Infinity, Infinity)
  const lit = new Set<object>()
  let lightsOn = 0
  const relamp = (eye: THREE.Vector3) => {
    if (!lightsOn) return
    if (Math.hypot(eye.x - lampsAt.x, eye.z - lampsAt.y) > RELAMP) {
      lampsAt.set(eye.x, eye.z)
      lampPools.reset(eye.x, eye.z)
      lit.clear()
    }
    for (const t of tiles.dataAround(lampsAt.x, lampsAt.y, LAMPS)) {
      if (lit.has(t)) continue
      lit.add(t)
      lampPools.add(t.data.lamps)
    }
    lampPools.flush()
  }
  /** The light at `h` o'clock; the environment's light and the sun's shadow drawn again too unless `full` is false. */
  const setHour = (h: number, full = true) => {
    hour = h
    const look = lookAt(h)
    set(look, full)
    lightsOn = look.lights ?? 0
    // Bloom from the golden hour on: a little round the low sun (more would blow its disc up over the street), and
    // more for the lights as they come on. Not on a weak device, where its pass is a frame's millisecond or more.
    glow(!weak && h >= TIMES.sunset - 0.4, THREE.MathUtils.lerp(0.1, 0.55, THREE.MathUtils.clamp(lightsOn / 0.6, 0, 1)))
    relamp(walk.camera.position)
    const near = (Object.keys(TIMES) as Time[]).reduce((a, b) => (Math.abs(TIMES[b] - h) < Math.abs(TIMES[a] - h) ? b : a))
    for (const b of timeButtons) b.setAttribute('aria-pressed', String(b.dataset.time === near))
  }
  // The time of day, changing: from one hour to another over TURN seconds.
  let change: { from: number; to: number; t: number; frames: number } | null = null
  const goTo = (to: number) => {
    if (to !== hour) change = { from: hour, to, t: 0, frames: 0 }
  }
  const timeButtons = [...document.querySelectorAll<HTMLButtonElement>('#time button')]
  for (const b of timeButtons) b.addEventListener('click', () => goTo(TIMES[b.dataset.time as Time]))
  const order = Object.keys(TIMES) as Time[]
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyT' || e.repeat || e.metaKey || e.ctrlKey) return
    const at = order.findIndex((t) => TIMES[t] >= (change?.to ?? hour) - 0.01)
    goTo(TIMES[order[(at + 1) % order.length]])
  })
  // outdoors() has set the light at this hour already: the rest (the lights, the bloom, the switch) without drawing
  // the environment's light and the shadow over again.
  setHour(hour, false)
  // Captured after a frame is drawn, never before it: the sun's shadow is then drawn already, and drawing it in the
  // middle of a capture leaves the frame with a shadow map the GPU has let go.
  let recapture = true
  // The first frame builds its shaders in one go, under the loading screen (quicker than a few at a time); tiles
  // streamed in later have theirs built between frames before they show.
  progress('Preparing the view', 0.75)
  tiles.prepare = prepare

  let redraw = 4
  THREE.DefaultLoadingManager.onLoad = () => (redraw = 2)
  let mapsIn = false
  mapsLoaded(10000).then(() => {
    mapsIn = true
    redraw = 3
    mark('maps')
    progress('Almost there', 0.95)
  })
  // The loading screen goes once the first frames are drawn with their maps (the glass's reflections fade in after);
  // the still underneath is of the same view, so the city seems to come to life where it stood.
  let revealed = false
  let revealedAt = 0
  const reveal = () => {
    revealed = true
    revealedAt = performance.now()
    // ?loading keeps the loading screen up, for a look at it (scripts/still.mjs).
    if (params.has('loading')) return document.body.setAttribute('data-ready', '')
    mark('ready')
    progress('Ready', 1)
    document.body.classList.add('ready')
    loader.classList.add('gone')
    // For scripts/still.mjs: ready once the loading screen has faded.
    setTimeout(() => {
      loader.remove()
      document.body.setAttribute('data-ready', '')
    }, 1000)
  }
  addEventListener('resize', () => {
    renderer.setSize(box.clientWidth, box.clientHeight)
    walk.camera.aspect = box.clientWidth / box.clientHeight
    walk.camera.updateProjectionMatrix()
    redraw = 2
  })
  const map = minimap(document.getElementById('minimap') as HTMLCanvasElement, tiles, index.tile)
  let last = performance.now()
  let labelAt = 0
  let mapAt = 0
  let stillFor = 0
  let settleAt = 0
  // Filming (scripts/film.mjs): the walk's loop stopped, and each frame drawn once the camera is set and all it sees is in.
  const camera = walk.camera
  const film = {
    stop: () => renderer.setAnimationLoop(null),
    pose(x: number, y: number, z: number, yaw: number, pitch: number, fov: number) {
      camera.position.set(x, y, z)
      camera.rotation.set(pitch, yaw, 0, 'YXZ')
      camera.fov = fov
      camera.near = THREE.MathUtils.clamp(y * 0.012, 0.2, 4)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
    },
    /** Readies a shot: the city round its first pose in, the sky's light baked round (x, z), the reflections from `eye`. */
    async shot(x: number, z: number, eye: [number, number, number]) {
      await tiles.settle(camera)
      bake(x, z)
      baked.set(x, z)
      follow(camera.position)
      reshadow()
      pipeline.render()
      reflections.capture(new THREE.Vector3(...eye))
      while (reflections.step(1));
    },
    /** The walker moved `dt` seconds by its controls, the map and the street's name with it (scripts/touch-film.mjs). */
    step(dt: number) {
      walk.update(dt)
      const eye = camera.position
      map.draw(eye.x, eye.z, camera.rotation.y)
      place.textContent = `${streetLabel(tiles.streetsAt(eye.x, eye.z), eye.x, eye.z)}${walk.flying() ? ' · flying' : ''}`
    },
    /** Sets the time of day at once, `h` o'clock (16.5 to 22). */
    time: (h: number) => setHour(h),
    async frame() {
      await tiles.settle(camera)
      relamp(camera.position)
      if (tiles.changed) {
        tiles.changed = false
        reshadow()
      }
      follow(camera.position)
      pipeline.render()
      await (renderer.backend as unknown as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device.queue.onSubmittedWorkDone()
    },
  }
  const dev = { scene, camera, renderer, frames: 0, timings, streamer: tiles, tiles: () => tiles.counts(), redraw: () => (redraw = 2), film }
  Object.assign(window, { city: dev })
  let lampCheck = 0
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const moved = walk.update(dt)
    const eye = walk.camera.position
    // A change of time: eased, the environment's light and the sun's shadow drawn again every fourth frame and at the
    // end, and the glass's reflections captured again once it is done.
    if (change) {
      change.t = Math.min(1, change.t + dt / TURN)
      const t = change.t * change.t * (3 - 2 * change.t)
      setHour(change.from + (change.to - change.from) * t, change.t >= 1 || ++change.frames % 4 === 0)
      if (change.t >= 1) {
        change = null
        recapture = true
      }
      redraw = Math.max(redraw, 1)
    }
    if (now - lampCheck > 500) {
      lampCheck = now
      relamp(eye)
    }
    stillFor = moved ? 0 : stillFor + dt
    if (tiles.update(walk.camera)) redraw = Math.max(redraw, 1)
    // Once tiles round the walker have come or gone and things have settled a moment: the shadow, the sky's light and
    // the reflections are redone with them.
    if (tiles.changed) {
      tiles.changed = false
      settleAt = now + 600
    }
    let shadow = follow(eye)
    if (settleAt && now > settleAt) {
      settleAt = 0
      reshadow()
      shadow = true
      rebake(eye.x, eye.z)
      baked.set(eye.x, eye.z)
      recapture = true
    } else if (Math.hypot(eye.x - baked.x, eye.z - baked.y) > REBAKE) {
      rebake(eye.x, eye.z)
      baked.set(eye.x, eye.z)
    }
    // The sky's light is baked a few milliseconds a frame, and shows when it is done.
    if (baking(4)) redraw = Math.max(redraw, 1)
    // The reflections are drawn again where the walker stops, not while they walk: a capture is six views of the city.
    if (stillFor > 0.35 && reflections.due(eye)) recapture = true
    if (recapture) redraw = Math.max(redraw, 1)
    // Until the loading screen goes, every frame is drawn: it waits on frames. And for a few seconds after: the
    // shaders of tiles built since are compiled in the background, and a tile whose shader is not in yet is left out
    // of a frame, so the city would stand half drawn until the walker moved.
    if (!revealed || now - revealedAt < SETTLE) redraw = Math.max(redraw, 1)
    // The map 30 times a second at most: it turns and slides, nothing in it moves faster.
    if (revealed && now - mapAt > 33) {
      mapAt = now
      map.draw(eye.x, eye.z, walk.camera.rotation.y)
    }
    if (!moved && !shadow && redraw <= 0) return
    redraw = Math.max(0, redraw - 1)
    pipeline.render()
    dev.frames++
    if (dev.frames <= 3) mark(`frame${dev.frames}`)
    if (recapture && !shadow) {
      reflections.capture(eye)
      recapture = false
    }
    if (reflections.step(dt)) redraw = Math.max(redraw, 1)
    if (!revealed && mapsIn && dev.frames >= 3) reveal()
    if (now - labelAt > 400) {
      labelAt = now
      place.textContent = `${streetLabel(tiles.streetsAt(eye.x, eye.z), eye.x, eye.z)}${walk.flying() ? ' · flying' : ''}`
    }
  })
}

main().catch((e) => {
  console.error(e)
  loader.classList.add('failed')
  stage.textContent = `Could not start: ${e instanceof Error ? e.message : e}`
})
