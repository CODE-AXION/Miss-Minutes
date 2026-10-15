import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { readFile, rm } from 'fs/promises'
import { get } from 'http'
import { join } from 'path'
import type { LibraryInfo, SigninOutcome } from '@shared/api'
import type { CheckResult, SigninEvent } from '@shared/protocol'
import { engineCommand, type Subcommand } from './settings'
import type { State } from './state'
import { ENGINE_ENV, killTree, LineSplitter, type LogBuffer, type Supervisor } from './worker'

const CHECK_TIMEOUT_MS = 20_000
const BUSY = 'Wait until the current video finishes: its Chrome is in use.'

/** signin = sign in (or verify), switch = sign out first so any account can sign in, signout = only sign out. */
export type SigninMode = 'signin' | 'switch' | 'signout'

const MODE_FLAGS: Record<SigninMode, string[]> = {
  signin: [],
  switch: ['--switch'],
  signout: ['--signout-only']
}

/**
 * The engine's one-shot commands (11c·T3, T5): `check` for the wizard, and `signin` for the wizard and the
 * Google account card. Both are spawned through engineCommand(), like the worker. At most one sign-in runs, and
 * never next to a busy worker: they share Chrome's port and profile.
 */
export class EngineTasks {
  private signin: { child: ChildProcessWithoutNullStreams; cancelled: boolean } | null = null

  constructor(
    private state: State,
    private supervisor: Supervisor,
    private log: LogBuffer,
    private sendEvent: (event: SigninEvent) => void
  ) {}

