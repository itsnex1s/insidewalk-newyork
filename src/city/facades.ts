import * as THREE from 'three/webgpu'
import { attribute, bumpMap, color, float, floor, fract, hash, mix, mx_noise_float, positionWorld, select, smoothstep, sqrt, step, vec3 } from 'three/tsl'
import { above, either, footprint, stripe } from '../engine/filter'
import { afterDark, lightsOn, litByLamps } from '../engine/night'
import { memo } from '../engine/util'
import type { Reflections } from '../engine/reflections'
import type { Style } from './styles'

/**
 * The walls' materials, drawn from the attributes buildings.ts lays on each edge (no textures: nothing loads and
 * nothing repeats), every line filtered over the pixel (engine/filter.ts) so it stays straight up close and fades to
 * its average down the street.
 *   wall    u metres along the edge, its length, its bay width (0: no windows), 1 on a street front
 *   storey  shop floor height, storey height, a seed in 0..1 (+2 for arched heads), the top of the windows
 *   paint, trim, back   the front's colour, the frames' and lintels', the back walls' brick
 * A front has a shop floor of storefronts between piers under a sign band, and storeys of windows above in its style;
 * a back or party wall is brick, blank or with a few small windows. After dark the windows light one by one as the
 * city's lights come on (night.ts's lightsOn), most of the shops, and the street lights' pools light the walls' feet.
 */

type F = THREE.Node<'float'>

/** The city's reflections, which the glass looks up: set (setReflections) before the first facade is built. */
let reflections: Reflections | null = null
export const setReflections = (r: Reflections) => {
  reflections = r
}
type V = THREE.Node<'vec3'>

const wall = attribute('wall', 'vec4') as unknown as THREE.Node<'vec4'>
const storey = attribute('storey', 'vec4') as unknown as THREE.Node<'vec4'>
const paint = attribute('paint', 'vec3') as unknown as V
const trim = attribute('trim', 'vec3') as unknown as V
const backBrick = attribute('back', 'vec3') as unknown as V

const u = wall.x
const len = wall.y
const bay = wall.z
const street = wall.w
const ground = storey.x
const floorH = storey.y
const seed = fract(storey.z)
const arched = step(1.5, storey.z)
const top = storey.w
const y = positionWorld.y

/** 1 within [a, b] on x, filtered. */
const rect = (x: F, a: F | number, b: F | number) => above(x.sub(a)).mul(above((typeof b === 'number' ? float(b) : b).sub(x)))
/** 1 within w/2 of 0 on x. */
const bar = (x: F, w: number) => rect(x, -w / 2, w / 2)
const h1 = (k: F) => hash(k.add(seed.mul(7919)).add(len.mul(13.7)).add(2 ** 20))

/** Which bay and where across it, metres from its middle; which storey and how high in it. */
const bayIndex = floor(u.div(bay.max(0.01)))
const lx = fract(u.div(bay.max(0.01))).sub(0.5).mul(bay)
const level = y.sub(ground).div(floorH)
const floorIndex = floor(level)
const ly = fract(level).mul(floorH)
const hasBays = step(0.01, bay)
const upper = above(y.sub(ground)).mul(above(top.sub(y))).mul(hasBays)
const shop = above(ground.sub(y)).mul(hasBays)
const cell = h1(bayIndex.add(floorIndex.mul(131)))
const cell2 = h1(bayIndex.mul(17).add(floorIndex.mul(57)).add(5))

/** Grime: darker toward the pavement and in streaks down from the top. */
const grime = float(1).sub(smoothstep(1.2, 0, y).mul(0.18)).sub(smoothstep(0.55, 0.9, mx_noise_float(vec3(u.mul(0.6), y.mul(0.05), seed.mul(40)))).mul(0.08))

/** Common brick in running bond: 8 by 2¼ inch faces in lighter mortar, each brick a shade of its own. */
function brick(tone: V) {
  const row = y.div(0.0762)
  const col = u.div(0.2032).add(floor(row).mul(0.5))
  const face = stripe(row, 0.14, 1).mul(stripe(col, 0.05, 1))
  const shade = hash(floor(row).mul(7.1).add(floor(col).mul(131.3)).add(2 ** 20)).mul(0.28).add(0.86)
  return { color: mix(color(0xb3ab9e), tone.mul(shade), face), relief: face.mul(0.004) }
}

