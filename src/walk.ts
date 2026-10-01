import * as THREE from 'three/webgpu'
import type { Segment } from './city/buildings'
import { KERB } from './city/streets'
import { PROPS } from './engine/util'

/**
 * Walking the streets at eye height: drag the view round (as a street panorama is dragged) or click to lock the mouse
 * and look as in a game, WASD or the arrows to walk, Shift to hurry. The walker is a circle 30 cm across its middle on
 * the plan and slides along the walls it meets; the eye rises a kerb's height onto a sidewalk and steps down off it, and
 * Space jumps. E rises into the air and Q comes down (no walls up there), back to walking on reaching the ground; F
 * takes off or lands at once. A touch screen drives the same walker through its `pad` (touch.ts): a stick, a look
 * and buttons, as a phone game has them.
 */

const EYE = 1.65
const RADIUS = 0.3
/** The near plane on foot, metres: inside the walker's radius, so a wall they stand against is never cut open. */
const NEAR = 0.2
const SPEED = 1.5
const HURRY = 4.2
const FLY = 18
/** Take-off speed, metres a second, and gravity: a jump of about 0.8 m, up and down in 0.8 s. */
const JUMP = 4
const GRAVITY = 9.81
/** How fast the view catches up with the mouse, per second: about 50 ms to get most of the way. */
const LOOK_EASE = 22

export interface Walker {
  camera: THREE.PerspectiveCamera
  /** Moves the walker by `dt` seconds of input; true when the view changed. */
  update(dt: number): boolean
  flying(): boolean
  pad: Pad
}

/** The on-screen controls' hold on the walker (touch.ts). */
export interface Pad {
  /** The stick, -1 to 1 each way (its length the share of the speed), and whether it is pushed past its rim to run. */
  forward: number
  right: number
  run: boolean
  /** Held up (1) or down (-1): rising takes off, as E does. */
  up: number
  /** Turns the view by a drag of (dx, dy) pixels: right turns right, up looks up. */
  turn(dx: number, dy: number): void
  jump(): void
  /** Takes off or lands, as F does. */
  fly(): void
  /** Told whenever the walker takes off or lands. */
  onFly?: (flying: boolean) => void
}

/** What the walker asks of the city round them (the streamed tiles, city/tiles.ts). */
export interface World {
  wallsAt(x: number, z: number): Segment[]
  onSidewalk(x: number, z: number): boolean
}

