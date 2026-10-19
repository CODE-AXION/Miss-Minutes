import { contextBridge, ipcRenderer } from 'electron'
import type { ToolbarBridge, ToolbarState } from '@shared/recording'
import { TOOLBAR_IPC } from '@shared/toolbar-ipc'

// The recording mini-toolbar's bridge (RC·T29): state in, Stop and Mute out, nothing else of Electron or Node.
const toolbar: ToolbarBridge = {
  onState: (cb) => {
    ipcRenderer.on(TOOLBAR_IPC.state, (_, state: ToolbarState) => cb(state))
  },
  ready: () => ipcRenderer.send(TOOLBAR_IPC.ready),
  stop: () => ipcRenderer.send(TOOLBAR_IPC.stop),
  toggleMute: () => ipcRenderer.send(TOOLBAR_IPC.mute)
}

contextBridge.exposeInMainWorld('recToolbar', toolbar)
