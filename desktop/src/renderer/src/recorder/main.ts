import { CAPTURE, pickMime, type RecorderJob, type RecordingAudio } from '@shared/recording'

/**
 * The hidden recorder window (RC·T8–T9): captures the source main's display-media handler hands out (with loopback
 * audio), mixes in the mic, records with MediaRecorder and streams 1 s chunks to main. Audio failures degrade the
 * recording; they never abort it. No timers or rAF: the window is hidden.
 */

const bridge = window.recorder

interface Session {
  tracks: MediaStreamTrack[]
  context: AudioContext | null
  recorder: MediaRecorder | null
  /** Muting disables it: a disabled track feeds silence into the mix, so the recording runs on (RC·T27). */
  mic: MediaStreamTrack | null
  /** Stop arrived while still starting; finish as soon as setup completes. */
  stopRequested: boolean
}

let session: Session | null = null

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const MIC_PROCESSING = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

/** The chosen mic; an unplugged device falls back once to the default one (RC·T8). */
async function openMic(
  deviceId: string
): Promise<{ track: MediaStreamTrack | null; mic: RecordingAudio['mic'] }> {
  const attempt = async (audio: MediaTrackConstraints): Promise<MediaStreamTrack | null> =>
    (await navigator.mediaDevices.getUserMedia({ audio })).getAudioTracks()[0] ?? null
  let fallback = false
  try {
    const track = await attempt({ deviceId: { exact: deviceId }, ...MIC_PROCESSING })
    return { track, mic: track ? 'on' : 'failed' }
  } catch (error) {
    const name = (error as DOMException).name
    if (name === 'NotAllowedError') return { track: null, mic: 'blocked' }
    fallback = name === 'NotFoundError' || name === 'OverconstrainedError'
  }
  if (!fallback) return { track: null, mic: 'failed' }
  try {
    const track = await attempt(MIC_PROCESSING)
    return { track, mic: track ? 'on' : 'failed' }
  } catch (error) {
    return {
      track: null,
      mic: (error as DOMException).name === 'NotAllowedError' ? 'blocked' : 'failed'
    }
  }
}

/** Stop every track and the mixer (RC·T9). */
function release(s: Session): void {
  for (const track of s.tracks) track.stop()
  void s.context?.close().catch(() => undefined)
  if (session === s) session = null
}

async function start({ choice, mime: requested }: RecorderJob): Promise<void> {
  if (session) {
    bridge.event({ type: 'error', message: 'A recording is already running' })
    return
  }
  const s: Session = { tracks: [], context: null, recorder: null, mic: null, stopRequested: false }
  session = s
  try {
    const mime = requested ?? pickMime((m) => MediaRecorder.isTypeSupported(m))
    if (!mime) throw new Error('This system can record neither MP4 nor WebM')

    // Main's handler (03) supplies the source and, when asked, `audio: 'loopback'`.
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: CAPTURE.frameRate,
        width: { max: CAPTURE.maxWidth },
        height: { max: CAPTURE.maxHeight }
      },
      audio: choice.systemAudio
    })
    s.tracks.push(...display.getTracks())
    const video = display.getVideoTracks()[0]
    if (!video) throw new Error('The capture returned no video')
    const systemTrack = display.getAudioTracks()[0] ?? null

    const audio: RecordingAudio = {
      system: systemTrack ? 'on' : choice.systemAudio ? 'failed' : 'off',
      mic: 'off',
      micLabel: null
    }
    let micTrack: MediaStreamTrack | null = null
    if (choice.micDeviceId) {
      const opened = await openMic(choice.micDeviceId)
      micTrack = opened.track
      audio.mic = opened.mic
      audio.micLabel = micTrack?.label || null
      if (micTrack) s.tracks.push(micTrack)
      s.mic = micTrack
    }

    // One mixed track (system + mic); with neither, the recording is video only.
    const sources = [systemTrack, micTrack].filter((t): t is MediaStreamTrack => t !== null)
    let mixed: MediaStreamTrack[] = []
    if (sources.length > 0) {
      s.context = new AudioContext()
      if (s.context.state === 'suspended') await s.context.resume()
      const dest = s.context.createMediaStreamDestination()
      for (const track of sources)
        s.context.createMediaStreamSource(new MediaStream([track])).connect(dest)
      mixed = dest.stream.getAudioTracks()
    }

    if (s.stopRequested) {
      release(s)
      bridge.event({ type: 'finished' })
      return
    }

    // videoKeyFrameIntervalDuration is Chromium-only, so not in lib.dom yet.
    const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration: number } = {
      mimeType: mime,
      videoBitsPerSecond: CAPTURE.videoBitsPerSecond,
      audioBitsPerSecond: CAPTURE.audioBitsPerSecond,
      videoKeyFrameIntervalDuration: CAPTURE.keyframeIntervalMs
    }
    const recorder = new MediaRecorder(new MediaStream([video, ...mixed]), options)
    s.recorder = recorder

    // arrayBuffer() is async, so chunks are serialised through one chain to reach main in order.
    let chain = Promise.resolve()
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return
      chain = chain
        .then(async () => bridge.chunk(new Uint8Array(await e.data.arrayBuffer())))
        .catch((error) => bridge.event({ type: 'error', message: `Chunk lost: ${message(error)}` }))
    }
    recorder.onstop = () => {
      void chain.then(() => {
        release(s)
        bridge.event({ type: 'finished' })
      })
    }
    recorder.onerror = (e) => {
      const error = (e as Event & { error?: DOMException }).error
      bridge.event({ type: 'error', message: error?.message || 'The recorder failed' })
    }
    // The recorded window was closed or the display unplugged; main decides to stop.
    video.onended = () => bridge.event({ type: 'track-ended' })

    recorder.start(CAPTURE.timesliceMs)
    const { width = 0, height = 0 } = video.getSettings()
    bridge.event({ type: 'started', mime, audio, width, height })
  } catch (error) {
    release(s)
    bridge.event({ type: 'error', message: message(error) })
  }
}

/** stop() flushes the last chunk; tracks are released in onstop once the chain drains (RC·T9). */
function stop(): void {
  const s = session
  if (!s) {
    bridge.event({ type: 'finished' })
    return
  }
  if (!s.recorder) {
    s.stopRequested = true
    return
  }
  if (s.recorder.state !== 'inactive') s.recorder.stop()
}

bridge.onStart((job) => void start(job))
bridge.onStop(stop)
bridge.onMute((muted) => {
  if (session?.mic) session.mic.enabled = !muted
})
window.addEventListener('pagehide', () => {
  if (!session) return
  if (session.recorder?.state === 'recording') session.recorder.stop()
  release(session)
})
bridge.event({ type: 'ready' })
