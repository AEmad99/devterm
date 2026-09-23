import type { AgentKind } from '@shared/types'
import devterm from '../assets/agents/devterm.svg'
import claude from '../assets/agents/claude.svg'
import pi from '../assets/agents/pi.svg'
import opencode from '../assets/agents/opencode.svg'
import kimi from '../assets/agents/kimi.svg'
import grok from '../assets/agents/grok.svg'
import codex from '../assets/agents/codex.svg'
import antigravity from '../assets/agents/antigravity.png'
import muse from '../assets/agents/muse.svg'
import cursor from '../assets/agents/cursor.svg'

/**
 * Bundled brand icons for the agent kind picker. Sources are the official
 * marks: the DevTerm app icon, simple-icons renditions of Claude/Kimi/OpenCode,
 * the pi.dev π mark, the xAI Grok tile, the OpenAI Codex mark from the
 * official OAI_Codex lockup, Google's Antigravity logo from antigravity.google,
 * Meta's Muse Code mark, and a Cursor mark for the Cursor Agent CLI.
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
  antigravity,
  muse,
  cursor
}

export function agentKindIcon(kind: AgentKind): string | undefined {
  return AGENT_ICONS[kind]
}
