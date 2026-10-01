import * as THREE from 'three/webgpu'
import { color, float, Fn, If, positionWorld, smoothstep, texture, uniform, vec3 } from 'three/tsl'

/**
 * The city's own light after dark: how far its lights are on (`lightsOn`, 0 by day, 1 at night, set from the time of
 * day), and the pools of light the street lights lay round them. Hundreds of lights are too many for the renderer's
 * lights, so their pools are drawn into a map of the ground round the walker (`lampPools`), 2 m a cell, and the ground
 * and the walls look their light up there: lit as they would be by a lamp 9 m up, without a light in the scene.
 */

/** 0 to 1: the windows lit one after another as it gets dark, the street lights coming on at dusk. */
export const lightsOn = uniform(0)
/** The street lights' LEDs: a warm white, about 3000 K. */
export const LAMP = new THREE.Color().setRGB(1, 0.74, 0.48)

/** Cells of the pools' map each way, and metres a cell: 1 km round the walker, fine enough for pools 40 m across. */
const CELLS = 512
const CELL = 2
const SPAN = CELLS * CELL
/** The light's height over the street (the cobra head on its arm), metres, and how far round its foot its pool reaches. */
const HEAD = 8.8
const REACH = 22
/** The arm's reach out over the road from the pole (planting.ts's cobra head). */
const ARM = 2.35

const pools = new Float32Array(CELLS * CELLS)
const packed = new Uint16Array(CELLS * CELLS)
const map = new THREE.DataTexture(packed, CELLS, CELLS, THREE.RedFormat, THREE.HalfFloatType)
map.minFilter = map.magFilter = THREE.LinearFilter
const centre = uniform(new THREE.Vector2(0, 0))
const node = texture(map)

/** The share of a pool at each distance from its foot, by the quarter metre: the light falling off as cos θ / r² from 9 m up. */
const falloff = Array.from({ length: REACH * 4 + 1 }, (_, i) => {
  const d = i / 4
  return (HEAD ** 3 / (d * d + HEAD * HEAD) ** 1.5) * THREE.MathUtils.smoothstep(REACH - d, 0, REACH * 0.45)
})

/** The map's south-west corner, metres, and the rows changed since it was last sent to the GPU. */
let [x0, z0] = [0, 0]
let [rowFrom, rowTo] = [CELLS, -1]

/**
 * The street lights' pools round the walker, kept as they walk: `reset` centres the map on (cx, cz) with nothing in
 * it, `add` draws the pools of more lights into it (pools add up, so a tile's lights come in on their own as its data
 * does), and `flush` sends what changed to the GPU. A pool is drawn under its light's head, out over the road.
 */
export const lampPools = {
  reset(cx: number, cz: number) {
    pools.fill(0)
    x0 = Math.round(cx / CELL) * CELL - SPAN / 2
    z0 = Math.round(cz / CELL) * CELL - SPAN / 2
    ;[rowFrom, rowTo] = [0, CELLS - 1]
  },
  /** Draws the pools of `lamps` ([x, z, turn]: their poles' feet and their arms' bearings, as the data has them). */
  add(lamps: Iterable<[number, number, number]>) {
    const reach = REACH / CELL
    for (const [x, z, turn] of lamps) {
      // The arm runs along the light's +x turned by `turn` about y: (cos, 0, −sin). In cells from the corner:
      const hx = (x + Math.cos(turn) * ARM - x0) / CELL
      const hz = (z - Math.sin(turn) * ARM - z0) / CELL
      if (hx < -reach || hz < -reach || hx > CELLS + reach || hz > CELLS + reach) continue
      const i0 = Math.max(0, Math.floor(hx - reach))
      const i1 = Math.min(CELLS - 1, Math.ceil(hx + reach))
      const j0 = Math.max(0, Math.floor(hz - reach))
      const j1 = Math.min(CELLS - 1, Math.ceil(hz + reach))
      for (let j = j0; j <= j1; j++) {
        const dz = (j + 0.5 - hz) * CELL
        for (let i = i0; i <= i1; i++) {
          const dx = (i + 0.5 - hx) * CELL
          const d = Math.sqrt(dx * dx + dz * dz)
          if (d < REACH) pools[j * CELLS + i] += falloff[Math.round(d * 4)]
        }
      }
      rowFrom = Math.min(rowFrom, j0)
      rowTo = Math.max(rowTo, j1)
    }
  },
  /** Packs the changed rows into half floats and has the map sent again. */
  flush() {
    if (rowTo < rowFrom) return
    for (let i = rowFrom * CELLS; i < (rowTo + 1) * CELLS; i++) packed[i] = pools[i] ? THREE.DataUtils.toHalfFloat(Math.min(pools[i], 60000)) : 0
    ;[rowFrom, rowTo] = [CELLS, -1]
    map.needsUpdate = true
    centre.value.set(x0 + SPAN / 2, z0 + SPAN / 2)
  },
}

/**
 * The street lights' light on a surface at the point shaded (as radiance per unit of its colour, to multiply its
 * albedo by and add to its emission): the pools from the map, less of it up a wall as it rises past the heads.
 */
export function lampLight(strength = 1) {
  const p = positionWorld
  const uv = p.xz.sub(centre).div(SPAN).add(0.5)
  const edge = uv.sub(0.5).abs()
  const inside = smoothstep(0.5, 0.42, edge.x.max(edge.y))
  const height = smoothstep(HEAD + 7, 1, p.y).mul(0.85).add(0.15)
  const pool = node.sample(uv.clamp(0, 1)).r
  return color(LAMP).mul(pool.mul(inside).mul(height).mul(lightsOn.mul(lightsOn)).mul(strength)) as unknown as THREE.Node<'vec3'>
}

/**
 * `light` only once the city's lights are on, and nothing otherwise: by day the GPU skips it (the branch is on a
 * uniform, the same for every pixel), so the night costs a frame nothing until it falls. What `light` shares with the
 * rest of its material (its position, its window's cell) is built before the branch, by the material's colour.
 */
export const afterDark = (light: THREE.Node<'vec3'>) =>
  Fn(() => {
    const out = vec3(0, 0, 0).toVar()
    If(lightsOn.greaterThan(0), () => {
      out.assign(light)
    })
    return out
  })() as unknown as THREE.Node<'vec3'>

/** Sets `material`'s emission to take the street lights' pools on its colour (`albedo`, its colour node or its colour). */
export function litByLamps(material: THREE.MeshStandardNodeMaterial, albedo?: THREE.Node<'vec3'>, strength = 1) {
  const base = albedo ?? (material.colorNode as THREE.Node<'vec3'> | null) ?? vec3(material.color.r, material.color.g, material.color.b)
  const lit = afterDark(base.mul(lampLight(strength)))
  material.emissiveNode = material.emissiveNode ? (material.emissiveNode as THREE.Node<'vec3'>).add(lit) : lit
  return material
}

/** For the lamps' own glow: their heads alight, bright enough to bloom. */
export const lampGlow = () => color(LAMP).mul(lightsOn.mul(float(14)))
