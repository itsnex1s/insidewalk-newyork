import * as THREE from 'three/webgpu'
import { Fn, float, If, normalWorld, positionWorld, smoothstep, texture, uniform, vec2 } from 'three/tsl'
import { PROPS } from './util'

/**
 * How much of the sky each point of the city sees, baked once when the scene is built. Nothing in it moves, so its
 * heights are drawn once into a height map of the ground round the building: every triangle of the buildings and the
 * podium (not the props: cars and trees are too small and too open to shade the street) raises the cells under it to
 * its top. Each shaded point then looks along eight bearings over that map, and the steeper the buildings rise on
 * the side it faces, the less of the sky's light it gets: streets between towers and the foot of a wall darken, roofs
 * and open plazas stay bright. It darkens only the light from the sky and the ground, not the sun, and it is the same
 * on a phone, which draws no screen-space ambient occlusion.
 */

/** Cells of the height map each way. */
const CELLS = 1024
/** Metres a shaded point steps out along its normal before it looks round: past its own wall's cells. */
const STEP_OUT = 3
/** How far it looks, metres. */
const RADII = [6, 16, 40, 90]
const BEARINGS = 8

/** The triangles of a box's top face (its vertices all at its greatest height), for heights(); none for another shape. */
const tops = new WeakMap<THREE.BufferGeometry, THREE.BufferAttribute | null>()
function topOf(geometry: THREE.BufferGeometry) {
  if (!tops.has(geometry)) {
    const position = geometry.getAttribute('position')
    const index = geometry.getIndex()
    let top: THREE.BufferAttribute | null = null
    if (geometry.type === 'BoxGeometry' && index) {
      let high = -Infinity
      for (let i = 0; i < position.count; i++) high = Math.max(high, position.getY(i))
      const kept: number[] = []
      for (let t = 0; t + 2 < index.count; t += 3) {
        const corners = [index.getX(t), index.getX(t + 1), index.getX(t + 2)]
        if (corners.every((v) => position.getY(v) === high)) kept.push(...corners)
      }
      top = new THREE.BufferAttribute(new Uint32Array(kept), 1)
    }
    tops.set(geometry, top)
  }
  return tops.get(geometry) ?? null
}

/**
 * Whether `m` stands a shape upright: turned about y, scaled and moved, nothing else (y from y alone and x and z from
 * x and z alone, exactly, and no projection).
 */
function upright(m: THREE.Matrix4) {
  const e = m.elements
  return e[1] === 0 && e[9] === 0 && e[4] === 0 && e[6] === 0 && e[3] === 0 && e[7] === 0 && e[11] === 0 && e[15] === 1 && e[5] > 0
}

/**
 * The heights, metres above the ground, of `scene` over a square `size` metres wide centred on (cx, cz), into `data`;
 * a generator that stops after each mesh, so the work can be spread over frames (`skyOcclusion`'s `start` and `step`).
 */
function* heights(scene: THREE.Scene, size: number, cx: number, cz: number, data: Float32Array) {
  data.fill(0)
  const cell = size / CELLS
  const half = size / 2
  const [x0, z0] = [cx - half, cz - half]
  const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  const world = new THREE.Matrix4()
  const instance = new THREE.Matrix4()
  scene.updateMatrixWorld(true)
  const raise = (m: THREE.Matrix4, position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: THREE.BufferAttribute | null) => {
    const count = index ? index.count : position.count
    const at = (i: number) => (index ? index.getX(i) : i)
    for (let t = 0; t + 2 < count; t += 3) {
      a.fromBufferAttribute(position, at(t)).applyMatrix4(m)
      b.fromBufferAttribute(position, at(t + 1)).applyMatrix4(m)
      c.fromBufferAttribute(position, at(t + 2)).applyMatrix4(m)
      const top = Math.max(a.y, b.y, c.y)
      // The ground, kerbs and low planting shade nothing.
      if (top < 1.5) continue
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) / cell))
      const i1 = Math.min(CELLS - 1, Math.floor((Math.max(a.x, b.x, c.x) - x0) / cell))
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) / cell))
      const j1 = Math.min(CELLS - 1, Math.floor((Math.max(a.z, b.z, c.z) - z0) / cell))
      if (i0 > i1 || j0 > j1) continue
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) if (data[j * CELLS + i] < top) data[j * CELLS + i] = top
      }
    }
  }
  const meshes: THREE.Object3D[] = []
  scene.traverse((o) => void meshes.push(o))
  for (const o of meshes) {
    const mesh = o as THREE.Mesh
    const material = mesh.material as THREE.Material
    // Leaves and fronds (drawn from both sides) are too open to take the sky away, and the most triangles there are.
    if (!mesh.isMesh || !o.visible || o.layers.isEnabled(PROPS) || !material.depthWrite || material.side === THREE.DoubleSide) continue
    // Dropped (disposed) since the walk began: nothing to raise.
    if (!o.parent) continue
    const position = mesh.geometry.getAttribute('position')
    if (!position) continue
    // A tile's merged mesh wholly outside the square raises nothing: its vertices are not even looked at.
    if (!(mesh as THREE.InstancedMesh).isInstancedMesh) {
      mesh.geometry.boundingSphere ?? mesh.geometry.computeBoundingSphere()
      const sphere = mesh.geometry.boundingSphere!
      if (Math.abs(sphere.center.x - cx) > half + sphere.radius || Math.abs(sphere.center.z - cz) > half + sphere.radius) continue
    }
    const index = mesh.geometry.getIndex()
    // An upright box raises the cells under its top face to its top, and its sides and bottom reach no further out and
    // no higher (their corners stand over the top's, exactly): its 2 top triangles do what its 12 did, the same cells to
    // the same heights. Most of what is raised is boxes, Warsaw's 62 000 windows and rails among them.
    const top = topOf(mesh.geometry)
    const instanced = mesh as THREE.InstancedMesh
    if (instanced.isInstancedMesh) {
      for (let k = 0; k < instanced.count; k++) {
        instanced.getMatrixAt(k, instance)
        world.multiplyMatrices(mesh.matrixWorld, instance)
        raise(world, position, top && upright(world) ? top : index)
      }
    } else raise(mesh.matrixWorld, position, top && upright(mesh.matrixWorld) ? top : index)
    yield
  }
}

