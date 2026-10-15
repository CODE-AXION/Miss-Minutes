import type { JSX } from 'react'
import { CheckCircle2, Download, RotateCcw, XCircle } from 'lucide-react'
import { voice } from '@shared/voice'
import { ClockSpinner } from '@/components/brand/clock-spinner'
import type { CheckState, StepProps } from '@/components/setup/types'
import { Button, buttonVariants } from '@/components/ui/button'

const CHROME_DOWNLOAD = 'https://www.google.com/chrome/'

/** Step 2: Google Chrome must be installed (the engine's `check`). Next stays disabled until it's found. */
export function ChromeStep({
  state,
  check,
  onCheck
}: StepProps & { check: CheckState; onCheck: () => void }): JSX.Element {
  const chrome = check.status === 'done' ? check.result.chrome : null
  return (
    <div className="flex flex-col gap-5">
      <p>{voice('setup.chrome', state.settings.voice)}</p>

      {(check.status === 'idle' || check.status === 'running') && (
        <div className="flex items-center gap-3">
          <ClockSpinner size={20} label="" />
          <span>Looking for Google Chrome…</span>
        </div>
      )}

      {chrome?.ok && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
            <span className="font-medium">Google Chrome is installed.</span>
          </div>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <code className="mt-2 block break-all">{chrome.path}</code>
          </details>
        </div>
      )}

      {(chrome?.ok === false || check.status === 'error') && (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
            <span>
              {chrome
                ? "Google Chrome isn't installed. Install it, then come back and check again."
                : "Miss Minutes couldn't check for Google Chrome."}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {chrome && (
              // main opens target=_blank links in the default browser (setWindowOpenHandler).
              <a
                href={CHROME_DOWNLOAD}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants()}
              >
                <Download /> Download Chrome
              </a>
            )}
            <Button variant="outline" onClick={onCheck}>
              <RotateCcw /> Check again
            </Button>
          </div>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <p className="mt-2 break-all">
              {check.status === 'error' ? check.error : chrome && !chrome.ok ? chrome.error : null}
            </p>
          </details>
        </div>
      )}
    </div>
  )
}
