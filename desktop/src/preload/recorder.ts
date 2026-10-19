import { contextBridge, ipcRenderer } from 'electron'
import { RECORDER_IPC, type RecorderBridge, type RecorderJob } from '@shared/recording'

// The hidden recorder window's bridge (RC·T7): five typed wrappers, nothing else of Electron or Node.
const recorder: RecorderBridge = {
  onStart: (cb) => {
    ipcRenderer.on(RECORDER_IPC.start, (_, job: RecorderJob) => cb(job))
  },
  onStop: (cb) => {
    ipcRenderer.on(RECORDER_IPC.stop, () => cb())
  },
  onMute: (cb) => {
    ipcRenderer.on(RECORDER_IPC.mute, (_, muted: boolean) => cb(muted === true))
  },
  chunk: (data) => ipcRenderer.send(RECORDER_IPC.chunk, data),
  event: (e) => ipcRenderer.send(RECORDER_IPC.event, e)
}

contextBridge.exposeInMainWorld('recorder', recorder)
