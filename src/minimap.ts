import type { Polygon } from './city/data'
import type { Tiles } from './city/tiles'

/**
 * A round map in the corner, as in a driving game: the streets round the walker, turned so that where they face is up,
 * and an arrow in the middle where they stand. Each tile is drawn once into two small pictures of its own, the ground
 * (roadbeds, sidewalks) and its buildings, as its data comes in, a tile a frame; the map is all the ground pictures
 * laid down, then all the buildings', turned and clipped to the circle, and drawn again only when the walker has
 * moved or turned enough to show. A tile's things belong to it by their middle and may run well past its square, so a
 * picture covers all of them, not the square alone.
 */

/** Metres from the middle to the rim. */
const REACH = 170
/** Pixels a metre in a tile's pictures: about a pixel a metre on a retina screen. */
const PX = 1.024
/** How far past its square a tile's things are drawn, metres. */
const MARGIN = 160
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
  type Picture = { ground: HTMLCanvasElement; buildings: HTMLCanvasElement; x: number; z: number; w: number; h: number; used: number }
  const pictures = new Map<string, Picture>()
  const last = { x: NaN, z: NaN, yaw: NaN, count: -1 }
  let frame = 0

  /**
   * Fills each of `polygons` in `colour`, each on its own (even-odd within a polygon cuts its holes; across them it cut
   * one polygon out of another where they overlapped); the outlines of all of them, to stroke.
   */
  function fill(c: CanvasRenderingContext2D, polygons: Polygon[], colour: string) {
    const outlines = new Path2D()
    c.fillStyle = colour
    for (const rings of polygons) {
      const path = new Path2D()
      for (const ring of rings) {
        path.moveTo(ring[0], ring[1])
        for (let i = 2; i < ring.length; i += 2) path.lineTo(ring[i], ring[i + 1])
        path.closePath()
      }
      c.fill(path, 'evenodd')
      outlines.addPath(path)
    }
    return outlines
  }

  /** Draws a tile's pictures over all its things reach (up to `MARGIN` past its square), a pixel about a metre. */
  function picture(t: ReturnType<Tiles['dataAround']>[number]): Picture {
    const { roads, setts, sidewalks, buildings } = t.data
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const rings of [...roads, ...setts, ...sidewalks, ...buildings.map((b) => b.rings)]) {
      const ring = rings[0]
      for (let i = 0; i < ring.length; i += 2) {
        x0 = Math.min(x0, ring[i])
        x1 = Math.max(x1, ring[i])
        z0 = Math.min(z0, ring[i + 1])
        z1 = Math.max(z1, ring[i + 1])
      }
    }
    x0 = Math.max(Math.min(x0, t.i * tile), t.i * tile - MARGIN)
    z0 = Math.max(Math.min(z0, t.j * tile), t.j * tile - MARGIN)
    x1 = Math.min(Math.max(x1, (t.i + 1) * tile), (t.i + 1) * tile + MARGIN)
    z1 = Math.min(Math.max(z1, (t.j + 1) * tile), (t.j + 1) * tile + MARGIN)
    const layer = (draw: (c: CanvasRenderingContext2D) => void) => {
      const image = document.createElement('canvas')
      image.width = Math.ceil((x1 - x0) * PX)
      image.height = Math.ceil((z1 - z0) * PX)
      const c = image.getContext('2d')!
      c.scale(PX, PX)
      c.translate(-x0, -z0)
      draw(c)
      return image
    }
    return {
      ground: layer((c) => {
        fill(c, roads, COLOURS.road)
        fill(c, setts, COLOURS.setts)
        fill(c, sidewalks, COLOURS.sidewalk)
      }),
      buildings: layer((c) => {
        const outlines = fill(c, buildings.map((b) => b.rings), COLOURS.building)
        c.strokeStyle = COLOURS.edge
        c.lineWidth = 0.8
        c.stroke(outlines)
      }),
      x: x0,
      z: z0,
      w: Math.ceil((x1 - x0) * PX) / PX,
      h: Math.ceil((z1 - z0) * PX) / PX,
      used: 0,
    }
  }

  /** Draws the map round (x, z), facing `yaw` (the camera's turn about the vertical, 0 facing north). */
  function draw(x: number, z: number, yaw: number) {
    // Hidden (?bare): nothing to draw into.
    const size = canvas.clientWidth
    if (!size) return
    frame++
    const around = tiles.dataAround(x, z, REACH + MARGIN)
    // One new picture a frame at most: a few milliseconds each.
    let fresh = false
    for (const t of around) {
      const key = `${t.i},${t.j}`
      const kept = pictures.get(key)
      if (kept) kept.used = frame
      else if (!fresh) {
        pictures.set(key, { ...picture(t), used: frame })
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
    const shown = around.map((t) => pictures.get(`${t.i},${t.j}`)).filter((p) => p !== undefined)
    for (const p of shown) ctx.drawImage(p.ground, p.x, p.z, p.w, p.h)
    for (const p of shown) ctx.drawImage(p.buildings, p.x, p.z, p.w, p.h)
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
