import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router'
import { Loader2 } from 'lucide-react'

export type ButtonVariant = 'primary' | 'ghost' | 'paper' | 'danger' | 'quiet' | 'ink'
export type ButtonSize = 'sm' | 'md' | 'lg'

const base =
  'inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap select-none transition-[transform,background-color,color,border-color,box-shadow] duration-150 ease-[var(--ease-snap)] active:translate-y-px disabled:opacity-45 disabled:pointer-events-none'
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-hl text-ink hover:bg-[#ffe27a] shadow-[0_1px_0_rgba(255,255,255,.5)_inset,0_8px_22px_-10px_rgba(255,216,77,.65)] hover:-translate-y-0.5',
  ghost: 'bg-transparent text-fog border border-line hover:border-soft hover:bg-ink-2',
  paper: 'bg-paper text-pink hover:bg-white shadow-[0_6px_18px_-8px_rgba(0,0,0,.6)] hover:-translate-y-0.5',
  ink: 'bg-pink text-paper hover:bg-black',
  danger: 'bg-coral text-ink hover:bg-[#ff8173]',
  quiet: 'bg-transparent text-soft hover:text-fog hover:bg-ink-2',
}
const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3.5 text-[13px] rounded-full',
  md: 'h-10 px-5 text-sm rounded-full',
  lg: 'h-12 px-7 text-[15px] rounded-full',
}
export const buttonClass = (v: ButtonVariant = 'primary', s: ButtonSize = 'md', extra = '') => `${base} ${variants[v]} ${sizes[s]} ${extra}`

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
}
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'primary', size = 'md', loading, icon, className = '', children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} className={buttonClass(variant, size, className)} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
})

interface LBProps extends LinkProps {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}
export function LinkButton({ variant = 'primary', size = 'md', icon, className = '', children, ...rest }: LBProps) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  )
}
