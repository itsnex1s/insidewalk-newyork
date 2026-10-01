import * as THREE from 'three/webgpu'
import { abs, cameraViewMatrix, color, float, floor, fract, hash, mix, mx_noise_float, normalize, positionWorld, smoothstep, vec2, vec3, vec4 } from 'three/tsl'
import { footprint, stripe } from '../engine/filter'
import { albedo, type PbrSet, roughness, tangentNormal } from '../engine/textures'
import { memo } from '../engine/util'
import type { CityIndex, Polygon, Ring, TileData } from './data'

/**
 * The ground: asphalt roadbeds, the Belgian block of Greene, Wooster, Mercer and Crosby, concrete sidewalks of
 * five-foot flags raised a kerb's height on granite kerbs (NYC Planimetric Database), and under them all a plain apron.
 */

/** Height of a kerb: sidewalks stand this far over the roadbed. */
export const KERB = 0.15
/** SoHo's streets' turn from true north (Greene Street runs 33° east of it): the sidewalks' flags and the setts' courses follow it. */
const GRID = (-33 * Math.PI) / 180

const ASPHALT: PbrSet = { id: 'aerial_asphalt_01', size: 9, mean: '#686368', roughMean: 0.775 }
const PAVERS: PbrSet = { id: 'concrete_pavers_02', size: 5, mean: '#736151', roughMean: 0.874 }

const xz = positionWorld.xz
const grid = vec2(xz.x.mul(Math.cos(GRID)).sub(xz.y.mul(Math.sin(GRID))), xz.x.mul(Math.sin(GRID)).add(xz.y.mul(Math.cos(GRID))))
const noise01 = (p: THREE.Node<'vec2'>) => mx_noise_float(p).mul(0.5).add(0.5)
/** A tangent-space normal on flat ground in view space, for normalNode. */
const groundNormal = (s: PbrSet, p: THREE.Node<'vec2'>, strength: number) => {
  const n = tangentNormal(s, p, strength)
  return cameraViewMatrix.mul(vec4(normalize(vec3(n.x, n.z, n.y)), 0)).xyz.normalize()
}

/** Worn asphalt, darker in the tyre tracks' patches, patched in squares where utilities dug it up. */
export const asphalt = memo(function asphalt() {
  const m = new THREE.MeshStandardNodeMaterial()
  const patch = smoothstep(0.62, 0.66, noise01(floor(grid.div(3.5)).mul(0.37)))
  const tone = mix(color(0x3a3b3d), color(0x57575a), noise01(xz.div(25))).mul(mix(1, 0.78, patch))
  m.colorNode = tone.mul(albedo(ASPHALT, xz, 0.9))
  m.roughnessNode = roughness(ASPHALT, xz, 0.85)
  m.normalNode = groundNormal(ASPHALT, xz, 0.6)
  return m
})

/** Belgian block: granite setts about 28 by 16 cm in courses across the street, each a grey or brown of its own, in dark joints. */
export const setts = memo(function setts() {
  const m = new THREE.MeshStandardNodeMaterial()
  const row = grid.y.div(0.17)
  const col = grid.x.div(0.27).add(floor(row).mul(0.5)).add(hash(floor(row).add(2 ** 20)).mul(0.3))
  const face = stripe(row, 0.1, 1).mul(stripe(col, 0.07, 1))
  const k = hash(floor(row).mul(17.3).add(floor(col).mul(93.1)).add(2 ** 20))
  const stone = mix(mix(color(0x5a5854), color(0x7c776f), k), color(0x6a5c50), smoothstep(0.88, 0.98, k))
  // Each sett's dome and its own shade, faded to their average where a pixel spans several setts (they would shimmer).
  const near = smoothstep(0.45, 0.12, footprint(row))
  const domed = mix(float(0.5), abs(fract(row).sub(0.55)).mul(2).oneMinus().mul(abs(fract(col).sub(0.5)).mul(2).oneMinus()).clamp(0, 1), near)
  const shade = mix(mix(color(0x5a5854), color(0x7c776f), 0.5), stone, near)
  m.colorNode = mix(color(0x2a2826), shade.mul(domed.mul(0.25).add(0.82)), face).mul(noise01(xz.div(9)).mul(0.15).add(0.9))
  m.roughnessNode = mix(0.95, 0.55, face.mul(domed))
  m.normalNode = groundNormal(PAVERS, xz.mul(3), 0.4)
  return m
})

