// Windows OpenSSH (Win32-OpenSSH) helpers.
//
// The exec channel on Windows OpenSSH is cmd.exe even when the interactive
// shell is PowerShell. SFTP speaks a POSIX-looking path (`/C/Users/...`),
// while OSC 7 / PowerShell report `C:\Users\...`. Agent host tools, git,
// and the file explorer all have to round-trip between those forms.

import { posix } from 'path'

export interface WindowsDrivePath {
  drive: string
  rest: string
}

const RE_SFTP_DRIVE_COLON = new RegExp("^/([A-Za-z]):[\\\\/]+(.*)$")
const RE_SFTP_DRIVE_SLASH = new RegExp("^/([A-Za-z])/(.*)$")
const RE_SFTP_DRIVE_ONLY = new RegExp("^/([A-Za-z])$")
const RE_FS_DRIVE = new RegExp("^([A-Za-z]):[\\\\/]+(.*)$")
const RE_FS_DRIVE_ONLY = new RegExp("^([A-Za-z]):\\\\?$")
const RE_SEP_RUNS = new RegExp("[\\\\/]+", "g")
const RE_TRAILING_BSLASH = new RegExp("\\\\+$")
const RE_LEADING_SEP = new RegExp("^[\\\\/]+")
const RE_DOT_SLASH = new RegExp("^\\./")
const RE_SLASH = new RegExp("/", "g")
const RE_POWERSHELL_EXE = new RegExp("\\bpowershell\\.exe\\b", "i")
const RE_POWERSHELL_SCRIPT_BLOCK = new RegExp(
  "\\b-Command\\b[\\s\\S]*FromBase64String\\('",
  "i"
)

/**
 * Parse a Windows drive path in any of the forms DevTerm actually sees:
 * `C:\Users\x`, `C:/Users/x`, `/C/Users/x`, `/C:/Users/x`.
 */
export function parseWindowsRemotePath(p: string): WindowsDrivePath | null {
  const s = p.trim()
  if (!s) return null
  let m = s.match(RE_SFTP_DRIVE_COLON)
  if (m) return { drive: m[1].toUpperCase(), rest: m[2] }
  m = s.match(RE_SFTP_DRIVE_SLASH)
  if (m) return { drive: m[1].toUpperCase(), rest: m[2] }
  m = s.match(RE_SFTP_DRIVE_ONLY)
  if (m) return { drive: m[1].toUpperCase(), rest: "" }
  m = s.match(RE_FS_DRIVE)
  if (m) return { drive: m[1].toUpperCase(), rest: m[2] }
  m = s.match(RE_FS_DRIVE_ONLY)
  if (m) return { drive: m[1].toUpperCase(), rest: "" }
  return null
}

export function isWindowsRemotePath(p: string): boolean {
  return parseWindowsRemotePath(p) !== null
}

/** Convert to a native Windows path for PowerShell Set-Location. */
export function toWindowsFsPath(p: string): string {
  const parsed = parseWindowsRemotePath(p)
  if (!parsed) return p
  const rest = parsed.rest.replace(RE_SEP_RUNS, "\\")
  return rest ? parsed.drive + ":\\" + rest : parsed.drive + ":\\"
}

/** Convert to Win32-OpenSSH SFTP form (`/C/Users/...`). */
export function toWindowsSftpPath(p: string): string {
  const parsed = parseWindowsRemotePath(p)
  if (!parsed) return posix.normalize(p.replace(/\\/g, "/"))
  const rest = parsed.rest.replace(/\\/g, "/")
  return posix.normalize(rest ? "/" + parsed.drive + "/" + rest : "/" + parsed.drive)
}

/** Resolve a possibly-relative path against a Windows cwd. */
export function resolveWindowsRelative(cwd: string | undefined, p: string): string {
  const t = p.trim()
  if (!t || t === ".") return cwd ?? t
  if (isWindowsRemotePath(t)) return t
  if (t.startsWith("/") || t.startsWith("\\")) return t
  if (!cwd) return t
  const rel = t.replace(RE_LEADING_SEP, "").replace(RE_DOT_SLASH, "")
  const fsCwd = toWindowsFsPath(cwd).replace(RE_TRAILING_BSLASH, "")
  return fsCwd + "\\" + rel.replace(RE_SLASH, "\\")
}

/** PowerShell single-argument escape: double embedded single quotes. */
export function psQuote(p: string): string {
  const sq = String.fromCharCode(39)
  return sq + p.split(sq).join(sq + sq) + sq
}

function encodePowerShellScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

/**
 * Run a PowerShell script through Windows OpenSSH cmd.exe exec channel.
 * EncodedCommand (UTF-16LE base64) avoids quoting collisions with cmd.
 */
export function powershellEncodedCommand(script: string): string {
  const encoded = encodePowerShellScript(script)
  return "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded
}

/**
 * Run a noninteractive PowerShell script without the CLIXML progress marker
 * emitted by Windows PowerShell when `-EncodedCommand` is attached to an SSH
 * exec request. The payload is still base64/UTF-16LE, so command quoting stays
 * safe even when the original script contains paths or shell metacharacters.
 */
export function powershellCommand(script: string): string {
  const encoded = encodePowerShellScript(script)
  return (
    "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command " +
    `"[ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))).Invoke()"`
  )
}

/**
 * Start an interactive PowerShell with the prompt hook already installed.
 * `-EncodedCommand` is ideal for one-shot commands, but PowerShell emits a
 * CLIXML progress marker when it is used for an interactive PTY. Put the
 * UTF-16LE payload inside a `-Command` ScriptBlock instead: the command line
 * remains quote-safe while the PTY receives only the real prompt and output.
 */
export function windowsPowerShellInteractiveCommand(script: string): string {
  const encoded = encodePowerShellScript(script)
  return (
    "powershell.exe -NoLogo -NoExit -Command " +
    `"[ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))).Invoke()"`
  )
}

/**
 * xterm emits the physical Backspace key as DEL (`0x7f`). Win32 OpenSSH's
 * Windows PTY expects BS (`0x08`) for readline/PSReadLine to erase a
 * character. Keep this translation at the SSH boundary so keyboard input from
 * the terminal, snippets, and autocomplete all use the same wire format.
 */
export function normalizeWindowsInteractiveInput(data: string): string {
  return data.replace(/\x7f/g, '\b')
}

export function isAlreadyWindowsWrapped(command: string): boolean {
  return (
    RE_POWERSHELL_EXE.test(command) &&
    (/EncodedCommand/i.test(command) || RE_POWERSHELL_SCRIPT_BLOCK.test(command))
  )
}

/** Wrap an agent run_command so it runs in PowerShell at the operator cwd. */
export function wrapWindowsRemoteCommand(command: string, cwd?: string): string {
  if (isAlreadyWindowsWrapped(command)) return command
  const parts: string[] = ["$ErrorActionPreference = \"Continue\""]
  if (cwd) parts.push("Set-Location -LiteralPath " + psQuote(toWindowsFsPath(cwd)))
  parts.push(command)
  parts.push("if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }")
  return powershellCommand(parts.join("; "))
}

/** Wrap a remote git invocation for Windows OpenSSH. */
export function wrapWindowsGitCommand(cwd: string, gitArgsQuoted: string): string {
  const script =
    "Set-Location -LiteralPath " +
    psQuote(toWindowsFsPath(cwd)) +
    "; git " +
    gitArgsQuoted +
    "; exit $LASTEXITCODE"
  return powershellCommand(script)
}

