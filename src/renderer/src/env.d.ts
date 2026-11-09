import type { HoleApi } from '../../shared/types'

declare global {
  interface Window {
    hole: HoleApi
  }
}
