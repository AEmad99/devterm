/**
 * Caps how many SSH exec channels a session may hold open at once.
 *
 * OpenSSH's default MaxSessions is 10, and that budget is shared with the
 * interactive shell, SFTP, and port forwards. Agents that fan out tool calls
 * (Claude, Cursor, Codex more than sequential CLIs) were opening a channel
 * per call on the same client. Past the cap the server resets the whole
 * transport, which the agent reports as a dropped connection. Extra calls
 * wait here instead of opening another channel.
 */
export function createExecGate(limit: number) {
  let active = 0
  const waiters: Array<() => void> = []
  const slots = Math.max(1, limit)

  return {
    acquire(): Promise<() => void> {
      if (active < slots) {
        active += 1
        return Promise.resolve(release)
      }
      return new Promise((resolve) => {
        waiters.push(() => {
          active += 1
          resolve(release)
        })
      })
    }
  }

  function release(): void {
    active = Math.max(0, active - 1)
    const next = waiters.shift()
    if (next) next()
  }
}

/** Parallel execs kept below a typical MaxSessions budget (shell + SFTP + git). */
export const POSIX_EXEC_SLOTS = 4
