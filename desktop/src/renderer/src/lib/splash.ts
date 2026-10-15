import { useSyncExternalStore } from 'react'

/** Whether the startup splash has finished (or was never shown), so animations behind it can start. */
let done = false
const listeners = new Set<() => void>()

export function markSplashDone(): void {
  if (done) return
  done = true
  listeners.forEach((listener) => listener())
}

export function useSplashDone(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => done
  )
}
