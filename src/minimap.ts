import type { Polygon } from './city/data'
import type { Tiles } from './city/tiles'

/**
 * A round map in the corner, as in a driving game: the streets round the walker, turned so that where they face is up,
 * and an arrow in the middle where they stand. Each tile is drawn once into a small picture of its own (roadbeds,
 * sidewalks, buildings) as its data comes in, a tile a frame; the map is those pictures laid down, turned and clipped
 * to the circle, and drawn again only when the walker has moved or turned enough to show.
 */

/** Metres from the middle to the rim. */
const REACH = 170
/** Pixels a tile's picture is across (250 m): about a metre a pixel on a retina screen. */
const RASTER = 256
/** Pictures kept, the least lately used let go past it. */
const KEEP = 64

const COLOURS = {
  ground: '#2b2f34',
  sidewalk: '#59606a',
  road: '#9aa1a9',
  setts: '#a3907a',
  building: '#1a1c20',
  edge: '#15171a',
}

export function minimap(canvas: HTMLCanvasElement, tiles: Tiles, tile: number) {
  const ctx = canvas.getContext('2d')!
  const pictures = new Map<string, { image: HTMLCanvasElement; used: number }>()
  const last = { x: NaN, z: NaN, yaw: NaN, count: -1 }
  let frame = 0

  function fill(c: CanvasRenderingContext2D, polygons: Polygon[], colour: string) {
    const path = new Path2D()
    for (const rings of polygons) {
      for (const ring of rings) {
        path.moveTo(ring[0], ring[1])
        for (let i = 2; i < ring.length; i += 2) path.lineTo(ring[i], ring[i + 1])
        path.closePath()
      }
    }
    c.fillStyle = colour
    c.fill(path, 'evenodd')
    return path
  }

  /** Draws a tile's picture: its own square of the plan, a pixel about a metre. */
  function picture(t: ReturnType<Tiles['dataAround']>[number]) {
    const image = document.createElement('canvas')
    image.width = image.height = RASTER
    const c = image.getContext('2d')!
    c.scale(RASTER / tile, RASTER / tile)
    c.translate(-t.i * tile, -t.j * tile)
    fill(c, t.data.roads, COLOURS.road)
    fill(c, t.data.setts, COLOURS.setts)
    fill(c, t.data.sidewalks, COLOURS.sidewalk)
    const outlines = fill(c, t.data.buildings.map((b) => b.rings), COLOURS.building)
    c.strokeStyle = COLOURS.edge
    c.lineWidth = 0.8
    c.stroke(outlines)
    return image
  }

  /** Draws the map round (x, z), facing `yaw` (the camera's turn about the vertical, 0 facing north). */
  function draw(x: number, z: number, yaw: number) {
    // Hidden (?bare): nothing to draw into.
    const size = canvas.clientWidth
    if (!size) return
    frame++
    const around = tiles.dataAround(x, z, REACH * 1.5)
    // One new picture a frame at most: a few milliseconds each.
    let fresh = false
    for (const t of around) {
      const key = `${t.i},${t.j}`
      const kept = pictures.get(key)
      if (kept) kept.used = frame
      else if (!fresh) {
        pictures.set(key, { image: picture(t), used: frame })
        fresh = true
      }
    }
    if (pictures.size > KEEP) {
      const old = [...pictures].sort((a, b) => a[1].used - b[1].used).slice(0, pictures.size - KEEP)
      for (const [key] of old) pictures.delete(key)
    }
    const scale = devicePixelRatio
    if (canvas.width !== Math.round(size * scale)) canvas.width = canvas.height = Math.round(size * scale)
    // Half a metre or a degree: less does not show at this scale.
    if (!fresh && Math.hypot(x - last.x, z - last.z) < 0.5 && Math.abs(yaw - last.yaw) < 0.017) return
    Object.assign(last, { x, z, yaw })

    const r = size / 2
    const perMetre = r / REACH
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(r, r, r - 1, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = COLOURS.ground
    ctx.fillRect(0, 0, size, size)
    // The plan turned so the way the walker faces (−sin yaw, −cos yaw on the plan) points up the screen.
    ctx.translate(r, r)
    ctx.rotate(yaw)
    ctx.scale(perMetre, perMetre)
    ctx.translate(-x, -z)
    ctx.imageSmoothingQuality = 'high'
    for (const t of around) {
      const kept = pictures.get(`${t.i},${t.j}`)
      if (kept) ctx.drawImage(kept.image, t.i * tile, t.j * tile, tile, tile)
    }
    ctx.restore()

    // North on the rim, where the plan's −z now points.
    const north = yaw - Math.PI / 2
    const [nx, ny] = [r + Math.cos(north) * (r - 11), r + Math.sin(north) * (r - 11)]
    ctx.fillStyle = 'rgba(14, 15, 17, 0.85)'
    ctx.beginPath()
    ctx.arc(nx, ny, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f6f1ea'
    ctx.font = '600 10px "Schibsted Grotesk", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', nx, ny + 0.5)

    // The walker: an arrow pointing the way they face (always up).
    ctx.translate(r, r)
    ctx.beginPath()
    ctx.moveTo(0, -8)
    ctx.lineTo(6, 7)
    ctx.lineTo(0, 3.5)
    ctx.lineTo(-6, 7)
    ctx.closePath()
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fill()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  return { draw }
}
