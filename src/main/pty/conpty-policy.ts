/**
 * The bundled ConPTY path launches node-pty's OpenConsole.exe helper. On
 * current Windows 11 builds that helper can access-violate during teardown,
 * taking an agent PTY with it and surfacing as a main-process JavaScript error.
 * Keep it available for targeted diagnostics, but use the in-box ConPTY by
 * default because it does not depend on the crashing helper process.
 */
export function shouldUseBundledConpty(
  platform: NodeJS.Platform,
  bundledAvailable: boolean,
  optIn: string | undefined
): boolean {
  return platform === 'win32' && bundledAvailable && optIn === '1'
}
