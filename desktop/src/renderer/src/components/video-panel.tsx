import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { FolderOpen, RotateCcw, RotateCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatClock } from '@/lib/format'
import { mediaUrl, type MediaFile, type MediaInfo } from '@shared/media'
import { seekTarget } from '@shared/timestamps'

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2]
const SKIP_SECONDS = 5

/** Stops playback and drops the src, so Chromium cancels its range requests and main closes the file. */
function release(video: HTMLVideoElement): void {
  video.pause()
  video.removeAttribute('src')
  video.load()
}

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export interface Jump {
  seconds: number
  /** Increments on every click, so the same timestamp twice seeks twice. */
  nonce: number
}

/**
 * The docked player of a note (NV·T14): plays the compressed MP4 Gemini watched, falls back to the original
 * recording when that is missing or fails, and otherwise says why it can't play. A new `jump` seeks the same element
 * (no reload). It releases the file on unmount (✕, Esc, tab or meeting change), so the engine can recompress.
 */
export function VideoPanel({
  entryKey,
  version,
  jump,
  onClose
}: {
  entryKey: string
  version: string | undefined
  jump: Jump
  onClose: () => void
}): JSX.Element {
  const [info, setInfo] = useState<MediaInfo | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [file, setFile] = useState<MediaFile | null>(null)
  const [failed, setFailed] = useState(false)
  const [from, setFrom] = useState(() => seekTarget(jump.seconds))
  const [rate, setRate] = useState(1)
  const video = useRef<HTMLVideoElement>(null)
  const last = useRef(jump.seconds)
  // The <video> is rendered exactly when there is something to play.
  const src = file && !failed && !infoError ? mediaUrl(entryKey, file, version) : null

  useEffect(() => {
    let live = true
    window.api.mediaInfo(entryKey).then(
      (result) => {
        if (!live) return
        setInfo(result)
        setFile(result.compressed ? 'compressed' : result.source ? 'source' : null)
      },
      (e: Error) => live && setInfoError(e.message)
    )
    return () => {
      live = false
    }
  }, [entryKey])

  // src is set here rather than as a prop, so the release in the cleanup (unmount, a switch to the original, an
  // error state replacing the video) can never leave a mounted element without one (StrictMode re-runs effects).
  useEffect(() => {
    const v = video.current
    if (!v || !src) return
    v.src = src
    return () => release(v)
  }, [src])

  const seek = useCallback((seconds: number) => {
    const v = video.current
    if (!v) return
    const target = seekTarget(seconds, v.duration)
    v.currentTime = target
    setFrom(target)
    // A rejection only means playback was interrupted (the panel closed, the src changed).
    v.play().catch(() => {})
  }, [])

  // Each click: remember the time; seek now if the metadata is in, else onLoadedMetadata does.
  useEffect(() => {
    last.current = jump.seconds
    if ((video.current?.readyState ?? 0) >= HTMLMediaElement.HAVE_METADATA) seek(jump.seconds)
    else setFrom(seekTarget(jump.seconds))
  }, [jump.nonce, jump.seconds, seek])

  // Esc closes, unless the user is typing, a dialog is open or the video is fullscreen (Esc leaves that first).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || typingTarget(e.target)) return
      if (document.fullscreenElement) return
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const skip = (delta: number): void => {
    const v = video.current
    if (!v) return
    const end = Number.isFinite(v.duration) ? v.duration : Infinity
    v.currentTime = Math.min(end, Math.max(0, v.currentTime + delta))
  }

  // Space / ← / → while focus is in the panel. The video's native controls, the speed select and the buttons
  // already handle these keys themselves.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const target = e.target as HTMLElement
    if (target.tagName === 'VIDEO' || typingTarget(target)) return
    const v = video.current
    if (!v) return
    if (e.key === ' ' && target.tagName !== 'BUTTON') {
      e.preventDefault()
      if (v.paused) v.play().catch(() => {})
      else v.pause()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      skip(e.key === 'ArrowLeft' ? -SKIP_SECONDS : SKIP_SECONDS)
    }
  }

  const onError = (): void => {
    if (file === 'compressed' && info?.source) {
      setFile('source') // onLoadedMetadata seeks the new file to the last jump
    } else setFailed(true)
  }

  let body: JSX.Element
  if (infoError || failed) {
    body = (
      <div className="flex flex-col items-start gap-2 rounded-md border p-3 text-sm">
        <p>This video can&apos;t be played here.</p>
        {infoError && <p className="text-xs text-muted-foreground">{infoError}</p>}
        {file && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.api.openPath(file, entryKey)}
          >
            <FolderOpen /> Show in folder
          </Button>
        )}
      </div>
    )
  } else if (info && !file) {
    body = (
      <p className="rounded-md border p-3 text-sm text-muted-foreground">
        The recording was moved or deleted.
      </p>
    )
  } else if (!file) {
    body = <div className="aspect-video w-full animate-pulse rounded-md bg-muted" />
  } else {
    body = (
      <>
        <video
          ref={video}
          controls
          preload="metadata"
          controlsList="nodownload noremoteplayback"
          className="aspect-video w-full rounded-md bg-black"
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = rate
            seek(last.current)
          }}
          onError={onError}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Playback speed"
            className="h-7 rounded-md border bg-background px-1.5 text-[0.8rem]"
            value={rate}
            onChange={(e) => {
              const value = Number(e.target.value)
              setRate(value)
              if (video.current) video.current.playbackRate = value
            }}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            aria-label="Back 5 seconds"
            onClick={() => skip(-SKIP_SECONDS)}
          >
            <RotateCcw /> 5
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Forward 5 seconds"
            onClick={() => skip(SKIP_SECONDS)}
          >
            <RotateCw /> 5
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.api.openPath(file, entryKey)}
          >
            <FolderOpen /> Show in folder
          </Button>
        </div>
      </>
    )
  }

  return (
    <aside
      aria-label="Video"
      className="sticky top-0 flex shrink-0 flex-col gap-2"
      style={{ width: 'clamp(280px, 30vw, 460px)' }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">
          From {formatClock(from)}
        </span>
        {file === 'source' && !failed && <Badge variant="secondary">Original recording</Badge>}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Close video"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      {body}
    </aside>
  )
}
