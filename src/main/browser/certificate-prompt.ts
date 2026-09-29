import type { BrowserCertificatePrompt } from '@shared/types'

/**
 * Holds in-app certificate decisions until the renderer answers.
 * The native OS message box is intentionally not used: a Windows dialog
 * sitting on top of a browser pane looks like a system prompt the page
 * itself raised. Refusal is the result when nobody can show the prompt
 * or the operator does not answer in time.
 */
export function createCertificatePromptBroker(timeoutMs = 120_000): {
  ask: (
    prompt: BrowserCertificatePrompt,
    deliver: (prompt: BrowserCertificatePrompt) => boolean
  ) => Promise<boolean>
  reply: (id: string, trust: boolean) => void
  pending: () => BrowserCertificatePrompt[]
} {
  const waiting = new Map<
    string,
    {
      prompt: BrowserCertificatePrompt
      resolve: (trust: boolean) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const finish = (id: string, trust: boolean) => {
    const row = waiting.get(id)
    if (!row) return
    clearTimeout(row.timer)
    waiting.delete(id)
    row.resolve(trust)
  }

  return {
    ask(prompt, deliver) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(prompt.id, false), timeoutMs)
        waiting.set(prompt.id, { prompt, resolve, timer })
        let delivered = false
        try {
          delivered = deliver(prompt)
        } catch {
          /* A failed send refuses the certificate. */
        }
        if (!delivered) finish(prompt.id, false)
      })
    },
    reply(id, trust) {
      finish(id, trust === true)
    },
    pending() {
      return [...waiting.values()].map((row) => row.prompt)
    }
  }
}
