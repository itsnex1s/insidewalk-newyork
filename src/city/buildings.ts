import * as THREE from 'three/webgpu'
import { type BuildingData, inPolygon } from './data'
import { escapeMaterials, facade, farFacade, roof, trimMaterial } from './facades'
import { Builder, rgb } from './mesh'
import { tanks } from './roofs'
import { type Dress, dress, type Style } from './styles'

/** A wall's foot on the plan, for the walker to bump into: from (x0, z0) to (x1, z1). */
export type Segment = [number, number, number, number]

const WALL = { wall: 4, storey: 4, paint: 3, trim: 3, back: 3 }
const UP = new THREE.Vector3(0, 1, 0)

/**
 * A tile's buildings: walls drawn by their style's material (facades.ts) from attributes laid on each edge, a flat roof,
 * and `near` a cornice along the street fronts, fire escapes on the walk-ups and water tanks on the roofs; far off, the
 * walls in one plainer material and nothing else. Walls that face a sidewalk or a street (marked by the data script)
 * are fronts, with shop floors and windows; the others are back and party walls in plain brick. The rings come wound so
 * that (dz, −dx) along an edge points out of the building (scripts/geo.mjs).
 */
export function buildings(list: BuildingData[], near: boolean) {
  const walls = new Map<Style | 'far', Builder>()
  const roofs = new Builder({ storey: 4 })
  const trims = new Builder({ paint: 3 })
  const escapes = { metal: new Builder(), rails: new Builder() }
  const segments: Segment[] = []
  const tankPlaces: { x: number; z: number; y: number; size: number }[] = []

  for (const b of list) {
    const d = dress(b, b.id)
    const kind = near ? d.style : 'far'
    const builder = walls.get(kind) ?? walls.set(kind, new Builder(WALL)).get(kind)!
    builder.set.storey = [d.ground, d.storey, ((b.id * 0.618034) % 1) + (d.arched ? 2 : 0), b.h - d.parapet]
    roofs.set.storey = builder.set.storey
    builder.set.paint = rgb(d.paint)
    builder.set.trim = rgb(d.trim)
    builder.set.back = rgb(d.back)
    trims.set.paint = rgb(d.style === 'iron' || d.style === 'stone' ? d.paint : d.trim)
    b.rings.forEach((ring, r) => {
      for (let i = 0; i < ring.length; i += 2) {
        const j = (i + 2) % ring.length
        const [ax, az, bx, bz] = [ring[i], ring[i + 1], ring[j], ring[j + 1]]
        const len = Math.hypot(bx - ax, bz - az)
        if (len < 0.05) continue
        if (near) segments.push([ax, az, bx, bz])
        const [nx, nz] = [(bz - az) / len, -(bx - ax) / len]
        const street = b.fronts[r]?.[i / 2] === '1' ? 1 : 0
        const bays = len < 1.6 ? 0 : Math.max(1, Math.round(len / d.bay))
        builder.set.wall = [0, len, bays ? len / bays : 0, street]
        wall(builder, ax, az, bx, bz, nx, nz, b.h, len)
        if (near && street && len > 1) {
          cornices(trims, d, b, ax, az, bx, bz, nx, nz, len)
          if (d.escapes && len > 7) fireEscape(escapes, d, b, ax, az, bx, bz, nx, nz, len)
        }
      }
    })
    roofOf(roofs, b)
    if (near && d.tank) {
      const spot = roofSpot(b)
      if (spot) tankPlaces.push({ ...spot, y: b.h, size: 0.85 + ((b.id * 0.37) % 0.4) })
    }
  }

  const group = new THREE.Group()
  for (const [kind, builder] of walls) group.add(builder.mesh(kind === 'far' ? farFacade() : facade(kind), near))
  group.add(roofs.mesh(roof(), near))
  if (!trims.empty) group.add(trims.mesh(trimMaterial()))
  const [metal, rails] = escapeMaterials()
  if (!escapes.metal.empty) group.add(escapes.metal.mesh(metal), escapes.rails.mesh(rails))
  if (tankPlaces.length) group.add(tanks(tankPlaces))
  return { group, segments }
}

/** One wall from a to b, `h` tall, facing (nx, nz): u runs 0 to `len` along it, for the material's bays. */
function wall(builder: Builder, ax: number, az: number, bx: number, bz: number, nx: number, nz: number, h: number, len: number) {
  const n = { x: nx, y: 0, z: nz }
  const corners = [{ x: ax, y: 0, z: az, u: 0 }, { x: bx, y: 0, z: bz, u: len }, { x: bx, y: h, z: bz, u: len }, { x: ax, y: h, z: az, u: 0 }]
  // Counter-clockwise from outside: a, b, b-top faces (b - a) × up = (-(bz - az), 0, bx - ax), along the outward normal or against it.
  const order = (bx - ax) * nz - (bz - az) * nx > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]
  for (const k of order) {
    builder.set.wall[0] = corners[k].u
    builder.vertex(corners[k], n)
  }
}

/** The roof: the outline at its height, triangulated with its light wells left open. */
function roofOf(builder: Builder, b: BuildingData) {
  const toVec = (ring: number[]) => Array.from({ length: ring.length / 2 }, (_, i) => new THREE.Vector2(ring[2 * i], ring[2 * i + 1]))
  const [outline, ...holes] = b.rings.map(toVec)
  const points = [outline, ...holes].flat()
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(outline, holes)) {
    const [p, q, r] = [points[i], points[j], points[k]]
    const up = (q.y - p.y) * (r.x - p.x) - (q.x - p.x) * (r.y - p.y) > 0
    const [a, c] = up ? [p, r] : [r, p]
    builder.triangle({ x: a.x, y: b.h, z: a.y }, { x: q.x, y: b.h, z: q.y }, { x: c.x, y: b.h, z: c.y }, UP)
  }
}

