import { Notification, powerSaveBlocker } from 'electron'
import { EventEmitter } from 'events'
import { basename } from 'path'
import type { Settings } from '@shared/api'
import type { StageEvent } from '@shared/protocol'
import { voice } from '@shared/voice'
import type { State } from './state'

/**
 * Toasts (decision 13): notes ready, a video that failed for good, and Google sign-in. Failures that will be retried
 * don't toast (unless "notify on every failure" is on); the tray shows them instead. Also keeps the PC awake while
 * the worker is busy.
 *
 * Emits `change` when `unseenFinalFailures` changes (the tray turns red until the window is opened).
 */
export class Notifier extends EventEmitter {
  /** Keys of final failures the user hasn't seen yet (cleared when the window is shown). */
  readonly unseenFinalFailures = new Set<string>()
  /** Electron drops click handlers of notifications that were garbage-collected; keep them until closed. */
  private shown = new Set<Notification>()
  private blocker: number | null = null

  constructor(
    private state: State,
    private getSettings: () => Settings,
    private icon: string,
    private openVideo: (key: string) => void,
    private openSignin: () => void
  ) {
    super()
    state.on('stage', (event: StageEvent) => this.onStage(event))
    state.on('change', () => this.keepAwake(state.worker.state === 'busy'))
  }

  /** Attempts after which a failure is final: what the running worker was started with. */
  maxAttempts(): number {
    const fromWorker = this.state.hello?.settings.max_attempts
    return typeof fromWorker === 'number' ? fromWorker : this.getSettings().maxAttempts
  }

  acknowledge(): void {
    if (this.unseenFinalFailures.size === 0) return
    this.unseenFinalFailures.clear()
    this.emit('change')
  }

  private onStage(event: StageEvent): void {
    const settings = this.getSettings()
    const v = settings.voice
    const name = basename(event.key)
    switch (event.stage) {
      case 'saved': {
        const title = this.state.videos[event.key]?.title ?? name
        if (settings.notify.done) this.toastVideo(voice('toast.done', v, { title }), event.key)
        break
      }
      case 'failed': {
        const max = this.maxAttempts()
        const error = event.detail.error
        if (event.attempt >= max) {
          this.unseenFinalFailures.add(event.key)
          this.emit('change')
          if (settings.notify.failedFinal)
            this.toastVideo(
              voice('toast.failedFinal', v, { n: event.attempt, name, error }),
              event.key
            )
        } else if (settings.notify.everyFailure) {
          this.toastVideo(
            voice('toast.failedRetry', v, { n: event.attempt, max, name, error }),
            event.key
          )
        }
        break
      }
      case 'login_required':
        // Always, whatever the other switches say: the only state that blocks progress until the user acts.
        // Hidden desktop (11f·T2): nobody can sign in in that Chrome; the worker has paused, so this comes once.
        if (event.detail.hidden) this.toast(voice('toast.sessionExpired', v), this.openSignin)
        else this.toastVideo(voice('toast.login', v), event.key)
        break
    }
  }

  private toastVideo(body: string, key: string): void {
    this.toast(body, () => this.openVideo(key))
  }

  toast(body: string, onClick?: () => void): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: 'Miss Minutes', body, icon: this.icon })
    this.shown.add(notification)
    if (onClick) notification.on('click', onClick)
    notification.on('close', () => this.shown.delete(notification))
    notification.show()
  }

  /** 'prevent-app-suspension' while a video is being processed, so the PC doesn't sleep mid-generation. */
  private keepAwake(busy: boolean): void {
    if (busy && this.blocker === null) {
      this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    } else if (!busy && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
  }
}
