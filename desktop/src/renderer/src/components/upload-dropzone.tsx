import { useEffect, useRef, useState, type JSX } from 'react'
import { Link } from 'react-router'
import { FileVideo, FolderOpen, X } from 'lucide-react'
import { cn } from 'cn'
import { voice } from '@shared/voice'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Mascot } from '@/components/brand/mascot'
import { formatBytes } from '@/lib/format'
import { videoPath } from '@/lib/paths'
import { useApp, type UploadItem } from '@/store'

/** Real paths of dropped files (File.path is gone in current Electron; the preload wraps webUtils). */
function droppedPaths(event: DragEvent): string[] {
  return Array.from(event.dataTransfer?.files ?? [])
    .map((file) => window.api.pathForFile(file))
    .filter(Boolean)
}

const hasFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

/**
 * Drops anywhere in the window upload the files, with a full-window overlay while dragging. Mounted once in the app
 * shell. It also stops Electron's default of navigating to a dropped file.
 */
export function WindowDropOverlay(): JSX.Element | null {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const voiceOn = useApp((s) => s.state?.settings.voice ?? true)
  const upload = useApp((s) => s.upload)

  useEffect(() => {
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    }
    const over = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) ? 'copy' : 'none'
    }
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const paths = droppedPaths(e)
      if (paths.length) void upload(paths)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [upload])

  if (!dragging) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/85 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-2xl border-4 border-dashed border-brand p-12">
        <Mascot pose="wave" size={140} />
        <p className="font-display text-2xl">{voice('upload.drop', voiceOn)}</p>
        <p className="text-sm text-muted-foreground">
          They go to the front of the queue, without the settle wait.
        </p>
      </div>
    </div>
  )
}

function UploadRow({ item }: { item: UploadItem }): JSX.Element {
  const pct = item.total > 0 ? (item.copied / item.total) * 100 : 0
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2 text-sm">
        <FileVideo className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" title={item.path}>
          {item.name}
        </span>
        {item.status === 'waiting' && <span className="text-muted-foreground">Waiting…</span>}
        {item.status === 'copying' && (
          <span className="tabular-nums text-muted-foreground">
            {formatBytes(item.copied)} / {formatBytes(item.total)}
          </span>
        )}
        {item.status === 'queued' &&
          (item.dest ? (
            <Link to={videoPath(item.dest)} className="text-sm">
              Queued · details
            </Link>
          ) : (
            <span className="text-success">Queued</span>
          ))}
        {item.status === 'error' && <span className="text-destructive">Not added</span>}
      </div>
      {(item.status === 'copying' || item.status === 'waiting') && (
        <Progress value={pct} aria-label={`Copying ${item.name}`} />
      )}
      {item.error && <p className="text-xs text-destructive">{item.error}</p>}
      {item.warning && <p className="text-xs text-warning">{item.warning}</p>}
    </li>
  )
}

/** The dashboard's upload area: a drop target hint, "Choose files", and the per-file progress list. */
export function UploadDropzone({ className }: { className?: string }): JSX.Element {
  const voiceOn = useApp((s) => s.state?.settings.voice ?? true)
  const uploads = useApp((s) => s.uploads)
  const upload = useApp((s) => s.upload)
  const clear = useApp((s) => s.clearFinishedUploads)
  const finished = uploads.some((u) => u.status === 'queued' || u.status === 'error')

  const choose = async (): Promise<void> => {
    const paths = await window.api.pickFiles()
    if (paths.length) await upload(paths)
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">{voice('upload.drop', voiceOn)}</p>
        <Button variant="outline" onClick={() => void choose()}>
          <FolderOpen /> Choose files
        </Button>
      </div>
      {uploads.length > 0 && (
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Uploads</h3>
            {finished && (
              <Button size="sm" variant="ghost" onClick={clear}>
                <X /> Clear finished
              </Button>
            )}
          </div>
          <ul className="divide-y divide-border">
            {uploads.map((item) => (
              <UploadRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
