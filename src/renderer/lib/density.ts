import type { AppSettings } from '../store/settings'

/**
 * Chrome density. Writes `data-density` onto the document root; compact mode
 * tightens manager/modal/palette spacing via overrides in panels.css. Only
 * cosmetic spacing changes — tab-strip and titlebar heights stay fixed
 * because layout math (TerminalLayout TAB_H) depends on them.
 */
export function applyDensity(density: AppSettings['density']): void {
  document.documentElement.dataset.density = density
}
