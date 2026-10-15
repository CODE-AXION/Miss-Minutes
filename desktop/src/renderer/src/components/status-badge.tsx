import type { JSX } from 'react'
import { Archive, CheckCircle2, Clock, PackageCheck, XCircle } from 'lucide-react'
import { cn } from 'cn'
import type { Status } from '@shared/protocol'
import { statusLabel } from '@shared/voice'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ClockSpinner } from '@/components/brand/clock-spinner'

const STYLE: Record<
  Status,
  { variant: 'outline' | 'secondary' | 'destructive'; className?: string }
> = {
  pending: { variant: 'outline' },
  compressing: { variant: 'outline', className: 'border-brand/60' },
  compressed: { variant: 'secondary' },
  generating: { variant: 'outline', className: 'border-brand/60' },
  done: { variant: 'secondary', className: 'bg-success/15 text-success' },
  failed: { variant: 'destructive' },
  baseline: { variant: 'secondary', className: 'bg-muted text-muted-foreground' }
}

/**
 * Status chip. Done / final failure / baseline get the themed words (Filed / Pruned / Archived) when the voice is
 * on; the tooltip always carries the functional status (04a·T5).
 */
export function StatusBadge({
  status,
  voice,
  final = true,
  className
}: {
  status: Status
  voice: boolean
  /** For `failed`: no attempts left (only then is it "Pruned"). */
  final?: boolean
  className?: string
}): JSX.Element {
  const { label, tooltip } = statusLabel(status, voice, final)
  const style = STYLE[status]
  const icon =
    status === 'compressing' || status === 'generating' ? (
      <ClockSpinner size={12} label="" />
    ) : status === 'pending' ? (
      <Clock />
    ) : status === 'compressed' ? (
      <PackageCheck />
    ) : status === 'done' ? (
      <CheckCircle2 />
    ) : status === 'failed' ? (
      <XCircle />
    ) : (
      <Archive />
    )
  const tip = status === 'failed' && !final ? `${tooltip} — will be retried automatically` : tooltip
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={style.variant} className={cn(style.className, className)}>
          {icon}
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
