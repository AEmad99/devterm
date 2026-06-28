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

/** A path looks like a POSIX absolute path (vs a Windows `C:\…` path). */
export function isPosixPath(p: string): boolean {
  return p.startsWith('/')
}

/**
 * Quote a path for safe interpolation into a remote shell command. POSIX paths
 * get airtight single-quoting; non-POSIX (Windows) paths keep double quotes with
 * any embedded double-quote characters removed.
 */
export function quoteRemotePath(p: string): string {
  return isPosixPath(p) ? shQuote(p) : `"${p.replace(/"/g, '')}"`
}