/** Dressed stone in courses 60 cm high, blocks 1.2 m long, fine dark joints. */
function stone(tone: V) {
  const row = y.div(0.6)
  const col = u.div(1.2).add(floor(row).mul(0.5))
  const face = stripe(row, 0.025, 1).mul(stripe(col, 0.012, 1))
  const shade = hash(floor(row).mul(3.3).add(floor(col).mul(71.7)).add(2 ** 20)).mul(0.08).add(0.96)
  return { color: tone.mul(mix(float(0.62), shade, face)), relief: face.mul(0.006) }
}

/**
 * Glass behind a window: dark, here and there a blind drawn part way, a curtain or a room's warm brown, varied window
 * by window; `bright` lifts it for a lit shop.
 */
function glass(k: F, k2: F, sill: F | number, head: F, bright = 0) {
  const room = mix(color(0x1b2125), color(0x39434a), k.mul(0.7))
  const warm = mix(room, color(0x4d3f33), step(0.78, k2))
  const drop = float(head).sub(float(head).sub(sill).mul(k2.mul(0.8).add(0.1)))
  const blind = above(ly.sub(drop)).mul(step(0.62, k)).mul(1 - bright)
  const inside = mix(warm, color(0xd8d0bf), blind)
  return { color: bright ? mix(inside, color(0x7a6d5f), k2.mul(bright)) : inside, blind }
}

/**
 * A room's light seen through its window after dark, once `share` of the windows are lit: most a lamp's warm light,
 * some a cool white, each its own brightness, brighter towards the ceiling (from `sill` to `head`); a drawn blind glows.
 */
function roomLight(k: F, share: F, sill: F | number, head: F, blind: F | number) {
  const on = step(k, share)
  const tone = mix(color(0xffa95e), color(0xc9dcff), step(0.86, hash(k.mul(97.1).add(2 ** 20))))
  const level = hash(k.mul(311.7).add(2 ** 20)).mul(0.7).add(0.45)
  const ceiling = smoothstep(typeof sill === 'number' ? float(sill) : sill, head, ly).mul(0.6).add(0.55)
  return tone.mul(level).mul(ceiling).mul(mix(float(1), float(1.5), blind)).mul(on)
}

/** How many windows are lit, all told, when the city's lights are full on. */
const LIT = 0.42
/** A lit window's light, as radiance: a room's lamp seen from the street. */
const ROOM = 0.32
/** How much of the street lights' pools the walls take: they light the pavement under them, the walls only in passing. */
const WALLS = 0.3

/** A window between piers, `halfW` either side of the bay's middle, from `sill` up to its head (arched where the building's are). */
function window_(halfW: F, sill: number, headDrop: number, frameW: number, sash: boolean) {
  const flatHead = floorH.sub(headDrop)
  const t = lx.div(halfW).clamp(-1, 1)
  const head = flatHead.sub(arched.mul(float(1).sub(sqrt(float(1).sub(t.mul(t)))).mul(0.45)))
  const opening = rect(lx, halfW.negate(), halfW).mul(rect(ly, sill, head))
  const pane = rect(lx, halfW.negate().add(frameW), halfW.sub(frameW)).mul(rect(ly, sill + frameW, head.sub(frameW)))
  const mid = float(sill).add(head).mul(0.5)
  const bars = sash ? either(bar(lx, 0.045), bar(ly.sub(mid), 0.06)) : float(0)
  const g = glass(cell, cell2, sill, head)
  // The reveal: the head and one jamb in shadow, as the window sits back in the wall.
  const reveal = float(1).sub(above(ly.sub(head.sub(0.14))).mul(0.45)).sub(above(lx.sub(halfW.sub(0.1))).mul(0.25))
  const glassy = pane.mul(float(1).sub(bars))
  const lit = roomLight(h1(bayIndex.mul(29).add(floorIndex.mul(7)).add(3)), lightsOn.mul(LIT), sill, head, g.blind)
  return { opening, glassy, glassColor: g.color.mul(reveal), blind: g.blind, head, lit: lit.mul(glassy) }
}

/**
 * The shop floor: plate glass on a low bulkhead between slim piers, a transom of small panes over it, a sign band
 * under the cornice, a glazed door in some bays.
 */