/**
 * Half floats (a quarter metre's step at 500 m), which every device filters: the map is read between its cells, so the
 * light across a street or a roof changes smoothly, where 32-bit floats (not filterable everywhere, iOS WebGL among
 * them) were read cell by cell and laid bands and blocks of their cells over plazas and roofs.
 */
function pack(data: Float32Array, packed: Uint16Array) {
  for (let i = 0; i < data.length; i++) packed[i] = data[i] ? THREE.DataUtils.toHalfFloat(data[i]) : 0
}

/**
 * The sky's share of light at each shaded point, 1 where the whole sky is open, for builtinAOContext: `size` metres
 * of the city round the origin; `strength` how dark a point closed in on all sides goes (0 to 1).
 */
export function skyOcclusion(scene: THREE.Scene, size: number, strength: number) {
  const data = new Float32Array(CELLS * CELLS)
  const packed = new Uint16Array(CELLS * CELLS)
  const heightMap = new THREE.DataTexture(packed, CELLS, CELLS, THREE.RedFormat, THREE.HalfFloatType)
  heightMap.minFilter = heightMap.magFilter = THREE.LinearFilter
  const map = texture(heightMap)
  const scale = uniform(1 / size)
  const centre = uniform(new THREE.Vector2())
  /** Bakes the heights again round (cx, cz) at once. The shader stays as it is. */
  const bake = (cx: number, cz: number) => {
    for (const _ of heights(scene, size, cx, cz, data));
    pack(data, packed)
    heightMap.needsUpdate = true
    centre.value.set(cx, cz)
  }
  // A bake spread over frames: the heights into a map of their own while the old one is still drawn from.
  const next = new Float32Array(CELLS * CELLS)
  let job: { work: Generator; cx: number; cz: number } | null = null
  /** Starts baking the heights round (cx, cz) a little a frame (`step`): as the walker goes and tiles come and go. */
  const start = (cx: number, cz: number) => {
    job = { work: heights(scene, size, cx, cz, next), cx, cz }
  }
  /** Bakes on for up to `ms` milliseconds; true when the map changed, the bake done. */
  const step = (ms: number) => {
    if (!job) return false
    const until = performance.now() + ms
    while (performance.now() < until) {
      if (!job.work.next().done) continue
      data.set(next)
      pack(data, packed)
      heightMap.needsUpdate = true
      centre.value.set(job.cx, job.cz)
      job = null
      return true
    }
    return false
  }
  const node = Fn(() => {
    // Taken before the branch below: the material's own shading reads them too, and what is first built inside a
    // branch is unset outside it.
    const p = positionWorld.toVar()
    const n = normalWorld.toVar()
    // Fading out towards the map's edge, where the streets are a few pixels across and the haze is setting in.
    const edge = p.xz.sub(centre).mul(scale).abs()
    const fade = smoothstep(0.5, 0.4, edge.x.max(edge.y)).toVar()
    const open = float(1).toVar()
    // Past the edge, where it has faded to nothing, nothing is looked at: 32 reads a pixel saved over the far ground and
    // the sea. Read at level 0, as a read in a branch must be (the map has no other).
    If(fade.greaterThan(0), () => {
      const from = p.xz.add(n.xz.mul(STEP_OUT))
      let closed: THREE.Node<'float'> = float(0)
      let weights: THREE.Node<'float'> = float(0)
      for (let k = 0; k < BEARINGS; k++) {
        const angle = (k / BEARINGS) * Math.PI * 2
        const d = vec2(Math.cos(angle), Math.sin(angle))
        // A wall sees only the half of the sky in front of it: the bearings behind it count for nothing.
        const w = d.dot(n.xz).add(n.y).clamp(0, 1)
        // The steepest rise along the bearing, as the tangent of its angle above the point.
        let rise: THREE.Node<'float'> = float(0)
        for (const r of RADII) {
          // Clamped: a read past the map's edge is undefined on some GPUs.
          const h = map.sample(from.add(d.mul(r)).sub(centre).mul(scale).add(0.5).clamp(0, 1)).level(float(0)).r
          rise = rise.max(h.sub(p.y).div(r))
        }
        // Sine of the horizon's angle: the share of the sky's light it hides on that bearing.
        closed = closed.add(rise.div(rise.mul(rise).add(1).sqrt()).mul(w))
        weights = weights.add(w)
      }
      open.assign(float(1).sub(closed.div(weights.max(1e-3)).mul(fade.mul(strength))))
    })
    return open
  })()
  return { node, bake, start, step }
}
