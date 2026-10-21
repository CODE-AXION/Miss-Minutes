import type { ToolbarState } from '@shared/recording'
import { formatClock } from '@shared/timestamps'
import './toolbar.css'

/**
 * The floating REC pill (RC·T29): elapsed time, mic mute and Stop, always on top while recording. React-free: one label and two buttons. The clock ticks here, so main sends only real changes.
 */

const bridge = window.recToolbar
const label = document.getElementById('label') as HTMLElement
const mute = document.getElementById('mute') as HTMLButtonElement
const stop = document.getElementById('stop') as HTMLButtonElement

// lucide's mic / mic-off, inline: the page loads nothing else.
const SVG = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
const MIC = SVG(
  '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'
)
const MIC_OFF = SVG(
  '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>'
)

let state: ToolbarState | null = null

function tick(): void {
  if (!state) return
  if (state.phase === 'recording' && state.startedAt) {
    label.textContent = `REC ${formatClock((Date.now() - Date.parse(state.startedAt)) / 1000)}`
  } else {
    label.textContent = state.phase === 'starting' ? 'Starting…' : 'Saving…'
  }
}

function render(next: ToolbarState): void {
  state = next
  const live = next.phase === 'recording'
  mute.hidden = !next.hasMic
  mute.setAttribute('aria-pressed', String(next.micMuted))
  mute.title = next.micMuted ? 'Unmute the mic' : 'Mute the mic'
  mute.innerHTML = `${next.micMuted ? MIC_OFF : MIC}${next.micMuted ? 'Unmute' : 'Mute'}`
  mute.disabled = !live
  stop.disabled = !live
  tick()
}

mute.addEventListener('click', () => bridge.toggleMute())
stop.addEventListener('click', () => {
  stop.disabled = true
  bridge.stop()
})
bridge.onState(render)
setInterval(tick, 1000)
bridge.ready()