export function walker(canvas: HTMLCanvasElement, world: World, start: { x: number; z: number; heading: number; pitch?: number; height?: number }): Walker {
  const camera = new THREE.PerspectiveCamera(62, canvas.clientWidth / canvas.clientHeight, NEAR, 6000)
  // Trees, lights and tanks are on the props layer (left out of the baked sky occlusion), and the walker sees them.
  camera.layers.enable(PROPS)
  // A height given starts the walker flying there, for a look from above.
  let fly = start.height !== undefined
  const at = new THREE.Vector3(start.x, start.height ?? groundAt(start.x, start.z) + EYE, start.z)
  let [yaw, pitch] = [start.heading, start.pitch ?? 0]
  // Where the mouse or finger has turned the view to: the camera follows it over a few frames (LOOK_EASE), so a
  // mouse's coarse steps and an uneven frame come out as a smooth turn.
  let [aimYaw, aimPitch] = [yaw, pitch]
  const keys = new Set<string>()
  let dirty = true
  /** Height of a jump above the ground, and its speed up. */
  let air = 0
  let rise = 0
  const jump = () => {
    if (fly || air > 0) return
    rise = JUMP
    dirty = true
  }

  function groundAt(x: number, z: number) {
    return world.onSidewalk(x, z) ? KERB : 0
  }

  const setFly = (on: boolean) => {
    if (on === fly) return
    fly = on
    pad.onFly?.(fly)
  }
  const toggleFly = () => {
    setFly(!fly)
    if (!fly) at.y = groundAt(at.x, at.z) + EYE
    else at.y = Math.max(at.y, groundAt(at.x, at.z) + EYE + 30)
    dirty = true
  }

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyF') toggleFly()
    if (e.code === 'Space') {
      // Not the page scrolling, nor a focused link following.
      e.preventDefault()
      if (!e.repeat) jump()
    }
    keys.add(e.code)
  })
  addEventListener('keyup', (e) => keys.delete(e.code))
  addEventListener('blur', () => keys.clear())

  const turn = (dx: number, dy: number) => {
    // A single event's jump is capped: some systems report a spike as the pointer locks.
    aimYaw -= THREE.MathUtils.clamp(dx, -300, 300) * 0.0022
    aimPitch = THREE.MathUtils.clamp(aimPitch - THREE.MathUtils.clamp(dy, -300, 300) * 0.0022, -1.45, 1.45)
    dirty = true
  }
  // The mouse looks by dragging, or, after a click that did not drag, with the pointer locked.
  const drag = { down: false, moved: 0 }
  canvas.addEventListener('mousedown', () => Object.assign(drag, { down: true, moved: 0 }))
  addEventListener('mouseup', () => (drag.down = false))
  canvas.addEventListener('click', () => {
    if (drag.moved < 5 && matchMedia('(pointer: fine)').matches) canvas.requestPointerLock?.()
  })
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) turn(e.movementX, e.movementY)
    else if (drag.down) {
      // Dragging takes hold of the view and pulls it, as a street panorama: drag left and the view turns right.
      drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY)
      turn(-e.movementX, -e.movementY)
    }
  })
  const pad: Pad = { forward: 0, right: 0, run: false, up: 0, turn, jump, fly: toggleFly }

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
    const forward = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown') + pad.forward
    const right = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft') + pad.right
    const up = THREE.MathUtils.clamp(k('KeyE') + k('PageUp') - k('KeyQ') - k('PageDown') + pad.up, -1, 1)
    const hurry = keys.has('ShiftLeft') || keys.has('ShiftRight') || pad.run
    // Rising takes off; coming down to the ground lands.
    if (up > 0 && !fly) {
      setFly(true)
      air = rise = 0
    }
    const moving = forward || right || (fly && up)
    if (moving) {
      const speed = fly ? FLY * (hurry ? 4 : 1) : hurry ? HURRY : SPEED
      const len = Math.min(1, Math.hypot(forward, right)) / (Math.hypot(forward, right) || 1)
      const [sin, cos] = [Math.sin(yaw), Math.cos(yaw)]
      const step = speed * dt * len
      const next = at.clone()
      next.x += (-sin * forward + cos * right) * step
      next.z += (-cos * forward - sin * right) * step
      if (fly) {
        const ground = groundAt(next.x, next.z) + EYE
        next.y += up * Math.max(speed, 6) * dt
        if (next.y <= ground) {
          next.y = ground
          setFly(false)
        }
      } else collide(next)
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
      if (rise > 0 || air > 0) {
        rise -= GRAVITY * dt
        air += rise * dt
        if (air <= 0) air = rise = 0
        dirty = true
      }
    } else air = rise = 0
    if (Math.abs(aimYaw - yaw) > 1e-5 || Math.abs(aimPitch - pitch) > 1e-5) {
      const k = 1 - Math.exp(-dt * LOOK_EASE)
      yaw += (aimYaw - yaw) * k
      pitch += (aimPitch - pitch) * k
      dirty = true
    }
    // In the air the near plane steps out with the height: depth precision kept for the streets far below.
    const near = fly ? THREE.MathUtils.clamp(at.y * 0.012, NEAR, 4) : NEAR
    if (Math.abs(near - camera.near) > 0.02 || (near === NEAR && camera.near !== NEAR)) {
      camera.near = near
      camera.updateProjectionMatrix()
    }
    camera.position.copy(at)
    camera.position.y += air
    camera.rotation.set(pitch, yaw, 0, 'YXZ')
    const changed = dirty
    dirty = false
    return changed
  }

  return { camera, update, flying: () => fly, pad }
}
