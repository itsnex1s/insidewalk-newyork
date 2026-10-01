import type * as THREE from 'three/webgpu'
import { dFdx, dFdy, float, floor, fract, hash, length, vec2 } from 'three/tsl'

/**
 * Patterns drawn from world position (window grids, slab edges, mullions, lattices) filtered over each pixel. A hard
 * `step()` is sampled once per pixel, and multisampling does not help, since it only smooths the edges of triangles:
 * lines a few centimetres wide come out a pixel or none, and break up into stairs, dashes and moiré as the camera moves.
 * Box-filtered, each pixel takes the share of it the stripe covers: edges are straight and smooth at any distance, and
 * where a pixel spans several windows the pattern fades to its average by itself.
 */

type Float = THREE.Node<'float'>
type Value = Float | number

const node = (v: Value) => (typeof v === 'number' ? float(v) : v)

/** How much `x` changes across one pixel: the width of the filter over it. */
export const footprint = (x: Float) => length(vec2(dFdx(x), dFdy(x))).max(1e-4)

/** The integral from 0 to `x` of the periodic stripe on which fract lies in [a, b]. */
const ramp = (x: Float, a: Float, b: Float) => floor(x).mul(b.sub(a)).add(fract(x).clamp(a, b).sub(a))

/**
 * The share of the pixel at which fract(x) lies in [a, b] (0 ≤ a ≤ b ≤ 1): 1 inside the stripe, 0 outside, a pixel's
 * width of ramp at each edge, and b − a where a pixel spans a period or more.
 */
export function stripe(x: Float, a: Value, b: Value) {
  const w = footprint(x)
  // From the period's start: the integral's values stay small, so their difference keeps its precision far from the origin.
  const f = fract(x)
  const [lo, hi] = [node(a), node(b)]
  return ramp(f.add(w.mul(0.5)), lo, hi).sub(ramp(f.sub(w.mul(0.5)), lo, hi)).div(w)
}

/** The share of the pixel at which `x` is above 0: step(0, x), filtered. */
export const above = (x: Float) => x.div(footprint(x)).add(0.5).clamp(0, 1)

/** The share of the pixel on either of two patterns laid across each other (a floor's band and a panel's mullion): each one's share, less what they share. */
export const either = (a: Float, b: Float) => a.add(b).sub(a.mul(b))

/**
 * A hash in [0, 1) of a seed made from world cells, which may be negative: TSL's hash takes its seed as an unsigned
 * integer, and every negative seed converts to the same 0 (one colour for every container west of the origin).
 */
export const cellHash = (seed: Float) => hash(seed.add(2 ** 20))
