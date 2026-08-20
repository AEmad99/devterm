import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TMUX_CLIENT_LEFT_RE,
  TMUX_PROBE_AND_LIST,
  buildDetachedSessionBootstrap,
  buildTmuxAttachCommand,
  buildTmuxKillCommand,
  defaultTmuxName,
  isTmuxSessionGone,
  parseTmuxClients,
  parseTmuxListing,
  pickClientTty,
  sanitizeTmuxName,
  sanitizeTmuxPreview
} from './tmux'

describe('sanitizeTmuxName / defaultTmuxName', () => {
  it('uses a stable sanitized tmux session name from the session id', () => {
    assert.equal(
      defaultTmuxName('35148259-faae-4338-b3dc-0146a4b93a79'),
      'devterm-35148259-faae-4338-b3dc-0146a4b93a79'
    )
  })

  it('strips characters tmux treats as hierarchy separators', () => {
    assert.equal(sanitizeTmuxName('sess/with spaces!and*junk'), 'sess-with-spaces-and-junk')
    assert.doesNotMatch(sanitizeTmuxName('a.b:c'), /[.:]/)
  })
})

describe('parseTmuxListing', () => {
  it('reports unavailable when the probe marker is missing', () => {
    const listing = parseTmuxListing('tmux: command not found\n', 'nope')
    assert.equal(listing.available, false)
    assert.deepEqual(listing.sessions, [])
  })

  it('parses version and session rows after a successful probe', () => {
    const listing = parseTmuxListing(
      [
        '__DT_VER=tmux 3.4',
        '__DT_TMUX_OK',
        'ops\t3\t1\t1710000000',
        'dev\t1\t0\t1710001000',
        ''
      ].join('\n')
    )
    assert.equal(listing.available, true)
    assert.equal(listing.version, 'tmux 3.4')
    assert.equal(listing.sessions.length, 2)
    assert.deepEqual(listing.sessions[0], {
      name: 'ops',
      windows: 3,
      attached: 1,
      created: 1710000000
    })
    assert.equal(listing.sessions[1].name, 'dev')
    assert.equal(listing.sessions[1].attached, 0)
  })

  it('parses activity, pane command, cwd, window list, and pane preview', () => {
    const listing = parseTmuxListing(
      [
        '__DT_VER=tmux 3.4',
        '__DT_TMUX_OK',
        'ops\t3\t1\t1710000000\t1710002000\tmain\tnvim\t/home/ops/app',
        '__DT_PREVIEWS',
        '__DT_P_BEGIN ops',
        '__DT_WINS 0:main*|1:logs|2:ssh',
        '\x1b[32mops@host\x1b[0m:~/app$ \x1b[1mnvim README.md\x1b[0m',
        'editing README.md',
        '__DT_P_END',
        ''
      ].join('\n')
    )
    const ops = listing.sessions[0]
    assert.equal(ops?.activity, 1710002000)
    assert.equal(ops?.currentWindow, 'main')
    assert.equal(ops?.currentCommand, 'nvim')
    assert.equal(ops?.currentPath, '/home/ops/app')
    assert.deepEqual(ops?.windowList, ['0:main*', '1:logs', '2:ssh'])
    assert.equal(ops?.preview, 'ops@host:~/app$ nvim README.md\nediting README.md')
  })

  it('does not treat preview markers as session rows', () => {
    const listing = parseTmuxListing(
      [
        '__DT_TMUX_OK',
        'dev\t1\t0\t1710001000',
        '__DT_PREVIEWS',
        '__DT_P_BEGIN dev',
        'hi',
        '__DT_P_END'
      ].join('\n')
    )
    assert.equal(listing.sessions.length, 1)
    assert.equal(listing.sessions[0]?.name, 'dev')
    assert.equal(listing.sessions[0]?.preview, 'hi')
  })

  it('treats "no server running" as an empty session list, not an error row', () => {
    const listing = parseTmuxListing('__DT_TMUX_OK\nno server running on /tmp/tmux-1000/default\n')
    assert.equal(listing.available, true)
    assert.deepEqual(listing.sessions, [])
  })
})