  /** `check` for this watch folder: one JSON line on stdout. */
  check(watchDir: string): Promise<CheckResult> {
    const child = this.spawn('check', { ...this.state.settings, watchDir })
    return new Promise<CheckResult>((resolve, reject) => {
      const out: string[] = []
      const err: string[] = []
      collect(
        child,
        (line) => out.push(line),
        (line) => {
          err.push(line)
          this.log.add('worker', line)
        }
      )
      const timer = setTimeout(() => {
        killTree(child)
        reject(new Error('The checks took too long (20 s).'))
      }, CHECK_TIMEOUT_MS)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        try {
          resolve(JSON.parse(out[out.length - 1]) as CheckResult)
        } catch {
          reject(
            new Error(`The checks failed (exit code ${code}). ${err[err.length - 1] ?? ''}`.trim())
          )
        }
      })
    })
  }

  /**
   * Runs `signin` in `mode` and resolves with how it ended. From the wizard (`setup`) no worker may be running.
   * From Settings an idle worker is paused for the duration (and resumed unless it was paused already), so no
   * video starts on the same Chrome mid sign-in; a busy one refuses.
   */
  async runSignin(mode: SigninMode, { setup = false } = {}): Promise<SigninOutcome> {
    if (this.signin) throw new Error('A sign-in is already open.')
    let resume = false
    if (this.supervisor.running) {
      if (setup) throw new Error('Miss Minutes is already running; use Settings → Google account.')
      if (!this.supervisor.up) throw new Error('The worker is starting; try again in a moment.')
      if (this.supervisor.busy) throw new Error(BUSY)
      if (!this.state.worker.paused) {
        const ack = await this.supervisor.send({ cmd: 'pause' })
        if (!ack.ok) throw new Error(ack.error ?? 'Could not pause the worker')
        resume = true
      }
      if (this.supervisor.busy) {
        // A video was picked just before the pause.
        if (resume) this.resume()
        throw new Error(BUSY)
      }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawn('signin', this.state.settings, MODE_FLAGS[mode])
    } catch (error) {
      if (resume) this.resume()
      throw error
    }
    const run = { child, cancelled: false }
    this.signin = run
    this.state.setSigninRunning(true)

    return new Promise<SigninOutcome>((resolve) => {
      let outcome: SigninOutcome | null = null
      const err: string[] = []
      collect(
        child,
        (line) => {
          let event: SigninEvent
          try {
            event = JSON.parse(line)
          } catch {
            this.log.add('app', `warning: unreadable sign-in line: ${line.slice(0, 200)}`)
            return
          }
          if (event.type === 'signin_ok') {
            this.state.setGoogleAccount({ email: event.account, checkedAt: event.ts })
            outcome = { ok: true, account: event.account }
          } else if (event.type === 'signout_ok') {
            this.state.setGoogleAccount(null)
            outcome = { ok: true, account: null }
          } else if (event.type === 'signin_failed') {
            outcome = { ok: false, error: event.error }
          }
          this.sendEvent(event)
        },
        (line) => {
          err.push(line)
          this.log.add('worker', line)
        }
      )
      let gone = false
      const onGone = (code: number | null, error?: Error): void => {
        if (gone) return
        gone = true
        this.signin = null
        this.state.setSigninRunning(false)
        const result: SigninOutcome = run.cancelled
          ? { ok: false, error: 'Cancelled' }
          : (outcome ?? {
              ok: false,
              error:
                error?.message ?? err[err.length - 1] ?? `The sign-in stopped (exit code ${code})`
            })
        // A worker that paused itself because the session expired on the hidden desktop (11f·T2) goes on once signed in.
        const signedIn = result.ok && mode !== 'signout'
        if (resume || (signedIn && this.state.worker.pauseReason === 'signin')) this.resume()
        this.supervisor.signinEnded()
        this.log.add('app', `Google ${mode}: ${result.ok ? 'done' : result.error}`)
        resolve(result)
      }
      child.on('exit', (code) => onGone(code))
      child.on('error', (error) => onGone(null, error))
    })
  }

  /** Ends the running sign-in (its process tree only: Chrome itself stays open, decision 6). */
  cancelSignin(): void {
    if (!this.signin) return
    this.signin.cancelled = true
    killTree(this.signin.child)
  }

  /** Deletes the automation Chrome profile (bundled mode only; the project folder's is never touched). */
  async resetProfile(): Promise<void> {
    const settings = this.state.settings
    if (settings.engine !== 'bundled')
      throw new Error(
        "Developer mode uses the project folder's Chrome profile; the app doesn't reset it."
      )
    if (this.signin) throw new Error('A sign-in is open; finish or cancel it first.')
    if (this.supervisor.busy) throw new Error(BUSY)
    if (await cdpReady(settings.port))
      throw new Error('The automation Chrome is still running. Try again once it has closed.')
    await rm(settings.profileDir, { recursive: true, force: true })
    this.state.setGoogleAccount(null)
    this.log.add('app', `Chrome profile deleted: ${settings.profileDir}`)
  }

  private resume(): void {
    this.supervisor
      .send({ cmd: 'resume' })
      .catch((error: Error) => this.log.add('app', `resume failed: ${error.message}`))
  }

  private spawn(
    sub: Subcommand,
    settings: State['settings'],
    extra: string[] = []
  ): ChildProcessWithoutNullStreams {
    const command = engineCommand(settings, sub, extra)
    if ('problem' in command) throw new Error(command.problem)
    this.log.add('app', `running: ${command.exe} ${command.args.join(' ')}`)
    return spawn(command.exe, command.args, {
      cwd: command.cwd,
      windowsHide: true,
      env: ENGINE_ENV
    })
  }
}

/** The library at `folder` (11d·T1 step 4): its index.json counts, or null when there is none to read. */
export async function inspectLibrary(folder: string): Promise<LibraryInfo | null> {
  try {
    const index = JSON.parse(await readFile(join(folder, 'index.json'), 'utf-8')) as {
      videos?: Record<string, { status?: string }>
    }
    const entries = Object.values(index.videos ?? {})
    const ignored = entries.filter((e) => e.status === 'baseline').length
    return { path: folder, meetings: entries.length - ignored, ignored }
  } catch {
    return null
  }
}

/** stdout lines to `onOut`; stderr lines to `onErr`. */
function collect(
  child: ChildProcessWithoutNullStreams,
  onOut: (line: string) => void,
  onErr: (line: string) => void
): void {
  const stdout = new LineSplitter()
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk: string) => stdout.push(chunk).forEach(onOut))
  const stderr = new LineSplitter()
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk).forEach(onErr))
  child.stdin.on('error', () => {})
  child.stdin.end()
}

/** A Chrome answers on the remote-debugging port (as meeting_notes.cdp_ready). */
function cdpReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: 1_500 },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      }
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}
