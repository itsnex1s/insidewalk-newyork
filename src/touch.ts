import type { Pad } from './walk'

/**
 * Controls for a touch screen, as a phone game has them. The left thumb walks: a stick appears where it lands, its
 * knob pushed as far as the thumb goes (the further, the faster), and a thumb pushed on past the rim runs. The right
 * thumb looks: dragged right the view turns right, up it looks up. Buttons by the right thumb jump, take off and land,
 * and in the air rise and come down while held. A line on the first visit says how, gone once both thumbs have moved.
 */

/** The stick's reach, CSS pixels: the knob's way from the middle to the rim. */
const RIM = 52
/** How far past the rim a thumb goes to run, as a share of the rim. */
const RUN = 1.3
/** Pixels of drag to the turn's unit (walk.ts turns 0.0022 rad a unit): about a quarter of a degree a pixel. */
const LOOK = 1.9

export const touchOnly = () => matchMedia('(hover: none) and (pointer: coarse)').matches

export function touchControls(canvas: HTMLCanvasElement, pad: Pad) {
  document.body.classList.add('touch')
  const stick = document.getElementById('stick')!
  const knob = stick.querySelector<HTMLElement>('.knob')!
  const coach = document.getElementById('coach')!
  const held = { stick: -1, look: -1 }
  const from = { x: 0, y: 0 }
  const looked = { x: 0, y: 0 }
  const learnt = { walk: false, look: false }
  const learn = (what: 'walk' | 'look') => {
    learnt[what] = true
    if (learnt.walk && learnt.look) coach.classList.add('gone')
  }

  /** The stick at rest: where a left thumb usually lands, faint. */
  const rest = () => {
    stick.classList.remove('held', 'run')
    stick.style.removeProperty('left')
    stick.style.removeProperty('top')
    knob.style.transform = ''
    Object.assign(pad, { forward: 0, right: 0, run: false })
  }

  // A touch stays with the element it came down on (implicit capture): the stick's thumb keeps the stick wherever it goes.
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return
    // The left part of the screen, and a little more on a phone held upright: the stick; the rest looks.
    if (e.clientX < innerWidth * (innerWidth < innerHeight ? 0.5 : 0.42) && held.stick < 0) {
      held.stick = e.pointerId
      Object.assign(from, { x: e.clientX, y: e.clientY })
      stick.classList.add('held')
      stick.style.left = `${e.clientX}px`
      stick.style.top = `${e.clientY}px`
    } else if (held.look < 0) {
      held.look = e.pointerId
      Object.assign(looked, { x: e.clientX, y: e.clientY })
    }
  })
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId === held.stick) {
      const [dx, dy] = [e.clientX - from.x, e.clientY - from.y]
      const d = Math.hypot(dx, dy)
      const k = Math.min(1, RIM / (d || 1))
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`
      // A small dead zone, so a resting thumb does not creep.
      const share = d < 6 ? 0 : Math.min(1, d / RIM)
      Object.assign(pad, { forward: (-dy / (d || 1)) * share, right: (dx / (d || 1)) * share, run: d > RIM * RUN })
      stick.classList.toggle('run', pad.run)
      if (share) learn('walk')
    }
    if (e.pointerId === held.look) {
      pad.turn((e.clientX - looked.x) * LOOK, (e.clientY - looked.y) * LOOK)
      Object.assign(looked, { x: e.clientX, y: e.clientY })
      learn('look')
    }
  })
  const lift = (e: PointerEvent) => {
    if (e.pointerId === held.stick) {
      held.stick = -1
      rest()
    }
    if (e.pointerId === held.look) held.look = -1
  }
  canvas.addEventListener('pointerup', lift)
  canvas.addEventListener('pointercancel', lift)

  // The buttons: pressed on touch down, not on release, as a game's are; up and down while held.
  const button = (id: string, down: () => void, up?: () => void) => {
    const el = document.getElementById(id)!
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      el.classList.add('down')
      down()
    })
    const release = () => {
      el.classList.remove('down')
      up?.()
    }
    el.addEventListener('pointerup', release)
    el.addEventListener('pointercancel', release)
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  button('jump', () => pad.jump())
  button('fly', () => pad.fly())
  button('rise', () => (pad.up = 1), () => (pad.up = 0))
  button('sink', () => (pad.up = -1), () => (pad.up = 0))
  pad.onFly = (flying) => {
    document.body.classList.toggle('flying', flying)
    if (!flying) pad.up = 0
  }
  // The coach goes on its own after a while too.
  setTimeout(() => coach.classList.add('gone'), 9000)
  rest()
}
