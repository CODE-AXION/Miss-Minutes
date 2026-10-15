import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'child_process'
import { EventEmitter } from 'events'
import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { LogLine, RestartMode, Settings } from '@shared/api'
import type { Ack, CommandInput, WorkerMessage } from '@shared/protocol'
import type { State } from './state'
import { engineCommand, writeContextFile } from './settings'

const ACK_TIMEOUT_MS = 30_000
const SHUTDOWN_WAIT_MS = 10_000
/** Delay before restart number 1, 2, 3, 4+ after an unexpected exit. */
const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000]
const CRASH_WINDOW_MS = 10 * 60_000
const MAX_CRASHES = 5
const LOG_LINES = 5_000

/** Local ISO time with milliseconds (the worker's own `ts` is local time too). */
export function localIso(d = new Date()): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, -1)
}

/** Splits a stream into lines, keeping a partial line until the rest arrives. */
export class LineSplitter {
  private rest = ''

  push(chunk: string): string[] {
    const lines = (this.rest + chunk).split('\n')
    this.rest = lines.pop() ?? ''
    return lines.map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0)
  }
}

/**
 * The last 5,000 log lines (worker stderr + the app's own lines), pushed to renderers in batches (`lines` event)
 * and appended to library/logs/app-YYYY-MM-DD.log.
 */
export class LogBuffer extends EventEmitter {
  readonly lines: LogLine[] = []
  private unsent: LogLine[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private logsDir: string) {
    super()
  }

  setLogsDir(dir: string): void {
    this.logsDir = dir
  }

  add(source: LogLine['source'], text: string): void {
    const line: LogLine = { ts: localIso(), text, source }
    this.lines.push(line)
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES)
    this.unsent.push(line)
    this.flushTimer ??= setTimeout(() => void this.flush(), 250)
  }

  /** The last `n` worker lines, for the "crashed" explanation. */
  tail(n: number): string[] {
    return this.lines
      .filter((l) => l.source === 'worker')
      .slice(-n)
      .map((l) => l.text)
  }

  async flush(): Promise<void> {
    this.flushTimer = null
    const batch = this.unsent
    if (batch.length === 0) return
    this.unsent = []
    this.emit('lines', batch)
    const text = batch.map((l) => `${l.ts} [${l.source}] ${l.text}\n`).join('')
    try {
      await mkdir(this.logsDir, { recursive: true })
      await appendFile(join(this.logsDir, `app-${batch[0].ts.slice(0, 10)}.log`), text, 'utf-8')
    } catch {
      // The log file is a convenience; the in-memory buffer still has the lines.
    }
  }
}

interface PendingAck {
  resolve: (ack: Ack) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Environment for every engine process (frozen exe or .venv python): UTF-8 and unbuffered stdout. */
export const ENGINE_ENV = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }

/**
 * Starts and supervises the single `serve` worker (bundled engine or watcher.py): events (stdout) go to the State, commands go to its
 * stdin, logs (stderr) go to the LogBuffer. Restarts it with backoff after a crash; never runs a second one.
 */
