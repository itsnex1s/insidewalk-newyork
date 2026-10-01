import * as THREE from 'three/webgpu'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { mix, texture, vec3 } from 'three/tsl'

/**
 * Photographed PBR sets (Poly Haven and ambientCG, CC0), KTX2 in public/textures: albedo with roughness in alpha, a
 * tangent-space normal map. Copied from the InsideWalk engine's scene/textures, trimmed to the ground's 512 px sets.
 * `size`: metres per repeat; `mean` (sRGB hex) and `roughMean`: averages, so a set takes any colour and roughness at its
 * own detail.
 */
export interface PbrSet {
  id: string
  size: number
  mean: string
  roughMean: number
}

/** ar: albedo rgb + roughness a; nor_gl: tangent-space normal, OpenGL convention. */
type MapKind = 'ar' | 'nor_gl'

const maps = new Map<string, THREE.TextureNode>()
let ktx2: KTX2Loader | null = null
let started = false
const pending: (() => void)[] = []
const loads: Promise<unknown>[] = []

/** The KTX2 transcoder on `renderer`, before any map loads: no path set, the loader's own `new URL(…, import.meta.url)` has Vite ship it. */
export function initTextures(renderer: THREE.WebGPURenderer) {
  ktx2 ??= new KTX2Loader().detectSupport(renderer)
}

/** Starts the downloads of every map asked for so far and of any asked for later: after the scene is built, so they do not hold it. */
export function startTextures() {
  started = true
  for (const load of pending.splice(0)) load()
}

/** Settles once the maps asked for are in place, or after `ms`. */
export const mapsLoaded = (ms: number) => Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, ms))])

function configure(t: THREE.Texture, kind: MapKind) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.anisotropy = 8
  t.colorSpace = kind === 'ar' ? THREE.SRGBColorSpace : THREE.NoColorSpace
  return t
}

/**
 * One node per map, the base of all its samples. Until the file is transcoded it holds one texel of the set's mean;
 * the real texture then takes its place, which rebinds without recompiling.
 */
function map(s: PbrSet, kind: MapKind) {
  const key = `${s.id}_${kind}`
  const cached = maps.get(key)
  if (cached) return cached
  const hex = parseInt(s.mean.slice(1), 16)
  const texel = kind === 'ar' ? [hex >> 16, (hex >> 8) & 255, hex & 255, Math.round(s.roughMean * 255)] : [128, 128, 255, 255]
  const placeholder = new THREE.DataTexture(new Uint8Array(texel), 1, 1)
  const node = texture(configure(placeholder, kind))
  placeholder.needsUpdate = true
  maps.set(key, node)
  const load = () => {
    const url = `${import.meta.env.BASE_URL}textures/${s.id}/${s.id}_${kind}_512.ktx2`
    THREE.DefaultLoadingManager.itemStart(url)
    loads.push(ktx2!.loadAsync(url)
      .then((t) => {
        node.value = configure(t, kind)
        placeholder.dispose()
      }, (e) => console.error(e))
      .finally(() => THREE.DefaultLoadingManager.itemEnd(url)))
  }
  if (started) load()
  else pending.push(load)
  return node
}

type Uv = THREE.Node<'vec2'>

function at(node: THREE.TextureNode, uv: Uv) {
  const sample = node.sample(uv)
  sample.updateMatrix = false
  return sample
}

const meanOf = (s: PbrSet) => {
  const c = new THREE.Color(s.mean)
  return vec3(c.r, c.g, c.b)
}

/** Albedo normalised to an average of 1, to multiply a finish colour; contrast 0 = flat, 1 = as photographed. */
export const albedo = (s: PbrSet, uv: Uv, contrast = 1) => mix(vec3(1), at(map(s, 'ar'), uv.div(s.size)).rgb.div(meanOf(s)), contrast)

/** Roughness of the set rescaled so its average becomes `target`. */
export const roughness = (s: PbrSet, uv: Uv, target: number | THREE.Node<'float'>) =>
  at(map(s, 'ar'), uv.div(s.size)).a.mul(typeof target === 'number' ? target / s.roughMean : target.div(s.roughMean)).clamp(0.04, 1)

/** Tangent-space normal (OpenGL convention), its slope scaled by `strength`. */
export const tangentNormal = (s: PbrSet, uv: Uv, strength: number) =>
  at(map(s, 'nor_gl'), uv.div(s.size)).xyz.mul(2).sub(1).mul(vec3(strength, strength, 1))
