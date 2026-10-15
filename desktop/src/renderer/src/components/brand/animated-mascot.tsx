import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { cn } from 'cn'
import helloGif from '@/assets/mascot/miss-minutes-hello.gif'
import helloStill from '@/assets/mascot/miss-minutes-hello-still.png'
import ideaGif from '@/assets/mascot/miss-minutes-idea.gif'
import ideaStill from '@/assets/mascot/miss-minutes-idea-still.png'

/**
 * The animated Miss Minutes stickers (Marvel Studios' Loki TVA stickers, full loop: spin in, wave, spin out).
 * Under reduced motion the <picture> falls back to a still frame, so nothing moves.
 */
const ART = {
  /** Waves with a hand on the hip. */
  hello: { gif: helloGif, still: helloStill },
  /** Waves, then raises a finger: "I have an idea". */
  idea: { gif: ideaGif, still: ideaStill }
} as const

export type AnimatedMascotKind = keyof typeof ART

/** One full loop of either GIF (225 frames at 30 ms). */
export const MASCOT_LOOP_MS = 6750

const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function AnimatedMascot({
  kind = 'hello',
  size = 120,
  className,
  title,
  then
}: {
  kind?: AnimatedMascotKind
  /** Rendered width and height in px (the art is square). */
  size?: number
  className?: string
  /** Accessible name. Omit for a decorative mascot. */
  title?: string
  /** Play one loop, then show this instead (shown right away under reduced motion). */
  then?: ReactNode
}): JSX.Element {
  const art = ART[kind]
  const [finished, setFinished] = useState(() => then !== undefined && prefersReducedMotion())
  // Chromium shares one animation clock per image URL; a fresh URL per mount restarts the GIF at frame 0.
  const [gif] = useState(() => (then === undefined ? art.gif : `${art.gif}?play=${Date.now()}`))

  // Keyed on a boolean: `then` is a new element on every parent render (the dashboard re-renders each second).
  const once = then !== undefined
  useEffect(() => {
    if (!once || finished) return
    const timer = setTimeout(() => setFinished(true), MASCOT_LOOP_MS)
    return () => clearTimeout(timer)
  }, [once, finished])

  if (then !== undefined)
    return (
      <div
        className={cn('flex shrink-0 items-center justify-center', className)}
        style={{ width: size, height: size }}
      >
        {finished ? (
          then
        ) : (
          <img
            src={gif}
            width={size}
            height={size}
            alt={title ?? ''}
            aria-hidden={title ? undefined : true}
            draggable={false}
            className="select-none"
          />
        )}
      </div>
    )

  return (
    <picture className={cn('shrink-0', className)}>
      <source media="(prefers-reduced-motion: no-preference)" srcSet={gif} />
      <img
        src={art.still}
        width={size}
        height={size}
        alt={title ?? ''}
        aria-hidden={title ? undefined : true}
        draggable={false}
        className="select-none"
      />
    </picture>
  )
}
