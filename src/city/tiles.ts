import * as THREE from 'three/webgpu'
import { merge } from '../engine/util'
import { type Segment, buildings } from './buildings'
import { type CityIndex, Grid, loadTile, polygonIndex, type TileData } from './data'
import { lights, trees } from './planting'
import { ground } from './streets'

/**
 * The city streamed round the walker in 250 m tiles, each built at the detail its distance asks for:
 *   near (within NEAR)  every building in full, streets, sidewalks, trees, lights; the walls the walker bumps into
 *   mid  (within MID)   buildings in the far field's plain walls, streets and sidewalks, sparser trees
 *   far  (within FAR)   buildings only; a tile with a tower in it from further off, so the skyline stands
 * A tile is fetched once and kept as data; its meshes are built when its detail changes (a few a frame, nearest
 * first, within a time budget, so walking on never stalls on a whole ring of tiles) and disposed when it goes.
 */

const NEAR = 420
const MID = 1200
const FAR = 2600
const TOWERS = 5000
/** How much further a tile must be before it drops a level: walking along a tile's edge does not rebuild it back and forth. */
const SLACK = 80
/** Milliseconds of building a frame may take. */
const BUDGET = 10

const Level = { None: 0, Far: 1, Mid: 2, Near: 3 } as const
type Level = (typeof Level)[keyof typeof Level]

interface Tile {
  i: number
  j: number
  top: number
  /** The centre on the plan. */
  x: number
  z: number
  data?: TileData
  loading?: Promise<void>
  level: Level
  group?: THREE.Group
  walls?: Grid<Segment>
  walks?: ReturnType<typeof polygonIndex>
}

export class Tiles {
  readonly root = new THREE.Group()
  private tiles: Tile[]
  private at = new THREE.Vector2()
  /** Set when a near or mid tile was built or dropped since the last look: the shadow, the sky's light and the reflections are redone. */
  changed = false

  constructor(private index: CityIndex) {
    const t = index.tile
    this.tiles = index.tiles.map(({ i, j, top }) => ({ i, j, top, x: (i + 0.5) * t, z: (j + 0.5) * t, level: Level.None }))
  }

  private wanted(tile: Tile) {
    const d = Math.hypot(tile.x - this.at.x, tile.z - this.at.y)
    const slack = (level: Level) => (tile.level >= level ? SLACK : 0)
    if (d < NEAR + slack(Level.Near)) return Level.Near
    if (d < MID + slack(Level.Mid)) return Level.Mid
    if (d < FAR + slack(Level.Far) || (tile.top > 60 && d < TOWERS)) return Level.Far
    return Level.None
  }

  /** Builds or drops what the walker at (x, z) needs, within the frame's budget; true when anything changed. */
  update(x: number, z: number, budget = BUDGET) {
    this.at.set(x, z)
    const start = performance.now()
    const todo = this.tiles
      .map((tile) => ({ tile, level: this.wanted(tile) }))
      .filter(({ tile, level }) => level !== tile.level)
      .sort((a, b) => b.level - a.level || this.distance(a.tile) - this.distance(b.tile))
    let built = false
    for (const { tile, level } of todo) {
      if (level === Level.None) {
        this.drop(tile)
        built = true
        continue
      }
      if (!tile.data) {
        this.fetch(tile)
        continue
      }
      if (performance.now() - start > budget) continue
      this.build(tile, level)
      built = true
    }
    return built
  }

  /** Loads and builds everything near and mid round (x, z) before the first frame; the far field follows as the walk runs. */
  async warm(x: number, z: number) {
    this.at.set(x, z)
    const first = this.tiles.filter((tile) => this.wanted(tile) >= Level.Mid)
    await Promise.all(first.map((tile) => this.fetch(tile, Infinity)))
    this.update(x, z, Infinity)
  }

  private distance = (tile: Tile) => Math.hypot(tile.x - this.at.x, tile.z - this.at.y)

  private fetching = 0
  private fetch(tile: Tile, limit = 8) {
    if (tile.loading) return tile.loading
    // A few at once: the nearest go first, and a burst of 200 requests would hold the near ones up behind the far.
    if (this.fetching >= limit) return Promise.resolve()
    this.fetching++
    tile.loading = loadTile(tile.i, tile.j)
      .then((data) => {
        tile.data = data
      })
      .catch((e) => {
        console.error(e)
        tile.loading = undefined
      })
      .finally(() => this.fetching--)
    return tile.loading
  }

  private build(tile: Tile, level: Level) {
    const data = tile.data!
    const near = level === Level.Near
    const group = new THREE.Group()
    const built = buildings(data.buildings, near)
    group.add(built.group)
    if (level >= Level.Mid) group.add(ground(data))
    if (level >= Level.Mid && data.trees.length) group.add(trees(data.trees, near))
    if (near && data.lamps.length) group.add(lights(data.lamps))
    merge(group)
    this.drop(tile)
    tile.group = group
    tile.level = level
    if (near) {
      tile.walls = new Grid<Segment>(8)
      for (const s of built.segments) tile.walls.add(s, Math.min(s[0], s[2]) - 1, Math.min(s[1], s[3]) - 1, Math.max(s[0], s[2]) + 1, Math.max(s[1], s[3]) + 1)
      tile.walks = polygonIndex(data.sidewalks)
    }
    this.root.add(group)
    if (level >= Level.Mid) this.changed = true
  }

  private drop(tile: Tile) {
    if (tile.group) {
      tile.group.removeFromParent()
      tile.group.traverse((o) => {
        const mesh = o as THREE.Mesh
        // Instanced meshes share their geometry (trees, lights, tanks): only their own instance buffers go.
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose()
        else if (mesh.isMesh) mesh.geometry.dispose()
      })
      if (tile.level >= Level.Mid) this.changed = true
    }
    tile.group = tile.walls = tile.walks = undefined
    tile.level = Level.None
  }

  /** The near tiles whose things may reach (x, z): a building or a sidewalk belongs to the tile its middle is in, and may run well past it. */
  private around(x: number, z: number) {
    const reach = this.index.tile / 2 + 160
    return this.tiles.filter((t) => t.level === Level.Near && Math.abs(t.x - x) < reach && Math.abs(t.z - z) < reach)
  }

  /** The walls round (x, z), for the walker to bump into. */
  wallsAt(x: number, z: number) {
    return this.around(x, z).flatMap((t) => t.walls!.at(x, z))
  }

  /** Whether (x, z) is on a sidewalk. */
  onSidewalk(x: number, z: number) {
    return this.around(x, z).some((t) => t.walks!.has(x, z))
  }

  /** The named streets near (x, z), for the label. */
  streetsAt(x: number, z: number) {
    const reach = this.index.tile
    return this.tiles.filter((t) => t.data && Math.abs(t.x - x) < reach && Math.abs(t.z - z) < reach).flatMap((t) => t.data!.streets)
  }

  /** How many tiles there are at each level, for the dev readout. */
  counts() {
    const n = [0, 0, 0, 0]
    for (const t of this.tiles) n[t.level] += 1
    return { far: n[1], mid: n[2], near: n[3] }
  }
}
