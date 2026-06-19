// Attention signals — pull the operator back to a coding AGENT that finished
// work or is waiting for input. Scoped to actual agents, never plain terminals:
//   • the dedicated remote agent pane (AgentPane), and
//   • an inline agent (`claude`/`pi`) run in a normal terminal — detected by its
//     launch command, watched only while it runs (TerminalView).
// A plain shell, a quick command, or a long build never raises attention. (An
// earlier version sniffed the raw stream for \x07, but a shell prompt emits BEL
// as an OSC-string terminator — see the [char]7 in pty/manager.ts — so every
// prompt produced a false "needs attention". Hence: no bell sniffing.)
//
// Detection is idle-based: an agent streams output (a live spinner) while it
// works, so output going quiet for a beat after a real burst is a reliable
// "finished or waiting" signal that an OSC terminator can't trip. `signalAttention`
// then plays a chime, flags the tab, and — only when DevTerm is backgrounded —
// posts an OS notification + flashes the taskbar.
//
// The chime is synthesized with Web Audio (no asset, works offline). An agent
// finishing isn't a user gesture, so the context is warmed up on the first
// interaction (and the BrowserWindow sets autoplayPolicy) — otherwise Chromium
// leaves it suspended and the chime is silent.

import { useSessions } from '../store/sessions'
import { useSettings } from '../store/settings'

/** A user-facing attention notice (OS notification title/body). */
export interface AttentionNotice {
  title: string
  body?: string
}

// ---------------------------------------------------------------------------
// Chime
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      audioCtx = new Ctor()
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return audioCtx
  } catch {
    return null
  }
}

// Warm up / unlock the AudioContext on the first user gesture so a later
// agent-triggered chime (not a gesture) is audible. Belt-and-suspenders with the
// window's autoplayPolicy; also revives a context that started suspended.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const unlock = (): void => {
    getAudioContext()
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}

/**
 * Play the attention chime at `volume` (0..1). A soft rising perfect fifth
 * (E5 → B5) that reads as "done / ready" rather than a harsh alert beep. Safe to
 * call anytime; no-ops when Web Audio is unavailable or the volume is 0.
 */
export function chime(volume = 0.5): void {
  const ctx = getAudioContext()
  if (!ctx) return
  const v = Math.max(0, Math.min(1, volume))
  if (v === 0) return
  const now = ctx.currentTime
  const master = ctx.createGain()
  // Perceptual (square) taper. Loudness tracks amplitude roughly logarithmically,
  // so a *linear* volume reads as top-heavy — 50%→100% is a mere +6 dB and feels
  // like "no change". Squaring spreads the audible range across the whole slider
  // so each step is a clear difference. The ceiling stays gentle (this can fire
  // while you're away) but high enough that 100% is plainly louder than the
  // middle; 50% still lands on 0.09, so the default loudness is unchanged.
  master.gain.value = v * v * 0.36
  master.connect(ctx.destination)
  const notes: Array<{ f: number; at: number }> = [
    { f: 659.25, at: 0 }, // E5
    { f: 987.77, at: 0.11 } // B5
  ]
  for (const n of notes) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = n.f
    const t0 = now + n.at
    // exponentialRamp can't touch 0, so floor the envelope at a hair above it.
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(1, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24)
    osc.connect(g)
    g.connect(master)
    osc.start(t0)
    osc.stop(t0 + 0.26)
  }
}

// ---------------------------------------------------------------------------
// signalAttention
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 4000
const lastSignalAt = new Map<string, number>()

/**
 * Raise an attention signal for `sessionId`: chime + tab badge, plus an OS
 * notification / taskbar flash when DevTerm is backgrounded. Debounced so a
 * burst is one ping. Callers (the agent sink) are responsible for only calling
 * this on a genuine "finished / waiting" transition.
 */
export function signalAttention(sessionId: string, notice: AttentionNotice): void {
  const attention = useSettings.getState().attention
  if (!attention.enabled) return

  const focused = typeof document !== 'undefined' ? document.hasFocus() : true
  const activeId = useSessions.getState().activeId
  const looking = focused && activeId === sessionId

  // Tab badge locates whichever session wants you — skip it only when you're
  // already looking right at that session (no point dotting the current tab).
  if (!looking) {
    try {
      useSessions.getState().setNeedsAttention(sessionId, true)
    } catch {
      /* store unavailable — non-fatal */
    }
  }

  const now = Date.now()
  if (now - (lastSignalAt.get(sessionId) ?? 0) < DEBOUNCE_MS) return
  lastSignalAt.set(sessionId, now)

  // Wrapped so a failure here can never break the terminal data path that calls
  // us (this runs before term.write in the sink).
  try {
    if (attention.sound) chime(attention.volume)
  } catch {
    /* audio unavailable */
  }
  try {
    // OS-level surfacing only makes sense when DevTerm is backgrounded; main
    // re-checks focus and no-ops if we're foreground.
    if (attention.system && !focused) window.devterm.window.flashAttention?.(notice)
  } catch {
    /* bridge unavailable */
  }
}

