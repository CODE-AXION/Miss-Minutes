import type { MissMinutesApi } from '../shared/api'

declare global {
  interface Window {
    api: MissMinutesApi
  }
}
