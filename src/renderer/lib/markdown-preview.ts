import { marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'img',
  'em',
  'strong',
  'del',
  'hr',
  'br',
  'input',
  'span'
] as const

const ALLOWED_ATTR = [
  'href',
  'src',
  'alt',
  'title',
  'class',
  'type',
  'checked',
  'disabled',
  'align',
  'colspan',
  'rowspan'
] as const

const SAFE_HREF_RE = /^(https?:|mailto:|#)/i
const DATA_IMAGE_RE = /^data:image\//i

function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'heading'
}

interface SanitizeConfig {
  ALLOWED_TAGS: string[]
  ALLOWED_ATTR: string[]
  ALLOW_DATA_ATTR: boolean
  ALLOW_UNKNOWN_PROTOCOLS: boolean
}

interface SanitizeElementData {
  tagName: string
}

interface SanitizeAttributeData {
  attrName: string
  attrValue: string
  keepAttr: boolean
}

interface Purifier {
  sanitize(source: string, config: SanitizeConfig): string
  addHook(name: 'uponSanitizeElement', cb: (node: Element, data: SanitizeElementData) => void): void
  addHook(
    name: 'uponSanitizeAttribute',
    cb: (node: Element, data: SanitizeAttributeData) => void
  ): void
}

type PurifierFactory = (window?: Window) => Purifier

let purify: Purifier | undefined
let hooksInstalled = false

function getPurify(): Purifier {
  if (purify) return purify

  const mod = DOMPurify as unknown as Purifier | PurifierFactory
  if (typeof (mod as Purifier).sanitize === 'function') {
    purify = mod as Purifier
  } else {
    purify = (mod as PurifierFactory)(
      typeof window !== 'undefined'
        ? window
        : (globalThis as typeof globalThis & { window: Window }).window
    )
  }

  if (!hooksInstalled) {
    hooksInstalled = true
    purify.addHook('uponSanitizeElement', (node: Element, data: SanitizeElementData) => {
      if (data.tagName === 'input') {
        node.setAttribute('type', 'checkbox')
        node.setAttribute('disabled', '')
      }
    })

    purify.addHook('uponSanitizeAttribute', (node: Element, data: SanitizeAttributeData) => {
      if (data.attrName === 'href') {
        const value = data.attrValue.trim()
        if (SAFE_HREF_RE.test(value)) return
        data.keepAttr = false
      } else if (data.attrName === 'src') {
        const value = data.attrValue.trim()
        if (DATA_IMAGE_RE.test(value)) return
        data.keepAttr = false
      } else if (data.attrName === 'id') {
        // Only keep heading ids we generated (slug format). Drop id on every
        // other element to avoid DOM clobbering via crafted markdown.
        const tag = node.tagName?.toLowerCase?.() ?? ''
        if (!/^h[1-6]$/.test(tag) || !/^[a-z0-9-]+$/.test(data.attrValue)) {
          data.keepAttr = false
        }
      }
    })
  }

  return purify
}

marked.use({
  renderer: {
    heading(token: Tokens.Heading) {
      const text = this.parser.parseInline(token.tokens)
      // Use the plain heading text (not token.raw, which includes the # marks).
      const id = slugify(token.text)
      return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`
    }
  }
})

export function renderMarkdownToSafeHtml(source: string): string {
  const dirty = marked.parse(source, {
    async: false,
    gfm: true,
    breaks: false,
    pedantic: false
  }) as string

  // `id` is allowed only for headings — the uponSanitizeAttribute hook strips
  // it from every other element.
  return getPurify().sanitize(dirty, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR, 'id'],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false
  })
}

export function isMarkdownName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'md' || ext === 'markdown' || ext === 'mdown' || ext === 'mkd'
}
