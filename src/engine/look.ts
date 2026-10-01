import * as THREE from 'three/webgpu'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { builtinAOContext, cameraPosition, color, dot, float, fog, fract, luminance, mix, normalize, pass, positionView, positionWorld, pow, saturation, screenCoordinate, smoothstep, vec2, vec3, vec4 } from 'three/tsl'
import { phone } from './device'
import { skyOcclusion } from './shade'
import { PROPS } from './util'

/**
 * An afternoon over the district (copied from InsideWalk's tower look.ts): a physical sky with some cloud, the sun low
 * enough to model the facades, haze thickening with distance, and the sky and the lit ground as the light every
 * surface reflects. The sun's shadow follows the walker (see `outdoors`), where the tower's covered one building.
 */

/** Sky, sun, haze and light. */
export interface Look {
  /** Towards the sun. */
  sun: THREE.Vector3
  sunColor: number
  sunIntensity: number
  exposure: number
  /** The haze's colour as radiance, not a display colour: as bright as the sky at the horizon. */
  haze: THREE.Color
  /** Haze density (exponential squared, per metre) past `clear` metres of clear air from the camera. */
  fog: number
  clear: number
  sky: {
    turbidity: number
    rayleigh: number
    mie: number
    mieG: number
    cloudCoverage: number
    cloudDensity: number
    cloudElevation: number
    /** What the sky's light is multiplied by from the horizon up to about 30° above it. */
    deep: THREE.Color
  }
  /** The ground as the environment map sees it: the light glass and shaded walls take from below. */
  ground: number
  environment: number
  /** The colour grade before the tone curve: 1 leaves saturation and contrast as they are; warmth tints lit tones gold and shaded ones blue. */
  grade: { saturation: number; contrast: number; warmth: number }
}

/** How far the sun stands from the walker, metres: its shadow box is set about this. */
const SUN_DISTANCE = 1500
/** The sky box's size: inside the camera's far plane (4 km), which is where the sky mesh draws itself. */
const SKY_SIZE = 3200
/** Metres round the walker the sun's shadow covers, and how far the walker goes before it is drawn again round them. */
const SHADOW_REACH = 170
const SHADOW_STEP = 35

/** The sky; `light` the sky as the environment's light takes it, paler: a street in shade is grey, not navy. */
function sky(size: number, disc: boolean, look: Look, light = false) {
  const mesh = new SkyMesh()
  mesh.scale.setScalar(size)
  mesh.turbidity.value = light ? look.sky.turbidity * 2.5 : look.sky.turbidity
  mesh.rayleigh.value = light ? look.sky.rayleigh * 0.45 : look.sky.rayleigh
  mesh.mieCoefficient.value = look.sky.mie
  mesh.mieDirectionalG.value = look.sky.mieG
  mesh.cloudCoverage.value = look.sky.cloudCoverage
  mesh.cloudDensity.value = look.sky.cloudDensity
  mesh.cloudElevation.value = look.sky.cloudElevation
  mesh.showSunDisc.value = disc ? 1 : 0
  mesh.sunPosition.value.copy(look.sun)
  const material = mesh.material as THREE.NodeMaterial
  const elevation = normalize(positionWorld.sub(cameraPosition)).y.clamp(0, 1)
  const deep = look.sky.deep
  const tint = light ? vec3(1, 1, 1) : mix(vec3(1, 1, 1), vec3(deep.r, deep.g, deep.b), smoothstep(0, 0.55, elevation))
  const rgb = (material.colorNode as THREE.Node<'vec4'>).rgb.mul(tint)
  // The light's sky at less than half its colour: what a shaded street takes from it is the sky's brightness, its blue
  // mostly lost to the walls and the haze between.
  material.colorNode = vec4(light ? saturation(rgb, 0.4) : rgb, 1)
  return mesh
}

/** Image-based light from the sky above and the sunlit ground below, rendered once into a PMREM. */
function environment(renderer: THREE.WebGPURenderer, look: Look) {
  const scene = new THREE.Scene()
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 32), new THREE.MeshStandardMaterial({ color: look.ground, roughness: 1 }))
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -3
  const sun = new THREE.DirectionalLight(look.sunColor, look.sunIntensity)
  sun.position.copy(look.sun)
  scene.add(sky(80, false, look, true), ground, sun)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const { texture } = pmrem.fromScene(scene, 0, 0.1, 100)
  pmrem.dispose()
  return texture
}

const occlusion = new WeakMap<THREE.Scene, THREE.Node<'float'>>()
const grades = new WeakMap<THREE.Scene, Look['grade']>()

/**
 * Sky, sun, haze and image-based light in `scene`: the sky's light is baked for `size` metres round a point, the origin
 * first and wherever `bake(x, z)` moves it after (shade.ts).
 * `follow(at)` keeps the sun's shadow box round the walker: drawn again only once they have gone `SHADOW_STEP` metres
 * from where it was last drawn, since nothing that casts a shadow moves.
 */
