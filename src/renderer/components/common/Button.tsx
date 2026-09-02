import { forwardRef, type ReactNode, type ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'icon'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  children: ReactNode
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className = '', children, ...rest },
  ref
) {
  const classes = ['btn', `btn--${variant}`, `btn--${size}`, className].filter(Boolean).join(' ')
  return (
    <button ref={ref} type="button" className={classes} {...rest}>
      {children}
    </button>
  )
})

export default Button
