import { shell } from 'electron'
import { readFile } from 'fs/promises'
import { basename, extname, join, resolve, sep } from 'path'
import type { OpenPathKind, Settings } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'

/** `rel` resolved inside `folder`, or an error: renderer paths never leave their folder (no `..`, no absolute paths). */
export function inside(folder: string, rel: string): string {
  const base = resolve(folder)
  const full = resolve(base, rel)
  if (!full.toLowerCase().startsWith(base.toLowerCase() + sep))
    throw new Error(`Not allowed: ${rel}`)
  return full
}

/** `relPath` is an entry's `notes` value ("notes/<category>/<file>.md", relative to the library). */
export function readNote(settings: Settings, relPath: string): Promise<string> {
  if (typeof relPath !== 'string') throw new Error('Not allowed')
  const full = resolve(settings.library, relPath)
  inside(join(settings.library, 'notes'), full) // throws outside library/notes
  if (extname(full).toLowerCase() !== '.md') throw new Error(`Not a note: ${relPath}`)
  return readFile(full, 'utf-8')
}

const stem = (file: string): string => basename(file, extname(file))

/** library/logs/<source stem>.handbrake.log, the name compress() writes (watcher.py). */
function handbrakeLogPath(settings: Settings, key: string): string {
  return inside(join(settings.library, 'logs'), `${stem(key)}.handbrake.log`)
}

export async function readHandbrakeLog(settings: Settings, key: string): Promise<string> {
  const path = handbrakeLogPath(settings, key)
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return '' // not compressed yet, or compression was reused
  }
}

/** Opens what the UI asks for, resolved from the index entry (never from a raw renderer path). */
export async function openPath(
  settings: Settings,
  kind: OpenPathKind,
  entry: VideoEntry | undefined
): Promise<void> {
  const { library } = settings
  const need = (value: string | null | undefined, what: string): string => {
    if (!value) throw new Error(`No ${what} for this video`)
    return value
  }
  const open = async (path: string): Promise<void> => {
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  }
  switch (kind) {
    case 'library':
      return open(library)
    case 'index':
      return open(join(library, 'INDEX.md'))
    case 'note':
      return open(inside(join(library, 'notes'), resolve(library, need(entry?.notes, 'notes'))))
    case 'noteFolder':
      return shell.showItemInFolder(
        inside(join(library, 'notes'), resolve(library, need(entry?.notes, 'notes')))
      )
    case 'source':
      return shell.showItemInFolder(need(entry?.source, 'source file'))
    case 'compressed':
      return shell.showItemInFolder(need(entry?.compressed, 'compressed file'))
    case 'hbLog':
      return open(handbrakeLogPath(settings, need(entry?.source, 'source file')))
  }
}
