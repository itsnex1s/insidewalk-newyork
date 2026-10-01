/** Lower Manhattan as scripts/fetch-city.mjs writes it: 250 m tiles in metres, x east, z south, the origin in SoHo. */

/** A ring as x, z pairs one after another, not closed. */
export type Ring = number[]
/** A polygon: its outline, then its holes. */
export type Polygon = Ring[]

export interface BuildingData {
  /** Stable across tiles and loads: it seeds the building's dress. */
  id: number
  /** Wound so that (dz, −dx) along an edge points out of the building. */
  rings: Polygon
  /** Per ring, per edge, '1' where the wall faces a sidewalk or a street. */
  fronts: string[]
  /** Roof height, metres. */
  h: number
  floors: number
  year: number
  /** MapPLUTO building class: C walk-up, D elevator flats, K shops, O offices, R condominiums, … */
  cls: string
  /** In the SoHo-Cast Iron Historic District or its extension. */
  hist: 0 | 1
}

export interface TileData {
  buildings: BuildingData[]
  sidewalks: Polygon[]
  /** Asphalt roadbeds, and those paved in Belgian block. */
  roads: Polygon[]
  setts: Polygon[]
  /** x, z, trunk diameter at breast height (inches), species. */
  trees: [number, number, number, string][]
  /** x, z, turn of the arm towards the road. */
  lamps: [number, number, number][]
  streets: { name: string; line: number[] }[]
}

export interface CityIndex {
  origin: { lat: number; lon: number }
  tile: number
  box: { min: [number, number]; max: [number, number] }
  /** Every tile with anything in it; `top` its tallest building, metres. */
  tiles: { i: number; j: number; bytes: number; top: number }[]
}

const base = `${import.meta.env.BASE_URL}data/city/`

export async function loadIndex(): Promise<CityIndex> {
  const response = await fetch(`${base}index.json`)
  if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`)
  return response.json()
}

export async function loadTile(i: number, j: number): Promise<TileData> {
  const response = await fetch(`${base}t_${i}_${j}.json`)
  if (!response.ok) throw new Error(`tile ${i}, ${j}: HTTP ${response.status}`)
  return response.json()
}

/** Whether (x, z) is inside `ring`, by the even-odd rule. */
export function inRing(ring: Ring, x: number, z: number) {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const [xi, zi, xj, zj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** Whether (x, z) is inside `polygon`: in its outline and in none of its holes. */
export const inPolygon = (polygon: Polygon, x: number, z: number) => inRing(polygon[0], x, z) && !polygon.slice(1).some((hole) => inRing(hole, x, z))

/** Signed area of a ring, positive when it runs clockwise seen from above (x east, z south). */
export function area(ring: Ring) {
  let a = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  return a / 2
}

/** Bounds of a polygon's outline. */
export function bounds(ring: Ring) {
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i])
    x1 = Math.max(x1, ring[i])
    z0 = Math.min(z0, ring[i + 1])
    z1 = Math.max(z1, ring[i + 1])
  }
  return { x0, z0, x1, z1 }
}

/**
 * Things laid in square cells of `size` metres by their bounds, so a question about a point looks only at what stands
 * in its cell: which polygon a point is in, which walls a walker is near.
 */
export class Grid<T> {
  private cells = new Map<number, T[]>()
  constructor(private size: number) {}

  private key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096)

  add(item: T, x0: number, z0: number, x1: number, z1: number) {
    for (let i = Math.floor(x0 / this.size); i <= Math.floor(x1 / this.size); i++) {
      for (let j = Math.floor(z0 / this.size); j <= Math.floor(z1 / this.size); j++) {
        const key = this.key(i, j)
        const cell = this.cells.get(key)
        if (cell) cell.push(item)
        else this.cells.set(key, [item])
      }
    }
  }

  at(x: number, z: number): readonly T[] {
    return this.cells.get(this.key(Math.floor(x / this.size), Math.floor(z / this.size))) ?? []
  }
}

/** A grid of polygons and the question whether a point is in any of them. */
export function polygonIndex(polygons: Polygon[]) {
  const grid = new Grid<Polygon>(20)
  for (const p of polygons) {
    const b = bounds(p[0])
    grid.add(p, b.x0, b.z0, b.x1, b.z1)
  }
  return { grid, has: (x: number, z: number) => grid.at(x, z).some((p) => inPolygon(p, x, z)) }
}
