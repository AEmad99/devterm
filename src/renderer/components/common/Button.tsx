import { forwardRef, type ReactNode, type ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'icon'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'xs' | 'sm' | 'md'
  /**
   * Async-busy state: shows a spinner, sets `aria-busy`, and disables the
   * button so the operation can't be double-submitted. Prefer this over
   * swapping the label text (e.g. "Importing…") so the button keeps its width.
   */
  busy?: boolean
  /**
   * Pressed/toggled look for on-off controls (segmented options, pin buttons,
   * panel toggles). Sets `aria-pressed` and the visible `is-active` style.
   */
  active?: boolean
  children: ReactNode
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    size = 'md',
    busy = false,
    active = false,
    className = '',
    children,
    disabled,
    ...rest
  },
  ref
) {
  const classes = [
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    busy ? 'is-busy' : '',
    active ? 'is-active' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-pressed={active || undefined}
      {...rest}
    >
      {busy && <span className="btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  )
})

export default Button
