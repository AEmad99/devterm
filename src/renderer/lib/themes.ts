import type { ITheme } from '@xterm/xterm'
import type { TerminalBg } from '../store/settings'

/**
 * The theme engine. One `Theme` drives **both** the terminal's ANSI palette and
 * the app chrome (titlebar, tabs, panels, modals) via CSS custom properties.
 *
 * `applyTheme()` writes the chrome tokens onto the document root and flips a
 * `data-glass` attribute used by the glass rules in styles.css; `xtermTheme()`
 * turns a theme + the user's background settings into an xterm `ITheme`.
 *
 * Adding a theme = append a `Theme` to `THEMES`. Each carries a full 16-colour
 * ANSI palette (so colourful CLI output looks right) plus a small set of chrome
 * colours; everything else (faded accents, hovers, shadows, radii) is derived in
 * CSS with `color-mix`, so a theme only specifies what's genuinely distinctive.
 */

export interface AnsiPalette {
  background: string
  foreground: string
  cursor: string
  /** Text drawn *under* a block cursor — usually the background colour. */
  cursorAccent: string
  selection: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ChromeColors {
  /** App background token (alpha is used by in-app glass surfaces). */
  bg: string
  /** Raised panels: sidebars, tab strips, modals. */
  panel: string
  /** Slightly lighter panel: toolbars, inputs' surroundings, hovers' base. */
  panel2: string
  /** Hairline borders/dividers. */
  border: string
  /** Primary text. */
  fg: string
  /** Secondary/dimmed text. */
  muted: string
  /** Brand/selection accent. */
  accent: string
  /** Secondary accent — drives the two-tone ambient backdrop glow and gradient
   *  flourishes. Falls back to `accent` (single-hue glow) when omitted. */
  accent2?: string
  /** Optional override for text on an accent-filled control (else auto by luminance). */
  accentFg?: string
}

export interface Theme {
  id: string
  name: string
  /** Short tag shown in the picker, e.g. "Dark" / "Glass". */
  group: string
  dark: boolean
  /** Frosted in-app surfaces: translucent fills + backdrop blur sampled over the
   *  ambient backdrop layer. The OS window stays opaque on Electron 29, so this
   *  is an in-app depth illusion, not real window see-through. */
  glass?: boolean
  terminal: AnsiPalette
  chrome: ChromeColors
}

// --- relative luminance, to auto-pick readable text on an accent ------------
function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0.5
  const n = parseInt(m[1], 16)
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  )
}
/** Readable foreground (near-black or white) for text sitting on `bg`. */
export function readableOn(bg: string): string {
  return luminance(bg) > 0.5 ? '#0b0e14' : '#ffffff'
}

// ── Theme registry ─────────────────────────────────────────────────────────

