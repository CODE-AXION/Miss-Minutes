// Builds the frozen Python engine, engine/dist/mm-engine/mm-engine.exe (11b). Run: npm run engine
// Uses its own venv (engine/.venv), never the project .venv, and PyInstaller --onedir via mm-engine.spec.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const engine = join(root, 'engine')
const venv = join(engine, '.venv')
const python = join(venv, 'Scripts', 'python.exe')
const exe = join(engine, 'dist', 'mm-engine', 'mm-engine.exe')
const handbrake = join(root, '..', 'tools', 'handbrake')

function run(cmd, args, opts = {}) {
  console.log(`[engine] ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`)
  return r
}

if (!existsSync(python)) run('py', ['-3.12', '-m', 'venv', venv])
run(python, [
  '-m',
  'pip',
  'install',
  '--disable-pip-version-check',
  '-q',
  '-r',
  join(engine, 'requirements-build.txt')
])
// No `playwright install`: the engine attaches to the user's Chrome over CDP, never a Playwright browser.
run(python, [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--log-level',
  'WARN',
  '--distpath',
  join(engine, 'dist'),
  '--workpath',
  join(engine, 'build'),
  join(engine, 'mm-engine.spec')
])
run(exe, ['--help'], { stdio: 'ignore' })
console.log(`[engine] smoke test ok: ${exe}`)

// HandBrakeCLI ships unmodified next to its licence files (extraResources); say where its source is.
const hbCli = join(handbrake, 'HandBrakeCLI.exe')
if (!existsSync(hbCli)) throw new Error(`HandBrakeCLI.exe not found in ${handbrake}`)
const hbVersion = spawnSync(hbCli, ['--version'], { encoding: 'utf8' }).stdout.match(
  /HandBrake (\S+)/
)?.[1]
mkdirSync(join(handbrake, 'doc'), { recursive: true })
writeFileSync(
  join(handbrake, 'doc', 'SOURCE.txt'),
  `HandBrakeCLI ${hbVersion ?? ''} is distributed unmodified under the GNU GPL v2 (see COPYING).\n` +
    `Source code: https://handbrake.fr/ and https://github.com/HandBrake/HandBrake` +
    (hbVersion ? `/releases/tag/${hbVersion}` : '') +
    '\n'
)
console.log(`[engine] HandBrake ${hbVersion ?? '(version unknown)'}: wrote doc/SOURCE.txt`)