export function outdoors(renderer: THREE.WebGPURenderer, scene: THREE.Scene, size: number, look: Look) {
  const shade = skyOcclusion(scene, size, 0.85)
  occlusion.set(scene, shade.node)
  grades.set(scene, look.grade)
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = look.exposure
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  // On the props layer, which the sky occlusion's later bakes leave out: its box would stand over the whole map.
  const dome = sky(SKY_SIZE, true, look)
  dome.layers.set(PROPS)
  scene.add(dome)
  scene.environment = environment(renderer, look)
  scene.environmentIntensity = look.environment
  const beyond = positionView.z.negate().sub(look.clear).max(0).mul(look.fog)
  scene.fogNode = fog(color(look.haze), beyond.mul(beyond).negate().exp().oneMinus())

  const sun = new THREE.DirectionalLight(look.sunColor, look.sunIntensity)
  sun.castShadow = true
  const texels = phone ? 2048 : 4096
  sun.shadow.mapSize.set(texels, texels)
  // Deep enough along the light for the tallest towers round the walker to cast into the box.
  const spread = SHADOW_REACH * 2 + 400
  Object.assign(sun.shadow.camera, { left: -SHADOW_REACH, right: SHADOW_REACH, top: SHADOW_REACH, bottom: -SHADOW_REACH, near: SUN_DISTANCE - spread, far: SUN_DISTANCE + spread })
  sun.shadow.camera.updateProjectionMatrix()
  const texel = (2 * SHADOW_REACH) / texels
  sun.shadow.bias = -Math.min(0.5, texel * 1.5) / (2 * spread)
  sun.shadow.normalBias = Math.min(0.12, texel * 1.2)
  sun.shadow.radius = 3
  sun.shadow.camera.layers.enable(PROPS)
  sun.shadow.autoUpdate = false
  scene.add(sun, sun.target)

  const centre = new THREE.Vector3(Infinity, 0, Infinity)
  const follow = (at: THREE.Vector3) => {
    // The sky's box goes with the walker, the walk being longer than the box is wide.
    dome.position.set(at.x, 0, at.z)
    if (Math.hypot(at.x - centre.x, at.z - centre.z) < SHADOW_STEP) return false
    // Snapped to the texel grid along the light, so the shadows' edges do not crawl as the box moves.
    centre.set(Math.round(at.x / 4) * 4, 0, Math.round(at.z / 4) * 4)
    sun.target.position.copy(centre)
    sun.position.copy(look.sun).multiplyScalar(SUN_DISTANCE).add(centre)
    sun.target.updateMatrixWorld()
    sun.updateMatrixWorld()
    sun.shadow.needsUpdate = true
    return true
  }
  /** Draws the sun's shadow again where it is (new buildings have come into its box). */
  const reshadow = () => {
    sun.shadow.needsUpdate = true
  }
  return { sun, follow, reshadow, bake: shade.bake }
}

function grade(rgb: THREE.Node<'vec3'>, { saturation: s, contrast, warmth }: Look['grade']) {
  const grey = float(0.18)
  const punchy = saturation(pow(rgb.max(0.0001).div(grey), float(contrast)).mul(grey), float(s))
  const lit = luminance(punchy).mul(0.6).clamp(0, 1)
  const shade = vec3(1 - warmth * 0.5, 1, 1 + warmth * 0.6)
  const sun = vec3(1 + warmth, 1 + warmth * 0.3, 1 - warmth * 0.8)
  return punchy.mul(mix(shade, sun, lit))
}

/** Interleaved gradient noise per pixel: breaks a smooth sky's 8-bit steps. */
const noise = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189))

/**
 * The picture: the scene 4× multisampled, the baked sky occlusion on its ambient light; `rich` adds screen-space ambient
 * occlusion a metre or two wide (where a wall meets the pavement, a cornice its wall) and a light bloom on glare.
 */
export function picture(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, rich = false) {
  const pipeline = new THREE.RenderPipeline(renderer)
  const scenePass = pass(scene, camera, { samples: 4 })
  const sky = occlusion.get(scene)
  if (sky) scenePass.contextNode = builtinAOContext(sky)
  const drawn = scenePass.getTextureNode()
  let rgb = drawn.rgb
  if (rich) {
    const depth = scenePass.getTextureNode('depth')
    const ambient = ao(depth, null as unknown as THREE.Node, camera)
    ambient.resolutionScale = 0.5
    ambient.radius.value = 1.2
    ambient.thickness.value = 1.5
    rgb = rgb.mul(mix(1, ambient.getTextureNode().r, 0.8))
    rgb = rgb.add(bloom(vec4(rgb, 1), 0.08, 0.35, 1.4).rgb)
  }
  rgb = rgb.mul(noise.sub(0.5).mul(0.012).add(1))
  pipeline.outputNode = vec4(grade(rgb, grades.get(scene) ?? { saturation: 1, contrast: 1, warmth: 0 }), drawn.a)
  return { pipeline, scenePass }
}