function storefront(pier: V) {
  const halfS = bay.mul(0.5).sub(0.28)
  const display = ground.mul(0.68)
  const transomTop = ground.sub(0.8)
  const door = step(h1(bayIndex.add(911)), 0.38).mul(rect(lx, -0.6, 0.6))
  const bulk = mix(float(0.55), float(0.04), door)
  const frame = rect(lx, halfS.negate(), halfS).mul(rect(y, 0, transomTop))
  const pane = rect(lx, halfS.negate().add(0.07), halfS.sub(0.07)).mul(rect(y, bulk, transomTop.sub(0.06)))
  const transomBars = either(bar(y.sub(display), 0.1), bar(fract(lx.div(0.62)).sub(0.5), 0.04).mul(above(y.sub(display))))
  const doorFrame = rect(lx, -0.66, 0.66).mul(float(1).sub(rect(lx, -0.56, 0.56))).mul(step(h1(bayIndex.add(911)), 0.38)).mul(above(display.sub(y)))
  const glassy = pane.mul(float(1).sub(transomBars)).mul(float(1).sub(doorFrame))
  // A shop seen through its window: brighter low down where the displays are, darker to the ceiling, lit in most.
  const k = h1(bayIndex.add(77))
  const depth = smoothstep(transomTop, float(0.8), y).mul(0.5).add(0.5)
  // Shelves and racks in rows, goods on them in patches, a lit shop's back wall pale: each shop its own.
  const shelves = stripe(y.div(0.55).add(k.mul(3)), 0, 0.18).mul(step(0.45, k))
  const goods = mx_noise_float(vec3(u.mul(2.3), y.mul(1.7), k.mul(50))).mul(0.5).add(0.5)
  const wallTone = mix(color(0x4a423b), color(0xc9bba6), k)
  const interior = mix(wallTone, wallTone.mul(goods.mul(0.9).add(0.3)), above(float(2.4).sub(y)).mul(0.7)).mul(float(1).sub(shelves.mul(0.45))).mul(depth)
  const g = { color: interior }
  const signs = [0x1d1f20, 0x23392c, 0x5b1f1c, 0x1e2a44, 0xe8e4da, 0x3a2d24]
  const pickSign = h1(bayIndex.mul(0).add(301))
  let sign = color(signs[0]) as unknown as V
  signs.forEach((c, i) => {
    sign = select(pickSign.greaterThan(i / signs.length), color(c) as unknown as V, sign) as unknown as V
  })
  const band = rect(y, transomTop, ground.sub(0.15))
  const frameColor = mix(color(0x1c1f21), trim, step(0.5, h1(bayIndex.mul(0).add(55))))
  let c: V = mix(pier, frameColor, frame)
  c = mix(c, g.color, glassy)
  c = mix(c, sign, band)
  // After dark most shops are lit, in a warm light; by day a lit shop shows against the street's light.
  const night = interior.mul(color(0xffcf9a)).mul(glassy).mul(step(0.18, k)).mul(lightsOn.mul(0.14))
  const day = interior.mul(glassy).mul(step(0.3, k)).mul(lightsOn.mul(-0.8).add(1).mul(0.22))
  return { color: c, glassy, relief: glassy.mul(-0.04), lit: day.add(afterDark(night)) }
}

/** A back or party wall: brick, painted over or patched grey here and there, a few small windows on some. */
function backWall() {
  const painted = step(0.8, h1(float(3)))
  const tone = mix(backBrick, color(0x8f8b84), painted)
  const b = brick(tone)
  const windows = step(0.55, h1(float(9))).mul(step(8, len))
  const wx = fract(u.div(2.4)).sub(0.5).mul(2.4)
  const wy = fract(y.div(3.2)).mul(3.2)
  const opening = rect(wx, -0.42, 0.42).mul(rect(wy, 0.9, 2.3)).mul(windows).mul(above(y.sub(3))).mul(above(top.sub(y)))
  const c = mix(mix(b.color, tone, painted.mul(0.8)), color(0x22282c), opening)
  const room = h1(floor(u.div(2.4)).mul(3).add(floor(y.div(3.2)).mul(17)).add(41))
  const lit = roomLight(room, lightsOn.mul(LIT * 0.7), 0.9, float(2.3), 0).mul(opening)
  return { color: c, glassy: opening, relief: b.relief.sub(opening.mul(0.05)), lit }
}

