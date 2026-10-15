// Builds the app, notification and tray icons from the original brand art (04a·T4). Run: npm run icons
// Output is committed: resources/icon.{png,ico}, resources/mascot.png, resources/tray/*.png,
// resources/brand/mascot.svg (rendered from the Mascot component) and resources/brand/tray-*.svg.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'
import { transformWithEsbuild } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const resources = join(root, 'resources')
const brand = join(resources, 'brand')
const trayDir = join(resources, 'tray')

const INK = '#3B2416'
const ORANGE = '#F29A32'
const RIM = '#D2691E'
const DOT = { idle: '#9A9A9A', busy: '#F28C38', paused: '#E7A93A', attention: '#E5483A' }

/** Rasterise an SVG at an exact pixel size (density scales the vector instead of resampling a bitmap). */
function png(svg, size, viewBox) {
  return sharp(Buffer.from(svg), { density: (72 * size) / viewBox })
    .resize(size, size)
    .png()
    .toBuffer()
}

/** Tray glyph on a 32-unit grid: the orange clock-face disc with hands, and a status dot. */
function traySvg(dot, minuteStep = 0) {
  const angle = (minuteStep * 45 * Math.PI) / 180
  const mx = (14 + 7.5 * Math.sin(angle)).toFixed(2)
  const my = (15 - 7.5 * Math.cos(angle)).toFixed(2)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <ellipse cx="12.6" cy="15.2" rx="11" ry="12" fill="${RIM}" stroke="${INK}" stroke-width="2"/>
  <ellipse cx="14" cy="15" rx="11" ry="12" fill="${ORANGE}" stroke="${INK}" stroke-width="2"/>
  <path d="M14 15 L10 12" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M14 15 L${mx} ${my}" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
  <circle cx="25" cy="25" r="6" fill="${dot}" stroke="${INK}" stroke-width="2"/>
</svg>
`
}

async function renderMascot() {
  const file = join(root, 'src/renderer/src/components/brand/mascot.tsx')
  const { code } = await transformWithEsbuild(await readFile(file, 'utf8'), file, {
    loader: 'tsx',
    jsx: 'automatic',
    format: 'esm'
  })
  // Written under node_modules so `react/jsx-runtime` resolves from the project.
  const cache = join(root, 'node_modules/.cache/miss-minutes')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, 'mascot.mjs'), code)
  const { Mascot } = await import(pathToFileURL(join(cache, 'mascot.mjs')).href)
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const svg = renderToStaticMarkup(createElement(Mascot, { pose: 'wave', size: 200 }))
  // Theme-aware colours are var(--x, #hex) in the app; a standalone SVG gets the plain fallback.
  return svg.replace(/var\(--[\w-]+, (#[0-9A-Fa-f]+)\)/g, '$1') + '\n'
}

async function main() {
  await mkdir(trayDir, { recursive: true })

  // App icon: PNG for the window, multi-size ICO for Windows (taskbar, installer, shortcuts).
  const icon = await readFile(join(brand, 'icon.svg'), 'utf8')
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = await Promise.all(sizes.map((s) => png(icon, s, 256)))
  await writeFile(join(resources, 'icon.png'), pngs.at(-1))
  await writeFile(join(resources, 'icon.ico'), await pngToIco(pngs))

  // Mascot: static SVG + a 256px PNG for notifications.
  const mascot = await renderMascot()
  await writeFile(join(brand, 'mascot.svg'), mascot)
  await writeFile(
    join(resources, 'mascot.png'),
    await sharp(Buffer.from(mascot), { density: 72 * (256 / 200) })
      .png()
      .toBuffer()
  )

  // Tray: 16px base with @1.5x/@2x, which Electron's nativeImage picks by display scale.
  const tray = {
    idle: traySvg(DOT.idle),
    paused: traySvg(DOT.paused),
    attention: traySvg(DOT.attention)
  }
  for (let frame = 0; frame < 8; frame++) tray[`busy-${frame}`] = traySvg(DOT.busy, frame)
  for (const [name, svg] of Object.entries(tray)) {
    await writeFile(join(brand, `tray-${name}.svg`), svg)
    for (const [suffix, size] of [
      ['', 16],
      ['@1.5x', 24],
      ['@2x', 32]
    ])
      await writeFile(join(trayDir, `tray-${name}${suffix}.png`), await png(svg, size, 32))
  }

  console.log(`icons: ${sizes.length} icon sizes, mascot, ${Object.keys(tray).length} tray states`)
}

await main()
