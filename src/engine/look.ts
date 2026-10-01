import * as THREE from 'three/webgpu'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { builtinAOContext, cameraPosition, dot, float, fog, fract, luminance, mix, normalize, pass, positionView, positionWorld, pow, saturation, screenCoordinate, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { phone } from './device'
import { lightsOn } from './night'
import { skyOcclusion } from './shade'
import { PROPS, SKY } from './util'

/**
 * The light over the district at an hour of the day (src/daytime.ts; first copied from InsideWalk's tower look.ts): a
 * physical sky with some cloud, the sun, haze thickening with distance, and the sky and the lit ground as the light
 * every surface reflects. The sun's shadow follows the walker (see `outdoors`), where the tower's covered one building.
 * Every part of it can be set again as the time changes (`outdoors`'s `set`), the shaders as they are.
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
  /** Where the sunlight comes from, if not from the sun (the moon's light at night). */
  light?: THREE.Vector3
  /** The night sky's glow over the city, lit from below by its streets: radiance at the horizon. */
  glow?: THREE.Color
  /** How far the city's lights are on, 0 to 1 (night.ts). */
  lights?: number
}

/** Every sky drawn (the dome, the environment's, the reflections'), to set again as the time changes. */
const skies = new Set<{ tune(look: Look): void }>()

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
  mesh.showSunDisc.value = disc ? 1 : 0
  const deep = uniform(new THREE.Vector3())
  const glow = uniform(new THREE.Vector3())
  const material = mesh.material as THREE.NodeMaterial
  const elevation = normalize(positionWorld.sub(cameraPosition)).y.clamp(0, 1)
  const tint = light ? vec3(1, 1, 1) : mix(vec3(1, 1, 1), deep, smoothstep(0, 0.55, elevation))
  // At night the sky is the city's: its streets' light on the haze, brown low down and a blue-grey overhead.
  const night = mix(glow, glow.mul(vec3(0.22, 0.28, 0.48)), smoothstep(0, 0.5, elevation))
  const rgb = (material.colorNode as THREE.Node<'vec4'>).rgb.mul(tint).add(night)
  // The light's sky at less than half its colour: what a shaded street takes from it is the sky's brightness, its blue
  // mostly lost to the walls and the haze between.
  material.colorNode = vec4(light ? saturation(rgb, 0.4) : rgb, 1)
  const tune = (look: Look) => {
    mesh.turbidity.value = light ? look.sky.turbidity * 2.5 : look.sky.turbidity
    mesh.rayleigh.value = light ? look.sky.rayleigh * 0.45 : look.sky.rayleigh
    mesh.mieCoefficient.value = look.sky.mie
    mesh.mieDirectionalG.value = look.sky.mieG
    mesh.cloudCoverage.value = look.sky.cloudCoverage
    mesh.cloudDensity.value = look.sky.cloudDensity
    mesh.cloudElevation.value = look.sky.cloudElevation
    mesh.sunPosition.value.copy(look.sun)
    deep.value.set(look.sky.deep.r, look.sky.deep.g, look.sky.deep.b)
    glow.value.set(look.glow?.r ?? 0, look.glow?.g ?? 0, look.glow?.b ?? 0)
  }
  tune(look)
  skies.add({ tune })
  return mesh
}

/** The sky for the glass's reflections: a dome of `size` metres on the SKY layer, which only their captures see. */
export function reflectedSky(size: number, look: Look) {
  const dome = sky(size, false, look)
  dome.layers.set(SKY)
  return dome
}

/**
 * Image-based light from the sky above and the lit ground below, rendered into a PMREM; `render(look)` draws it again
 * for another hour into the same target, so the materials keep the texture they were built with.
 */
