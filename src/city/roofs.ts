import * as THREE from 'three/webgpu'
import { attribute, color, floor, fract, hash, mix, mx_noise_float, positionWorld, smoothstep, step } from 'three/tsl'
import { instances, memo, type Place, prop } from '../engine/util'

/**
 * New York's rooftop water tanks: a tub of cedar staves bound by steel hoops under a conical roof, on a steel frame of
 * legs and beams. Instanced: every tank of the district is a few draws.
 */

const LEGS = 3.6
const TUB = { r: 2.6, h: 4.4 }

const tub = memo(() => new THREE.CylinderGeometry(TUB.r, TUB.r * 1.04, TUB.h, 28, 1, false).translate(0, LEGS + TUB.h / 2, 0))
const cap = memo(() => new THREE.ConeGeometry(TUB.r * 1.06, 1.5, 28).translate(0, LEGS + TUB.h + 0.75, 0))
const deck = memo(() => new THREE.BoxGeometry(TUB.r * 2.3, 0.3, TUB.r * 2.3).translate(0, LEGS - 0.15, 0))
const leg = memo(() => new THREE.BoxGeometry(0.22, LEGS, 0.22).translate(0, LEGS / 2, 0))

/** Weathered cedar in vertical staves, silver-grey to brown, with dark steel hoops around it. */
const cedar = memo(function cedar() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 })
  // The tub's own coordinates: under instancing positionLocal is already placed and scaled.
  const own = attribute('position', 'vec3') as unknown as THREE.Node<'vec3'>
  const around = own.x.atan(own.z).mul(TUB.r)
  const stave = floor(around.div(0.14))
  const tone = mix(color(0x6d5b49), color(0x9d9284), hash(stave.add(2 ** 20)).mul(0.6).add(mx_noise_float(positionWorld.mul(0.4)).mul(0.3)))
  const gap = smoothstep(0.0, 0.08, fract(around.div(0.14)))
  const hoopAt = fract(own.y.sub(LEGS).div(0.55))
  const hoop = step(hoopAt, 0.06)
  m.colorNode = mix(tone.mul(gap.mul(0.25).add(0.75)), color(0x2a2724), hoop)
  return m
})

const steel = memo(() => new THREE.MeshStandardNodeMaterial({ color: 0x2b2a28, roughness: 0.7, metalness: 0.4 }))
const tar = memo(() => new THREE.MeshStandardNodeMaterial({ color: 0x3a3632, roughness: 0.85 }))

export function tanks(spots: { x: number; z: number; y: number; size: number }[]) {
  const places: Place[] = spots.map((s, i) => ({ x: s.x, z: s.z, y: s.y, scale: s.size, turn: i * 1.7 }))
  const legs: Place[] = spots.flatMap((s) => [-1, 1].flatMap((a) => [-1, 1].map((b) => ({ x: s.x + a * TUB.r * 0.8 * s.size, z: s.z + b * TUB.r * 0.8 * s.size, y: s.y, scale: { x: s.size, y: s.size, z: s.size } }))))
  return prop(new THREE.Group().add(
    instances(tub(), cedar(), places),
    instances(cap(), tar(), places),
    instances(deck(), steel(), places),
    instances(leg(), steel(), legs),
  ))
}
