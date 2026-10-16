/**
 * Miss Minutes voice (04a·T5): every user-facing line exists in a plain and a flavoured form, side by side, so plain
 * mode is never missing a string. Flavour is added to the information, never instead of it: the type check below
 * fails the build if a flavoured line drops a {placeholder} that its plain line has.
 *
 * Used by the renderer and by main (toasts, tray tooltip). `enabled` is Settings.voice.
 */
import type { Status } from './protocol'

const LINES = {
  'queue.empty': {
    plain: 'No videos waiting.',
    flavoured: 'All quiet on the Sacred Timeline, sugar. No videos waiting.'
  },
  'upload.drop': {
    plain: 'Drop videos to process',
    flavoured: "Drop 'em here, hon — I'll handle the paperwork."
  },
  'toast.done': {
    plain: 'Notes ready: {title}',
    flavoured: 'Your notes are filed, sugar! {title}'
  },
  'toast.failedFinal': {
    plain: 'Failed after {n} attempts: {name} — {error}',
    flavoured:
      'Uh-oh, that one got pruned after {n} tries: {name} — {error}. Want me to give it another go?'
  },
  'toast.failedRetry': {
    plain: 'Failed (attempt {n} of {max}): {name} — {error}. Will retry in 10 min.',
    flavoured:
      "Hiccup on the timeline (attempt {n} of {max}): {name} — {error}. I'll try again in 10 min, hon."
  },
  'toast.login': {
    plain: 'Sign in to Google in the automation Chrome window',
    flavoured: 'Sugar, I need you to sign in to Google in the automation Chrome window real quick.'
  },
  'toast.sessionExpired': {
    plain: 'Your Google session expired. Sign in to continue.',
    flavoured: "Your Google session expired, sugar. Sign in and I'll pick right back up."
  },
  'worker.paused': {
    plain: 'Watching paused',
    flavoured: "Watching paused. I'll wait right here."
  },
  'tray.closed': {
    plain: 'Still running in the tray',
    flavoured: "Still running in the tray — I'll keep an eye on the timeline while you're away!"
  },
  'setup.welcome': {
    plain: "Welcome to Miss Minutes. Let's get you set up: it takes about two minutes.",
    flavoured:
      "Welcome aboard, sugar! I'm Miss Minutes. Let's get your paperwork in order: it takes about two minutes."
  },
  'setup.chrome': {
    plain: 'Miss Minutes uses Google Chrome to talk to Google AI Studio.',
    flavoured: "I use Google Chrome to talk to Google AI Studio, hon. Let me check it's here."
  },
  'setup.signin': {
    plain: 'Sign in to the Google account you use for AI Studio.',
    flavoured: 'Now sign in to the Google account you use for AI Studio, sugar.'
  },
  'setup.library': {
    plain: 'Where should your meeting notes be saved?',
    flavoured: 'Where should I file your meeting notes, hon?'
  },
  'setup.search': {
    plain: 'Search your notes by meaning, not just by the exact words?',
    flavoured: 'Want me to find things by what you meant, hon, not just the exact words you typed?'
  },
  'settings.search': {
    plain: 'Find passages in your notes by meaning. Everything runs on this computer.',
    flavoured: 'I find passages by meaning, sugar, and none of it ever leaves this computer.'
  },
  'setup.watch': {
    plain: 'Which folder do your recordings go to?',
    flavoured: "Which folder do your recordings land in? I'll keep an eye on it."
  },
  'setup.autostart': {
    plain: 'Start Miss Minutes with Windows?',
    flavoured: 'Want me to clock in when Windows starts?'
  },
  'setup.done': {
    plain: 'All set. Here is what you chose.',
    flavoured: "All set, sugar! Here's the paperwork, all signed and stamped."
  },
  'timeline.noHistory': {
    plain: 'Detailed timeline not available for meetings processed before the app',
    flavoured:
      'This one was filed before my time, hon — no detailed timeline for meetings processed before the app.'
  }
} as const

type Lines = typeof LINES
export type VoiceKey = keyof Lines

/** The {placeholder} names in a string literal. */
type Placeholders<S extends string> = S extends `${string}{${infer V}}${infer Rest}`
  ? V | Placeholders<Rest>
  : never

type PlainVars<K extends VoiceKey> = Placeholders<Lines[K]['plain']>

// Compile-time guarantee: each flavoured line keeps every placeholder of its plain line.
type DroppedVars = {
  [K in VoiceKey]: Exclude<PlainVars<K>, Placeholders<Lines[K]['flavoured']>>
}[VoiceKey]
const everyFlavouredLineKeepsItsInfo: [DroppedVars] extends [never] ? true : DroppedVars = true
void everyFlavouredLineKeepsItsInfo

export type VoiceVars<K extends VoiceKey> = Record<PlainVars<K>, string | number>

/** voice('toast.done', true, { title }) -> the flavoured line when the voice is on, the plain line otherwise. */
export function voice<K extends VoiceKey>(
  key: K,
  enabled: boolean,
  ...[vars]: PlainVars<K> extends never ? [] : [VoiceVars<K>]
): string {
  const template: string = LINES[key][enabled ? 'flavoured' : 'plain']
  const values = (vars ?? {}) as Record<string, string | number>
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match
  )
}

/**
 * Display label for a status. Only three statuses get themed words (Filed / Pruned / Archived); the tooltip always
 * carries the functional word. `final` = a failure with no retries left (only then is it "pruned").
 */
export function statusLabel(
  status: Status,
  enabled: boolean,
  final = true
): { label: string; tooltip: string } {
  const plain = PLAIN_STATUS[status]
  const themed = enabled ? THEMED_STATUS[status] : undefined
  if (!themed || (status === 'failed' && !final)) return { label: plain, tooltip: plain }
  return { label: themed, tooltip: plain }
}

const PLAIN_STATUS: Record<Status, string> = {
  pending: 'Pending',
  compressing: 'Compressing',
  compressed: 'Compressed',
  generating: 'Generating',
  done: 'Done',
  failed: 'Failed',
  baseline: 'Baseline'
}

const THEMED_STATUS: Partial<Record<Status, string>> = {
  done: 'Filed',
  failed: 'Pruned',
  baseline: 'Archived'
}
