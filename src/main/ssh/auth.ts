import { readFileSync } from 'fs'
import type { ConnectConfig } from 'ssh2'
import type { SSHHop, SSHProfile } from '@shared/types'

/** OpenSSH's Windows named pipe (not Pageant). */
export const WINDOWS_SSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

export const AGENT_NO_KEY_ERROR = 'system agent has no usable key'

export function hopUsesAgent(hop: {
  useAgent?: boolean
  password?: string
  privateKeyPath?: string
}): boolean {
  if (hop.useAgent === true) return true
  if (hop.useAgent === false) return false
  return !hop.password && !hop.privateKeyPath
}

export function systemAgentPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform === 'win32') return WINDOWS_SSH_AGENT_PIPE
  const sock = env.SSH_AUTH_SOCK?.trim()
  return sock || undefined
}

/** Auth fields handed to ssh2 `connect()`. */
export function authConfig(hop: SSHHop): Partial<ConnectConfig> {
  const cfg: Partial<ConnectConfig> = {}
  if (hop.privateKeyPath) {
    cfg.privateKey = readFileSync(hop.privateKeyPath)
    if (hop.passphrase) cfg.passphrase = hop.passphrase
  }
  if (hop.password) cfg.password = hop.password
  if (hopUsesAgent(hop)) {
    const agent = systemAgentPath()
    if (agent) cfg.agent = agent
  }
  return cfg
}

/**
 * Build the hop object `establish()` expects, including `useAgent` so
 * auxiliary Windows clients and reconnects keep the same auth methods.
 */
export function establishProfile(profile: SSHProfile): SSHHop & { jump?: SSHHop | SSHHop[] } {
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    password: profile.password,
    privateKeyPath: profile.privateKeyPath,
    passphrase: profile.passphrase,
    useAgent: profile.useAgent,
    jump: profile.jump
  }
}

function isTransportError(message: string): boolean {
  return (
    /host key/i.test(message) ||
    /timed out/i.test(message) ||
    /ECONNREFUSED/i.test(message) ||
    /ENOTFOUND/i.test(message) ||
    /EHOSTUNREACH/i.test(message) ||
    /TCP connect/i.test(message)
  )
}

function looksLikeAgentAuthFailure(message: string): boolean {
  return (
    /all configured authentication methods failed/i.test(message) ||
    /no more authentication methods/i.test(message) ||
    /cannot connect to (the )?agent/i.test(message) ||
    (/agent/i.test(message) && /fail|error|unable|ENOENT|pipe/i.test(message)) ||
    /connect ENOENT/i.test(message)
  )
}

/** Rewrite agent-auth failures so the UI names the system agent. */
export function mapAuthError(err: Error, hop: SSHHop): Error {
  if (!hopUsesAgent(hop)) return err
  const message = err.message || String(err)
  if (isTransportError(message)) return err
  const agentOnly = !hop.password && !hop.privateKeyPath
  if (agentOnly) {
    return new Error(AGENT_NO_KEY_ERROR)
  }
  if (looksLikeAgentAuthFailure(message)) {
    return new Error(`${message} (${AGENT_NO_KEY_ERROR})`)
  }
  return err
}

/** Thrown before connect when agent is required but no socket/pipe path exists. */
export function missingAgentPathError(hop: SSHHop): Error | null {
  if (!hopUsesAgent(hop)) return null
  if (systemAgentPath()) return null
  return new Error(AGENT_NO_KEY_ERROR)
}
