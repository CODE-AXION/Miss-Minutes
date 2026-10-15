import type { ComponentProps, JSX } from 'react'
import { cn } from 'cn'
import { Card } from '@/components/ui/card'

/**
 * A Card with faint CRT scanlines and an inner vignette (04a·T3), for the dashboard's "Now processing" card and the
 * timeline's live row only. The notes viewer always uses a plain Card. Scanlines drop out under reduced motion and
 * forced colours (see `crt-scanlines` in styles/theme.css).
 */
export function CrtPanel({ className, ...props }: ComponentProps<typeof Card>): JSX.Element {
  return <Card data-crt className={cn('crt-scanlines', className)} {...props} />
}

/** A VT323 readout with the amber glow, for timers, ETA and percentages. Only use it at 20px and up. */
export function Readout({ className, ...props }: ComponentProps<'span'>): JSX.Element {
  return <span className={cn('readout', className)} {...props} />
}
