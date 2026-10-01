import * as THREE from 'three/webgpu'
import { merge, shareShaders } from '../engine/util'
import { type Segment, buildings } from './buildings'
import { type CityIndex, Grid, loadTile, polygonIndex, type TileData } from './data'
import { lights, trees } from './planting'
import { ground } from './streets'

/**
 * The city streamed round the walker in 250 m tiles, each built at the detail its distance asks for:
 *   near (within NEAR)  every building in full, streets, sidewalks, trees, lights; the walls the walker bumps into
 *   mid  (within MID)   buildings in the far field's plain walls, streets and sidewalks, sparser trees
 *   far  (within FAR)   buildings only; a tile with a tower in it from further off, so the skyline stands
 * Past AROUND, a tile is raised to more detail only once it is in view (the camera's frustum, with a margin): the city
 * behind the walker is not built until they turn to it, as a game streams its world. Its data is fetched all the same,
 * so turning round builds it straight away. A tile is fetched once and kept as data; its meshes are built when its
 * detail changes (nearest in view first, within a time budget a frame, so walking on never stalls on a whole ring of
 * tiles) and disposed when it goes.
 */

const NEAR = 420
const MID = 1200
const FAR = 2600
const TOWERS = 5000
/** Metres round the walker built whichever way they look: what turning round shows at once. */
const AROUND = 260
/** Metres a tile's box is grown by for the view test, so a tile at the edge of the view is there before it is seen. */
const MARGIN = 60
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
  /** Built and having its shaders built (`prepare`), shown once they are; dropped if anything replaced it meanwhile. */
  pending?: THREE.Group
  walls?: Grid<Segment>
  walks?: ReturnType<typeof polygonIndex>
}

/**
 * Takes `group` off the scene and frees its geometry. Meshes of instances (shareShaders) share their shape's buffers
 * with every other tile's (trees, lights, tanks), which disposing their geometry would free: they are let go of, and
 * their own small instance buffers with them when they are collected.
 */
function dispose(group: THREE.Group) {
  group.removeFromParent()
  group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && !(mesh.geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry) mesh.geometry.dispose()
  })
}

export class Tiles {
  readonly root = new THREE.Group()
  private tiles: Tile[]
  private at = new THREE.Vector2()
  private frustum = new THREE.Frustum()
  private view = new THREE.Matrix4()
  private box = new THREE.Box3()
  /** Set when a near tile was built or dropped since the last look: the shadow, the sky's light and the reflections are redone. */
  changed = false
  /**
   * Builds a tile's shaders before it is shown (look.ts picture's `prepare`), one tile after another, nearest first;
   * without it a tile shows the moment it is built.
   */
  prepare: ((group: THREE.Object3D) => Promise<unknown>) | null = null
  private queue: Promise<unknown> = Promise.resolve()
  /** Set when a tile was shown since the last update. */
  private shown = false

  constructor(private index: CityIndex) {
    const t = index.tile
    this.tiles = index.tiles.map(({ i, j, top }) => ({ i, j, top, x: (i + 0.5) * t, z: (j + 0.5) * t, level: Level.None }))
  }

  /** The detail the walker's distance asks of `tile`, in view or not. */
  private reach(tile: Tile) {
    const d = this.distance(tile)
    const slack = (level: Level) => (tile.level >= level ? SLACK : 0)
    if (d < NEAR + slack(Level.Near)) return Level.Near
    if (d < MID + slack(Level.Mid)) return Level.Mid
    if (d < FAR + slack(Level.Far) || (tile.top > 60 && d < TOWERS)) return Level.Far
    return Level.None
  }

  /** The detail `tile` is to be built at: what its distance asks, but no more than it has unless it is near or in view. */
  private wanted(tile: Tile) {
    const level = this.reach(tile)
    if (level <= tile.level || this.distance(tile) < AROUND || this.seen(tile)) return level
    return tile.level
  }

  /** Whether `tile` (its buildings up to its tallest) is in the camera's view, give or take MARGIN. */
  private seen(tile: Tile) {
    const half = this.index.tile / 2 + MARGIN
    this.box.min.set(tile.x - half, -MARGIN, tile.z - half)
    this.box.max.set(tile.x + half, Math.max(tile.top, 30) + MARGIN, tile.z + half)
    return this.frustum.intersectsBox(this.box)
  }

  private look(camera: THREE.Camera) {
    camera.updateMatrixWorld()
    this.at.set(camera.position.x, camera.position.z)
    this.frustum.setFromProjectionMatrix(this.view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem)
  }

