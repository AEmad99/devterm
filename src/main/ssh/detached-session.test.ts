import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ECHO_RESTORE_FAILSAFE_MS,
  SHELL_INTEGRATION_IDLE_MS,
  SHELL_INTEGRATION_MAX_WAIT_MS,
  SHELL_INTEGRATION_READY_MARK,
  SHELL_INTEGRATION_READY_MARK_TMUX,
  SHELL_INTEGRATION_RECLAIM_LINES,
  STTY_ENABLE_ECHO,
  buildDetachedSessionBootstrap,
  buildPosixShellIntegrationSetup,
  buildQuietStartCwd,
  consumeShellIntegrationReady
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

  it('exports MOTD-idle timing so long banners are not raced', () => {
    assert.ok(SHELL_INTEGRATION_IDLE_MS >= 300)
    assert.ok(SHELL_INTEGRATION_MAX_WAIT_MS >= SHELL_INTEGRATION_IDLE_MS * 4)
    // The echo failsafe must outlast a normal ready-marker round trip, or it
    // types `stty echo` at the prompt after a successful inject.
    assert.ok(ECHO_RESTORE_FAILSAFE_MS >= 3000)
    // If the failsafe still lands after echo is on, erase the row it paints.
    assert.match(STTY_ENABLE_ECHO, /stty echo 2>\/dev\/null/)
    assert.ok(STTY_ENABLE_ECHO.includes('\\033[1A\\r\\033[2K'))
  })

  it('prints a ready marker only after echo is restored', () => {
    const script = buildPosixShellIntegrationSetup()
    const echoAt = script.lastIndexOf('stty echo')
    const markAt = script.indexOf('633;P;DevTermReady')
    assert.ok(echoAt >= 0 && markAt > echoAt)
    assert.ok(script.includes("printf '\\033]633;P;DevTermReady\\007'"))
    assert.ok(script.includes("printf '\\033Ptmux;\\033\\033]633;P;DevTermReady\\007\\033\\\\'"))
    assert.equal(script.includes('cd --'), false)
  })

  it('changes to the start directory inside the quiet inject', () => {
    const script = buildPosixShellIntegrationSetup({ startCwd: '/root' })
    assert.ok(script.startsWith("cd -- '/root' 2>/dev/null || true; "))
    const evil = buildPosixShellIntegrationSetup({ startCwd: '/tmp/$(reboot)' })
    assert.ok(evil.startsWith("cd -- '/tmp/$(reboot)' 2>/dev/null || true; "))
    assert.equal(evil.includes('$(reboot)'), true)
    const injected = buildPosixShellIntegrationSetup({ startCwd: '/tmp\nrm -rf /' })
    assert.equal(injected.startsWith('cd '), false)
    assert.equal(injected.includes('rm -rf'), false)
  })
})

describe('buildQuietStartCwd', () => {
  it('cds without installing prompt hooks', () => {
    const script = buildQuietStartCwd('/root')
    assert.ok(script.startsWith("cd -- '/root' 2>/dev/null || true; "))
    assert.equal(script.includes('__dt7'), false)
    assert.equal(script.includes('633;P;DevTermReady'), true)
    assert.equal(buildQuietStartCwd('/tmp\nid'), '')
  })
})

describe('consumeShellIntegrationReady', () => {
  it('strips the ready marker and reports it', () => {
    const out = consumeShellIntegrationReady(
      '',
      `banner${SHELL_INTEGRATION_READY_MARK}[root@host ~]# `
    )
    assert.equal(out.ready, true)
    assert.equal(out.text, 'banner[root@host ~]# ')
    assert.equal(out.carry, '')
  })

  it('strips the tmux DCS form', () => {
    const out = consumeShellIntegrationReady('', `x${SHELL_INTEGRATION_READY_MARK_TMUX}y`)
    assert.equal(out.ready, true)
    assert.equal(out.text, 'xy')
  })

  it('holds a marker split across chunks', () => {
    const mark = SHELL_INTEGRATION_READY_MARK
    const mid = 6
    const first = consumeShellIntegrationReady('', `prompt${mark.slice(0, mid)}`)
    assert.equal(first.ready, false)
    assert.equal(first.text, 'prompt')
    assert.equal(first.carry, mark.slice(0, mid))
    const second = consumeShellIntegrationReady(first.carry, `${mark.slice(mid)}# `)
    assert.equal(second.ready, true)
    assert.equal(second.text, '# ')
    assert.equal(second.carry, '')
  })

  it('releases a held escape that is not the ready marker', () => {
    const held = consumeShellIntegrationReady('', 'hi\x1b')
    assert.equal(held.text, 'hi')
    assert.equal(held.carry, '\x1b')
    const next = consumeShellIntegrationReady(held.carry, '[31mOK')
    assert.equal(next.ready, false)
    assert.equal(next.text, '\x1b[31mOK')
    assert.equal(next.carry, '')
  })

  it('does not swallow a normal OSC 133 prompt', () => {
    const prompt = '[root@newaiops ~]# \x1b]133;B\x07'
    const out = consumeShellIntegrationReady('', prompt)
    assert.equal(out.ready, false)
    assert.equal(out.text, prompt)
    assert.equal(out.carry, '')
  })
})
