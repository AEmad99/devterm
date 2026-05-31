// Pure helpers for snippet placeholder substitution. A snippet command may
// contain {{token}} placeholders (e.g. `ssh {{user}}@{{host}}`); these are
// collected and prompted for before the command is sent to a terminal.

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g

/** Unique placeholder names in `command`, in first-seen order. */
export function extractPlaceholders(command: string): string[] {
  const seen: string[] = []
  for (const m of command.matchAll(TOKEN)) {
    if (!seen.includes(m[1])) seen.push(m[1])
  }
  return seen
}

/** Substitute placeholder values into `command`; unfilled tokens are left as-is. */
export function applyPlaceholders(command: string, values: Record<string, string>): string {
  return command.replace(TOKEN, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole
  )
}
