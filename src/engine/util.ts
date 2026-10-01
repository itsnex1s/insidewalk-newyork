import * as THREE from 'three/webgpu'

/** One of `list`, by `random`. */
export const pick = <T>(random: () => number, list: readonly T[]) => list[Math.floor(random() * list.length)]

/** A seeded random in [0, 1) (mulberry32): the same street on every visit. */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A maker that builds once per set of arguments: the scenes ask for a material at every place it is used, and each call
 * would be a shader of its own to build and compile (seconds of a tower's load).
 */
export function memo<F extends (...args: never[]) => unknown>(make: F): F {
  const made = new Map<string, unknown>()
  return ((...args: never[]) => {
    const key = JSON.stringify(args)
    if (!made.has(key)) made.set(key, make(...args))
    return made.get(key)
  }) as F
}

/**
 * A unit box standing on its base, scaled to a building's size: one geometry for every scene, so the instanced meshes
 * built on it merge (merge() groups by geometry).
 */
export const standing = memo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0))

/**
 * The layer of small and far things, a pixel or two across from the tower's views: cars, trees, street lights, the
 * sprawl and the skyline. The baked sky occlusion (shade.ts) leaves them out.
 */
export const PROPS = 1
/** The sky dome the reflections' captures draw behind the city (engine/reflections.ts); no other camera sees it. */
export const SKY = 2

/** Moves `object` and all under it onto the PROPS layer. */
export function prop<T extends THREE.Object3D>(object: T) {
  object.traverse((o) => o.layers.set(PROPS))
  return object
}

export type Place = { x: number; z: number; y?: number; turn?: number; scale?: THREE.Vector3Like | number; color?: THREE.ColorRepresentation }

const m = new THREE.Matrix4()
const q = new THREE.Quaternion()
const up = new THREE.Vector3(0, 1, 0)
const s = new THREE.Vector3()
const p = new THREE.Vector3()

/** One instanced mesh of `geometry` at each place: turned about y, scaled, optionally coloured. Casts and takes shadows. */
export function instances(geometry: THREE.BufferGeometry, material: THREE.Material, places: Place[], shadows = true) {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(places.length, 1))
  mesh.count = places.length
  const c = new THREE.Color()
  places.forEach((at, i) => {
    q.setFromAxisAngle(up, at.turn ?? 0)
    if (typeof at.scale === 'number') s.setScalar(at.scale)
    else s.copy(at.scale ?? { x: 1, y: 1, z: 1 })
    m.compose(p.set(at.x, at.y ?? 0, at.z), q, s)
    mesh.setMatrixAt(i, m)
    if (at.color !== undefined) mesh.setColorAt(i, c.set(at.color))
  })
  mesh.castShadow = mesh.receiveShadow = shadows
  return mesh
}

const IDENTITY = new THREE.Matrix4()

/**
 * The instanced meshes under `root` that can draw as one (the same geometry, material, shadows, layer, and instance
 * colours or none) merged into one each, their instances where they stood in the world: a scene builds a mesh at each
 * call of instances() (Warsaw's estate one set per block), and each mesh is a draw of its own in every pass and a render
 * object whose shader is built apart. Transparent ones keep their order and stay as they are; empty ones go.
 */
export function merge(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  const toRoot = root.matrixWorld.clone().invert()
  const sets = new Map<string, THREE.InstancedMesh[]>()
  const empty: THREE.Object3D[] = []
  root.traverseVisible((o) => {
    const mesh = o as THREE.InstancedMesh
    if (!mesh.isInstancedMesh || mesh.children.length) return
    if (!mesh.count) {
      empty.push(mesh)
      return
    }
    const materials = [mesh.material].flat()
    if (materials.some((material) => material.transparent)) return
    const key = [...materials.map((material) => material.uuid), mesh.geometry.uuid, mesh.castShadow, mesh.receiveShadow, mesh.layers.mask, !!mesh.instanceColor].join()
    const set = sets.get(key)
    if (set) set.push(mesh)
    else sets.set(key, [mesh])
  })
  for (const mesh of empty) mesh.removeFromParent()
  const at = new THREE.Matrix4()
  const place = new THREE.Matrix4()
  const c = new THREE.Color()
  for (const meshes of sets.values()) {
    if (meshes.length < 2) continue
    const [first] = meshes
    const all = new THREE.InstancedMesh(first.geometry, first.material, meshes.reduce((n, mesh) => n + mesh.count, 0))
    let k = 0
    for (const mesh of meshes) {
      // Most stand at the root's origin: their matrices go over as they are, not rounded through a product.
      const moved = !place.multiplyMatrices(toRoot, mesh.matrixWorld).equals(IDENTITY)
      for (let i = 0; i < mesh.count; i++, k++) {
        mesh.getMatrixAt(i, at)
        all.setMatrixAt(k, moved ? at.premultiply(place) : at)
        if (mesh.instanceColor) all.setColorAt(k, mesh.getColorAt(i, c))
      }
      mesh.removeFromParent()
    }
    all.castShadow = first.castShadow
    all.receiveShadow = first.receiveShadow
    all.layers.mask = first.layers.mask
    root.add(all)
  }
}

/** A flat rectangle on the ground, centred at (x, z), `y` above it. */
export function slab(material: THREE.Material, x: number, z: number, w: number, d: number, y = 0) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(x, y, z)
  mesh.receiveShadow = true
  return mesh
}