/** The crowning cornice and its frieze at the top of a street front, and the shop floor's cornice over the storefronts. */
function cornices(builder: Builder, d: Dress, b: BuildingData, ax: number, az: number, bx: number, bz: number, nx: number, nz: number, len: number) {
  const along = new THREE.Vector3((bx - ax) / len, 0, (bz - az) / len)
  const out = new THREE.Vector3(nx, 0, nz)
  const band = (y0: number, y1: number, depth: number, ext: number) => {
    const c = new THREE.Vector3((ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2).addScaledVector(out, depth / 2)
    builder.box(c, along.clone().multiplyScalar(len / 2 + ext), new THREE.Vector3(0, (y1 - y0) / 2, 0), out.clone().multiplyScalar(depth / 2))
  }
  if (d.cornice > 0) {
    band(b.h - 0.5, b.h, d.cornice, d.cornice)
    band(b.h - 0.95, b.h - 0.5, d.cornice * 0.35, d.cornice * 0.35)
    band(b.h - 1.1, b.h - 0.95, d.cornice * 0.55, d.cornice * 0.55)
  }
  if (b.h > d.ground + 2) band(d.ground - 0.15, d.ground + 0.35, d.style === 'modern' ? 0.12 : 0.32, 0)
}

/**
 * A fire escape on a walk-up's street front: at every storey above the shops a grated landing on brackets with its
 * railing, and a stair from each landing to the next, alternating ends; centred on the front, two bays wide.
 */
function fireEscape(e: { metal: Builder; rails: Builder }, d: Dress, b: BuildingData, ax: number, az: number, bx: number, bz: number, nx: number, nz: number, len: number) {
  const along = new THREE.Vector3((bx - ax) / len, 0, (bz - az) / len)
  const out = new THREE.Vector3(nx, 0, nz)
  const width = Math.min(len - 2, Math.max(3.6, d.bay * 2))
  const depth = 1.0
  const mid = new THREE.Vector3((ax + bx) / 2, 0, (az + bz) / 2)
  const top = b.h - d.parapet - 0.5
  const h = (v: number) => new THREE.Vector3(0, v, 0)
  let k = 0
  for (let y = d.ground + d.storey * 0.02; y + 1 < top; y += d.storey, k++) {
    const deck = mid.clone().setY(y).addScaledVector(out, depth / 2 + 0.05)
    e.metal.box(deck, along.clone().multiplyScalar(width / 2), h(0.03), out.clone().multiplyScalar(depth / 2))
    // The railing: a top rail on the three open sides, the bars between drawn by the rails' material on thin panels.
    const rail = (c: THREE.Vector3, a: THREE.Vector3, o: THREE.Vector3) => {
      e.metal.box(c.clone().setY(y + 0.95), a, h(0.025), o)
      e.rails.box(c.clone().setY(y + 0.48), a, h(0.45), o.clone().setLength(0.008))
    }
    rail(deck.clone().addScaledVector(out, depth / 2), along.clone().multiplyScalar(width / 2), out.clone().multiplyScalar(0.02))
    for (const s of [-1, 1]) rail(deck.clone().addScaledVector(along, (s * width) / 2), out.clone().multiplyScalar(depth / 2), along.clone().multiplyScalar(0.02))
    // A diagonal bracket under each end, from the wall up to the landing's outer edge.
    for (const s of [-0.85, 0.85]) {
      const strut = new THREE.Vector3().addScaledVector(out, depth * 0.85).add(h(0.6))
      const foot = mid.clone().setY(y - 0.62).addScaledVector(along, (s * width) / 2).addScaledVector(strut, 0.5)
      e.metal.box(foot, strut.clone().multiplyScalar(0.5), along.clone().multiplyScalar(0.02), strut.clone().cross(along).setLength(0.03))
    }
    // The stair up to the next landing, from one end to the other, inside the landing's depth.
    if (y + d.storey + 1 < top) {
      const s = k % 2 ? 1 : -1
      const from = mid.clone().setY(y).addScaledVector(along, s * (width / 2 - 0.4)).addScaledVector(out, depth * 0.7)
      const to = mid.clone().setY(y + d.storey).addScaledVector(along, -s * (width / 2 - 1.6)).addScaledVector(out, depth * 0.7)
      const run = to.clone().sub(from)
      const centre = from.clone().add(to).multiplyScalar(0.5)
      const side = out.clone().multiplyScalar(0.28)
      for (const o of [-1, 1]) e.metal.box(centre.clone().addScaledVector(side, o), run.clone().multiplyScalar(0.5), h(0.08), out.clone().multiplyScalar(0.015))
      e.rails.box(centre.clone().addScaledVector(side, 0), run.clone().multiplyScalar(0.5), h(0.02), side.clone())
    }
  }
}

/** A spot on the roof for a water tank: the outline's centre if it is on the roof and far enough from the edges, else none. */
function roofSpot(b: BuildingData) {
  const ring = b.rings[0]
  let [x, z] = [0, 0]
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i]
    z += ring[i + 1]
  }
  ;[x, z] = [x / (ring.length / 2), z / (ring.length / 2)]
  const clear = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]].every(([dx, dz]) => inPolygon(b.rings, x + dx, z + dz))
  return clear ? { x, z } : null
}
