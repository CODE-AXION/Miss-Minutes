import { useCallback, useEffect, useRef, useState } from 'react'
import type { SigninOutcome } from '@shared/api'
import { errorMessage } from '@/lib/format'

/** opening = the engine is starting Chrome; waiting = Google's sign-in page is open in Chrome. */
export type SigninPhase = 'idle' | 'opening' | 'waiting' | 'ok' | 'failed'

export interface SigninView {
  phase: SigninPhase
  /** When the engine stops waiting for the sign-in (Date.now() ms), from `login_required.wait_s`. */
  deadline: number | null
  error: string | null
}

const IDLE: SigninView = { phase: 'idle', deadline: null, error: null }

/**
 * One sign-in/sign-out run (11d·T1 step 3, T1b): `run(start)` calls the given window.api method and follows the
 * run's `setup:event`s until it resolves. Only this hook's own run is followed, so the wizard and the dialog can
 * both be mounted.
 */
export function useSignin(): {
  view: SigninView
  run(start: () => Promise<SigninOutcome>): Promise<SigninOutcome>
  cancel(): void
  reset(): void
} {
  const [view, setView] = useState<SigninView>(IDLE)
  const active = useRef(false)

  useEffect(
    () =>
      window.api.onSigninEvent((event) => {
        if (!active.current) return
        if (event.type === 'login_required')
          setView((v) => ({ ...v, phase: 'waiting', deadline: Date.now() + event.wait_s * 1000 }))
      }),
    []
  )

  const run = useCallback(async (start: () => Promise<SigninOutcome>) => {
    active.current = true
    setView({ phase: 'opening', deadline: null, error: null })
    let outcome: SigninOutcome
    try {
      outcome = await start()
    } catch (error) {
      outcome = { ok: false, error: errorMessage(error) }
    } finally {
      active.current = false
    }
    setView(
      outcome.ok
        ? { phase: 'ok', deadline: null, error: null }
        : { phase: 'failed', deadline: null, error: outcome.error }
    )
    return outcome
  }, [])

  const cancel = useCallback(() => void window.api.cancelSignin(), [])
  const reset = useCallback(() => setView(IDLE), [])

  return { view, run, cancel, reset }
}
