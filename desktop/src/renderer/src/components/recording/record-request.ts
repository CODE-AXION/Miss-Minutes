import { toast } from 'sonner'
import { create } from 'zustand'
import { errorMessage } from '@/lib/format'

/** `session` grows with every opening, so the picker starts fresh each time. */
export const useRecordRequest = create<{ open: boolean; session: number }>(() => ({
  open: false,
  session: 0
}))

/** Opens the recording picker (dashboard card, tray and hotkey via `navigate 'record'`) (RC·T21). */
export function openRecordDialog(): void {
  const { open, session } = useRecordRequest.getState()
  if (!open) useRecordRequest.setState({ open: true, session: session + 1 })
}

export function closeRecordDialog(): void {
  useRecordRequest.setState({ open: false })
}

/** Stops, saves and queues the recording (banner, dashboard card); a failure shows as a toast (RC·T23). */
export async function stopRecording(): Promise<void> {
  try {
    await window.api.recording.stop()
  } catch (error) {
    toast.error(errorMessage(error))
  }
}

/** Mutes or unmutes the mic in the running recording (banner, sidebar); a failure shows as a toast (RC·T27). */
export async function setMicMuted(muted: boolean): Promise<void> {
  try {
    await window.api.recording.setMicMuted(muted)
  } catch (error) {
    toast.error(errorMessage(error))
  }
}

/**
 * Outline buttons on the red recording panels (sidebar, banner). The dark: variants undo the outline button's own
 * dark-mode fill, which would otherwise hide them (RC·T28).
 */
export const ON_RECORD = {
  button:
    'border-white/60 bg-transparent text-white hover:bg-white/15 hover:text-white dark:border-white/60 dark:bg-transparent dark:hover:bg-white/15',
  pressed:
    'border-white bg-white text-record hover:bg-white/90 hover:text-record dark:border-white dark:bg-white dark:hover:bg-white/90'
}
