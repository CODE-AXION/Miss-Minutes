import { toast } from 'sonner'
import type { Settings } from '@shared/api'

/**
 * Folder picker for the project folder (health card fix action, first-run setup). Rejects a folder without
 * watcher.py / .venv python (main's validateRoot), saves it and starts the worker right away. A library still
 * at its default place (<project>\library) moves along with the project folder.
 */
export async function chooseProjectRoot(settings: Settings): Promise<void> {
  const folder = await window.api.pickFolder()
  if (!folder) return
  const problem = await window.api.checkProjectRoot(folder)
  if (problem) {
    toast.error(problem)
    return
  }
  const patch: Partial<Settings> = { projectRoot: folder }
  if (settings.library.toLowerCase() === `${settings.projectRoot}\\library`.toLowerCase())
    patch.library = `${folder}\\library`
  try {
    await window.api.saveSettings(patch, { restart: 'now' })
    toast.success('Project folder saved; starting the worker')
  } catch (error) {
    toast.error((error as Error).message)
  }
}