describe('buildTmuxAttachCommand', () => {
  it('attaches without exec so detach returns to the login shell', () => {
    const script = buildTmuxAttachCommand('ops')
    assert.match(script, /tmux attach-session -t 'ops'/)
    assert.doesNotMatch(script, /\bexec tmux\b/)
    assert.match(script, /allow-passthrough on/)
    assert.match(script, /detached from tmux/)
  })

  it('optionally creates the session before attaching', () => {
    const script = buildTmuxAttachCommand('new-one', { create: true })
    assert.match(script, /tmux new-session -Ad -s 'new-one'/)
    assert.match(script, /tmux attach-session -t 'new-one'/)
    assert.doesNotMatch(script, /\bexec tmux\b/)
  })

  it('single-quotes names so a hostile session name cannot break out', () => {
    const script = buildTmuxAttachCommand("foo'$(reboot)")
    assert.match(script, /'foo'\\''\$\(reboot\)'/)
  })
})

describe('buildDetachedSessionBootstrap', () => {
  it('still targets a stable per-session name, but never execs tmux', () => {
    const script = buildDetachedSessionBootstrap('35148259-faae-4338-b3dc-0146a4b93a79')
    assert.match(script, /tmux new-session -Ad -s 'devterm-35148259-faae-4338-b3dc-0146a4b93a79'/)
    assert.match(script, /tmux attach-session -t 'devterm-35148259-faae-4338-b3dc-0146a4b93a79'/)
    assert.doesNotMatch(script, /\bexec tmux\b/)
  })

  it('probes stay on the listing helper, not the attach script', () => {
    assert.match(TMUX_PROBE_AND_LIST, /command -v tmux/)
    assert.match(TMUX_PROBE_AND_LIST, /tmux -V/)
    assert.match(TMUX_PROBE_AND_LIST, /__DT_TMUX_OK/)
    assert.match(TMUX_PROBE_AND_LIST, /__DT_TMUX_MISSING/)
    assert.match(TMUX_PROBE_AND_LIST, /capture-pane/)
    assert.match(TMUX_PROBE_AND_LIST, /-S -48/)
    assert.match(TMUX_PROBE_AND_LIST, /__DT_PREVIEWS/)
  })
})

describe('sanitizeTmuxPreview', () => {
  it('strips ANSI and control bytes but keeps line breaks', () => {
    assert.equal(sanitizeTmuxPreview('\x1b[31mred\x1b[0m\nnext\r\nlast'), 'red\nnext\nlast')
  })

  it('drops leading and trailing blank lines', () => {
    assert.equal(sanitizeTmuxPreview('\n\nfoo\n\n'), 'foo')
  })
})

describe('tmux kill / clients', () => {
  it('quotes the target session for kill-session', () => {
    const script = buildTmuxKillCommand("ops'$(reboot)")
    assert.match(script, /tmux kill-session -t/)
    assert.match(script, /'ops'\\''\$\(reboot\)'/)
  })

  it('treats missing sessions as already gone', () => {
    assert.equal(isTmuxSessionGone('', "can't find session: ops", 1), true)
    assert.equal(isTmuxSessionGone('', 'no server running on /tmp/tmux-1000/default', 1), true)
    assert.equal(isTmuxSessionGone('', '', 0), true)
    assert.equal(isTmuxSessionGone('', 'permission denied', 1), false)
  })

  it('picks the most recently active client for a session', () => {
    const clients = parseTmuxClients(
      '/dev/pts/3\tops\t10\n/dev/pts/5\tops\t99\n/dev/pts/2\tdev\t50\n'
    )
    assert.equal(pickClientTty(clients, 'ops'), '/dev/pts/5')
    assert.equal(pickClientTty(clients, 'missing'), undefined)
  })
})

describe('TMUX_CLIENT_LEFT_RE', () => {
  it('matches tmux detach / last-pane-exit banners', () => {
    assert.match('[detached (from session ops)]', TMUX_CLIENT_LEFT_RE)
    assert.match('[detached]', TMUX_CLIENT_LEFT_RE)
    assert.match('[exited]', TMUX_CLIENT_LEFT_RE)
    assert.doesNotMatch('detached something in user output', TMUX_CLIENT_LEFT_RE)
  })
})
