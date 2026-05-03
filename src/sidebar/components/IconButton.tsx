import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type Variant = 'square' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string;
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  active?: boolean;
}

const SIZE: Record<Size, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-9 w-9',
};

/**
 * Single source of truth for every icon-only button in the sidebar. Every
 * caller must provide a `tooltip` — if we stop requiring that we'll drift back
 * into the pre-migration state where icon meanings were a guessing game.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { tooltip, children, variant = 'square', size = 'md', active, className = '', ...rest },
    ref,
  ) {
    const base =
      'inline-flex items-center justify-center rounded-lg transition ' +
      'disabled:cursor-not-allowed disabled:opacity-40 ' +
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring';
    const variantCls =
      variant === 'square'
        ? active
          ? 'border border-brand-hover bg-brand text-white hover:bg-brand-hover'
          : 'border border-slate-200 bg-slate-100 text-slate-500 hover:border-brand-ring hover:bg-brand-soft hover:text-brand'
        : active
          ? 'text-brand'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700';
    return (
      <Tooltip label={tooltip}>
        <button
          ref={ref}
          type="button"
          {...rest}
          className={`${base} ${SIZE[size]} ${variantCls} ${className}`.trim()}
        >
          {children}
        </button>
      </Tooltip>
    );
  },
);
