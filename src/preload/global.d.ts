import type { MagneticApi } from '../shared/ipc'

declare global {
  interface Window {
    api: MagneticApi
  }
}

export {}
