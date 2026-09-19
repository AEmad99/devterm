/**
 * Decide whether a user-originated BrowserWindow close should become a tray
 * hide. Explicit quit and the headless self-test must always retain the normal
 * close path.
 */
export function shouldHideToTrayOnClose(input: {
  keepSessionsInTray: boolean
  allowWindowClose: boolean
  selfTest: boolean
}): boolean {
  return input.keepSessionsInTray && !input.allowWindowClose && !input.selfTest
}
