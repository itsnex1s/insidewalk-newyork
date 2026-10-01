// The loading screen's still and the social card, rendered from the walk itself against a running dev server:
//   node scripts/posters.mjs [--base http://localhost:5240]
// public/poster.webp is the opening view (the default ?at) at 2:1, so on any screen up to that wide it is cropped as the
// camera crops the scene and the 3D fades in exactly where it stood; index.html inlines a blurred 48 px copy of it to
// show before it has come. public/og.jpg is 1200 × 630, looking south over SoHo to the Financial District.
// Needs cwebp and ImageMagick (brew install webp imagemagick).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://localhost:5240'
const dir = mkdtempSync(join(tmpdir(), 'city-posters-'))
const still = (query, out, w, h, ...more) => execFileSync('node', ['scripts/still.mjs', query, out, '--base', base, '--w', w, '--h', h, ...more], { stdio: 'inherit' })

try {
  still('bare', join(dir, 'poster.png'), '2000', '1000')
  execFileSync('cwebp', ['-quiet', '-q', '72', join(dir, 'poster.png'), '-o', 'public/poster.webp'])
  execFileSync('magick', [join(dir, 'poster.png'), '-resize', '48x24', '-quality', '50', join(dir, 'lqip.webp')])
  const lqip = readFileSync(join(dir, 'lqip.webp')).toString('base64')
  const html = readFileSync('index.html', 'utf8').replace(/data:image\/webp;base64,[A-Za-z0-9+/=]*/, `data:image/webp;base64,${lqip}`)
  writeFileSync('index.html', html)

  // Once the whole skyline has streamed in.
  still('bare&at=0,200,200,-12,260', join(dir, 'og.png'), '1200', '630', '--eval', 'new Promise((done) => setTimeout(() => done(city.redraw()), 12000))')
  execFileSync('magick', [join(dir, 'og.png'), '-quality', '82', 'public/og.jpg'])
} finally {
  rmSync(dir, { recursive: true, force: true })
}
