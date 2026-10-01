import * as THREE from 'three/webgpu'
import { loadIndex, type TileData } from './city/data'
import { setReflections } from './city/facades'
import { apron } from './city/streets'
import { Tiles } from './city/tiles'
import { type Look, outdoors, picture } from './engine/look'
import { initTextures, mapsLoaded, startTextures } from './engine/textures'
import { cityReflections } from './engine/reflections'
import { walker } from './walk'

/** A late summer afternoon over Lower Manhattan: the sun in the south-west, warm haze, a few high clouds. */
const LOOK: Look = {
  sun: new THREE.Vector3(-0.52, 0.62, 0.58).normalize(),
  sunColor: 0xffe8cc,
  sunIntensity: 6.4,
  exposure: 0.62,
  haze: new THREE.Color().setRGB(1.75, 1.66, 1.56),
  fog: 0.00045,
  clear: 350,
  sky: { turbidity: 2.6, rayleigh: 2.4, mie: 0.005, mieG: 0.8, cloudCoverage: 0.35, cloudDensity: 0.4, cloudElevation: 0.5, deep: new THREE.Color().setRGB(0.6, 0.76, 1.02) },
  ground: 0xb4ab9c,
  environment: 0.75,
  grade: { saturation: 0.95, contrast: 1.1, warmth: 0.035 },
}

const params = new URLSearchParams(location.search)
const box = document.getElementById('view')!
const status = document.getElementById('status')!
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

/** Metres the walker goes before the sky's light is baked again round them (it covers 1800 m). */
const REBAKE = 300

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, params.has('sharp') ? 2 : 1.5))
  renderer.setSize(box.clientWidth, box.clientHeight)
  box.appendChild(renderer.domElement)
  const [index] = await Promise.all([loadIndex(), renderer.init()])
  initTextures(renderer)

  // ?at=x,z,bearing[,pitch[,height]]: metres; degrees clockwise from north and up from level; a height flies there.
  const [sx, sz, bearing, pitch = 0, height] = (params.get('at') ?? '97,43,33').split(',').map(Number)
  const scene = new THREE.Scene()
  const tiles = new Tiles(index)
  scene.add(apron(index.box), tiles.root)
  // Before any facade is built: the glass's shader looks the reflections up.
  const reflections = cityReflections(renderer, scene)
  setReflections(reflections)
  status.textContent = 'Loading Lower Manhattan…'
  await tiles.warm(sx, sz)
  const { follow, reshadow, bake } = outdoors(renderer, scene, 1800, LOOK)
  bake(sx, sz)
  const baked = new THREE.Vector2(sx, sz)
  startTextures()

  const walk = walker(renderer.domElement, tiles, { x: sx, z: sz, heading: (-bearing * Math.PI) / 180, pitch: (pitch * Math.PI) / 180, height })
  const { pipeline } = picture(renderer, scene, walk.camera, params.has('rich'))
  walk.update(0)
  // Captured after a frame is drawn, never before it: the sun's shadow is then drawn already, and drawing it in the
  // middle of a capture leaves the frame with a shadow map the GPU has let go.
  let recapture = true

  let redraw = 4
  THREE.DefaultLoadingManager.onLoad = () => (redraw = 2)
  // For scripts/still.mjs: ready once the ground's maps are in and drawn.
  mapsLoaded(10000).then(() => {
    redraw = 3
    setTimeout(() => document.body.setAttribute('data-ready', ''), 600)
  })
  addEventListener('resize', () => {
    renderer.setSize(box.clientWidth, box.clientHeight)
    walk.camera.aspect = box.clientWidth / box.clientHeight
    walk.camera.updateProjectionMatrix()
    redraw = 2
  })
  let last = performance.now()
  let labelAt = 0
  let stillFor = 0
  let settleAt = 0
  const dev = { scene, camera: walk.camera, renderer, frames: 0, tiles: () => tiles.counts(), redraw: () => (redraw = 2) }
  Object.assign(window, { castiron: dev })
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const moved = walk.update(dt)
    const eye = walk.camera.position
    stillFor = moved ? 0 : stillFor + dt
    if (tiles.update(eye.x, eye.z)) redraw = Math.max(redraw, 1)
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
      bake(eye.x, eye.z)
      baked.set(eye.x, eye.z)
      recapture = true
    } else if (Math.hypot(eye.x - baked.x, eye.z - baked.y) > REBAKE) {
      bake(eye.x, eye.z)
      baked.set(eye.x, eye.z)
      redraw = Math.max(redraw, 1)
    }
    // The reflections are drawn again where the walker stops, not while they walk: a capture is six views of the city.
    if (stillFor > 0.35 && reflections.due(eye)) recapture = true
    if (recapture) redraw = Math.max(redraw, 1)
    if (!moved && !shadow && redraw <= 0) return
    redraw = Math.max(0, redraw - 1)
    pipeline.render()
    dev.frames++
    if (recapture && !shadow) {
      reflections.capture(eye)
      recapture = false
      redraw = Math.max(redraw, 1)
    }
    if (now - labelAt > 400) {
      labelAt = now
      place.textContent = `${streetLabel(tiles.streetsAt(eye.x, eye.z), eye.x, eye.z)}${walk.flying() ? ' · flying' : ''}`
    }
  })
  status.remove()
}

main().catch((e) => {
  console.error(e)
  status.textContent = `Could not start: ${e instanceof Error ? e.message : e}`
})
