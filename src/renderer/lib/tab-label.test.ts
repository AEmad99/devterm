import { describe, it } from 'node:test'
import assert from 'node:assert'
import { summarizeCommand, summarizeAgentTask, deriveTabLabel } from './tab-label'

/**
 * summarizeCommand flattens noisy agent invocations into something readable
 * in a tab. summarizeAgentTask unwraps `tool: key=value…` dumps and keeps
 * the tool name + the most useful value. These tests pin both against
 * real-world agent output shapes.
 */

describe('summarizeCommand', () => {
  it('returns empty string for empty input', () => {
    assert.strictEqual(summarizeCommand(''), '')
    assert.strictEqual(summarizeCommand('   '), '')
  })

  it('passes short commands through', () => {
    assert.strictEqual(summarizeCommand('ls -la'), 'ls -la')
  })

  it('strips a leading command= or cmd= prefix', () => {
    assert.strictEqual(summarizeCommand('command=ls -la'), 'ls -la')
    assert.strictEqual(summarizeCommand('cmd=ls -la'), 'ls -la')
  })

  it('prefers the value when the whole string is a single key=value', () => {
    assert.strictEqual(summarizeCommand('path=/etc/nginx/nginx.conf'), '/etc/nginx/nginx.conf')
  })

  it('keeps a leading prefix and marks the heredoc body with `<<…`', () => {
    // The heredoc regex requires the program + optional short flags
    // (no positional args) before `<<`. `sudo nginx -t <<EOF …` matches;
    // a command with a positional path between the program and the
    // heredoc does not (the existing regex limitation — a future
    // improvement could widen it to accept a single positional arg).
    const cmd = 'sudo nginx -t <<EOF\nserver {\nlisten 80;\n}\nEOF'
    const out = summarizeCommand(cmd)
    assert.match(out, /^sudo nginx -t <<…$/)
  })

  it('marks a long pipeline with the first clause and an ellipsis', () => {
    const cmd = 'docker build -t myimage . && docker push myimage && docker rmi myimage'
    const out = summarizeCommand(cmd, 30)
    assert.match(out, /\u2026$/)
    assert.ok(out.length <= 30)
  })

  it('truncates a single long command with no chain', () => {
    const cmd = 'a'.repeat(200)
    const out = summarizeCommand(cmd, 50)
    assert.ok(out.length <= 50)
  })
})

describe('summarizeAgentTask', () => {
  it('returns the original string when there is no tool: prefix', () => {
    assert.strictEqual(summarizeAgentTask('ls -la'), 'ls -la')
  })

  it('returns just the tool when the value is empty', () => {
    assert.strictEqual(summarizeAgentTask('ping:'), 'ping')
  })

  it('unwraps tool: command=… and runs summarizeCommand on the value', () => {
    const out = summarizeAgentTask('run_command: command=ls -la')
    assert.strictEqual(out, 'run_command ls -la')
  })

  it('unwraps tool: path=… and shows the file basename', () => {
    const out = summarizeAgentTask('read_file: path=/etc/nginx/nginx.conf')
    assert.strictEqual(out, 'read_file nginx.conf')
  })

  it('handles a generic first key=value', () => {
    const out = summarizeAgentTask('write_file: content=hello world')
    assert.strictEqual(out, 'write_file hello world')
  })
})

describe('deriveTabLabel — exit codes', () => {
  it('shows non-zero exit on a closed session as context', () => {
    const label = deriveTabLabel({
      kind: 'local',
      title: 'Local 1',
      closed: true,
      exitCode: 127
    })
    assert.strictEqual(label.context, 'exit 127')
    assert.match(label.tooltip, /exit: 127/)
  })

  it('shows clean exit without inventing an error chip', () => {
    const label = deriveTabLabel({
      kind: 'local',
      title: 'Local 1',
      closed: true,
      exitCode: 0
    })
    assert.strictEqual(label.context, 'exited')
  })
})
