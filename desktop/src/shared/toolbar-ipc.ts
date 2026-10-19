/**
 * The floating mini-toolbar's channels (RC·T29), in a module of their own: the recorder preload imports
 * RECORDER_IPC from recording.ts, and two sandboxed preloads importing one module make rollup split it into a chunk
 * they can't require().
 */
export const TOOLBAR_IPC = {
  // main -> toolbar
  state: 'toolbar:state',
  // toolbar -> main
  ready: 'toolbar:ready',
  stop: 'toolbar:stop',
  mute: 'toolbar:mute'
} as const
