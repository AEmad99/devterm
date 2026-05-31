import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'

/** Pick a CodeMirror language extension from a filename, or none for plain text. */
export function languageFor(name: string): Extension[] {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return [javascript()]
    case 'ts':
      return [javascript({ typescript: true })]
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })]
    case 'json':
    case 'jsonc':
      return [json()]
    case 'html':
    case 'htm':
      return [html()]
    case 'css':
    case 'scss':
    case 'less':
      return [css()]
    case 'md':
    case 'markdown':
      return [markdown()]
    case 'py':
      return [python()]
    case 'rs':
      return [rust()]
    case 'xml':
    case 'svg':
      return [xml()]
    case 'yaml':
    case 'yml':
      return [yaml()]
    default:
      return []
  }
}
