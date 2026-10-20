import type { MissMinutesApi } from '../shared/api'
import type { PromptBridge } from '../shared/meetings'
import type { RecorderBridge, ToolbarBridge } from '../shared/recording'

declare global {
  interface Window {
    api: MissMinutesApi
    /** Only in the hidden recorder window (preload/recorder.ts). */
    recorder: RecorderBridge
    /** Only in the recording mini-toolbar (preload/toolbar.ts). */
    recToolbar: ToolbarBridge
    /** Only in the meeting prompt (preload/prompt.ts). */
    meetPrompt: PromptBridge
  }
}
