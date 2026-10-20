/**
 * Notices a Google Meet room and offers to record it (MD·T8): polls window titles, opens the prompt pill, and on
 * Record calls RecordingService.start() like the picker does. Detection only ever opens the prompt; nothing records
 * without a click, and nothing stops when the meeting ends.
 */
import { desktopCapturer, type Display } from 'electron'
import type { Settings } from '@shared/api'
import {
  findMeetings,
  meetingLabel,
  MeetingTracker,
  promptChoice,
  screenLabel,
  type Meeting,
  type PromptView
} from '@shared/meetings'
import type { Notifier } from './notify'
import type { RecordingService } from './recording'
import { voice } from '@shared/voice'
import { loadLastRecording } from './settings'
import type { State } from './state'
import { screenForWindow } from './window-display'

const POLL_MS = 5_000
/** Ignored this long, the prompt closes and counts as "Not now". */
const PROMPT_MS = 30_000

export interface PromptHandlers {
  onRecord(): void
  /** Not now, or the prompt timed out. */
  onDismiss(): void
  onNever(): void
}

/** The prompt pill (MeetingPrompt, MD·T13); only the first action a prompt reports counts. */
export interface PromptWindow {
  readonly open: boolean
  show(view: PromptView, display: Display, handlers: PromptHandlers): void
  close(): void
}

export class MeetingWatcher {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private tracker = new MeetingTracker()

  constructor(
    private state: State,
    private recording: RecordingService,
    private prompt: PromptWindow,
    private notifier: Notifier,
    private log: (text: string) => void,
    private getSettings: () => Settings,
    /** index.ts's updateSettings, so the change is published like a save from Settings. */
    private saveSettings: (patch: Partial<Settings>) => Promise<unknown>
  ) {
    state.on('change', () => this.sync())
    this.sync()
  }

  /** Polls only while the setting is on, setup is done and nothing is recording. */
  sync(): void {
    const wanted =
      this.getSettings().meetingPrompt && !this.state.setupNeeded && !this.recording.busy
    if (wanted && !this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_MS)
      this.log('meetings: watching for Google Meet')
    } else if (!wanted && this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.log('meetings: stopped watching')
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.prompt.close()
  }

  private async poll(): Promise<void> {
    if (this.polling || this.prompt.open) return
    this.polling = true
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      })
      const meetings = findMeetings(sources)
      const now = Date.now()
      this.tracker.seen(
        meetings.map((m) => m.code),
        now
      )
      const next = meetings.find((m) => this.tracker.shouldPrompt(m.code, now))
      // Re-checked after the await: a recording or the setting may have changed meanwhile.
      if (next && this.timer) await this.offer(next)
    } catch (error) {
      this.log(`meetings: ${error instanceof Error ? error.message : error}`)
    } finally {
      this.polling = false
    }
  }

  private async offer(meeting: Meeting): Promise<void> {
    // First, so a slow PowerShell call can't prompt twice for the same room.
    this.tracker.prompted(meeting.code, Date.now())
    const last = loadLastRecording()
    const found = await screenForWindow(meeting.sourceId, last?.displayId ?? null, this.log)
    if (!found) return this.log(`meetings: no screen to offer for ${meeting.code}`)
    if (!this.timer || this.prompt.open) return
    const { source, display, index, count } = found
    const choice = promptChoice({ id: source.id, displayId: source.display_id || null }, last)
    const label = screenLabel(index, count, display.size)
    const view: PromptView = {
      app: meeting.app,
      title: voice('meeting.prompt', this.getSettings().voice, {
        app: meetingLabel(meeting.app),
        code: meeting.code
      }),
      code: meeting.code,
      thumbnail: source.thumbnail.toDataURL(),
      screenLabel: label,
      systemAudio: choice.systemAudio,
      micDeviceId: choice.micDeviceId,
      expiresAt: Date.now() + PROMPT_MS
    }
    this.prompt.show(view, display, {
      onRecord: () => {
        if (this.recording.busy) return this.log('meetings: Record ignored, already recording')
        this.log(`meetings: recording ${meeting.code} on ${label}`)
        this.recording.start(choice).catch((error: Error) => {
          this.log(`meetings: could not start: ${error.message}`)
          this.notifier.toast(
            voice('meeting.startFailed', this.getSettings().voice, { error: error.message })
          )
        })
      },
      onDismiss: () => this.log(`meetings: ${meeting.code} dismissed`),
      onNever: () => {
        this.log('meetings: turned off from the prompt')
        this.saveSettings({ meetingPrompt: false })
          .then(() => this.sync())
          .catch((error: Error) => this.log(`meetings: ${error.message}`))
      }
    })
    this.log(`meetings: offered ${meeting.code} on ${label}`)
  }
}
