import type { MissMinutesApi } from '../shared/api'
import type { RecorderBridge, ToolbarBridge } from '../shared/recording'

declare global {
  interface Window {
    api: MissMinutesApi
    /** Only in the hidden recorder window (preload/recorder.ts). */
    recorder: RecorderBridge
    /** Only in the recording mini-toolbar (preload/toolbar.ts). */
    recToolbar: ToolbarBridge
  }
}
