import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type MissMinutesApi, type Unsubscribe } from '@shared/api'

// Only typed invoke/on wrappers cross the bridge; the raw ipcRenderer is never exposed.
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: MissMinutesApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (cb) => subscribe(IPC.state, cb),
  onLog: (cb) => subscribe(IPC.log, cb),
  onNavigate: (cb) => subscribe(IPC.navigate, cb),
  command: (cmd) => ipcRenderer.invoke(IPC.command, cmd),

  uploadFiles: (paths) => ipcRenderer.invoke(IPC.uploadFiles, paths),
  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onUploadProgress: (cb) => subscribe(IPC.uploadProgress, cb),

  readNote: (relPath) => ipcRenderer.invoke(IPC.readNote, relPath),
  readHandbrakeLog: (key) => ipcRenderer.invoke(IPC.readHandbrakeLog, key),
  getWorkerLog: () => ipcRenderer.invoke(IPC.getWorkerLog),
  openPath: (kind, key) => ipcRenderer.invoke(IPC.openPath, kind, key),
  mediaInfo: (key) => ipcRenderer.invoke(IPC.mediaInfo, key),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (patch, options) => ipcRenderer.invoke(IPC.saveSettings, patch, options),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  pickFile: (filters) => ipcRenderer.invoke(IPC.pickFile, filters),
  checkProjectRoot: (root) => ipcRenderer.invoke(IPC.checkProjectRoot, root),

  setup: {
    check: (watchDir) => ipcRenderer.invoke(IPC.setupCheck, watchDir),
    signin: (options) => ipcRenderer.invoke(IPC.setupSignin, options),
    finish: (patch) => ipcRenderer.invoke(IPC.setupFinish, patch),
    libraryOptions: () => ipcRenderer.invoke(IPC.setupLibraryOptions),
    inspectLibrary: (folder) => ipcRenderer.invoke(IPC.setupInspectLibrary, folder)
  },
  account: {
    signin: (options) => ipcRenderer.invoke(IPC.accountSignin, options),
    signout: () => ipcRenderer.invoke(IPC.accountSignout),
    resetProfile: () => ipcRenderer.invoke(IPC.accountResetProfile)
  },
  cancelSignin: () => ipcRenderer.invoke(IPC.signinCancel),
  onSigninEvent: (cb) => subscribe(IPC.setupEvent, cb),

  search: {
    query: (q, options) => ipcRenderer.invoke(IPC.searchQuery, q, options),
    setEnabled: (enabled, options) => ipcRenderer.invoke(IPC.searchSetEnabled, enabled, options),
    retry: () => ipcRenderer.invoke(IPC.searchRetry),
    rebuild: () => ipcRenderer.invoke(IPC.searchRebuild)
  },

  app: {
    quit: () => ipcRenderer.invoke(IPC.quit),
    hide: () => ipcRenderer.invoke(IPC.hide),
    restartWorker: () => ipcRenderer.invoke(IPC.restartWorker),
    getVersion: () => ipcRenderer.invoke(IPC.getVersion)
  }
}

contextBridge.exposeInMainWorld('api', api)
