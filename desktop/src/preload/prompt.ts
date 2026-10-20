import { contextBridge, ipcRenderer } from 'electron'
import type { PromptBridge, PromptView } from '@shared/meetings'
import { PROMPT_IPC } from '@shared/prompt-ipc'

// The meeting prompt's bridge (MD·T11): the view in, three answers out, nothing else of Electron or Node.
const prompt: PromptBridge = {
  onState: (cb) => {
    ipcRenderer.on(PROMPT_IPC.state, (_, view: PromptView) => cb(view))
  },
  ready: () => ipcRenderer.send(PROMPT_IPC.ready),
  record: () => ipcRenderer.send(PROMPT_IPC.record),
  dismiss: () => ipcRenderer.send(PROMPT_IPC.dismiss),
  never: () => ipcRenderer.send(PROMPT_IPC.never)
}

contextBridge.exposeInMainWorld('meetPrompt', prompt)
