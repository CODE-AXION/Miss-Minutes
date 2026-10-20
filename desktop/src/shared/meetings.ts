/**
 * Rules for noticing a meeting and offering to record it (MD·T1–T4). Pure: no Electron or Node imports, so main
 * (the watcher) and the prompt pill only call it, and it is unit-tested like recording.ts.
 */
import type { RecordingChoice } from './recording'

export type MeetingApp = 'meet'

/** A meeting window found in desktopCapturer's window list (MD·T1). */
export interface Meeting {
  app: MeetingApp
  code: string
  sourceId: string
}

/**
 * Window titles that mean "in a meeting" (MD·T1). Matched on the title alone, so any browser counts; the en dash is
 * accepted in case Meet ever uses one. Zoom/Teams get a row once their real titles have been observed.
 */
const MATCHERS: { app: MeetingApp; label: string; pattern: RegExp }[] = [
  { app: 'meet', label: 'Google Meet', pattern: /^Meet [-–] ([a-z]{3}-[a-z]{4}-[a-z]{3})\b/ }
]

/** `Meet - wer-cqne-rvx - Google Chrome` → `{ app: 'meet', code: 'wer-cqne-rvx' }` (MD·T1). */
export function matchMeeting(title: string): { app: MeetingApp; code: string } | null {
  for (const { app, pattern } of MATCHERS) {
    const m = pattern.exec(title)
    if (m) return { app, code: m[1] }
  }
  return null
}

/** Meeting windows in list order, one per code; the first window with a code wins (MD·T1). */
export function findMeetings(sources: { id: string; name: string }[]): Meeting[] {
  const found = new Map<string, Meeting>()
  for (const { id, name } of sources) {
    if (!id.startsWith('window:')) continue
    const m = matchMeeting(name)
    if (m && !found.has(m.code)) found.set(m.code, { ...m, sourceId: id })
  }
  return [...found.values()]
}

/** The app's display name for the prompt (MD·T1). */
export const meetingLabel = (app: MeetingApp): string =>
  MATCHERS.find((m) => m.app === app)?.label ?? app

/**
 * One prompt per room code (MD·T2): a prompted code stays quiet while its window is seen, and is forgotten
 * `forgetMs` after its last sighting so a recurring room prompts again next time. No timers: the clock is injected.
 */
export class MeetingTracker {
  private lastSeen = new Map<string, number>()
  private done = new Set<string>()

  constructor(private forgetMs = 120_000) {}

  /** Called on every poll with the codes currently on screen. */
  seen(codes: string[], now: number): void {
    for (const code of codes) this.lastSeen.set(code, now)
    this.forget(now)
  }

  shouldPrompt(code: string, now: number): boolean {
    this.forget(now)
    return !this.done.has(code)
  }

  prompted(code: string, now: number): void {
    this.done.add(code)
    this.lastSeen.set(code, now)
  }

  private forget(now: number): void {
    for (const [code, at] of this.lastSeen) {
      if (now - at <= this.forgetMs) continue
      this.lastSeen.delete(code)
      this.done.delete(code)
    }
  }
}

/** `window:2033812:0` → `'2033812'`; digits only, since 02 hands it to PowerShell (MD·T3). */
export function hwndOf(sourceId: string): string | null {
  return /^window:(\d+):\d+$/.exec(sourceId)?.[1] ?? null
}

/**
 * What Record starts (MD·T4): the Meet window's whole screen, with the last audio choice and the picker's defaults
 * (record-dialog.tsx:164-168), so a previous window choice still records a screen.
 */
export function promptChoice(
  screen: { id: string; displayId: string | null },
  last: RecordingChoice | null
): RecordingChoice {
  return {
    sourceId: screen.id,
    kind: 'screen',
    displayId: screen.displayId,
    systemAudio: last?.systemAudio ?? true,
    micDeviceId: last ? last.micDeviceId : 'default'
  }
}

/** `Your screen · 1920×1080` with one display, else `Screen 2 · 2560×1440`; `index` is 1-based (MD·T4). */
export function screenLabel(
  index: number,
  count: number,
  size: { width: number; height: number }
): string {
  const name = count === 1 ? 'Your screen' : `Screen ${index}`
  return `${name} · ${size.width}×${size.height}`
}

/**
 * The prompt's audio line (MD·T12) from the page's enumerateDevices() audio inputs. A missing mic says so (the
 * recorder falls back to the default one, RC·T8); labels can be empty without a media permission.
 */
export function audioLine(
  systemAudio: boolean,
  micDeviceId: string | null,
  mics: { deviceId: string; label: string }[]
): string {
  const parts = systemAudio ? ['🔊 System audio'] : []
  if (micDeviceId === null) {
    parts.push(systemAudio ? 'no mic' : '🔇 No audio')
  } else {
    const mic = mics.find((m) => m.deviceId === micDeviceId)
    // Chromium labels the default entry "Default - <the real device>".
    const label = mic?.label.replace(/^Default - /, '') || 'Microphone'
    parts.push(mic ? `🎤 ${label}` : "🎤 Default mic (your last one isn't connected)")
  }
  return parts.join(' + ')
}

/** The state main sends the prompt pill (MD·T4). */
export interface PromptView {
  app: MeetingApp
  title: string
  code: string
  /** 320×180 data URL, taken before the pill opens so the pill isn't in it. */
  thumbnail: string
  screenLabel: string
  systemAudio: boolean
  micDeviceId: string | null
  /** Epoch ms; ignored until then counts as "Not now". */
  expiresAt: number
}

/** `window.meetPrompt`: the only things the prompt page can reach (MD·T10). */
export interface PromptBridge {
  onState(cb: (view: PromptView) => void): void
  ready(): void
  record(): void
  /** Not now, or the countdown ran out. */
  dismiss(): void
  never(): void
}
