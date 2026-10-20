import { audioLine, type PromptView } from '@shared/meetings'
import './prompt.css'

/**
 * The meeting prompt (MD·T12): what Record will capture (screen preview, label, audio) and three answers. React-free
 * like the REC pill. Main closes it after the first answer and enforces the timeout itself too.
 */

const bridge = window.meetPrompt
const title = document.getElementById('title') as HTMLElement
const thumb = document.getElementById('thumb') as HTMLImageElement
const screenLabel = document.getElementById('screen') as HTMLElement
const audio = document.getElementById('audio') as HTMLElement
const bar = document.getElementById('bar') as HTMLElement
const buttons = {
  record: document.getElementById('record') as HTMLButtonElement,
  dismiss: document.getElementById('dismiss') as HTMLButtonElement,
  never: document.getElementById('never') as HTMLButtonElement
}

let timer: number | undefined

async function mics(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'audioinput')
  } catch {
    return []
  }
}

async function render(view: PromptView): Promise<void> {
  title.textContent = `🎙 ${view.title}`
  thumb.src = view.thumbnail
  screenLabel.textContent = view.screenLabel
  audio.textContent = audioLine(view.systemAudio, view.micDeviceId, await mics())
  const left = Math.max(0, view.expiresAt - Date.now())
  bar.style.animationDuration = `${left}ms`
  bar.classList.add('run')
  window.clearTimeout(timer)
  timer = window.setTimeout(() => answer('dismiss'), left)
}

function answer(which: keyof typeof buttons): void {
  window.clearTimeout(timer)
  for (const b of Object.values(buttons)) b.disabled = true
  bridge[which]()
}

for (const which of Object.keys(buttons) as (keyof typeof buttons)[]) {
  buttons[which].addEventListener('click', () => answer(which))
}
bridge.onState((view) => void render(view))
bridge.ready()