function environment(renderer: THREE.WebGPURenderer, look: Look) {
  const scene = new THREE.Scene()
  const groundMaterial = new THREE.MeshStandardMaterial({ roughness: 1 })
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 32), groundMaterial)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -3
  const sun = new THREE.DirectionalLight()
  scene.add(sky(80, false, look, true), ground, sun)
  const pmrem = new THREE.PMREMGenerator(renderer)
  let target: THREE.RenderTarget | null = null
  return (look: Look) => {
    groundMaterial.color.set(look.ground)
    // At night the streets light the ground themselves.
    groundMaterial.emissive.copy(look.glow ?? new THREE.Color(0, 0, 0)).multiplyScalar(0.6)
    sun.color.set(look.sunColor)
    sun.intensity = look.sunIntensity
    sun.position.copy(look.light ?? look.sun)
    target = pmrem.fromScene(scene, 0, 0.1, 100, { renderTarget: target })
    return target.texture
  }
}

const occlusion = new WeakMap<THREE.Scene, THREE.Node<'float'>>()
/** The colour grade, for every picture: set with the look. */
const grading = { saturation: uniform(1), contrast: uniform(1), warmth: uniform(0) }

/**
 * Sky, sun, haze and image-based light in `scene`: the sky's light is baked for `size` metres round a point, the origin
 * first and wherever `bake(x, z)` moves it after (shade.ts).
 * `follow(at)` keeps the sun's shadow box round the walker: drawn again only once they have gone `SHADOW_STEP` metres
 * from where it was last drawn, since nothing that casts a shadow moves.
 */
export function outdoors(renderer: THREE.WebGPURenderer, scene: THREE.Scene, size: number, look: Look) {
  const shade = skyOcclusion(scene, size, 0.85)
  occlusion.set(scene, shade.node)
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  // On the props layer, which the sky occlusion's later bakes leave out: its box would stand over the whole map.
  const dome = sky(SKY_SIZE, true, look)
  dome.layers.set(PROPS)
  scene.add(dome)
  const lightOf = environment(renderer, look)
  const haze = uniform(new THREE.Color())
  const density = uniform(0)
  const clear = uniform(0)
  const beyond = positionView.z.negate().sub(clear).max(0).mul(density)
  scene.fogNode = fog(haze, beyond.mul(beyond).negate().exp().oneMinus())

  const sun = new THREE.DirectionalLight()
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
  let now = look
  /** The sun (or the moon) where it stands round the shadow's centre, and its shadow to be drawn again unless `shadow` is false. */
  const place = (shadow = true) => {
    sun.target.position.copy(centre)
    sun.position.copy(now.light ?? now.sun).multiplyScalar(SUN_DISTANCE).add(centre)
    sun.target.updateMatrixWorld()
    sun.updateMatrixWorld()
    if (shadow) sun.shadow.needsUpdate = true
  }
  const follow = (at: THREE.Vector3) => {
    // The sky's box goes with the walker, the walk being longer than the box is wide.
    dome.position.set(at.x, 0, at.z)
    if (Math.hypot(at.x - centre.x, at.z - centre.z) < SHADOW_STEP) return false
    // Snapped to the texel grid along the light, so the shadows' edges do not crawl as the box moves.
    centre.set(Math.round(at.x / 4) * 4, 0, Math.round(at.z / 4) * 4)
    place()
    return true
  }
  /**
   * The light of another hour: the skies, the haze, the sun, the exposure, the grade and the city's lights at once; the
   * environment's light and the sun's shadow too unless `full` is false. Those two are drawn again (the environment a
   * few milliseconds, the shadow a pass over the city round the walker): a change of time over many frames redraws
   * them every few.
   */
  const set = (look: Look, full = true) => {
    now = look
    for (const s of skies) s.tune(look)
    if (full) scene.environment = lightOf(look)
    scene.environmentIntensity = look.environment
    haze.value.copy(look.haze)
    density.value = look.fog
    clear.value = look.clear
    sun.color.set(look.sunColor)
    sun.intensity = look.sunIntensity
    renderer.toneMappingExposure = look.exposure
    grading.saturation.value = look.grade.saturation
    grading.contrast.value = look.grade.contrast
    grading.warmth.value = look.grade.warmth
    lightsOn.value = look.lights ?? 0
    if (centre.x !== Infinity) place(full)
  }
  set(look)
  /** Draws the sun's shadow again where it is (new buildings have come into its box). */
  const reshadow = () => {
    sun.shadow.needsUpdate = true
  }
  return { sun, follow, reshadow, set, bake: shade.bake, rebake: shade.start, baking: shade.step }
}