/** The upper storeys of a front in `style`. */
function upperFront(style: Style) {
  if (style === 'modern') {
    const level2 = y.sub(ground).div(floorH)
    const panel = u.div(bay.max(0.01))
    const solid = either(stripe(level2, 0, 0.28), stripe(panel, 0, 0.05))
    const pane = mix(color(0x2c3a44), color(0x52636e), cell.mul(0.5))
    // Offices and flats behind the curtain wall: a cool white, a pane here and there warm.
    const lit = roomLight(h1(floor(panel).mul(13).add(floor(level2).mul(71)).add(5)), lightsOn.mul(LIT), 0, floorH, 0)
    return { color: mix(pane, paint, solid), glassy: float(1).sub(solid), relief: solid.mul(0.03), lit: lit.mul(float(1).sub(solid)) }
  }
  const wallFace = style === 'brick' ? brick(paint) : style === 'stone' ? stone(paint) : { color: paint, relief: float(0) }
  const halfW = style === 'iron' ? bay.mul(0.5).sub(0.4) : style === 'stone' ? bay.mul(0.5).sub(0.55) : bay.mul(0.5).sub(0.52).min(0.5)
  const w = style === 'iron' ? window_(halfW, 0.7, 0.62, 0.09, true) : style === 'stone' ? window_(halfW, 0.85, 0.75, 0.08, true) : window_(halfW, 0.85, 0.7, 0.06, true)
  let c: V = wallFace.color
  if (style === 'iron') {
    // Cast-iron columns between the windows, rounded by their shading, and an entablature at each floor with its shadow line.
    const pier = bay.mul(0.5).sub(lx.abs()).div(bay.mul(0.5).sub(halfW).max(0.05)).clamp(0, 1)
    const round = float(1).sub(float(1).sub(pier.mul(2).sub(1).abs()).mul(-0.12).add(0.12))
    const band = rect(ly, floorH.sub(0.42), floorH).mul(0.08).add(1)
    const shadow = float(1).sub(rect(ly, floorH.sub(0.5), floorH.sub(0.42)).mul(0.35))
    c = paint.mul(round).mul(band).mul(shadow)
  } else {
    // A lintel over each window and a sill under it, in the trim's stone or paint.
    const lintel = rect(lx, halfW.negate().sub(0.1), halfW.add(0.1)).mul(rect(ly, w.head, w.head.add(0.22)))
    const sill = rect(lx, halfW.negate().sub(0.08), halfW.add(0.08)).mul(rect(ly, 0.75, 0.85))
    c = mix(c, trim, either(lintel, sill).mul(style === 'stone' ? 0.6 : 1))
    c = c.mul(float(1).sub(rect(lx, halfW.negate().sub(0.1), halfW.add(0.1)).mul(rect(ly, 0.68, 0.75)).mul(0.4)))
  }
  const frameColor = style === 'iron' ? mix(paint.mul(0.8), color(0x1e2021), step(0.5, seed)) : trim
  c = mix(c, frameColor, w.opening)
  // A window unit in some walk-up windows.
  const unit = style === 'brick' ? step(0.9, cell2).mul(rect(lx, -0.3, 0.3)).mul(rect(ly, 0.95, 1.35)) : float(0)
  c = mix(c, w.glassColor, w.glassy)
  c = mix(c, color(0x9a9a96), unit)
  return { color: c, glassy: w.glassy.mul(float(1).sub(w.blind)).mul(float(1).sub(unit)), relief: wallFace.relief.sub(w.opening.mul(0.06)), lit: w.lit.mul(float(1).sub(unit)) }
}

export const facade = memo(function facade(style: Style) {
  const m = new THREE.MeshStandardNodeMaterial()
  const pier = style === 'brick' ? brick(paint).color : style === 'stone' ? stone(paint).color : paint
  const up = upperFront(style)
  const sf = storefront(pier)
  const back = backWall()
  // Above the windows the cornice zone in the front's own face.
  const plain = style === 'brick' ? brick(paint) : style === 'stone' ? stone(paint) : { color: paint, relief: float(0) }
  const frontColor = mix(mix(plain.color, up.color, upper), sf.color, shop)
  const frontGlass = up.glassy.mul(upper).add(sf.glassy.mul(shop))
  const frontRelief = mix(mix(plain.relief, up.relief, upper), sf.relief, shop)
  const isFront = street
  const c = mix(back.color, select(hasBays.greaterThan(0.5), frontColor, plain.color) as unknown as V, isFront)
  const glassy = mix(back.glassy, frontGlass, isFront)
  // The city in the glass (engine/reflections.ts): its share by Fresnel off the glass's own colour and onto its light.
  // A shop window shows more of the shop, a pane above more of the street; each pane a touch off true, as old glass is.
  const strength = glassy.mul(mix(float(1), float(0.55), shop.mul(isFront)))
  const r = reflections?.reflection(cell.mul(0.05).add(0.03))
  const mirrored = r ? r.fresnel.mul(strength) : float(0)
  m.colorNode = c.mul(grime).mul(float(1).sub(mirrored))
  m.roughnessNode = mix(float(style === 'iron' ? 0.55 : 0.85), mix(float(0.06), float(0.16), shop), glassy)
  // With the city reflected, the glass takes less of the sky from the environment (it would show the sky twice).
  m.metalnessNode = mix(float(0), mix(float(r ? 0.2 : 0.55), float(0.04), shop.mul(isFront)), glassy)
  const rooms = afterDark(mix(back.lit, up.lit.mul(upper).mul(hasBays), isFront).mul(ROOM))
  m.emissiveNode = (r ? sf.lit.mul(shop).mul(isFront).add(r.color.mul(mirrored)) : sf.lit.mul(shop).mul(isFront)).add(rooms)
  m.normalNode = bumpMap(mix(back.relief, frontRelief, isFront), float(1))
  return litByLamps(m, undefined, WALLS)
})

