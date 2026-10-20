/**
 * The meeting prompt's channels (MD·T10), in a module of their own for the same reason as toolbar-ipc.ts: two
 * sandboxed preloads importing one module make rollup split it into a chunk they can't require().
 */
export const PROMPT_IPC = {
  // main -> prompt
  state: 'prompt:state',
  // prompt -> main
  ready: 'prompt:ready',
  record: 'prompt:record',
  dismiss: 'prompt:dismiss',
  never: 'prompt:never'
} as const
