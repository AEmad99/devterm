import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDetachedSessionBootstrap } from './manager'

describe('buildDetachedSessionBootstrap', () => {
  it('uses a stable sanitized tmux session name from the session id', () => {
    const script = buildDetachedSessionBootstrap('35148259-faae-4338-b3dc-0146a4b93a79')
    assert.match(script, /tmux new-session -A -s 'devterm-35148259-faae-4338-b3dc-0146a4b93a79'/)
  })

  it('probes tmux -V so broken installs (missing libs) fall back to a normal shell', () => {
    const script = buildDetachedSessionBootstrap('abc')
    assert.match(script, /command -v tmux/)
    assert.match(script, /tmux -V/)
    assert.match(script, /missing libraries\?/)
    assert.match(script, /tmux is not installed/)
    assert.match(script, /tmux failed to start/)
  })

  it('sanitizes unsafe characters out of the tmux session name', () => {
    const script = buildDetachedSessionBootstrap('sess/with spaces!and*junk')
    assert.match(script, /-s 'devterm-sess-with-spaces-and-junk'/)
    assert.doesNotMatch(script, /sess\/with/)
  })
})
