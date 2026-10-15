import { useEffect, useState, type JSX } from 'react'
import { cn } from 'cn'
import { markSplashDone } from '@/lib/splash'
import { AnimatedMascot, MASCOT_LOOP_MS } from './animated-mascot'

const FADE_MS = 400

/**
 * Launch splash: Miss Minutes spins in, waves and spins out (one full GIF loop), then the app fades in.
 * Plays once per window load, starting when the window is first visible (autostart loads it hidden in the tray).
 * Click, Escape or Enter skips it; under reduced motion it is not shown at all.
 */
export function StartupSplash(): JSX.Element | null {
  const [phase, setPhase] = useState<'waiting' | 'playing' | 'fading' | 'done'>(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'done' : 'waiting'
  )

  useEffect(() => {
    if (phase !== 'waiting') return
    const start = (): void => {
      if (document.visibilityState === 'visible') setPhase('playing')
    }
    start()
    document.addEventListener('visibilitychange', start)
    return () => document.removeEventListener('visibilitychange', start)
  }, [phase])

  useEffect(() => {
    if (phase === 'playing') {
      const timer = setTimeout(() => setPhase('fading'), MASCOT_LOOP_MS)
      const skip = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' || e.key === 'Enter') setPhase('fading')
      }
      window.addEventListener('keydown', skip)
      return () => {
        clearTimeout(timer)
        window.removeEventListener('keydown', skip)
      }
    }
    if (phase === 'fading') {
      const timer = setTimeout(() => setPhase('done'), FADE_MS)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [phase])

  useEffect(() => {
    if (phase === 'fading' || phase === 'done') markSplashDone()
  }, [phase])

  if (phase === 'done') return null
  return (
    <div
      role="presentation"
      onClick={() => setPhase('fading')}
      className={cn(
        'fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center gap-4 bg-background transition-opacity',
        phase === 'fading' && 'pointer-events-none opacity-0'
      )}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      {/* Mounted only once visible, so the GIF starts from its first frame. */}
      {phase !== 'waiting' && <AnimatedMascot kind="hello" size={240} title="Miss Minutes" />}
      <span className="wordmark text-2xl">Miss Minutes</span>
      <span className="text-sm text-muted-foreground">Click anywhere to skip</span>
    </div>
  )
}
