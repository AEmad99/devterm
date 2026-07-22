// Safe construction of remote shell command fragments from untrusted paths.
//
// DevTerm interpolates renderer-/remote-supplied paths (the file explorer's
// current directory, a filename) into one-shot commands run over the SSH exec
// channel — e.g. `cd <dir> && git status`. Double-quoting a path is NOT safe in
// a POSIX shell: `"$(...)"`, backticks, and `${...}` still expand inside double
// quotes, so a directory literally named `$(reboot)` would execute. Single
// quotes are the only airtight POSIX escape.
//
// Windows remotes (cmd.exe / PowerShell) treat single quotes literally, so a
// POSIX single-quote escape would break their paths. We detect POSIX paths by
// their leading slash (which is also how mcp/tools.ts gates its own cwd prefix)
// and fall back to double quotes with embedded quotes stripped for Windows —
// the `"` character is not legal in a Windows path anyway, so stripping it can
// only remove an injection attempt, never a real path component.

/** Single-quote a string for a POSIX shell: close, escaped literal quote, reopen. */
export function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** A path looks like a POSIX absolute path (vs a Windows `C:\…` or `C:/…` path). */
export function isPosixPath(p: string): boolean {
  return p.startsWith('/') && !/^[a-zA-Z]:\//.test(p)
}

/** PowerShell single-argument escape: double single quotes embed a literal quote. */
function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`
}

/**
 * Quote a path for safe interpolation into a remote shell command.
 *  - POSIX paths get airtight single-quoting.
 *  - Windows paths get PowerShell single-quoting (safe for cmd.exe callers that
 *    forward to PowerShell) with embedded single quotes doubled.
 */
export function quoteRemotePath(p: string): string {
  if (isPosixPath(p)) return shQuote(p)
  return psQuote(p)
}
