/** Plan geometry for the data scripts: rings are flat [x0, z0, x1, z1, …] arrays in metres, x east, z south. */

/** Whether (x, z) is inside `ring`, by the even-odd rule. */
export function inRing(ring, x, z) {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    if (ring[i + 1] > z !== ring[j + 1] > z && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) inside = !inside
  }
  return inside
}

export const inPolygon = (polygon, x, z) => inRing(polygon[0], x, z) && !polygon.slice(1).some((hole) => inRing(hole, x, z))

/** Signed area, positive for a ring clockwise on the map (east, then south). */
export function area(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  return a / 2
}

/** The ring run the other way round. */
export function reversed(ring) {
  const out = []
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i], ring[i + 1])
  return out
}

/**
 * A polygon wound the outline clockwise on the map and the holes anticlockwise: then (dz, −dx) of every edge points
 * away from the solid, which the client takes as the wall's outward normal.
 */
export const wound = ([outline, ...holes]) => [area(outline) < 0 ? reversed(outline) : outline, ...holes.map((h) => (area(h) > 0 ? reversed(h) : h))]

export function bounds(ring) {
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i])
    x1 = Math.max(x1, ring[i])
    z0 = Math.min(z0, ring[i + 1])
    z1 = Math.max(z1, ring[i + 1])
  }
  return { x0, z0, x1, z1 }
}

/** Polygons in 50 m cells by their bounds, and whether a point is in any of them. */
export function polygonIndex(polygons) {
  const size = 50
  const cells = new Map()
  const key = (i, j) => `${i},${j}`
  for (const p of polygons) {
    const b = bounds(p[0])
    for (let i = Math.floor(b.x0 / size); i <= Math.floor(b.x1 / size); i++) {
      for (let j = Math.floor(b.z0 / size); j <= Math.floor(b.z1 / size); j++) {
        const k = key(i, j)
        if (!cells.has(k)) cells.set(k, [])
        cells.get(k).push(p)
      }
    }
  }
  return (x, z) => (cells.get(key(Math.floor(x / size), Math.floor(z / size))) ?? []).some((p) => inPolygon(p, x, z))
}

/** A seeded random in [0, 1) (mulberry32). */
export function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Street lights along every kerb (a sidewalk's edge with a roadbed beside it), about 30 m apart: x, z, turn towards the road. */
export function lamps(sidewalks, onRoad) {
  const random = seeded(11)
  const taken = new Map()
  const near = (x, z) => {
    const [i, j] = [Math.floor(x / 25), Math.floor(z / 25)]
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [qx, qz] of taken.get(`${i + a},${j + b}`) ?? []) if (Math.hypot(qx - x, qz - z) < 22) return true
    return false
  }
  const out = []
  for (const polygon of sidewalks) {
    const ring = polygon[0]
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length
      const [ax, az, bx, bz] = [ring[i], ring[i + 1], ring[j], ring[j + 1]]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 6) continue
      const [dx, dz] = [(bx - ax) / len, (bz - az) / len]
      for (let t = 3 + random() * 6; t < len - 3; t += 28) {
        const [x, z] = [ax + dx * t, az + dz * t]
        const side = [1, -1].find((s) => onRoad(x + dz * s * 1.2, z - dx * s * 1.2))
        if (!side) continue
        const [ox, oz] = [dz * side, -dx * side]
        const [px, pz] = [Math.round((x - ox * 0.5) * 100) / 100, Math.round((z - oz * 0.5) * 100) / 100]
        if (near(px, pz)) continue
        const k = `${Math.floor(px / 25)},${Math.floor(pz / 25)}`
        if (!taken.has(k)) taken.set(k, [])
        taken.get(k).push([px, pz])
        out.push([px, pz, Math.round(Math.atan2(-oz, ox) * 1000) / 1000])
      }
    }
  }
  return out
}

/**
 * Where each street tree's pit goes. The census places a tree a few metres off where it stands: a seventh of Lower
 * Manhattan's in the roadway, the rest at any distance from the kerb, so a row of them wanders. A tree within `reach`
 * metres of a kerb (a roadbed's edge with a sidewalk beside it; 12 m from the roadway, 5 m from the sidewalk) goes onto
 * the sidewalk, `inset` metres in from the nearest kerb, turned along it, and a row lines up as the pits do; one further
 * from any kerb (a park, a plaza) stays where it is, turned with the grid round it; one in the roadway with no
 * sidewalk near is left out (null). Returns [x, z, turn], turn as instances() takes it: the pit's x along the kerb.
 */
export function treePits(sidewalks, roadbeds, inset = 1) {
  const onSidewalk = polygonIndex(sidewalks)
  const onRoad = polygonIndex(roadbeds)
  const size = 20
  const cells = new Map()
  for (const polygon of roadbeds) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i += 2) {
        const j = (i + 2) % ring.length
        const edge = [ring[i], ring[i + 1], ring[j], ring[j + 1]]
        for (let a = Math.floor(Math.min(edge[0], edge[2]) / size); a <= Math.floor(Math.max(edge[0], edge[2]) / size); a++) {
          for (let b = Math.floor(Math.min(edge[1], edge[3]) / size); b <= Math.floor(Math.max(edge[1], edge[3]) / size); b++) {
            const k = `${a},${b}`
            if (!cells.has(k)) cells.set(k, [])
            cells.get(k).push(edge)
          }
        }
      }
    }
  }
  const round = (v) => Math.round(v * 100) / 100
  return (x, z) => {
    const inRoad = onRoad(x, z)
    const reach = inRoad ? 12 : 5
    const near = []
    const seen = new Set()
    const n = Math.ceil(reach / size)
    for (let a = Math.floor(x / size) - n; a <= Math.floor(x / size) + n; a++) {
      for (let b = Math.floor(z / size) - n; b <= Math.floor(z / size) + n; b++) {
        for (const e of cells.get(`${a},${b}`) ?? []) {
          if (seen.has(e)) continue
          seen.add(e)
          const [ax, az, bx, bz] = e
          const [dx, dz] = [bx - ax, bz - az]
          const len = Math.hypot(dx, dz)
          if (len < 0.5) continue
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (len * len)))
          const [qx, qz] = [ax + dx * t, az + dz * t]
          const d = Math.hypot(x - qx, z - qz)
          if (d < reach) near.push({ d, qx, qz, ux: dx / len, uz: dz / len })
        }
      }
    }
    near.sort((p, q) => p.d - q.d)
    // The nearest edge that is a kerb: the roadway on one side, a sidewalk `inset` in on the other (a seam between two
    // roadbeds has the roadway on both).
    for (const { qx, qz, ux, uz } of near.slice(0, 8)) {
      for (const s of [1, -1]) {
        const [nx, nz] = [-uz * s, ux * s]
        if (onRoad(qx + nx * 0.3, qz + nz * 0.3)) continue
        for (const k of [inset, inset * 0.65, inset * 0.4]) {
          const [px, pz] = [qx + nx * k, qz + nz * k]
          if (onSidewalk(px, pz)) return [round(px), round(pz), Math.round(Math.atan2(-uz, ux) * 1000) / 1000]
        }
      }
    }
    if (inRoad) return null
    // Turned with the street grid (29° east of north here), as the paving round it is.
    return [round(x), round(z), -0.506]
  }
}
