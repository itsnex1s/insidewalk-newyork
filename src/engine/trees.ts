import * as THREE from 'three/webgpu'
import { weak } from './device'
import { color, length, materialColor, mix, mx_noise_float, normalViewGeometry, positionWorld, smoothstep, step, uv, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { instances, memo, type Place, seeded } from './util'

/**
 * Broadleaf trees: a trunk forking into boughs, each bough carrying a mass of leaves, with gaps of sky between the masses
 * as a real crown has. The leaves are small cards turned every way; their normals lean out from the crown's centre, so
 * the crown shades as one soft volume, and their colour darkens toward its inside and underside, where little light gets
 * in. Instanced: a kind's trees are two draw calls, and every planting of a kind at one detail shares its geometry, so
 * a scene's plantings merge into those two (see merge in util.ts). Warsaw's lindens, birches and maples; New York's
 * planes, honey locusts and pears.
 */

/** A kind of tree, one unit tall: its crown's centre and radii, the size of its leaf clusters and its bark. */
export interface Kind {
  centre: number
  radius: [number, number]
  cluster: number
  boughs: number
  bark: number
  /** How much of the planting is of this kind. */
  share: number
  /** Its trees' height against the planting's (a birch stands a little taller than the lindens round it); 1 unset. */
  stretch?: number
}

/** A planting's kinds and the leaf colours its crowns are given, one per tree. */
export interface Species { kinds: Kind[]; leaves: number[] }

/** A planting seen from down the street: grove draws far trees with a quarter of a near crown's leaves, so their cards are made bigger. */
export const fuller = (s: Species): Species => ({ ...s, kinds: s.kinds.map((k) => ({ ...k, cluster: k.cluster * 1.8 })) })

/** Tree leaves: the crown's colour is the instance's, its shade the vertices'. */
export const leaves = memo(function leaves() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, vertexColors: true, side: THREE.DoubleSide })
  // Named for the layout audit (audit.ts): a plant, wherever it stands.
  m.name = 'plant'
  m.colorNode = vec3(1).mul(mx_noise_float(positionWorld.mul(1.3)).mul(0.16).add(0.92))
  // Each card is cut to a round leaf (its corners are (0,0), (1,0), (0,1)), so a crown is soft-edged clumps, never triangles.
  m.opacityNode = step(length(uv().sub(1 / 3)), 0.34)
  m.alphaTest = 0.5
  // The card's normal as built, never turned round on its back: both faces of a card are lit as the crown is there.
  m.normalNode = normalViewGeometry
  return m
})

/** Bark: the kind's colour (the material's, so kinds share a shader), and for a birch's white bark (a light tint) the dark marks across it. */
export const bark = memo(function bark(tint: number) {
  const m = new THREE.MeshStandardNodeMaterial({ color: tint, roughness: 0.9 })
  m.name = 'plant'
  const light = new THREE.Color(tint).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6
  const marks = smoothstep(0.55, 0.7, mx_noise_float(positionWorld.mul(vec3(9, 2.2, 9))))
  m.colorNode = light ? mix(materialColor.rgb, color(0x2e2a26), marks) : materialColor.rgb.mul(mx_noise_float(positionWorld.mul(3)).mul(0.15).add(0.92))
  return m
})

const UP = new THREE.Vector3(0, 1, 0)

/** A tapered limb from `a` to `b`, radii `r0` at `a` and `r1` at `b`. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number) {
  const dir = b.clone().sub(a)
  const g = new THREE.CylinderGeometry(r1, r0, dir.length(), 6, 1, true).translate(0, dir.length() / 2, 0)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()))
  return g.translate(a.x, a.y, a.z)
}

/** A random direction, biased up by `lift` (0: any way, 1: only upward). */
function direction(random: () => number, lift: number) {
  const y = lift + (1 - lift) * (random() * 2 - 1)
  const a = random() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)
}

