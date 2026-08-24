import type { AgentKind } from '@shared/types'
import devterm from '../assets/agents/devterm.svg'
import claude from '../assets/agents/claude.svg'
import pi from '../assets/agents/pi.svg'
import opencode from '../assets/agents/opencode.svg'
import kimi from '../assets/agents/kimi.svg'
import grok from '../assets/agents/grok.svg'
import codex from '../assets/agents/codex.svg'
import antigravity from '../assets/agents/antigravity.png'

/**
 * Bundled brand icons for the agent kind picker. Sources are the official
 * marks: the DevTerm app icon, simple-icons renditions of Claude/Kimi/OpenCode,
 * the pi.dev π mark, the xAI Grok tile, the OpenAI Codex mark from the
 * official OAI_Codex lockup, and Google's Antigravity logo from antigravity.google.
 * Monochrome marks are baked white for the dark UI; undefined kinds fall back
 * to the letter glyph in agent-ui.ts.
 */
const AGENT_ICONS: Partial<Record<AgentKind, string>> = {
  devterm,
  claude,
  pi,
  opencode,
  kimi,
  grok,
  codex,
  antigravity
}

export function agentKindIcon(kind: AgentKind): string | undefined {
  return AGENT_ICONS[kind]
}
