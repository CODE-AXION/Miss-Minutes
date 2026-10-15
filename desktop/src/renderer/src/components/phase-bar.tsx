import type { JSX } from 'react'
import { cn } from 'cn'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDuration } from '@/lib/format'
import { phaseTotals, type BarPhaseId, type Run } from '@/lib/timeline'

const COLOR: Record<BarPhaseId, string> = {
  settle: 'bg-muted-foreground/40',
  compress: 'bg-chart-4',
  setup: 'bg-chart-3',
  upload: 'bg-chart-2',
  generate: 'bg-chart-1'
}

/**
 * "Temporal loom" gauge of one run (07·T2): a stacked bar of settle / compress / AI Studio setup / upload / generate,
 * each segment as wide as its share of the run, with a tooltip per segment and a legend underneath.
 */
export function PhaseBar({ run }: { run: Run }): JSX.Element | null {
  const phases = phaseTotals(run).filter((p) => p.seconds > 0)
  const total = phases.reduce((sum, p) => sum + p.seconds, 0)
  if (total <= 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div
        className="loom h-4"
        role="img"
        aria-label={phases.map((p) => `${p.label} ${formatDuration(p.seconds)}`).join(', ')}
      >
        {phases.map((p) => (
          <Tooltip key={p.id}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  'h-full min-w-1 rounded-[1px]',
                  COLOR[p.id],
                  p.active && 'shadow-(--glow) motion-safe:animate-dot-pulse'
                )}
                style={{ flex: `${p.seconds} 1 0` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              {p.label}: {formatDuration(p.seconds)} ({Math.round((p.seconds / total) * 100)}%)
              {p.active ? ' — in progress' : ''}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {phases.map((p) => (
          <li key={p.id} className="flex items-center gap-1.5">
            <span className={cn('size-2.5 rounded-[2px]', COLOR[p.id])} aria-hidden />
            {p.label}{' '}
            <span className="tabular-nums text-foreground">{formatDuration(p.seconds)}</span>
          </li>
        ))}
        <li className="ml-auto">
          Total <span className="tabular-nums text-foreground">{formatDuration(total)}</span>
        </li>
      </ul>
    </div>
  )
}