export const THEMES: Theme[] = [
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    group: 'Dark',
    dark: true,
    terminal: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selection: 'rgba(122,162,247,0.30)',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    },
    chrome: {
      bg: '#16161e',
      panel: '#1a1b26',
      panel2: '#20212e',
      border: '#2a2c3d',
      fg: '#c0caf5',
      muted: '#565f89',
      accent: '#7aa2f7',
      accent2: '#bb9af7'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    group: 'Dark',
    dark: true,
    terminal: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selection: 'rgba(189,147,249,0.35)',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    },
    chrome: {
      bg: '#21222c',
      panel: '#282a36',
      panel2: '#343746',
      border: '#3a3c4e',
      fg: '#f8f8f2',
      muted: '#6272a4',
      accent: '#bd93f9',
      accent2: '#ff79c6'
    }
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    group: 'Dark',
    dark: true,
    terminal: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selection: 'rgba(203,166,247,0.30)',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#cba6f7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#cba6f7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    },
    chrome: {
      bg: '#181825',
      panel: '#1e1e2e',
      panel2: '#313244',
      border: '#313244',
      fg: '#cdd6f4',
      muted: '#7f849c',
      accent: '#cba6f7',
      accent2: '#f5c2e7'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    group: 'Dark',
    dark: true,
    terminal: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selection: 'rgba(136,192,208,0.30)',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    },
    chrome: {
      bg: '#2e3440',
      panel: '#3b4252',
      panel2: '#434c5e',
      border: '#4c566a',
      fg: '#eceff4',
      muted: '#7b88a1',
      accent: '#88c0d0',
      accent2: '#81a1c1'
    }
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    group: 'Dark',
    dark: true,
    terminal: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selection: 'rgba(254,128,25,0.28)',
      black: '#3c3836',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
    },
    chrome: {
      bg: '#1d2021',
      panel: '#282828',
      panel2: '#3c3836',
      border: '#504945',
      fg: '#ebdbb2',
      muted: '#928374',
      accent: '#fe8019',
      accent2: '#d3869b',
      accentFg: '#1d2021'
    }
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    group: 'Dark',
    dark: true,
    terminal: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selection: 'rgba(97,175,239,0.28)',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    },
    chrome: {
      bg: '#21252b',
      panel: '#282c34',
      panel2: '#2c313a',
      border: '#3a3f4b',
      fg: '#abb2bf',
      muted: '#5c6370',
      accent: '#61afef',
      accent2: '#c678dd'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    group: 'Dark',
    dark: true,
    terminal: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selection: 'rgba(38,139,210,0.30)',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    },
    chrome: {
      bg: '#002b36',
      panel: '#073642',
      panel2: '#0a4250',
      border: '#0e4b5a',
      fg: '#93a1a1',
      muted: '#586e75',
      accent: '#268bd2',
      accent2: '#2aa198'
    }
  },
  {
    id: 'ayu-mirage',
    name: 'Ayu Mirage',
    group: 'Dark',
    dark: true,
    terminal: {
      background: '#1f2430',
      foreground: '#cbccc6',
      cursor: '#ffcc66',
      cursorAccent: '#1f2430',
      selection: 'rgba(255,204,102,0.25)',
      black: '#191e2a',
      red: '#ed8274',
      green: '#87d96c',
      yellow: '#ffd173',
      blue: '#6dcbfa',
      magenta: '#dabafa',
      cyan: '#5ccfe6',
      white: '#c7c7c7',
      brightBlack: '#686868',
      brightRed: '#f28779',
      brightGreen: '#a6cc70',
      brightYellow: '#ffd580',
      brightBlue: '#73d0ff',
      brightMagenta: '#dfbfff',
      brightCyan: '#95e6cb',
      brightWhite: '#ffffff'
    },
    chrome: {
      bg: '#171b24',
      panel: '#1f2430',
      panel2: '#232834',
      border: '#2a3140',
      fg: '#cbccc6',
      muted: '#707a8c',
      accent: '#ffcc66',
      accent2: '#5ccfe6',
      accentFg: '#171b24'
    }
  },
  {
    id: 'glass',
    name: 'Glass',
    group: 'Glass',
    dark: true,
    glass: true,
    terminal: {
      // Translucent within the app's glass surface treatment (allowTransparency).
      background: 'rgba(18,20,28,0.42)',
      foreground: '#e8ebf5',
      cursor: '#9bbcff',
      cursorAccent: '#12141c',
      selection: 'rgba(138,180,255,0.30)',
      black: '#1b1e29',
      red: '#ff7a8a',
      green: '#a6e3a1',
      yellow: '#f4d58d',
      blue: '#8ab4ff',
      magenta: '#cba6f7',
      cyan: '#86e1fc',
      white: '#d7dbe8',
      brightBlack: '#5b6478',
      brightRed: '#ff8f9d',
      brightGreen: '#b8efb3',
      brightYellow: '#ffe1a3',
      brightBlue: '#a6c8ff',
      brightMagenta: '#d9bcff',
      brightCyan: '#a3ecff',
      brightWhite: '#ffffff'
    },
    chrome: {
      bg: 'rgba(16,18,26,0.55)',
      panel: 'rgba(28,32,44,0.45)',
      panel2: 'rgba(44,49,66,0.50)',
      border: 'rgba(255,255,255,0.10)',
      fg: '#e8ebf5',
      muted: '#aab2c6',
      accent: '#8ab4ff',
      accent2: '#cba6f7'
    }
  },
  {
    id: 'aurora',
    name: 'Aurora',
    group: 'Glass',
    dark: true,
    glass: true,
    terminal: {
      // Deep teal-black glass; the ambient teal/violet blooms read through it.
      background: 'rgba(9, 18, 22, 0.42)',
      foreground: '#e6f7f3',
      cursor: '#5eead4',
      cursorAccent: '#091216',
      selection: 'rgba(94, 234, 212, 0.28)',
      black: '#0a141a',
      red: '#ff8a9a',
      green: '#7ee7c7',
      yellow: '#ffd98a',
      blue: '#7dd3fc',
      magenta: '#c9a6ff',
      cyan: '#5eead4',
      white: '#d7eae6',
      brightBlack: '#4d6b6b',
      brightRed: '#ff9fb0',
      brightGreen: '#9bf0d6',
      brightYellow: '#ffe6ab',
      brightBlue: '#a5e0ff',
      brightMagenta: '#dcc2ff',
      brightCyan: '#8ff3e4',
      brightWhite: '#ffffff'
    },
    chrome: {
      bg: 'rgba(7, 15, 19, 0.55)',
      panel: 'rgba(13, 26, 30, 0.45)',
      panel2: 'rgba(22, 41, 46, 0.50)',
      border: 'rgba(255, 255, 255, 0.10)',
      fg: '#e6f7f3',
      muted: '#8fb3ad',
      accent: '#5eead4',
      accent2: '#c084fc',
      accentFg: '#06121a'
    }
  }
]

