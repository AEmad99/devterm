import type { ReactNode, ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'icon'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  children: ReactNode
}

export default function Button({
  variant = 'default',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, `btn--${size}`, className].filter(Boolean).join(' ')
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  )
}
