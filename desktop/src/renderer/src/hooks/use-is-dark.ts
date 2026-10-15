import { useSyncExternalStore } from 'react'

/** Whether the `.dark` class (CRT theme) is on <html>; follows theme changes live. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, () =>
    document.documentElement.classList.contains('dark')
  )
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