export const DEFAULT_THEME_ID = 'tokyo-night'

export function getTheme(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** xterm `ITheme` for a theme + the user's background settings. */
export function xtermTheme(theme: Theme, bg: TerminalBg): ITheme {
  const t = theme.terminal
  return {
    // A background image shows through, so the terminal layer goes fully clear.
    background: bg.image ? 'rgba(0,0,0,0)' : t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selection,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite
  }
}

/** Solid colour painted beneath the terminal (under an image, or as the host bg). */
export function terminalHostColor(theme: Theme): string {
  // Glass keeps the terminal host clear so the in-app glass surface shows through.
  return theme.glass ? 'transparent' : theme.terminal.background
}

/**
 * Push a theme's chrome colours onto the document root as CSS custom properties,
 * and flag glass mode. styles.css derives the rest (hovers, faded accents,
 * shadows) from these with `color-mix`. Also asks the main process to toggle a
 * translucent window material where the platform supports it (no-op on Electron
 * 29; forward-compatible with Acrylic/Mica on newer builds).
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  const c = theme.chrome
  const set = (k: string, v: string) => root.style.setProperty(k, v)
  set('--bg', c.bg)
  set('--bg-term', theme.terminal.background)
  set('--panel', c.panel)
  set('--panel-2', c.panel2)
  set('--border', c.border)
  set('--fg', c.fg)
  set('--muted', c.muted)
  set('--accent', c.accent)
  set('--accent-2', c.accent2 ?? c.accent)
  set('--accent-fg', c.accentFg ?? readableOn(c.accent))
  set('--selection', theme.terminal.selection)
  set('--term-fg', theme.terminal.foreground)
  // Ambient backdrop intensity: glass themes lean into the glow, solid themes
  // keep it subtle. styles.css scales the bloom opacity by this number.
  set('--ambient-strength', theme.glass ? '1' : '0.55')
  root.dataset.theme = theme.id
  root.dataset.glass = theme.glass ? 'on' : 'off'
  root.style.colorScheme = theme.dark ? 'dark' : 'light'
  try {
    window.devterm?.window?.setGlass(!!theme.glass)
  } catch {
    /* main bridge not ready / unsupported — CSS glass still applies */
  }
}
