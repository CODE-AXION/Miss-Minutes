import type { LucideIcon } from 'lucide-react'
import {
  Bot,
  CheckCircle2,
  ClipboardCopy,
  Flag,
  Globe,
  Hourglass,
  KeyRound,
  MessageSquarePlus,
  MousePointerClick,
  PackageCheck,
  PauseCircle,
  Recycle,
  RefreshCw,
  Replace,
  Repeat,
  ScanSearch,
  Shrink,
  UploadCloud,
  XCircle
} from 'lucide-react'
import type { HistoryItem, StageDetails, StageId, VideoEntry } from '@shared/protocol'
import { formatDuration, formatPercent } from './format'

export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'muted'

interface StageInfo<S extends StageId> {
  label: string
  icon: LucideIcon
  tone: Tone
  /** One line of detail for the timeline and the "current step" line; empty when there is nothing to add. */
  describe: (detail: StageDetails[S]) => string
}

const none = (): string => ''

/** Stage id → presentation, used by the dashboard's current step (06) and the timeline (07). */
export const STAGES: { [S in StageId]: StageInfo<S> } = {
  detected: { label: 'Detected', icon: ScanSearch, tone: 'muted', describe: none },
  ready: { label: 'Ready to process', icon: Flag, tone: 'info', describe: none },
  compress_reused: {
    label: 'Reused earlier compression',
    icon: Recycle,
    tone: 'success',
    describe: (d) => d.file
  },
  compress_start: {
    label: 'Compressing',
    icon: Shrink,
    tone: 'info',
    describe: (d) => `${d.size_mb} MB at RF ${d.quality}${d.encoder ? ` (${d.encoder})` : ''}`
  },
  compress_done: {
    label: 'Compressed',
    icon: PackageCheck,
    tone: 'success',
    describe: (d) =>
      `${d.size_mb} MB (${formatPercent(d.ratio)} of the original) in ${formatDuration(d.seconds)}`
  },
  chrome_start: { label: 'Chrome started', icon: Globe, tone: 'info', describe: none },
  chrome_reconnect: {
    label: 'Reconnected to Chrome',
    icon: RefreshCw,
    tone: 'warning',
    describe: none
  },
  login_required: {
    label: 'Google sign-in needed',
    icon: KeyRound,
    tone: 'danger',
    describe: (d) =>
      d.hidden
        ? 'The Google session expired; processing paused until you sign in'
        : `Sign in in the automation Chrome window (waiting up to ${formatDuration(d.wait_s)})`
  },
  chat_open: {
    label: 'AI Studio chat opened',
    icon: MessageSquarePlus,
    tone: 'info',
    describe: (d) => d.model
  },
  resumed_tab: {
    label: 'Resumed the open AI Studio tab',
    icon: Replace,
    tone: 'info',
    describe: () => 'The video was already uploaded'
  },
  upload_start: {
    label: 'Uploading',
    icon: UploadCloud,
    tone: 'info',
    describe: (d) => `${d.size_mb} MB`
  },
  upload_ready: {
    label: 'Upload ready',
    icon: CheckCircle2,
    tone: 'success',
    describe: (d) => `processed in ${formatDuration(d.seconds)}`
  },
  run_retry_click: {
    label: 'Run clicked again',
    icon: MousePointerClick,
    tone: 'warning',
    describe: (d) => `try ${d.n}${d.hint ? ` — ${d.hint}` : ''}`
  },
  generating: { label: 'Generating', icon: Bot, tone: 'info', describe: none },
  copy_fallback: {
    label: 'Copied the answer another way',
    icon: ClipboardCopy,
    tone: 'warning',
    describe: none
  },
  retry_wait: {
    label: 'Retrying',
    icon: Repeat,
    tone: 'warning',
    describe: (d) =>
      `${d.model} (retry ${d.retry}/${d.retries}) in ${formatDuration(d.wait_s)} — ${d.error}`
  },
  fallback_model: {
    label: 'Switched to the fallback model',
    icon: Hourglass,
    tone: 'warning',
    describe: (d) => d.model
  },
  saved: { label: 'Saved', icon: CheckCircle2, tone: 'success', describe: (d) => d.notes },
  failed: { label: 'Failed', icon: XCircle, tone: 'danger', describe: (d) => d.error },
  interrupted: {
    label: 'Interrupted',
    icon: PauseCircle,
    tone: 'warning',
    describe: () => 'It is processed again on the next start'
  }
}

/** Label, icon, tone and the detail line of one history row. */
export function stageInfo(item: HistoryItem): {
  label: string
  icon: LucideIcon
  tone: Tone
  text: string
} {
  const info = STAGES[item.stage] as StageInfo<StageId>
  return { label: info.label, icon: info.icon, tone: info.tone, text: info.describe(item as never) }
}

// --- The five phases of the dashboard step row (Settle → Compress → Upload → Generate → Saved) ---

export const PHASES = ['Settle', 'Compress', 'Upload', 'Generate', 'Saved'] as const

const PHASE_OF: Record<StageId, number> = {
  detected: 0,
  ready: 0,
  compress_reused: 1,
  compress_start: 1,
  compress_done: 1,
  chrome_start: 2,
  chrome_reconnect: 2,
  login_required: 2,
  chat_open: 2,
  resumed_tab: 2,
  upload_start: 2,
  upload_ready: 3,
  run_retry_click: 3,
  generating: 3,
  copy_fallback: 3,
  retry_wait: 3,
  fallback_model: 3,
  saved: 4,
  failed: -1,
  interrupted: -1
}

/** History of the latest run: everything since its last `ready` (one run = one attempt). */
export function currentRun(entry: VideoEntry): HistoryItem[] {
  const history = entry.history ?? []
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].stage === 'ready') return history.slice(i)
  }
  return history
}

export function lastStage(entry: VideoEntry): HistoryItem | undefined {
  return entry.history?.[entry.history.length - 1]
}

export type PhaseState = 'done' | 'active' | 'pending' | 'failed'

/** State of each phase for the step row, from the current run's history and the status. */
export function phaseStates(entry: VideoEntry): PhaseState[] {
  if (entry.status === 'done') return PHASES.map(() => 'done')
  let reached = 0
  for (const item of currentRun(entry)) reached = Math.max(reached, PHASE_OF[item.stage])
  if (entry.status === 'compressing') reached = Math.max(reached, 1)
  if (entry.status === 'generating') reached = Math.max(reached, 2)
  const failed = entry.status === 'failed'
  return PHASES.map((_, i) =>
    i < reached ? 'done' : i === reached ? (failed ? 'failed' : 'active') : 'pending'
  )
}
