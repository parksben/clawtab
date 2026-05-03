import type { ReactElement, ReactNode } from 'react';

/**
 * Lightweight tooltip. Uses the native `title` attribute under the hood so
 * there's no positioning / portal code; works even for disabled buttons in
 * Chrome (disabled controls still show their title). If we later need
 * richer positioning we can swap to a proper popover without touching
 * callers.
 */
export function Tooltip({
  label,
  children,
  disabled,
}: {
  label: string;
  children: ReactElement<{ title?: string; 'aria-label'?: string }>;
  disabled?: boolean;
}): ReactNode {
  if (disabled || !label) return children;
  // Cloning lets us inject the title prop on any intrinsic host element
  // (button, div, etc) without forcing callers to thread refs.
  const cloneProps = { title: label, 'aria-label': label };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Any = children.type as any;
  return (
    <Any {...children.props} {...cloneProps}>
      {(children.props as { children?: ReactNode }).children}
    </Any>
  );
}
