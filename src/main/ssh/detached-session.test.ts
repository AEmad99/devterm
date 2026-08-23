import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SHELL_INTEGRATION_RECLAIM_LINES,
  buildDetachedSessionBootstrap,
  buildPosixShellIntegrationSetup
} from './manager'

describe('buildDetachedSessionBootstrap', () => {
  it('uses a stable sanitized tmux session name from the session id', () => {
    const script = buildDetachedSessionBootstrap('35148259-faae-4338-b3dc-0146a4b93a79')
    assert.match(script, /tmux new-session -Ad -s 'devterm-35148259-faae-4338-b3dc-0146a4b93a79'/)
    assert.match(script, /tmux attach-session -t 'devterm-35148259-faae-4338-b3dc-0146a4b93a79'/)
  })

  it('enables allow-passthrough so OSC 7 from the pane reaches DevTerm', () => {
    const script = buildDetachedSessionBootstrap('abc')
    assert.match(script, /allow-passthrough on/)
    assert.match(script, /set-option -t 'devterm-abc' allow-passthrough on/)
  })

  it('does not exec tmux so detach returns to the login shell', () => {
    const script = buildDetachedSessionBootstrap('abc')
    assert.doesNotMatch(script, /\bexec tmux\b/)
    assert.match(script, /detached from tmux/)
  })

  it('sanitizes unsafe characters out of the session name', () => {
    const script = buildDetachedSessionBootstrap('sess/with spaces!and*junk')
    assert.match(script, /-s 'devterm-sess-with-spaces-and-junk'/)
    assert.doesNotMatch(script, /sess\/with/)
  })
})

describe('buildPosixShellIntegrationSetup', () => {
  it('installs __dt7 on PROMPT_COMMAND / precmd_functions and emits OSC 7', () => {
    const script = buildPosixShellIntegrationSetup()
    assert.match(script, /__dt7\(\)/)
    assert.match(script, /PROMPT_COMMAND=/)
    assert.match(script, /precmd_functions\+=\(__dt7\)/)
    assert.match(script, /\]7;file:\/\//)
    assert.match(script, /\]133;A/)
    assert.match(script, /\]133;B/)
  })

  it('wraps OSC sequences in tmux DCS passthrough when TMUX is set', () => {
    const script = buildPosixShellIntegrationSetup()
    // Enable passthrough on the current session (user or DevTerm tmux).
    assert.match(script, /\[ -n "\$\{TMUX-\}" \] && tmux set-option allow-passthrough on/)
    // DCS form: ESC P tmux; ESC ESC ]7;… BEL ESC \
    assert.match(script, /\\033Ptmux;\\033\\033\]7;file:\/\//)
    assert.match(script, /\\033Ptmux;\\033\\033\]133;A/)
    assert.match(script, /\\033Ptmux;\\033\\033\]133;B/)
    // Still has the plain (non-tmux) path for shells outside tmux.
    assert.match(script, /else printf '\\033\]7;file:\/\//)
  })

  it('defers bash prompt marker vars instead of baking OSC bytes into PS1', () => {
    const script = buildPosixShellIntegrationSetup()
    // bash decodes `\[`/`\]` before expanding ${var}, so the marker OSC must not
    // be baked into PS1 (the tmux DCS terminator `ESC \` would collide with `\]`
    // and print a stray `]`). Assert PS1 references ${__dtA}/${__dtB} deferral.
    assert.match(script, /PS1='\\\[\$\{__dtA\}\\\]'"\$PS1"'\\\[\$\{__dtB\}\\\]'/)
    // The old form that embedded the raw marker bytes must be gone.
    assert.doesNotMatch(script, /PS1="\\\[\$__dtA\\\]/)
  })

  it('does not clear the screen after injecting hooks', () => {
    const script = buildPosixShellIntegrationSetup()
    assert.doesNotMatch(script, /\bclear\b/)
    assert.match(script, /stty echo/)
  })

  it('reclaims leftover inject rows instead of leaving blank lines', () => {
    const script = buildPosixShellIntegrationSetup()
    assert.equal(SHELL_INTEGRATION_RECLAIM_LINES, 3)
    assert.match(script, /printf '\\033\[3A\\r\\033\[J'/)
    // OSC 7 is emitted on the next prompt, not on a row we then delete.
    assert.doesNotMatch(script, /stty echo 2>\/dev\/null; __dt7/)
  })
})
