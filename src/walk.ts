import * as THREE from 'three/webgpu'
import type { Segment } from './city/buildings'
import { KERB } from './city/streets'
import { PROPS } from './engine/util'

/**
 * Walking the streets at eye height: drag or click-and-lock the mouse to look, WASD or the arrows to walk, Shift to
 * hurry. The walker is a circle 30 cm across its middle on the plan and slides along the walls it meets; the eye rises
 * a kerb's height onto a sidewalk and steps down off it. F flies (no walls, Space and C up and down), for a look
 * from above. On a touch screen the left half of the screen walks as a stick, the right half looks.
 */

const EYE = 1.65
const RADIUS = 0.3
const SPEED = 1.5
const HURRY = 4.2
const FLY = 18

export interface Walker {
  camera: THREE.PerspectiveCamera
  /** Moves the walker by `dt` seconds of input; true when the view changed. */
  update(dt: number): boolean
  flying(): boolean
}

/** What the walker asks of the city round them (the streamed tiles, city/tiles.ts). */
export interface World {
  wallsAt(x: number, z: number): Segment[]
  onSidewalk(x: number, z: number): boolean
}

export function walker(canvas: HTMLCanvasElement, world: World, start: { x: number; z: number; heading: number; pitch?: number; height?: number }): Walker {
  const camera = new THREE.PerspectiveCamera(62, canvas.clientWidth / canvas.clientHeight, 0.1, 6000)
  // Trees, lights and tanks are on the props layer (left out of the baked sky occlusion), and the walker sees them.
  camera.layers.enable(PROPS)
  // A height given starts the walker flying there, for a look from above.
  let fly = start.height !== undefined
  const at = new THREE.Vector3(start.x, start.height ?? groundAt(start.x, start.z) + EYE, start.z)
  let [yaw, pitch] = [start.heading, start.pitch ?? 0]
  const keys = new Set<string>()
  const stick = { id: -1, x: 0, y: 0, dx: 0, dy: 0 }
  const look = { id: -1, x: 0, y: 0 }
  let dirty = true

  function groundAt(x: number, z: number) {
    return world.onSidewalk(x, z) ? KERB : 0
  }

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyF') {
      fly = !fly
      if (!fly) at.y = groundAt(at.x, at.z) + EYE
      dirty = true
    }
    keys.add(e.code)
  })
  addEventListener('keyup', (e) => keys.delete(e.code))
  addEventListener('blur', () => keys.clear())

  const turn = (dx: number, dy: number) => {
    yaw -= dx * 0.0024
    pitch = THREE.MathUtils.clamp(pitch - dy * 0.0024, -1.45, 1.45)
    dirty = true
  }
  canvas.addEventListener('click', () => {
    if (matchMedia('(pointer: fine)').matches) canvas.requestPointerLock?.()
  })
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) turn(e.movementX, e.movementY)
  })
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return
    if (e.clientX < innerWidth / 2 && stick.id < 0) Object.assign(stick, { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 })
    else if (look.id < 0) Object.assign(look, { id: e.pointerId, x: e.clientX, y: e.clientY })
  })
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId === stick.id) Object.assign(stick, { dx: (e.clientX - stick.x) / 60, dy: (e.clientY - stick.y) / 60 })
    if (e.pointerId === look.id) {
      turn((e.clientX - look.x) * 1.6, (e.clientY - look.y) * 1.6)
      Object.assign(look, { x: e.clientX, y: e.clientY })
    }
  })
  const lift = (e: PointerEvent) => {
    if (e.pointerId === stick.id) Object.assign(stick, { id: -1, dx: 0, dy: 0 })
    if (e.pointerId === look.id) look.id = -1
  }
  canvas.addEventListener('pointerup', lift)
  canvas.addEventListener('pointercancel', lift)

  /** Pushes (x, z) out of every wall within the walker's radius. */
  function collide(p: THREE.Vector3) {
    for (let pass = 0; pass < 3; pass++) {
      for (const [ax, az, bx, bz] of world.wallsAt(p.x, p.z)) {
        const [dx, dz] = [bx - ax, bz - az]
        const t = THREE.MathUtils.clamp(((p.x - ax) * dx + (p.z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1)
        const [cx, cz] = [ax + dx * t, az + dz * t]
        const d = Math.hypot(p.x - cx, p.z - cz)
        if (d < RADIUS && d > 1e-6) {
          p.x = cx + ((p.x - cx) / d) * RADIUS
          p.z = cz + ((p.z - cz) / d) * RADIUS
        }
      }
    }
  }

  function update(dt: number) {
    const k = (code: string) => (keys.has(code) ? 1 : 0)
    const forward = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown') - stick.dy
    const right = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft') + stick.dx
    const up = k('Space') - k('KeyC')
    const moving = forward || right || (fly && up)
    if (moving) {
      const speed = fly ? FLY * (keys.has('ShiftLeft') ? 4 : 1) : keys.has('ShiftLeft') || keys.has('ShiftRight') ? HURRY : SPEED
      const len = Math.min(1, Math.hypot(forward, right)) / (Math.hypot(forward, right) || 1)
      const [sin, cos] = [Math.sin(yaw), Math.cos(yaw)]
      const step = speed * dt * len
      const next = at.clone()
      next.x += (-sin * forward + cos * right) * step
      next.z += (-cos * forward - sin * right) * step
      if (fly) next.y = Math.max(1, next.y + up * speed * dt)
      else collide(next)
      at.copy(next)
      dirty = true
    }
    if (!fly) {
      // The eye eases up a kerb and down off it over a few frames, as a step does.
      const target = groundAt(at.x, at.z) + EYE
      if (Math.abs(target - at.y) > 0.002) {
        at.y += (target - at.y) * Math.min(1, dt * 12)
        dirty = true
      }
    }
    camera.position.copy(at)
    camera.rotation.set(pitch, yaw, 0, 'YXZ')
    const changed = dirty
    dirty = false
    return changed
  }

  return { camera, update, flying: () => fly }
}