/** Sidewalk concrete in 1.52 m flags, a joint between each, flag by flag a shade apart and stained here and there. */
export const sidewalk = memo(function sidewalk() {
  const m = new THREE.MeshStandardNodeMaterial()
  const cells = grid.div(1.524)
  const joint = stripe(cells.x, 0.008, 1).mul(stripe(cells.y, 0.008, 1))
  const k = hash(floor(cells.x).mul(31.7).add(floor(cells.y).mul(113.3)).add(2 ** 20))
  const tone = mix(color(0x9c978d), color(0xb9b3a7), k).mul(noise01(xz.div(4)).mul(0.12).add(0.9))
  const stain = smoothstep(0.7, 0.85, noise01(xz.div(1.7).add(9))).mul(0.18)
  m.colorNode = tone.mul(joint.mul(0.45).add(0.55)).mul(stain.oneMinus())
  m.roughnessNode = roughness(PAVERS, xz, 0.88)
  m.normalNode = groundNormal(ASPHALT, xz.mul(4), 0.12)
  return m
})

/** Granite kerbs, a steel edge along the top. */
export const kerb = memo(() => new THREE.MeshStandardNodeMaterial({ color: 0x8c8780, roughness: 0.7 }))

const toShape = ([outline, ...holes]: Polygon) => {
  const shape = new THREE.Shape(points(outline))
  for (const hole of holes) shape.holes.push(new THREE.Path(points(hole)))
  return shape
}
const points = (ring: Ring) => Array.from({ length: ring.length / 2 }, (_, i) => new THREE.Vector2(ring[2 * i], ring[2 * i + 1]))

/** Flat polygons at height `y`, facing up. */
function flat(polygons: Polygon[], y: number) {
  const g = new THREE.ShapeGeometry(polygons.map(toShape))
  // The shape lies in x, y: turned flat, its y becomes z (x, y, 0) → (x, 0, y) and its front faces up.
  g.rotateX(Math.PI / 2)
  g.translate(0, y, 0)
  // Turning it about x by +90° flips which side faces up: the triangles' order is turned round to face the sky.
  const index = g.getIndex()!
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i + 1)
    index.setX(i + 1, index.getX(i + 2))
    index.setX(i + 2, a)
  }
  g.computeVertexNormals()
  return g
}

const mesh = (g: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]) => {
  const m = new THREE.Mesh(g, material)
  m.receiveShadow = true
  return m
}

/** A tile's roadbeds, asphalt or Belgian block, and its sidewalks raised on their kerbs. */
export function ground(tile: Pick<TileData, 'roads' | 'setts' | 'sidewalks'>) {
  const group = new THREE.Group()
  if (tile.roads.length) group.add(mesh(flat(tile.roads, 0), asphalt()))
  if (tile.setts.length) group.add(mesh(flat(tile.setts, 0.005), setts()))
  if (tile.sidewalks.length) {
    const walks = new THREE.ExtrudeGeometry(tile.sidewalks.map(toShape), { depth: KERB, bevelEnabled: false })
    // Extruded along +z from the shape's x, y: turned so the shape's y is the world's z and the extrusion runs down, then raised.
    walks.rotateX(Math.PI / 2).translate(0, KERB, 0)
    group.add(mesh(walks, [sidewalk(), kerb()]))
  }
  return group
}

/** The ground under everything, the whole city and a few kilometres round it: plain grey where no tile has drawn its streets. */
export function apron(box: CityIndex['box']) {
  const pad = 4000
  const { min, max } = box
  const plane = new THREE.PlaneGeometry(max[0] - min[0] + 2 * pad, max[1] - min[1] + 2 * pad).rotateX(-Math.PI / 2).translate((min[0] + max[0]) / 2, -0.1, (min[1] + max[1]) / 2)
  // Drawn as if further off than it is: from the air or down a long street, where the depth buffer's steps are
  // decimetres, the roadbeds over it would otherwise flicker through it.
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8 })
  material.colorNode = mix(color(0x55575a), color(0x6d6c69), noise01(xz.div(60)))
  return mesh(plane, material)
}