// ---------------------------------------------------------------------------
// Agent detection — idle-after-sustained-output (no bell sniffing)
// ---------------------------------------------------------------------------

// How long the agent's output must stay quiet (after a burst) before we treat it
// as "finished or waiting". Agents render a live spinner while working, so output
// streams continuously until they actually stop — a quiet period is a reliable
// completion signal. Long enough to ride out a brief streaming gap.
const IDLE_QUIET_MS = 8000

// Minimum span of agent activity (first output → last output, this turn) before a
// following quiet period counts as a real "finished / waiting" transition. It
// filters trivial output: the bare echo of a launch command, a one-line prompt
// redraw. Kept low so a short "asking a question" turn — little preceding work,
// then the agent stops and waits — still signals, the same as a long turn that
// finishes. Shared by both agent surfaces so they behave identically.
const MIN_BURST_MS = 1500

// One wording for every agent attention notice, local pane or remote pane, so the
// "finished" and "needs input" cases read the same everywhere. We can't tell the
// two apart from the output stream (both are "agent stopped emitting"), so the
// copy covers both.
export const AGENT_ATTENTION_BODY = 'Agent finished or needs your input'

/** Command names DevTerm treats as a coding agent when launched in a shell. */
const AGENT_COMMAND_NAMES = new Set(['claude', 'pi'])
/** Wrappers that run another command — `npx claude`, `bunx pi`, etc. */
const RUNNER_NAMES = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'dlx', 'uvx', 'bun'])

const basename = (token: string): string =>
  token
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase()

/**
 * True when a shell command line launches a coding agent (`claude`, `pi`, or one
 * of those via a runner like `npx`). Used to arm idle detection for a normal
 * terminal *only* while an inline agent is running — so plain shells, quick
 * commands, and long builds never raise an alert.
 */
export function isAgentCommand(commandLine: string): boolean {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  if (AGENT_COMMAND_NAMES.has(basename(tokens[0]))) return true
  if (RUNNER_NAMES.has(basename(tokens[0]))) {
    const sub = tokens.slice(1).find((t) => !t.startsWith('-'))
    if (sub && AGENT_COMMAND_NAMES.has(basename(sub))) return true
  }
  return false
}

/**
 * An armed idle detector: while `armed`, a sustained output burst (≥ `minBurstMs`)
 * that then goes quiet for `IDLE_QUIET_MS` raises attention — the agent finished
 * or is waiting for input. Disarmed, output is ignored entirely (no work, no
 * store writes), so a normal terminal costs nothing.
 *
 * Used by both the dedicated agent pane (armed once the operator types) and a
 * normal terminal running an inline agent (armed on the agent's launch command,
 * disarmed when the shell prompt returns). Gated by `attention.idle`.
 *
 * `minBurstMs` defaults to the shared `MIN_BURST_MS` so both surfaces use the same
 * sensitivity; callers only override it for a reason. Call `feed` on each PTY
 * output chunk, `setArmed` to toggle detection, and `dispose` to clear the pending
 * timer on unmount.
 */
export function createIdleChime(opts: {
  sessionId: string
  makeNotice: () => AttentionNotice
  minBurstMs?: number
}): {
  feed: (data: string) => void
  setArmed: (armed: boolean) => void
  onInput: () => void
  dispose: () => void
} {
  const { sessionId, makeNotice } = opts
  const minBurstMs = opts.minBurstMs ?? MIN_BURST_MS
  let timer: number | undefined
  let burstStart = 0
  let lastOutputAt = 0
  let armed = false

  const clear = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
  }

  const feed = (data: string): void => {
    if (!data) return
    if (!armed || !useSettings.getState().attention.idle) {
      clear()
      burstStart = 0
      return
    }
    const now = Date.now()
    if (timer === undefined) burstStart = now // a fresh burst begins
    lastOutputAt = now
    clear()
    timer = window.setTimeout(() => {
      timer = undefined
      // Only fire for a sustained burst that has now gone quiet — filters the
      // quick echo of a launch command and short, non-agent output.
      if (lastOutputAt - burstStart >= minBurstMs) signalAttention(sessionId, makeNotice())
    }, IDLE_QUIET_MS)
  }

  const setArmed = (next: boolean): void => {
    if (armed === next) return
    armed = next
    if (!next) {
      clear()
      burstStart = 0
    }
  }

  // The operator typed — reset the current burst so composing a prompt (which
  // the agent echoes back as output) can't be measured as a finished turn. Only
  // output that arrives after you stop typing counts toward "quiet → done".
  const onInput = (): void => {
    clear()
    burstStart = 0
  }

  return { feed, setArmed, onInput, dispose: clear }
}
