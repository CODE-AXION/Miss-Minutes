import { create } from 'zustand'

/** signin = sign in (or verify), switch = use a different account, signout = sign out only. */
export type SigninMode = 'signin' | 'switch' | 'signout'

export const useSigninRequest = create<{ request: { mode: SigninMode; id: number } | null }>(
  () => ({
    request: null
  })
)

let nextId = 1

/** Opens the sign-in dialog (Settings → Google account, the health card's fix action) and starts the run. */
export function openSignin(mode: SigninMode): void {
  if (useSigninRequest.getState().request) return
  useSigninRequest.setState({ request: { mode, id: nextId++ } })
}
