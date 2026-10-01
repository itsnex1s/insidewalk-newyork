import * as THREE from 'three/webgpu'
import type { Look } from './engine/look'

/**
 * The day over Lower Manhattan, late summer, from the afternoon into the night: the look at a few hours, and every
 * hour between drawn from the two either side. The sun sets in the west-north-west, down the cross streets (SoHo's
 * grid turns 33° from north, its cross streets run to 303°), so at the golden hour it shines straight along them as it
 * does on Manhattanhenge's evenings. After it the sky goes orange and blue, the street lights and the windows come on,
 * and the night is the city's own light under a sky it lights from below; the moon stands in for the sun's light.
 */

type RGB = [number, number, number]
interface Key {
  /** The sun's bearing (degrees clockwise from north) and height (above the horizon); the light's, if not the sun's. */
  sun: [number, number]
  light?: [number, number]
  lightColor: number
  lightIntensity: number
  exposure: number
  haze: RGB
  fog: number
  clear: number
  sky: { turbidity: number; rayleigh: number; mie: number; mieG: number; cloudCoverage: number; deep: RGB }
  ground: number
  environment: number
  grade: { saturation: number; contrast: number; warmth: number }
  glow: RGB
  lights: number
}

const KEYS: [number, Key][] = [
  // The afternoon the walk opens in: the sun high in the south-west.
  [16.5, { sun: [222, 38], lightColor: 0xffe8cc, lightIntensity: 6.4, exposure: 0.62, haze: [1.75, 1.66, 1.56], fog: 0.00045, clear: 350, sky: { turbidity: 2.6, rayleigh: 2.4, mie: 0.005, mieG: 0.8, cloudCoverage: 0.35, deep: [0.6, 0.76, 1.02] }, ground: 0xb4ab9c, environment: 0.75, grade: { saturation: 0.95, contrast: 1.1, warmth: 0.035 }, glow: [0, 0, 0], lights: 0 }],
  // The golden hour: the sun low down the cross streets, long shadows across the avenues, the haze gold.
  [19.4, { sun: [303, 7], lightColor: 0xffb47a, lightIntensity: 5.2, exposure: 0.58, haze: [1.0, 0.74, 0.52], fog: 0.0005, clear: 320, sky: { turbidity: 3.2, rayleigh: 2.4, mie: 0.004, mieG: 0.8, cloudCoverage: 0.35, deep: [0.72, 0.8, 1] }, ground: 0xa08a72, environment: 0.6, grade: { saturation: 1.05, contrast: 1.12, warmth: 0.1 }, glow: [0, 0, 0], lights: 0.06 }],
  // Just after sunset: an orange west, the last light low and red, the lights coming on.
  [20.15, { sun: [304, -2.5], light: [304, 4], lightColor: 0xff9466, lightIntensity: 0.9, exposure: 1.5, haze: [0.55, 0.4, 0.38], fog: 0.0007, clear: 260, sky: { turbidity: 4, rayleigh: 3, mie: 0.006, mieG: 0.82, cloudCoverage: 0.3, deep: [0.8, 0.86, 1] }, ground: 0x6a5a50, environment: 0.9, grade: { saturation: 1.05, contrast: 1.1, warmth: 0.06 }, glow: [0.012, 0.008, 0.007], lights: 0.55 }],
  // The blue hour: the sky deep blue, the streets lit.
  [20.8, { sun: [306, -7], light: [140, 35], lightColor: 0x9fb4ff, lightIntensity: 0.14, exposure: 2.4, haze: [0.07, 0.07, 0.1], fog: 0.0008, clear: 200, sky: { turbidity: 3, rayleigh: 3, mie: 0.005, mieG: 0.8, cloudCoverage: 0.3, deep: [1, 1, 1] }, ground: 0x2a2a30, environment: 0.8, grade: { saturation: 1, contrast: 1.08, warmth: 0 }, glow: [0.03, 0.022, 0.02], lights: 0.9 }],
  // Night: the moon over the harbour, the sky a city's, brown at the horizon and blue-grey above.
  [22, { sun: [320, -20], light: [140, 40], lightColor: 0x9fb4ff, lightIntensity: 0.12, exposure: 2.6, haze: [0.035, 0.03, 0.03], fog: 0.0009, clear: 150, sky: { turbidity: 3, rayleigh: 3, mie: 0.005, mieG: 0.8, cloudCoverage: 0.3, deep: [1, 1, 1] }, ground: 0x201c1a, environment: 0.7, grade: { saturation: 1, contrast: 1.1, warmth: 0 }, glow: [0.035, 0.025, 0.02], lights: 1 }],
]

