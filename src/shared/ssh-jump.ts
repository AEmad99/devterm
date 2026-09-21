import type { SSHHop } from './types'

/** Extra hops besides the target. Target + jumps ≤ 3. */
export const MAX_JUMP_HOPS = 2

/** Normalize a stored `jump` field (legacy single hop or a list) into hops. */
export function listJumpHops(jump: SSHHop | SSHHop[] | undefined | null): SSHHop[] {
  if (!jump) return []
  const hops = Array.isArray(jump) ? jump : [jump]
  return hops
    .filter((h) => h && typeof h.host === 'string' && h.host.trim())
    .slice(0, MAX_JUMP_HOPS)
    .map((h) => ({
      ...h,
      host: h.host.trim(),
      port: Number(h.port) || 22,
      username: (h.username || '').trim()
    }))
}

/** Persist one hop as an object so existing connections.json stays compatible. */
export function encodeJump(hops: SSHHop[]): SSHHop | SSHHop[] | undefined {
  const list = listJumpHops(hops)
  if (!list.length) return undefined
  if (list.length === 1) return list[0]
  return list
}

export function jumpLabel(jump: SSHHop | SSHHop[] | undefined | null): string {
  const hops = listJumpHops(jump)
  if (!hops.length) return ''
  return hops.map((h) => `${h.username}@${h.host}`).join(' → ')
}
