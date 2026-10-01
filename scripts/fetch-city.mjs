#!/usr/bin/env node
/**
 * Downloads Lower Manhattan (14th Street to the Battery) from New York City's open data and OpenStreetMap, and writes
 * it in 250 m tiles to public/data/city/: index.json and t_<i>_<j>.json, in local metres (x east, z south; three.js:
 * north is -z), the origin near Prince and Greene in SoHo. The walk loads the tiles round the walker as it goes.
 *
 *   buildings  NYC Building Footprints (5zhs-2jue): outline, roof height; joined to MapPLUTO (64uk-42ks) by BBL, or for a
 *              condominium by the lot's point inside the footprint: building class, year built, floors, historic district
 *   sidewalks  NYC Planimetric Database: Sidewalk (52n9-sdep)
 *   roadbeds   NYC Planimetric Database: Roadbed (i36f-5ih7); those an OSM way paved in setts runs through are setts
 *   trees      2015 Street Tree Census (uvpi-gqnh), the living ones
 *   lamps      placed along every kerb here, as the tiles do not see their neighbours' streets
 *   streets    OSM street centrelines with their names, for the "where am I" label
 *
 * Each building's walls are marked here as fronts (facing a sidewalk or a street) or not, for the same reason, and
 * its rings wound so that the client can tell a wall's outward side from the order of its corners (geo.mjs, wound).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { bounds, inPolygon, inRing, lamps, polygonIndex, wound } from './geo.mjs'

const BOX = { south: 40.7, north: 40.741, west: -74.021, east: -73.971 }
const ORIGIN = { lat: 40.72475, lon: -74.00095 }
const TILE = 250
const FT = 0.3048
const SOCRATA = 'https://data.cityofnewyork.us/resource'
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
/** Overpass answers 406 to a request with no User-Agent of its own. */
const HEADERS = { 'User-Agent': 'castiron/0.2 (Lower Manhattan walk prototype)' }
const OUT = new URL('../public/data/city/', import.meta.url)

const M_LAT = 111132.92 - 559.82 * Math.cos((2 * ORIGIN.lat * Math.PI) / 180)
const M_LON = 111412.84 * Math.cos((ORIGIN.lat * Math.PI) / 180)
const round = (v) => Math.round(v * 100) / 100
const project = ([lon, lat]) => [round((lon - ORIGIN.lon) * M_LON), round(-(lat - ORIGIN.lat) * M_LAT)]

