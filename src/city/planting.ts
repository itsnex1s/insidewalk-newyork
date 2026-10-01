import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { grove, type Kind } from '../engine/trees'
import { instances, memo, prop } from '../engine/util'
import type { TileData } from './data'
import { KERB } from './streets'

/**
 * The street trees of the 2015 census where they stood, each its kind's crown at a height from its trunk's girth, in
 * a pit of earth; and New York's cobra-head street lights along the kerbs.
 */

/** The census's commonest SoHo trees as crown kinds (InsideWalk's Manhattan planting): planes, honey locusts, pears, the rest. */
const KINDS: Record<string, Kind> = {
  plane: { centre: 0.6, radius: [0.46, 0.37], cluster: 0.055, boughs: 9, bark: 0x7a7260, share: 1 },
  locust: { centre: 0.64, radius: [0.47, 0.3], cluster: 0.042, boughs: 11, bark: 0x3d362f, share: 1 },
  pear: { centre: 0.6, radius: [0.3, 0.4], cluster: 0.046, boughs: 7, bark: 0x4a4038, share: 1, stretch: 1.1 },
  ginkgo: { centre: 0.62, radius: [0.28, 0.42], cluster: 0.05, boughs: 8, bark: 0x5a5148, share: 1, stretch: 1.15 },
  broad: { centre: 0.6, radius: [0.42, 0.36], cluster: 0.05, boughs: 10, bark: 0x4f463c, share: 1 },
}
const LEAVES = [0x4d6b2a, 0x5a7830, 0x46652a, 0x668436, 0x70893a, 0x587a2e, 0x7d9442, 0x5f7a34]

const kindOf = (name: string) =>
  /plane/i.test(name) ? 'plane' : /locust/i.test(name) ? 'locust' : /pear/i.test(name) ? 'pear' : /ginkgo/i.test(name) ? 'ginkgo' : 'broad'

const pit = memo(() => new THREE.BoxGeometry(1.4, 0.04, 1.4).translate(0, 0.02, 0))
const earth = memo(() => new THREE.MeshStandardNodeMaterial({ color: 0x3b3128, roughness: 1 }))

/** A tile's street trees; `near` with full crowns of their kinds, far off with sparser plane crowns. Each kind keeps one crown shape everywhere, so tiles merge. */
export function trees(list: TileData['trees'], near: boolean) {
  const groups = new Map<string, { x: number; z: number; y: number; height: number }[]>()
  for (const [x, z, dbh, species] of list) {
    // Down the street every tree has the plane's crown: a few pixels across, one kind of crown is one instanced mesh
    // for its leaves and one for its bark, each a shader for three to build, where five kinds were ten a tile.
    const kind = near ? kindOf(species) : 'plane'
    const points = groups.get(kind) ?? groups.set(kind, []).get(kind)!
    points.push({ x, z, y: KERB, height: Math.min(17, Math.max(4.5, 3 + dbh * 0.6)) })
  }
  const group = new THREE.Group()
  const names = Object.keys(KINDS)
  for (const [kind, points] of groups) {
    const form = names.indexOf(kind) + 3
    group.add(grove({ kinds: [KINDS[kind]], leaves: LEAVES }, points, Math.round(points[0].x * 7 + points[0].z), near, form, near))
  }
  if (near) group.add(instances(pit(), earth(), list.map(([x, z]) => ({ x, z, y: KERB - 0.03 })), false))
  return prop(group)
}

/** A cobra-head light, its arm along +x: a tapered grey pole, the arm curving out over the road, the head at its end. */
const cobra = memo(() => {
  const pole = new THREE.CylinderGeometry(0.07, 0.11, 8.6, 10).translate(0, 4.3, 0)
  const base = new THREE.CylinderGeometry(0.2, 0.24, 0.9, 10).translate(0, 0.45, 0)
  const arm = new THREE.CylinderGeometry(0.05, 0.06, 2.3, 8).rotateZ(-Math.PI / 2 + 0.18).translate(1.1, 8.75, 0)
  const head = new THREE.BoxGeometry(0.75, 0.2, 0.36).translate(2.35, 8.95, 0)
  return mergeGeometries([pole, base, arm, head].map((g) => g.toNonIndexed()))
})
const lampGrey = memo(() => new THREE.MeshStandardNodeMaterial({ color: 0x5d625f, roughness: 0.55, metalness: 0.6 }))

/** A tile's street lights, placed by the data script along the kerbs, their arms over the road. */
export function lights(list: TileData['lamps']) {
  return prop(new THREE.Group().add(instances(cobra(), lampGrey(), list.map(([x, z, turn]) => ({ x, z, y: KERB, turn })))))
}
