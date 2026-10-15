import type { JSX } from 'react'
import { cn } from 'cn'

/**
 * The app's spinner: a small clock face whose minute hand sweeps (04a·T3). Drawn in currentColor.
 * Under prefers-reduced-motion the hands stand still and a dot pulses instead (it only fades).
 */
export function ClockSpinner({
  size = 16,
  label = 'Working',
  className
}: {
  size?: number
  /** Accessible name; pass '' when the spinner sits next to visible text that already says it. */
  label?: string
  className?: string
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      className={cn('inline-block shrink-0 text-brand', className)}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <circle cx={12} cy={12} r={10} strokeWidth={2} />
      <path d="M12 12 L8.5 9.5" strokeWidth={2} />
      <path
        d="M12 12 V5"
        strokeWidth={2}
        className="motion-safe:animate-sweep"
        style={{ transformOrigin: '12px 12px' }}
      />
      <circle
        cx={17.5}
        cy={17.5}
        r={2.5}
        fill="currentColor"
        stroke="none"
        className="motion-safe:hidden motion-reduce:animate-dot-pulse"
        data-motion="essential"
      />
    </svg>
  )
}