async function socrata(id, params) {
  const url = new URL(`${SOCRATA}/${id}.json`)
  for (const [k, v] of Object.entries({ $limit: 100000, ...params })) url.searchParams.set(k, v)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status} ${await response.text()}`)
  return response.json()
}

/** Overpass mirrors refuse a second query at once (429): queries go one after another, each tried on every mirror a few times. */
let queue = Promise.resolve()
function overpass(query) {
  const run = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const url of OVERPASS) {
        const response = await fetch(url, { method: 'POST', headers: HEADERS, body: new URLSearchParams({ data: query }) }).catch(() => null)
        if (response?.ok) return (await response.json()).elements
      }
      await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)))
    }
    throw new Error('Overpass: no mirror answered')
  }
  const result = queue.then(run)
  queue = result.catch(() => {})
  return result
}

const inBox = `within_box(the_geom,${BOX.north},${BOX.west},${BOX.south},${BOX.east})`
const bbox = `${BOX.south},${BOX.west},${BOX.north},${BOX.east}`

/** A ring without its closing point, points nearer than 5 cm to the last kept and points on a straight line dropped. */
function clean(ring) {
  const pts = []
  for (const p of ring.map(project)) {
    const last = pts.at(-1)
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) pts.push(p)
  }
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) <= 0.05) pts.pop()
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const [a, b, c] = [pts[(i + pts.length - 1) % pts.length], pts[i], pts[(i + 1) % pts.length]]
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1])
      // Under about 1.5° of turn: the arcs the footprints are drawn with at rounded corners stay, a jitter goes.
      if (len === 0 || Math.abs(cross) / len < 0.026) {
        pts.splice(i, 1)
        changed = true
      }
    }
  }
  return pts.length >= 3 ? pts.flat() : null
}

/** Each polygon of a (Multi)Polygon as its cleaned rings, the outline first, wound (geo.mjs). */
function polygons(geom) {
  const list = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates]
  return list.map((rings) => rings.map(clean).filter(Boolean)).filter((rings) => rings.length).map(wound)
}

console.log('footprints, PLUTO, sidewalks, roadbeds, trees, OSM…')
const [footprints, pluto, sidewalkRows, roadbedRows, treeRows, settWays, streetWays] = await Promise.all([
  socrata('5zhs-2jue', { $where: inBox, $select: 'the_geom,bin,base_bbl,height_roof,construction_year,feature_code' }),
  socrata('64uk-42ks', {
    $where: `latitude between ${BOX.south - 0.002} and ${BOX.north + 0.002} and longitude between ${BOX.west - 0.002} and ${BOX.east + 0.002}`,
    $select: 'bbl,bldgclass,yearbuilt,numfloors,histdist,latitude,longitude',
  }),
  socrata('52n9-sdep', { $where: inBox, $select: 'the_geom' }),
  socrata('i36f-5ih7', { $where: inBox, $select: 'the_geom' }),
  socrata('uvpi-gqnh', {
    $where: `latitude between ${BOX.south} and ${BOX.north} and longitude between ${BOX.west} and ${BOX.east} and status='Alive'`,
    $select: 'latitude,longitude,tree_dbh,spc_common',
  }),
  overpass(`[out:json][timeout:90];way["highway"]["surface"~"sett|cobblestone|unhewn_cobblestone"](${bbox});out tags geom;`),
  overpass(`[out:json][timeout:90];way["highway"~"primary|secondary|tertiary|residential|unclassified|living_street|pedestrian"]["name"](${bbox});out tags geom;`),
])
console.log(`${footprints.length} footprints, ${pluto.length} lots, ${sidewalkRows.length} sidewalks, ${roadbedRows.length} roadbeds, ${treeRows.length} trees`)

const sidewalks = sidewalkRows.flatMap((s) => polygons(s.the_geom))
const roadbeds = roadbedRows.flatMap((s) => polygons(s.the_geom))
const onStreet = polygonIndex([...sidewalks, ...roadbeds])
const onRoad = polygonIndex(roadbeds)

// Lots by BBL, and by their point for a condominium's footprint (its base lot; MapPLUTO lists the billing lot, 75xx).
const lots = new Map(pluto.map((p) => [String(Math.round(Number(p.bbl))), p]))
const lotCells = new Map()
for (const p of pluto) {
  if (!p.latitude || !p.longitude) continue
  const at = project([Number(p.longitude), Number(p.latitude)])
  const k = `${Math.floor(at[0] / 50)},${Math.floor(at[1] / 50)}`
  if (!lotCells.has(k)) lotCells.set(k, [])
  lotCells.get(k).push({ p, at })
}
function lotAt(rings) {
  const b = bounds(rings[0])
  for (let i = Math.floor(b.x0 / 50); i <= Math.floor(b.x1 / 50); i++) {
    for (let j = Math.floor(b.z0 / 50); j <= Math.floor(b.z1 / 50); j++) {
      const hit = (lotCells.get(`${i},${j}`) ?? []).find(({ at }) => inRing(rings[0], at[0], at[1]))
      if (hit) return hit.p
    }
  }
}

/** Each edge of each ring: 1 where a point 3 m out from its middle is on a sidewalk or a street. */
function fronts(rings) {
  return rings.map((ring) => {
    let s = ''
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length
      const len = Math.hypot(ring[j] - ring[i], ring[j + 1] - ring[i + 1]) || 1
      const [nx, nz] = [(ring[j + 1] - ring[i + 1]) / len, -(ring[j] - ring[i]) / len]
      s += onStreet((ring[i] + ring[j]) / 2 + nx * 3, (ring[i + 1] + ring[j + 1]) / 2 + nz * 3) ? '1' : '0'
    }
    return s
  })
}

const tiles = new Map()
const tileOf = (x, z) => {
  const [i, j] = [Math.floor(x / TILE), Math.floor(z / TILE)]
  const k = `${i}_${j}`
  if (!tiles.has(k)) tiles.set(k, { i, j, buildings: [], sidewalks: [], roads: [], setts: [], trees: [], lamps: [], streets: [] })
  return tiles.get(k)
}
const centre = (ring) => {
  const b = bounds(ring)
  return [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2]
}

let id = 0
let hist = 0
for (const f of footprints) {
  // 2100 is a building; garages, sheds and the like (5100 and up) are left out, a skybridge (2110) too.
  if (f.feature_code && f.feature_code !== '2100') continue
  const shapes = polygons(f.the_geom)
  if (!shapes.length) continue
  const lot = lots.get(String(Math.round(Number(f.base_bbl)))) ?? lotAt(shapes[0])
  const floors = Number(lot?.numfloors) || 0
  let h = Number(f.height_roof) * FT
  if (!(h > 2)) h = floors ? floors * 3.8 + 1 : 12
  for (const rings of shapes) {
    const building = { id: id++, rings, fronts: fronts(rings), h: round(h), floors, year: Number(lot?.yearbuilt) || Number(f.construction_year) || 0, cls: lot?.bldgclass ?? '', hist: lot?.histdist?.includes('SoHo') ? 1 : 0 }
    hist += building.hist
    tileOf(...centre(rings[0])).buildings.push(building)
  }
}

// A roadbed is Belgian block where an OSM way paved in setts runs through it.
const settPoints = []
for (const way of settWays.filter((w) => w.tags.highway !== 'footway')) {
  const g = way.geometry.map((p) => project([p.lon, p.lat]))
  for (let i = 0; i + 1 < g.length; i++) {
    const n = Math.ceil(Math.hypot(g[i + 1][0] - g[i][0], g[i + 1][1] - g[i][1]) / 3)
    for (let k = 0; k <= n; k++) settPoints.push([g[i][0] + ((g[i + 1][0] - g[i][0]) * k) / n, g[i][1] + ((g[i + 1][1] - g[i][1]) * k) / n])
  }
}
const cobbled = (p) => {
  const b = bounds(p[0])
  return settPoints.some(([x, z]) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && inPolygon(p, x, z))
}
for (const p of sidewalks) tileOf(...centre(p[0])).sidewalks.push(p)
for (const p of roadbeds) {
  const tile = tileOf(...centre(p[0]))
  ;(cobbled(p) ? tile.setts : tile.roads).push(p)
}
for (const t of treeRows) {
  const [x, z] = project([Number(t.longitude), Number(t.latitude)])
  tileOf(x, z).trees.push([x, z, Number(t.tree_dbh) || 4, t.spc_common ?? ''])
}
for (const lamp of lamps(sidewalks, onRoad)) tileOf(lamp[0], lamp[1]).lamps.push(lamp)
// A street's line goes to every tile one of its segments starts in, so the label finds it wherever the walker stands.
for (const way of streetWays) {
  const line = way.geometry.flatMap((p) => project([p.lon, p.lat]))
  const seen = new Set()
  for (let i = 0; i < line.length; i += 2) {
    const tile = tileOf(line[i], line[i + 1])
    if (!seen.has(tile)) tile.streets.push({ name: way.tags.name, line })
    seen.add(tile)
  }
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const index = { origin: ORIGIN, tile: TILE, box: { min: project([BOX.west, BOX.north]), max: project([BOX.east, BOX.south]) }, tiles: [] }
let bytes = 0
for (const t of tiles.values()) {
  const { i, j, ...content } = t
  const json = JSON.stringify(content)
  await writeFile(new URL(`t_${i}_${j}.json`, OUT), json)
  // The tallest building of a tile: the far field loads tiles with towers from further off.
  index.tiles.push({ i, j, bytes: json.length, top: Math.round(Math.max(0, ...t.buildings.map((b) => b.h))) })
  bytes += json.length
}
await writeFile(new URL('index.json', OUT), JSON.stringify(index))
console.log(`${id} buildings (${hist} in the SoHo historic district), ${sidewalks.length} sidewalks, ${roadbeds.length} roadbeds, ${treeRows.length} trees, ${index.tiles.length} tiles, ${(bytes / 1e6).toFixed(1)} MB`)
