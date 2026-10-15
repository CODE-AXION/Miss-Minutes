import type { JSX, ReactNode } from 'react'
import { cn } from 'cn'

export type StampTone = 'filed' | 'pruned' | 'archived'

const TONE: Record<StampTone, string> = {
  filed: 'text-success',
  pruned: 'text-destructive',
  archived: 'text-muted-foreground'
}

/**
 * A rubber-stamp badge for the detail header (04a·T3): done → filed, final failure → pruned, baseline → archived.
 * The text comes from statusLabel() in @shared/voice, so it reads "Done"/"Failed"/"Baseline" when the voice is off;
 * `title` carries the functional word as a tooltip.
 */
export function TvaStamp({
  tone,
  title,
  className,
  children
}: {
  tone: StampTone
  title?: string
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'stamp-distress inline-flex -rotate-6 items-center rounded-sm border-[3px] border-double border-current px-2 py-0.5',
        'font-display text-sm uppercase leading-none tracking-[0.18em] select-none',
        TONE[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