  /**
   * Builds or drops what the walker's `camera` needs, within the frame's budget, and fetches the data of whatever their
   * distance asks for; true when anything changed.
   */
  update(camera: THREE.Camera, budget = BUDGET) {
    this.look(camera)
    const start = performance.now()
    const todo = []
    for (const tile of this.tiles) {
      const level = this.wanted(tile)
      if (level !== tile.level) todo.push({ tile, level })
      else if (!tile.data && this.reach(tile) > Level.None) this.fetch(tile)
    }
    todo.sort((a, b) => b.level - a.level || this.distance(a.tile) - this.distance(b.tile))
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
    if (this.shown) {
      this.shown = false
      built = true
    }
    return built
  }

  /**
   * Loads and builds what the walker's `camera` sees near them before the first frame: the near tiles round them and in
   * view, and the nearest tile in view at middle detail, so the far field's materials are built with the first frame
   * rather than when it streams in. The rest of the city follows as the walk runs (`update`). `progress` hears how far
   * it is, 0 to 1 for the loading and then for the building: the page is handed back every few dozen milliseconds of
   * building, so the loading screen keeps moving.
   */
  async warm(camera: THREE.Camera, progress: (stage: 'load' | 'build', done: number) => void = () => {}) {
    this.look(camera)
    const near = this.tiles.filter((tile) => this.wanted(tile) === Level.Near)
    const mid = this.tiles.filter((tile) => this.wanted(tile) === Level.Mid).sort((a, b) => this.distance(a) - this.distance(b))
    const first = [...near.sort((a, b) => this.distance(a) - this.distance(b)), ...mid.slice(0, 1)]
    let loaded = 0
    await Promise.all(first.map((tile) => this.fetch(tile, Infinity).then(() => progress('load', ++loaded / first.length))))
    let slice = performance.now()
    for (const [k, tile] of first.entries()) {
      const level = this.wanted(tile)
      if (tile.data && level !== tile.level) this.build(tile, level)
      if (performance.now() - slice > 30) {
        progress('build', (k + 1) / first.length)
        await new Promise((resolve) => setTimeout(resolve))
        slice = performance.now()
      }
    }
    progress('build', 1)
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
    shareShaders(group)
    // Nothing in a tile moves: its matrices are worked out once here, not walked through every frame.
    group.updateMatrixWorld(true)
    group.traverse((o) => {
      o.matrixAutoUpdate = false
      o.matrixWorldAutoUpdate = false
    })
    const was = tile.level
    tile.level = level
    // The walls are there to bump into at once, before the tile shows.
    tile.walls = tile.walks = undefined
    if (near) {
      tile.walls = new Grid<Segment>(8)
      for (const s of built.segments) tile.walls.add(s, Math.min(s[0], s[2]) - 1, Math.min(s[1], s[3]) - 1, Math.max(s[0], s[2]) + 1, Math.max(s[1], s[3]) + 1)
      tile.walks = polygonIndex(data.sidewalks)
    }
    tile.pending = group
    const show = () => {
      // Replaced or dropped while its shaders were built: let go of.
      if (tile.pending !== group) return dispose(group)
      tile.pending = undefined
      if (tile.group) dispose(tile.group)
      tile.group = group
      this.root.add(group)
      this.shown = true
      if (near || was === Level.Near) this.changed = true
    }
    const prepare = this.prepare
    if (!prepare) return show()
    this.queue = this.queue.then(() => (tile.pending === group ? prepare(group).then(show) : dispose(group)))
  }

  private drop(tile: Tile) {
    if (tile.group) {
      dispose(tile.group)
      if (tile.level === Level.Near) this.changed = true
    }
    // One being prepared is let go of when its turn comes (show).
    tile.group = tile.pending = tile.walls = tile.walks = undefined
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

  /**
   * Builds at once everything `camera` wants, fetching what it must, and resolves once it all shows: for filming
   * (scripts/film.mjs), where a frame waits for the city rather than the city for the frame.
   */
  async settle(camera: THREE.Camera) {
    for (let round = 0; round < 20; round++) {
      this.look(camera)
      const todo = this.tiles.filter((tile) => this.wanted(tile) !== tile.level)
      if (!todo.length && !this.tiles.some((tile) => tile.pending)) return
      await Promise.all(todo.filter((tile) => !tile.data).map((tile) => this.fetch(tile, Infinity)))
      this.update(camera, Infinity)
      await this.queue
    }
  }

  /** The tiles whose data is in within `reach` metres of (x, z) (as squares), for the minimap: built or not. */
  dataAround(x: number, z: number, reach: number) {
    const r = reach + this.index.tile / 2
    return this.tiles.filter((t) => t.data && Math.abs(t.x - x) < r && Math.abs(t.z - z) < r) as (Tile & { data: TileData })[]
  }

  /** How many tiles there are at each level, for the dev readout. */
  counts() {
    const n = [0, 0, 0, 0]
    for (const t of this.tiles) n[t.level] += 1
    return { far: n[1], mid: n[2], near: n[3] }
  }
}
