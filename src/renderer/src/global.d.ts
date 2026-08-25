import type { YxferApi } from '../../preload'

declare global {
  interface Window {
    yxfer: YxferApi
  }
}

export {}
