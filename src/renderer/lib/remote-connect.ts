/**
 * Keep remote connection starts apart during restore/workspace/grid launches.
 * A small fixed interval is deliberate: it bounds the number of ssh2 clients
 * created in one renderer tick without making local PTY creation wait.
 */
export const REMOTE_CONNECT_STAGGER_MS = 300

export function waitForRemoteConnectStagger(index: number): Promise<void> {
  if (index <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, index * REMOTE_CONNECT_STAGGER_MS))
}
