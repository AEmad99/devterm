export type ShellDialect = 'shell' | 'powershell'
export type ShellTokenKind =
  'text' | 'command' | 'flag' | 'string' | 'comment' | 'operator' | 'number' | 'path'

export interface ShellToken {
  kind: ShellTokenKind
  text: string
}

const OPERATORS = /^(&&|\|\||;;|<<|>>|[|;&<>])/
const FLAG = /^(--?[\w][\w-]*)/
const NUMBER = /^(\d+(?:\.\d+)?)/
const PATH = /^(?:~|\.{1,2})?(?:\/[\w.+@-]+)+\/?/
const WIN_PATH = /^(?:[A-Za-z]:\\|\\\\)[\w.\\ -]+/
const WORD = /^([^\s'"#;|&<>]+)/

function takeString(src: string, quote: string): { text: string; rest: string } {
  let i = 1
  while (i < src.length) {
    if (src[i] === '\\' && i + 1 < src.length) {
      i += 2
      continue
    }
    if (src[i] === quote) {
      i += 1
      break
    }
    i += 1
  }
  return { text: src.slice(0, i), rest: src.slice(i) }
}

/** Lightweight highlighter for the OSC 133 command editor. No new framework. */
export function tokenizeShell(input: string, dialect: ShellDialect = 'shell'): ShellToken[] {
  const tokens: ShellToken[] = []
  let rest = input
  let firstWord = true
  while (rest.length) {
    const space = rest.match(/^\s+/)
    if (space) {
      tokens.push({ kind: 'text', text: space[0] })
      rest = rest.slice(space[0].length)
      continue
    }
    if (rest.startsWith('#') && dialect === 'shell') {
      tokens.push({ kind: 'comment', text: rest })
      break
    }
    if (rest.startsWith('<#') && dialect === 'powershell') {
      const end = rest.indexOf('#>')
      const chunk = end >= 0 ? rest.slice(0, end + 2) : rest
      tokens.push({ kind: 'comment', text: chunk })
      rest = end >= 0 ? rest.slice(end + 2) : ''
      continue
    }
    if ((dialect === 'powershell' && rest.startsWith('#')) || rest.startsWith('<#')) {
      tokens.push({ kind: 'comment', text: rest })
      break
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const taken = takeString(rest, rest[0])
      tokens.push({ kind: 'string', text: taken.text })
      rest = taken.rest
      firstWord = false
      continue
    }
    const op = rest.match(OPERATORS)
    if (op) {
      tokens.push({ kind: 'operator', text: op[1] })
      rest = rest.slice(op[1].length)
      firstWord = true
      continue
    }
    const flag = rest.match(FLAG)
    if (flag) {
      tokens.push({ kind: 'flag', text: flag[1] })
      rest = rest.slice(flag[1].length)
      firstWord = false
      continue
    }
    const path = rest.match(dialect === 'powershell' ? WIN_PATH : PATH)
    if (path) {
      tokens.push({ kind: 'path', text: path[0] })
      rest = rest.slice(path[0].length)
      firstWord = false
      continue
    }
    const num = rest.match(NUMBER)
    if (num && !firstWord) {
      tokens.push({ kind: 'number', text: num[1] })
      rest = rest.slice(num[1].length)
      continue
    }
    const word = rest.match(WORD)
    if (word) {
      tokens.push({ kind: firstWord ? 'command' : 'text', text: word[1] })
      rest = rest.slice(word[1].length)
      firstWord = false
      continue
    }
    tokens.push({ kind: 'text', text: rest[0] })
    rest = rest.slice(1)
  }
  return tokens
}
