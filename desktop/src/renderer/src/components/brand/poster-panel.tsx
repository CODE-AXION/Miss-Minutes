import type { JSX, ReactNode } from 'react'
import { cn } from 'cn'
import { Mascot, type MascotPose } from './mascot'

/**
 * Empty-state "public information poster" (04a·T3): a striped header strip, the mascot and one line of copy in a
 * bordered panel. Pass the copy through voice() so it stays plain when the voice is off.
 */
export function PosterPanel({
  pose = 'wave',
  heading = 'Public information',
  className,
  children
}: {
  pose?: MascotPose
  heading?: string
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-lg border-2 border-foreground/80 bg-card text-card-foreground',
        className
      )}
    >
      <header className="poster-stripes flex items-center gap-2 border-b-2 border-foreground/80 px-3 py-1">
        <span className="wordmark rounded-sm bg-card px-1.5 text-xs">{heading}</span>
      </header>
      <div className="flex items-center gap-4 p-4">
        <Mascot pose={pose} size={84} className="shrink-0" />
        <p className="text-base">{children}</p>
      </div>
    </section>
  )
}