function grade(rgb: THREE.Node<'vec3'>) {
  const { saturation: s, contrast, warmth } = grading
  const grey = float(0.18)
  const punchy = saturation(pow(rgb.max(0.0001).div(grey), contrast).mul(grey), s)
  const lit = luminance(punchy).mul(0.6).clamp(0, 1)
  const shade = vec3(float(1).sub(warmth.mul(0.5)), 1, float(1).add(warmth.mul(0.6)))
  const sun = vec3(float(1).add(warmth), float(1).add(warmth.mul(0.3)), float(1).sub(warmth.mul(0.8)))
  return punchy.mul(mix(shade, sun, lit))
}

/** Interleaved gradient noise per pixel: breaks a smooth sky's 8-bit steps. */
const noise = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189))

/**
 * The picture: the scene 4× multisampled, the baked sky occlusion on its ambient light; `rich` adds screen-space ambient
 * occlusion a metre or two wide (where a wall meets the pavement, a cornice its wall) and a light bloom on glare.
 * `glow(true, strength)` blooms what is brightest (the low sun, the street lights' heads after dark): a pass of its own,
 * so only from the evening on.
 */
export function picture(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, rich = false) {
  const pipeline = new THREE.RenderPipeline(renderer)
  const scenePass = pass(scene, camera, { samples: 4 })
  const sky = occlusion.get(scene)
  // The sky's occlusion for every render, not the pass alone: a pass's own context is set only while it draws, so
  // shaders built ahead of it (`prepare`) would be built for another context and built again when it draws.
  if (sky) renderer.contextNode = builtinAOContext(sky)
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
  const plain = vec4(grade(rgb), drawn.a)
  pipeline.outputNode = plain
  let glowing: THREE.Node | null = null
  const strength = uniform(0)
  const glow = (on: boolean, amount = 0.55) => {
    strength.value = amount
    if (on) glowing ??= vec4(grade(rgb.add(bloom(vec4(rgb, 1), strength, 0.5, 0.9).rgb)), drawn.a)
    const node = on ? glowing! : plain
    if (pipeline.outputNode === node) return
    pipeline.outputNode = node
    pipeline.needsUpdate = true
  }

  /**
   * Builds the shaders `object` (in `scene`) needs for the scene pass, in the background: three builds a shader's
   * nodes for every instanced mesh apart, a few milliseconds each, which drawn straight away is a frame of a tenth of a
   * second each time a tile comes in. compileAsync builds them one at a time between frames, and the pass's first draw
   * of them finds them built. Everything under `object` is taken, in view or not.
   */
  function prepare(object: THREE.Object3D, onProgress?: (e: ProgressEvent) => void) {
    const culled: THREE.Object3D[] = []
    object.traverse((o) => {
      if (o.frustumCulled) culled.push(o)
      o.frustumCulled = false
    })
    const [target, mrt] = [renderer.getRenderTarget(), renderer.getMRT()]
    // compileAsync takes the render target and the objects to build before its first await. Its render context is
    // asked for at depth 0, and the pass draws at depth 1 (inside the pipeline's draw of the screen): the same depth
    // here, or nothing it builds would be found again.
    const contexts = (renderer as unknown as { _renderContexts: { get(...args: unknown[]): unknown } })._renderContexts
    const get = contexts.get
    contexts.get = (target: unknown, mrt: unknown) => get.call(contexts, target, mrt, 1)
    renderer.setRenderTarget(scenePass.renderTarget)
    renderer.setMRT(scenePass.getMRT())
    const built = renderer.compileAsync(object, camera, scene, onProgress ?? null)
    contexts.get = get
    renderer.setRenderTarget(target)
    renderer.setMRT(mrt)
    for (const o of culled) o.frustumCulled = true
    return built.catch((e) => console.warn(e))
  }

  return { pipeline, scenePass, prepare, glow }
}