/** Tar and gravel roofs, a shade apart building by building. */
export const roof = memo(function roof() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 })
  // Building by building (the storey seed) a dark tar, a gravel or a silver coating; stained and patched across each.
  const k = seed
  const base = mix(mix(color(0x3e3c39), color(0x6f6b64), step(0.45, k)), color(0x9c9c98), step(0.8, k))
  const n = mx_noise_float(positionWorld.xz.div(2.5)).mul(0.5).add(0.5)
  m.colorNode = base.mul(n.mul(0.18).add(0.9)).mul(mx_noise_float(positionWorld.xz.mul(4)).mul(0.06).add(0.97))
  return m
})

/** Cornices and shop cornices: the front's paint (vertex colour), a little weathered. */
export const trimMaterial = memo(function trimMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.7 })
  m.colorNode = (attribute('paint', 'vec3') as unknown as V).mul(mx_noise_float(positionWorld.mul(0.8)).mul(0.06).add(0.95))
  return litByLamps(m, undefined, WALLS)
})

/** Fire escapes: black painted iron, and the railings' bars cut out of thin panels. */
export const escapeMaterials = memo(function escapeMaterials() {
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x1d1e1f, roughness: 0.6, metalness: 0.3 })
  const rails = new THREE.MeshStandardNodeMaterial({ color: 0x1d1e1f, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide, alphaTest: 0.5 })
  const along = positionWorld.x.add(positionWorld.z)
  rails.opacityNode = step(fract(along.div(0.11)), 0.22)
  return [metal, rails] as const
})

/**
 * The far field's walls, kilometres of them a few pixels a storey: the front's paint or the back's brick, and a grid of
 * windows by storey and bay, filtered to its average where a pixel spans several. One cheap shader for every style.
 */
export const farFacade = memo(function farFacade() {
  const m = new THREE.MeshStandardNodeMaterial()
  const span = mix(float(2.6), bay, hasBays)
  const across = stripe(u.div(span.max(0.5)), 0.22, 0.78)
  const up = stripe(y.sub(ground).div(floorH), 0.25, 0.8).mul(above(y.sub(ground))).mul(above(top.sub(y)))
  const windows = across.mul(up).mul(mix(float(0.35), float(1), street))
  const tone = mix(backBrick, paint, street)
  const pane = mix(color(0x252c32), color(0x46525b), cell.mul(0.6))
  m.colorNode = mix(tone, pane, windows).mul(grime)
  m.roughnessNode = mix(float(0.85), float(0.15), windows)
  m.metalnessNode = mix(float(0), float(0.4), windows)
  // Lit windows window by window up close; where a pixel spans a few, their average, which does not shimmer.
  const share = lightsOn.mul(LIT)
  const room = h1(floor(u.div(span.max(0.5))).mul(29).add(floor(y.sub(ground).div(floorH)).mul(7)).add(3))
  const one = smoothstep(0.7, 0.3, footprint(u.div(span.max(0.5))).max(footprint(y.div(floorH))))
  const lit = mix(share.mul(0.75), step(room, share).mul(hash(room.mul(311.7).add(2 ** 20)).mul(0.7).add(0.45)), one)
  m.emissiveNode = afterDark(color(0xffb06a).mul(lit).mul(windows).mul(ROOM))
  return litByLamps(m, undefined, WALLS)
})
