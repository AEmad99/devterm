/**
 * Hand-built vector icon set — the app ships crisp SVGs instead of OS emoji, so
 * the chrome looks consistent across platforms and themes (icons inherit
 * `currentColor`). All glyphs share a 24×24 grid and a 1.7px stroke for a
 * cohesive line-weight. Pass `size` to scale; any other SVG prop passes through.
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Brand mark: a rounded glass tile with a prompt chevron + caret block. */
export function LogoMark({ size = 22, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" {...rest}>
      <defs>
        <linearGradient id="dt-logo" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="url(#dt-logo)" />
      <rect
        x="1.5"
        y="1.5"
        width="29"
        height="29"
        rx="8"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.25"
      />
      <path
        d="M9 10.5 13.5 16 9 21.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="15.5" y="19.2" width="7.5" height="2.6" rx="1.3" fill="#fff" fillOpacity="0.92" />
    </svg>
  )
}

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" />
  </Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" />
  </Svg>
)

export const IconKeyboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
    <path d="M6 9h.01M9.5 9h.01M13 9h.01M16.5 9h.01M6 12.5h.01M9.5 12.5h.01M13 12.5h.01M16.5 12.5h.01M8 15.5h8" />
  </Svg>
)

/** Local shell — a monitor with a prompt chevron. */
export const IconLocal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="3.5" width="19" height="13" rx="2.2" />
    <path d="M9.5 20.5h5M12 16.5v4" />
    <path d="M6.5 8 9 10.5 6.5 13" strokeWidth="1.5" />
    <path d="M11 13h4" strokeWidth="1.5" />
  </Svg>
)

/** Remote SSH — a globe. */
export const IconRemote = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.6 2.4 4 5.5 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.5-4-9s1.4-6.6 4-9Z" />
  </Svg>
)

/** Browser pane — a compass. */
export const IconBrowser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
  </Svg>
)

/** Terminals home group — a window with a prompt. */
export const IconTerminals = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="16" rx="2.4" />
    <path d="M2.5 8.5h19" />
    <path d="M6.5 12.5 9 15l-2.5 2.5M11.5 17.5h5" strokeWidth="1.5" />
  </Svg>
)

/** A saved/launched group — stacked layers. */
export const IconGroup = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
    <path d="m3 12 9 4.5L21 12M3 16.5 12 21l9-4.5" />
  </Svg>
)

export const IconSave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3.5h11l3 3V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1-1.5Z" />
    <path d="M8 3.5v5h6v-5M8 20.5v-6h8v6" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m20 20-4.5-4.5" />
  </Svg>
)

export const IconPalette = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
    <path d="M7 9l2.5 2.5L7 14M12.5 14h4.5" strokeWidth="1.5" />
  </Svg>
)

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4l10.5-10.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z" />
    <path d="M13.5 6.5 17.5 10.5" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
    <path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5M10 10.5v6M14 10.5v6" />
  </Svg>
)

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
    <path d="M5 15.5V5.5A1.5 1.5 0 0 1 6.5 4h9.5" />
  </Svg>
)

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-.8 4.5" />
    <path d="M20 5v6h-6" />
  </Svg>
)

/** Diff / changes — plus and minus stacked. */
export const IconDiff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 9h8M5 15h5" />
    <path d="M17 7v5M14.5 9.5h5" />
  </Svg>
)

export const IconConnect = (p: IconProps) => (
  <Svg {...p}>
    <path d="m13 4-1.5 6h4L10 20l1.5-6h-4L13 4Z" />
  </Svg>
)

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h3.4a1.5 1.5 0 0 1 1.1.5l1.2 1.3a1.5 1.5 0 0 0 1.1.5H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" />
  </Svg>
)

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 3.5h7L18 8v11.5A1 1 0 0 1 17 20.5H6.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
    <path d="M13 3.5V8h4.5" />
  </Svg>
)

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M11 7l1.2-1.2a3.5 3.5 0 0 1 5 5L16 12M13 17l-1.2 1.2a3.5 3.5 0 0 1-5-5L8 12" />
  </Svg>
)

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11 12 4l8 7" />
    <path d="M6 9.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5" />
  </Svg>
)

export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V6M6 11l6-6 6 6" />
  </Svg>
)

export const IconMerge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 4v5.5L4.5 13M16 4v5.5L19.5 13" />
    <path d="M5 13h14M12 13v7" />
  </Svg>
)

/** Disclosure chevron — points down (collapsed); callers rotate 180° when expanded. */
export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
)

/** Focus / magnify — four arrows expanding to the corners. */
export const IconFocus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 4H4v4M16 4h4v4M16 20h4v-4M8 20H4v-4" />
  </Svg>
)

/** Empty-state illustration for "no terminals / empty group". */
export function EmptyTerminalArt({ size = 76 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-hidden="true">
      <rect
        x="10"
        y="16"
        width="76"
        height="58"
        rx="9"
        fill="var(--panel-2)"
        stroke="var(--border)"
        strokeWidth="1.5"
      />
      <path d="M10 30h76" stroke="var(--border)" strokeWidth="1.5" />
      <circle cx="20" cy="23" r="2.2" fill="var(--accent)" fillOpacity="0.85" />
      <circle cx="28" cy="23" r="2.2" fill="var(--muted)" fillOpacity="0.6" />
      <circle cx="36" cy="23" r="2.2" fill="var(--muted)" fillOpacity="0.4" />
      <path
        d="M22 44l8 7-8 7"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M38 58h22" stroke="var(--muted)" strokeWidth="3" strokeLinecap="round" />
      <rect x="64" y="50" width="14" height="5" rx="2.5" fill="var(--accent)" fillOpacity="0.5" />
    </svg>
  )
}
