import { pick, seeded } from '../engine/util'
import type { BuildingData } from './data'

/**
 * What each building is built as, from MapPLUTO: SoHo's cast-iron lofts (the historic district's commercial buildings
 * of 1850–1900, painted iron fronts of tall windows between columns), stone lofts and office buildings, brick walk-ups
 * with fire escapes (class C, the tenements), and what went up after 1960 in glass or plain brick.
 */
export type Style = 'iron' | 'stone' | 'brick' | 'modern'

export interface Dress {
  style: Style
  /** The front's paint, brick or stone; the trim (window frames, lintels, sills); the back and party walls' brick. */
  paint: number
  trim: number
  back: number
  /** Height of the shop floor, of each storey above it, and of the cornice zone at the top with no windows. */
  ground: number
  storey: number
  parapet: number
  /** Width of a window bay, metres, as near as an edge's length allows. */
  bay: number
  /** Arched window heads (iron and stone). */
  arched: boolean
  /** Fire escapes on the street fronts (walk-ups). */
  escapes: boolean
  /** A timber water tank on the roof. */
  tank: boolean
  /** A projecting cornice, metres out from the wall. */
  cornice: number
}

const IRON = [0xe9e1cc, 0xf1eee6, 0xcfccc2, 0xb2ab9f, 0xa3ab96, 0x3e4a3d, 0x2c2c2b, 0xdcc9a0, 0xbcc5c7, 0xe4d7bd, 0x8c8578]
const BRICK = [0x8a3b2a, 0x713e2e, 0x9c4f37, 0x5a3229, 0xa86b4b, 0x7e4a36, 0x94452f]
const PAINTED_BRICK = [0xe6e1d7, 0xd8cdb8, 0xb9b2a5, 0x2e3133]
const STONE = [0xd2c7b0, 0xc8bba0, 0x75533f, 0x9e9a91, 0xcca37c, 0xe0d8c6]
const TRIM_LIGHT = [0xf3f0e8, 0xe8e2d4, 0xd6cfbf]
const TRIM_DARK = [0x1f2224, 0x2e3a33, 0x3b2f28]

export function dress(b: BuildingData, index: number): Dress {
  const random = seeded(index * 7919 + 17)
  const floors = b.floors || Math.max(1, Math.round(b.h / 3.9))
  const c = b.cls[0] ?? ''
  const old = b.year > 0 && b.year < 1960
  const tall = b.h > 45
  let style: Style
  if (!old && b.year >= 1960) style = random() < 0.6 ? 'modern' : 'brick'
  else if (tall) style = 'stone'
  // The district's lofts, condominiums (R) and co-ops (D) of before 1915: most of them iron fronts, the rest stone.
  else if (b.hist && c !== 'C' && floors <= 9 && (!b.year || b.year < 1915)) style = random() < 0.66 ? 'iron' : random() < 0.75 ? 'stone' : 'brick'
  else if ('CBAS'.includes(c) || floors <= 3) style = 'brick'
  else style = random() < 0.45 ? 'stone' : random() < 0.5 ? 'iron' : 'brick'

  const back = pick(random, BRICK)
  const ground = style === 'iron' ? 4.8 + random() * 0.8 : style === 'modern' ? 4.5 : 4 + random() * 0.8
  const parapet = style === 'modern' ? 1.1 : 1.4 + random() * 0.6
  const upper = Math.max(1, floors - 1)
  const storey = Math.min(5.6, Math.max(2.9, (b.h - ground - parapet) / upper))
  const painted = style === 'brick' && random() < 0.18
  const paint = style === 'iron' ? pick(random, IRON) : style === 'stone' ? pick(random, STONE) : style === 'brick' ? (painted ? pick(random, PAINTED_BRICK) : back) : random() < 0.5 ? 0x2a2d30 : 0xb4b8b9
  const dark = (paint >> 16) + ((paint >> 8) & 255) + (paint & 255) < 300
  const trim = style === 'iron' ? (dark ? 0x1e2021 : paint) : dark || random() < 0.35 ? pick(random, TRIM_DARK) : pick(random, TRIM_LIGHT)
  return {
    style,
    paint,
    trim,
    back,
    ground,
    storey,
    parapet,
    bay: style === 'iron' ? 3.1 + random() * 0.6 : style === 'stone' ? 2.4 + random() * 0.5 : style === 'brick' ? 1.8 + random() * 0.3 : 1.5,
    arched: (style === 'iron' || style === 'stone') && random() < 0.4,
    escapes: style === 'brick' && old && floors >= 4 && floors <= 8 && ('CSDKB'.includes(c) || random() < 0.4),
    tank: old && floors >= 5 && b.h < 70 && random() < 0.45,
    cornice: style === 'modern' ? 0 : style === 'iron' ? 0.8 + random() * 0.3 : 0.5 + random() * 0.3,
  }
}
