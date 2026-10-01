import * as THREE from 'three/webgpu'
import { cameraPosition, float, max, min, mix, normalize, normalWorld, pmremTexture, positionWorld, pow, smoothstep, sqrt, uniform } from 'three/tsl'
import { PROPS } from './util'

/**
 * The city in its own glass. The scene round the walker is drawn into a cube map from a little above their eye whenever
 * they stop somewhere new, prefiltered (PMREM) for rough and smooth glass alike, and the windows look it up corrected for
 * parallax: the reflected world is taken to be a sphere `RADIUS` metres round the capture, or the street where a ray
 * meets the ground first, so a shop window shows the facades across the street and the pavement before it, not the
 * sky over the walker's head. The environment's own sky reflection stays underneath for the far glass.
 */

/** Metres to the reflected facades: about a street's width and a half, the street canyon the walker stands in. */
const RADIUS = 28
/** How high above the eye the cube is drawn from: storefront and second-floor glass see the street much as from here. */
const LIFT = 2.5
/** How far the walker goes before the next capture, metres. */
const STEP = 18

export function cityReflections(renderer: THREE.WebGPURenderer, scene: THREE.Scene) {
  const cube = new THREE.CubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false })
  const camera = new THREE.CubeCamera(0.3, 4000, cube)
  for (const face of camera.children) face.layers.enable(PROPS)
  const generator = new THREE.PMREMGenerator(renderer)
  // A first, empty capture: the glass's shader is built on this target, which every later capture fills in place.
  const target = generator.fromCubemap(cube.texture)
  const centre = uniform(new THREE.Vector3(0, -1e4, 0))
  const last = new THREE.Vector3(Infinity, 0, Infinity)

  /** Draws the city round `eye` into the reflections. */
  function capture(eye: THREE.Vector3) {
    camera.position.set(eye.x, eye.y + LIFT, eye.z)
    camera.updateMatrixWorld()
    camera.update(renderer, scene)
    generator.fromCubemap(cube.texture, target)
    centre.value.copy(camera.position)
    last.copy(eye)
  }

  /** Whether the walker at `eye` is `STEP` metres from the last capture. */
  const due = (eye: THREE.Vector3) => Math.hypot(eye.x - last.x, eye.z - last.z) >= STEP

  /**
   * The reflected city for glass of `roughness` with normal `n` (world), weighted by Fresnel for glass (F0 = 0.05):
   * add it to the glass's emission and take the same share off its own colour.
   */
  function reflection(roughness: THREE.Node<'float'> | number, n: THREE.Node<'vec3'> = normalWorld) {
    const p = positionWorld
    const view = normalize(cameraPosition.sub(p))
    const r = view.negate().reflect(n).normalize()
    // Where the ray leaves the sphere round the capture (from inside it), or meets the ground, whichever is first.
    const o = p.sub(centre)
    const b = o.dot(r)
    const c = o.dot(o).sub(RADIUS * RADIUS)
    const toSphere = b.negate().add(sqrt(max(b.mul(b).sub(c), 0)))
    const toGround = mix(float(1e6), p.y.negate().div(min(r.y, -1e-3)), smoothstep(0, -0.02, r.y))
    const hit = p.add(r.mul(max(min(toSphere, toGround), 0.01)))
    // Far from the capture, the sphere is no guess at what the glass faces: the plain direction there.
    const near = smoothstep(RADIUS * 4, RADIUS * 1.5, o.length())
    const dir = normalize(mix(r, hit.sub(centre), near))
    const city = pmremTexture(target.texture, dir, typeof roughness === 'number' ? float(roughness) : roughness)
    const fresnel = pow(float(1).sub(n.dot(view).clamp(0, 1)), 5).mul(0.95).add(0.05)
    return { color: city.rgb, fresnel }
  }

  return { capture, due, reflection }
}

export type Reflections = ReturnType<typeof cityReflections>