/** The three times the walk offers, and the hour each is. */
export const TIMES = { day: 16.5, sunset: 19.4, night: 22 } as const
export type Time = keyof typeof TIMES

/** Towards the sun at a bearing and height, degrees: x east, y up, z south. */
const towards = ([bearing, height]: [number, number]) => {
  const [b, h] = [THREE.MathUtils.degToRad(bearing), THREE.MathUtils.degToRad(height)]
  return new THREE.Vector3(Math.sin(b) * Math.cos(h), Math.sin(h), -Math.cos(b) * Math.cos(h))
}
const mixColor = (a: number, b: number, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t).getHex()
const rgb = ([r, g, b]: RGB) => new THREE.Color().setRGB(r, g, b)
const lerpRGB = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as RGB
const lerp = THREE.MathUtils.lerp

/** The look at `hour` (16.5 to 22, held at either end). */
export function lookAt(hour: number): Look {
  // The keys either side; before the first or after the last, that one alone.
  const next = KEYS.findIndex(([h]) => h > hour)
  const last = KEYS.length - 1
  const [h0, a] = KEYS[next < 0 ? last : Math.max(0, next - 1)]
  const [h1, b] = KEYS[next < 0 ? last : next]
  // Eased between the keys, so a change of time does not turn at each.
  const s = h1 > h0 ? THREE.MathUtils.smoothstep(hour, h0, h1) : 0
  const sun = towards(a.sun).lerp(towards(b.sun), s).normalize()
  const light = towards(a.light ?? a.sun).lerp(towards(b.light ?? b.sun), s).normalize()
  return {
    sun,
    light,
    sunColor: mixColor(a.lightColor, b.lightColor, s),
    sunIntensity: lerp(a.lightIntensity, b.lightIntensity, s),
    exposure: lerp(a.exposure, b.exposure, s),
    haze: rgb(lerpRGB(a.haze, b.haze, s)),
    fog: lerp(a.fog, b.fog, s),
    clear: lerp(a.clear, b.clear, s),
    sky: {
      turbidity: lerp(a.sky.turbidity, b.sky.turbidity, s),
      rayleigh: lerp(a.sky.rayleigh, b.sky.rayleigh, s),
      mie: lerp(a.sky.mie, b.sky.mie, s),
      mieG: lerp(a.sky.mieG, b.sky.mieG, s),
      cloudCoverage: lerp(a.sky.cloudCoverage, b.sky.cloudCoverage, s),
      cloudDensity: 0.4,
      cloudElevation: 0.5,
      deep: rgb(lerpRGB(a.sky.deep, b.sky.deep, s)),
    },
    ground: mixColor(a.ground, b.ground, s),
    environment: lerp(a.environment, b.environment, s),
    grade: { saturation: lerp(a.grade.saturation, b.grade.saturation, s), contrast: lerp(a.grade.contrast, b.grade.contrast, s), warmth: lerp(a.grade.warmth, b.grade.warmth, s) },
    glow: rgb(lerpRGB(a.glow, b.glow, s)),
    lights: lerp(a.lights, b.lights, s),
  }
}

/** The hour `?time=` asks for: day, sunset or night, or an hour such as 19.5; the afternoon otherwise. */
export function hourOf(param: string | null) {
  if (!param) return TIMES.day
  if (param in TIMES) return TIMES[param as Time]
  const h = Number(param)
  return Number.isFinite(h) ? THREE.MathUtils.clamp(h, KEYS[0][0], KEYS.at(-1)![0]) : TIMES.day
}