export class Supervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private connected = false
  private nextId = 1
  private pending = new Map<string, PendingAck>()
  private crashes: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  /** The next exit is one we asked for (shutdown, restart): don't treat it as a crash. */
  private stopping = false
  private restartAfterExit = false
  private quitting = false
  private runLines: string[] = []
  /** Pause lives in the worker process; re-applied after a restart so "paused" survives it. */
  private wantPaused = false
  /** A start was skipped while a sign-in held Chrome's port and profile; done when it ends. */
  private startAfterSignin = false

  constructor(
    private state: State,
    private log: LogBuffer,
    private getSettings: () => Settings
  ) {}

  /** A worker is connected (its `hello` arrived) and takes commands. */
  get up(): boolean {
    return this.child !== null && this.connected
  }

  get busy(): boolean {
    return this.up && this.state.worker.state === 'busy'
  }

  /** A worker process exists (maybe still starting). */
  get running(): boolean {
    return this.child !== null
  }

  /** A sign-in run ended: do the start (e.g. a crash restart) that it held back. */
  signinEnded(): void {
    if (!this.startAfterSignin) return
    this.startAfterSignin = false
    this.start()
  }

  start(): void {
    if (this.child || this.quitting) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const settings = this.getSettings()
    const command = engineCommand(settings)
    if ('problem' in command) {
      // Shown in the health card; not retried (restarting can't bring a missing engine back).
      this.log.add('app', command.problem)
      this.state.setWorker({ connection: 'crashed', problem: { message: command.problem } })
      this.state.watchIndex(settings.library)
      return
    }
    if (this.state.signinRunning) {
      // The sign-in Chrome uses the same port and profile; start when it ends.
      this.startAfterSignin = true
      return
    }
    if (this.state.setupNeeded) {
      this.log.add('app', 'the worker starts when the first-run setup is finished')
      this.state.watchIndex(settings.library)
      return
    }
    writeContextFile(settings)
    this.log.add('app', `starting worker: ${command.exe} ${command.args.join(' ')}`)
    this.connected = false
    this.runLines = []
    const child = spawn(command.exe, command.args, {
      cwd: command.cwd,
      windowsHide: true,
      env: ENGINE_ENV
    })
    this.child = child
    this.state.setWorker({
      connection: this.crashes.length > 0 ? 'reconnecting' : 'starting',
      pid: child.pid ?? null,
      problem: undefined
    })

    const stdout = new LineSplitter()
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) =>
      stdout.push(chunk).forEach((line) => this.onEventLine(line))
    )
    const stderr = new LineSplitter()
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) =>
      stderr.push(chunk).forEach((line) => {
        this.runLines.push(line)
        if (this.runLines.length > 200) this.runLines.shift()
        this.log.add('worker', line)
      })
    )
    child.stdin.on('error', () => {}) // EPIPE after the worker died; 'exit' handles it

    let gone = false
    const onGone = (code: number | null, error?: Error): void => {
      if (gone) return
      gone = true
      this.onExit(child, code, error)
    }
    child.on('exit', (code) => onGone(code))
    child.on('error', (error) => onGone(null, error))
  }

  private onEventLine(line: string): void {
    let event: WorkerMessage
    try {
      event = JSON.parse(line)
    } catch {
      this.log.add('app', `warning: unreadable worker line: ${line.slice(0, 200)}`)
      return
    }
    if (event.type === 'ack') {
      const waiting = event.id !== null ? this.pending.get(event.id) : undefined
      if (!waiting) {
        if (!event.ok) this.log.add('app', `worker refused a command: ${event.error}`)
        return
      }
      this.pending.delete(event.id as string)
      clearTimeout(waiting.timer)
      waiting.resolve({ ok: event.ok, error: event.error, warning: event.warning })
      return
    }
    if (event.type === 'hello') {
      this.connected = true
      this.state.unwatchIndex()
      this.state.setWorker({ connection: 'up', pid: event.pid, problem: undefined })
      if (this.wantPaused) {
        // A video picked before this arrives still finishes, as with any pause.
        this.send({ cmd: 'pause' }).catch((e: Error) =>
          this.log.add('app', `pause failed: ${e.message}`)
        )
      }
    }
    this.state.apply(event)
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, error?: Error): void {
    if (this.child !== child) return
    this.child = null
    this.connected = false
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('The worker stopped before answering'))
    }
    this.pending.clear()
    this.state.workerGone()
    this.log.add('app', `worker exited (${error ? error.message : `code ${code}`})`)
    if (this.quitting) return

    if (this.stopping) {
      this.stopping = false
      if (this.restartAfterExit) {
        this.restartAfterExit = false
        this.start()
        return
      }
    }
    const { library } = this.getSettings()
    this.state.watchIndex(library) // keep the library visible while the worker is down

    const lockLine = this.runLines.find((l) => l.includes('already running'))
    if (code === 1 && lockLine) {
      const pid = /\(pid ([^)]+)\)/.exec(lockLine)?.[1] ?? '?'
      this.state.setWorker({
        connection: 'locked',
        problem: {
          message: `Another watcher is running (pid ${pid}). Stop it (e.g. the CLI "watcher.py watch"), then restart the worker.`
        }
      })
      return
    }
    if (code === 2) {
      // argparse rejected the command line: restarting with the same settings can't help.
      this.state.setWorker({
        connection: 'crashed',
        problem: {
          message: 'The worker rejected its settings.',
          lastLines: this.runLines.slice(-50)
        }
      })
      return
    }

    const now = Date.now()
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    if (this.crashes.length >= MAX_CRASHES) {
      this.state.setWorker({
        connection: 'crashed',
        problem: {
          message: `The worker stopped unexpectedly ${this.crashes.length} times in 10 minutes and was not restarted.`,
          lastLines: this.log.tail(50)
        }
      })
      return
    }
    const delay = BACKOFF_MS[Math.min(this.crashes.length, BACKOFF_MS.length) - 1]
    this.log.add('app', `restarting the worker in ${delay / 1000}s`)
    this.state.setWorker({ connection: 'reconnecting' })
    this.restartTimer = setTimeout(() => this.start(), delay)
  }

  /** Sends a command and resolves with its ack (rejects when the worker is down or doesn't answer in 30 s). */
  send(cmd: CommandInput): Promise<Ack> {
    const child = this.child
    if (!child || !this.connected) return Promise.reject(new Error('The worker is not running'))
    const id = String(this.nextId++)
    return new Promise<Ack>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`No answer from the worker to "${cmd.cmd}"`))
      }, ACK_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n')
    }).then((ack) => {
      if (ack.ok && (cmd.cmd === 'pause' || cmd.cmd === 'resume'))
        this.wantPaused = cmd.cmd === 'pause'
      return ack
    })
  }

  /**
   * Stops the worker: a polite `shutdown` when idle, otherwise (or when it doesn't exit within 10 s) a hard kill of
   * the process tree, which takes HandBrake with it. Chrome is detached and survives. A killed video goes back to
   * `pending` on the next start.
   */
  async stop({ force = false } = {}): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    if (!force && this.up && !this.busy) {
      try {
        const ack = await this.send({ cmd: 'shutdown' })
        if (ack.ok && (await within(exited, SHUTDOWN_WAIT_MS))) return
      } catch {
        // fall through to the hard kill
      }
    }
    if (this.child !== child) return // exited meanwhile
    killTree(child)
    await within(exited, SHUTDOWN_WAIT_MS)
  }

  /**
   * Restarts with the current settings. `after-current` lets a running video finish first (`shutdown
   * {after_current}`); `now` kills it (the UI has asked the user) and it is processed again after the start.
   */
  async restart(mode: RestartMode): Promise<void> {
    this.crashes = []
    if (!this.child) {
      this.start()
      return
    }
    this.restartAfterExit = true
    if (mode === 'after-current' && this.busy) {
      if (this.stopping) return // already waiting for the current video
      this.stopping = true
      this.log.add('app', 'the worker restarts after the current video')
      try {
        const ack = await this.send({ cmd: 'shutdown', after_current: true })
        if (!ack.ok) throw new Error(ack.error)
      } catch (error) {
        this.stopping = false
        this.restartAfterExit = false
        throw error
      }
      return
    }
    await this.stop({ force: mode === 'now' })
  }

  /** For quitting the app: kill without restarting. */
  async shutdownForQuit(): Promise<void> {
    this.quitting = true
    this.restartAfterExit = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    await this.stop({ force: true })
  }

  /** Last resort on exit if the worker is somehow still alive. */
  killNow(): void {
    if (this.child) killTree(this.child)
  }
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    child.kill('SIGKILL')
  }
}

/** True if `promise` settles within `ms`. */
function within(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
