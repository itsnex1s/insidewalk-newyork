/** What the device can do, as the engine's render/device decides it (trimmed to what the walk needs). */

export const phone = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { deviceMemory?: number; gpu?: unknown }

/** A device to spare: `?lite`, or a phone without WebGPU or short of memory or cores. Its trees have half the leaves. */
export const weak = (typeof location !== 'undefined' && new URLSearchParams(location.search).has('lite'))
  || (phone && (!nav.gpu || (nav.deviceMemory ?? 8) <= 3 || (nav.hardwareConcurrency ?? 8) < 4))
