import type { FitAddon } from '@xterm/addon-fit'

/**
 * Fit xterm to its host, but only when the host has real dimensions. Calling
 * fit() while the element is hidden (display:none) or pre-layout (0×0) computes
 * 0 cols and corrupts sizing — that's what made panes look "cut". Returns true
 * if a fit happened.
 */
export function fitNow(fit: FitAddon, host: HTMLElement): boolean {
  if (host.clientWidth < 20 || host.clientHeight < 20) return false
  try {
    fit.fit()
    return true
  } catch {
    return false
  }
}

/**
 * Retry fits across a few animation frames after mount/visibility changes, since
 * flex/absolute layout may not have settled on the first call.
 */
export function fitSoon(fit: FitAddon, host: HTMLElement, onFit: () => void): void {
  let tries = 0
  const tick = () => {
    if (fitNow(fit, host)) onFit()
    if (++tries < 6) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