/** The crown (`clusters` clusters of `cards` leaves, with their normals and shade) and the wood of one tree of `kind`. */
export const treeGeometry = memo(function treeGeometry(kind: Kind, clusters: number, cards: number, seed: number) {
  const random = seeded(seed)
  const centre = new THREE.Vector3(0, kind.centre, 0)
  const [rx, ry] = kind.radius
  const scaleOut = new THREE.Vector3(rx, ry, rx)
  const fork = new THREE.Vector3(0, kind.centre - ry * 0.55, 0)
  const wood = [limb(new THREE.Vector3(), fork, 0.022, 0.016)]
  // The masses: one at the heart and one at the end of each bough, pushed out toward the crown's shell.
  const masses = [{ at: centre.clone().add(new THREE.Vector3(0, ry * 0.15, 0)), r: 0.5 }]
  for (let i = 0; i < kind.boughs; i++) {
    const d = direction(random, 0.1)
    const at = centre.clone().add(d.multiply(scaleOut).multiplyScalar(0.5 + random() * 0.18))
    masses.push({ at, r: 0.38 + random() * 0.14 })
    const from = fork.clone().add(new THREE.Vector3(0, random() * ry * 0.4, 0))
    wood.push(limb(from, at.clone().lerp(from, 0.25), 0.012, 0.005))
  }

  const position = new Float32Array(clusters * cards * 9)
  const normal = new Float32Array(clusters * cards * 9)
  const shade = new Float32Array(clusters * cards * 9)
  const corner = new Float32Array(clusters * cards * 6)
  // Smaller leaves the more a cluster has, so a cluster stays the same size.
  const leaf = kind.cluster * Math.sqrt(6 / cards)
  const [n, e1, e2] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  for (let i = 0, f = 0; i < clusters; i++) {
    const m = i % masses.length
    const mass = masses[m]
    const at = mass.at.clone().add(direction(random, 0).multiply(scaleOut).multiplyScalar(mass.r * Math.sqrt(random())))
    // A touch yellower or greener mass by mass, as leaves turn branch by branch.
    const turn = 0.94 + ((m * 0.37) % 1) * 0.12
    for (let c = 0; c < cards; c++, f++) {
      const size = leaf * (0.7 + random() * 0.6)
      const middle = at.clone().add(direction(random, 0).multiplyScalar(kind.cluster * random()))
      e1.copy(direction(random, 0)).multiplyScalar(size)
      e2.copy(direction(random, 0)).cross(e1).normalize().multiplyScalar(size * 0.8)
      // Out from the crown: the crown shades as one volume, each card tilted a little off it so the light sparkles.
      n.copy(middle).sub(centre).divide(scaleOut)
      const depth = n.length()
      n.normalize().add(direction(random, 0).multiplyScalar(0.25)).normalize()
      const under = THREE.MathUtils.clamp((middle.y - (kind.centre - ry)) / (2 * ry), 0, 1)
      const light = THREE.MathUtils.clamp(0.2 + depth * 0.8, 0.25, 1) * (0.66 + under * 0.34) * (0.9 + random() * 0.2)
      const corners = [middle.clone().add(e1), middle.clone().sub(e1).add(e2), middle.clone().sub(e1).sub(e2)]
      corners.forEach((p, k) => {
        position.set([p.x, p.y, p.z], f * 9 + k * 3)
        normal.set([n.x, n.y, n.z], f * 9 + k * 3)
        shade.set([light * turn, light, light * (2 - turn)], f * 9 + k * 3)
        corner.set([k === 1 ? 1 : 0, k === 2 ? 1 : 0], f * 6 + k * 2)
      })
    }
  }
  const crown = new THREE.BufferGeometry()
  crown.setAttribute('position', new THREE.BufferAttribute(position, 3))
  crown.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  crown.setAttribute('color', new THREE.BufferAttribute(shade, 3))
  crown.setAttribute('uv', new THREE.BufferAttribute(corner, 2))
  return { crown, wood: mergeGeometries(wood.map((g) => g.toNonIndexed())) }
})

/**
 * Trees of `species` at the given ground positions, `height` metres tall on average (11 unset); `near` ones have fuller
 * crowns of finer leaves. `form` picks the crowns' shapes (by default `seed`): plantings of one form share their geometry.
 * Far plantings pass `shadows` false (see palms in planting.ts).
 */
export function grove(species: Species, points: { x: number; z: number; y?: number; height?: number }[], seed = 3, near = false, form = seed, shadows = true) {
  const random = seeded(seed)
  const group = new THREE.Group()
  const { kinds } = species
  const planted: Place[][] = kinds.map(() => [])
  for (const p of points) {
    let pick = random()
    const k = Math.max(0, kinds.findIndex((kind) => (pick -= kind.share) < 0))
    const h = (p.height ?? 11) * (0.75 + random() * 0.5) * (kinds[k].stretch ?? 1)
    const wide = h * (0.9 + random() * 0.25)
    const color = species.leaves[Math.floor(random() * species.leaves.length)]
    planted[k].push({ x: p.x, z: p.z, y: p.y ?? 0, turn: random() * 6.3, scale: { x: wide, y: h, z: wide * (0.9 + random() * 0.2) }, color })
  }
  kinds.forEach((kind, k) => {
    if (!planted[k].length) return
    // A weak phone's near trees have half the leaves, in bigger cards: the same crowns, sparser close up.
    const { crown, wood } = treeGeometry(kind, near && !weak ? 170 : near ? 100 : 44, near && !weak ? 10 : 6, form * 10 + k)
    group.add(instances(wood, bark(kind.bark), planted[k].map(({ color, ...p }) => p), shadows), instances(crown, leaves(), planted[k], shadows))
  })
  return group
}
