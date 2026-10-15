import type { JSX } from 'react'
import { Check } from 'lucide-react'
import { cn } from 'cn'

/** "1 · 2 · 3 …" with the current step's name: done steps get a tick. */
export function StepIndicator({
  steps,
  current
}: {
  steps: readonly string[]
  current: number
}): JSX.Element {
  return (
    <nav aria-label="Setup steps" className="flex flex-col gap-2">
      <ol className="flex items-center gap-1.5">
        {steps.map((name, i) => (
          <li key={name} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <span
              aria-current={i === current ? 'step' : undefined}
              title={name}
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                i < current && 'border-primary bg-primary text-primary-foreground',
                i === current && 'border-primary bg-card text-primary',
                i > current && 'border-border bg-card text-muted-foreground'
              )}
            >
              {i < current ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
            </span>
            {i < steps.length - 1 && (
              <span
                className={cn('h-0.5 flex-1 rounded', i < current ? 'bg-primary' : 'bg-border')}
              />
            )}
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">
        Step {current + 1} of {steps.length} · {steps[current]}
      </p>
    </nav>
  )
}
