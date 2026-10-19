import { toast } from 'sonner'
import { errorMessage } from '@/lib/format'

/** Restarts into the downloaded update; refusals (recording, a video in progress) show as a toast (UP·T4). */
export async function installUpdate(): Promise<void> {
  try {
    await window.api.updates.install()
  } catch (error) {
    toast.error(errorMessage(error))
  }
}
