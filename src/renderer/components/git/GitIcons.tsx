/**
 * Vector icons for the git panel. Keep them inline so the git module is
 * self-contained — the chrome's Icons file already houses general-purpose
 * glyphs; these are git-specific (branch, stash, tag, etc.).
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

/** Branch icon — a forked line with two end nodes. */
export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="5.5" r="2.2" />
    <circle cx="6.5" cy="18.5" r="2.2" />
    <circle cx="17.5" cy="9.5" r="2.2" />
    <path d="M6.5 7.7v8.6" />
    <path d="M6.5 11.7h6.5a3 3 0 0 0 3-3V11.7" />
  </Svg>
)

/** Commit — a single node with horizontal end ticks. */
export const IconCommit = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 12h6M15 12h6" />
  </Svg>
)

/** History — a clock with a return arrow. */
export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v4.5h4.5" />
    <path d="M12 7v5l3 2" />
  </Svg>
)

/** Stash — a tray. */
export const IconStash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7.5h18M3 17h18" />
    <path d="M5 7.5v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 16.5v-9" />
    <path d="M9 11.5h6" />
  </Svg>
)

/** Tag — a price tag. */
export const IconTag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12 12 3h8v8l-9 9z" />
    <circle cx="15.5" cy="8.5" r="1.4" />
  </Svg>
)

/** Pull — down arrow with a baseline (fetch into the tree). */
export const IconPull = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v13" />
    <path d="m6 11 6 6 6-6" />
    <path d="M5 21h14" />
  </Svg>
)

/** Push — up arrow with a baseline (push out of the tree). */
export const IconPush = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21V8" />
    <path d="m6 13 6-6 6 6" />
    <path d="M5 21h14" />
  </Svg>
)

/** Fetch — circular arrow (sync). */
export const IconFetch = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 0 1 13.5-5.7" />
    <path d="m17.5 2 .3 4.3-4.3.3" />
    <path d="M20 12a8 8 0 0 1-13.5 5.7" />
    <path d="m6.5 22-.3-4.3 4.3-.3" />
  </Svg>
)

/** Revert / undo. */
export const IconRevert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 6 6v3" />
  </Svg>
)

/** Stage / plus. */
export const IconStage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

/** Unstage / minus. */
export const IconUnstage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
)
