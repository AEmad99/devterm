import { describe, it } from 'node:test'
import assert from 'node:assert'
import { Policy } from './policy'

/**
 * The Policy class is the only guardrail the MCP bridge trusts — it
 * classifies commands as allow / ask / deny under each of the three modes.
 * These tests pin the destructive + mutating regexes against a real-world
 * corpus so a quiet change to a regex doesn't silently widen or narrow the
 * guardrail.
 *
 * A determined model can obfuscate around any denylist (base64, `$IFS`,
 * env indirection); the denylist is a defense-in-depth over a cooperative
 * agent, not a hard sandbox. Tests cover the obvious cases.
 */

const r = (
  cmd: string,
  mode: 'read_only' | 'confirm' | 'full' = 'read_only'
): { allow: boolean; needConfirm: boolean; reason?: string } => {
  const p = new Policy(mode)
  return p.evaluateCommand(cmd)
}

describe('Policy.evaluateCommand — destructive ops', () => {
  const destructiveCases: string[] = [
    'rm -rf /',
    'rm -fr /tmp/x',
    'dd if=/dev/zero of=/dev/sda',
    'shred -u secrets.txt',
    'find . -delete',
    'rsync -avz --delete src/ dst/',
    'systemctl stop nginx',
    'systemctl disable nginx',
    'oc delete pod x',
    'kubectl delete namespace x',
    'drop database prod',
    'drop table users',
    'shutdown -h now',
    'reboot'
  ]

  for (const cmd of destructiveCases) {
    it(`flags "${cmd}" as destructive (read-only → block)`, () => {
      const v = r(cmd, 'read_only')
      assert.strictEqual(v.allow, false, `expected block for ${cmd}`)
      assert.match(v.reason ?? '', /read-only/)
    })
    it(`flags "${cmd}" as needing confirm in confirm mode`, () => {
      const v = r(cmd, 'confirm')
      assert.strictEqual(v.allow, true)
      assert.strictEqual(v.needConfirm, true)
    })
    it(`allows "${cmd}" in full mode without confirm`, () => {
      const v = r(cmd, 'full')
      assert.strictEqual(v.allow, true)
      assert.strictEqual(v.needConfirm, false)
    })
  }
})

describe('Policy.evaluateCommand — mutating ops (read-only blocks)', () => {
  const mutatingCases: string[] = [
    'rm /tmp/x',
    'mv a b',
    'cp a b',
    'touch x',
    'mkdir new',
    'chmod 777 file',
    'chown root file',
    'sed -i s/x/y/ file',
    'tee file',
    'truncate -s 0 file',
    'unlink file',
    'yum install nginx',
    'apt-get update',
    'npm install',
    'pip install requests',
    'npm publish',
    'git push origin main',
    'git reset --hard',
    'git clean -fd',
    'systemctl start nginx',
    'oc apply -f x.yaml',
    'kubectl create deploy x --image=y',
    'echo hi > /etc/hosts',
    'echo hi >> file'
  ]

  for (const cmd of mutatingCases) {
    it(`blocks "${cmd}" in read-only mode`, () => {
      const v = r(cmd, 'read_only')
      assert.strictEqual(v.allow, false, `expected block for ${cmd}`)
    })
    it(`requires confirm for "${cmd}" in confirm mode`, () => {
      const v = r(cmd, 'confirm')
      assert.strictEqual(v.allow, true)
      assert.strictEqual(v.needConfirm, true)
    })
    it(`allows "${cmd}" in full mode`, () => {
      const v = r(cmd, 'full')
      assert.strictEqual(v.allow, true)
      assert.strictEqual(v.needConfirm, false)
    })
  }
})

describe('Policy.evaluateCommand — benign commands', () => {
  const benign: string[] = [
    'ls -la',
    'cat file.txt',
    'grep -r pattern .',
    'find . -name "*.ts"',
    'echo hello',
    'ps aux',
    'df -h',
    'uptime',
    'git status',
    'git log --oneline',
    'git diff',
    'kubectl get pods',
    'oc get pods'
  ]

  for (const cmd of benign) {
    it(`allows "${cmd}" in all modes without confirm`, () => {
      for (const mode of ['read_only', 'confirm', 'full'] as const) {
        const v = r(cmd, mode)
        assert.strictEqual(v.allow, true, `${cmd} blocked in ${mode}`)
        assert.strictEqual(v.needConfirm, false, `${cmd} asked confirm in ${mode}`)
      }
    })
  }
})

describe('Policy.evaluateCommand — heredocs and pipes', () => {
  it('flags a heredoc to a sensitive file as destructive (dd of=)', () => {
    // Heredocs themselves aren't blocked, but destructive patterns inside still match.
    const v = r(`cat <<EOF | dd of=/dev/sda
stuff
EOF`, 'read_only')
    assert.strictEqual(v.allow, false)
  })

  it('flags a piped rm as destructive', () => {
    const v = r('find . -name x | xargs rm -f', 'read_only')
    assert.strictEqual(v.allow, false)
  })
})

describe('Policy.evaluateCommand — token-boundary edge cases', () => {
  it('does not match "kubectlized" against the kubectl prefix', () => {
    // The current denylist matches `\b(oc|kubectl)\s+delete\b` etc. — it
    // requires the destructive suffix, not the bare verb. A plain
    // `kubectlized` should not match.
    const v = r('kubectlized foo', 'read_only')
    assert.strictEqual(v.allow, true)
  })
})

describe('Policy.evaluateWrite', () => {
  it('blocks writes in read-only mode', () => {
    const p = new Policy('read_only')
    const v = p.evaluateWrite()
    assert.strictEqual(v.allow, false)
  })
  it('asks in confirm mode', () => {
    const p = new Policy('confirm')
    const v = p.evaluateWrite()
    assert.strictEqual(v.allow, true)
    assert.strictEqual(v.needConfirm, true)
  })
  it('allows in full mode', () => {
    const p = new Policy('full')
    const v = p.evaluateWrite()
    assert.strictEqual(v.allow, true)
    assert.strictEqual(v.needConfirm, false)
  })
})

describe('Policy PRE-CHECK via rule matcher', () => {
  it('an explicit allow rule short-circuits the mode', async () => {
    const p = new Policy('read_only', async () => ({ outcome: 'allow' }))
    const v = await p.evaluateCommandAsync('sess1', 'rm -rf /')
    assert.strictEqual(v.allow, true)
    assert.strictEqual(v.needConfirm, false)
  })

  it('an explicit deny rule short-circuits the mode', async () => {
    const p = new Policy('full', async () => ({ outcome: 'deny' }))
    const v = await p.evaluateCommandAsync('sess1', 'ls')
    assert.strictEqual(v.allow, false)
    assert.match(v.reason ?? '', /denied by approval rule/)
  })

  it('an ask rule falls through to the mode-based decision', async () => {
    // ask → falls through to mode verdict (here: read_only blocks the destructive cmd)
    const p = new Policy('read_only', async () => ({ outcome: 'ask' }))
    const v = await p.evaluateCommandAsync('sess1', 'rm -rf /')
    assert.strictEqual(v.allow, false)
  })

  it('no rule (undefined matcher) → mode-based decision', async () => {
    const p = new Policy('full')
    const v = await p.evaluateCommandAsync('sess1', 'rm -rf /')
    assert.strictEqual(v.allow, true)
    assert.strictEqual(v.needConfirm, false)
  })
})
