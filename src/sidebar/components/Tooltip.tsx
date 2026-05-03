import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// Custom tooltip — replaces the native `title=` attribute.
//
// Why custom: native browser tooltips fire after ~1500ms with no styling
// hooks. That made every icon-only button feel slow ("did the click
// register?"). This component opens after `delayMs` (default 250ms),
// renders into document.body via a portal so the chat overflow / sidepanel
// iframe edges don't clip it, and auto-flips to the opposite side if the
// chosen edge would push the bubble off-screen.
//
// Accessibility:
//  - The trigger keeps any `aria-label` the caller already passed.
//  - We also set role="tooltip" on the bubble. Most icon buttons in this
//    codebase still receive aria-label via IconButton, so screen readers
//    don't depend on the visual tooltip.

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  label: ReactNode;
  children: ReactElement<{
    onMouseEnter?: (e: unknown) => void;
    onMouseLeave?: (e: unknown) => void;
    onFocus?: (e: unknown) => void;
    onBlur?: (e: unknown) => void;
  }>;
  side?: Side;
  delayMs?: number;
  disabled?: boolean;
}

interface Coords {
  x: number;
  y: number;
  transform: string;
  side: Side;
}

const TOOLTIP_MARGIN = 6;
const VIEWPORT_PAD = 6;

function computePosition(rect: DOMRect, preferred: Side): Coords {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const bubbleH = 32;
  const bubbleW = 120;

  let side: Side = preferred;
  if (side === 'bottom' && rect.bottom + TOOLTIP_MARGIN + bubbleH > vh) side = 'top';
  else if (side === 'top' && rect.top - TOOLTIP_MARGIN - bubbleH < 0) side = 'bottom';
  else if (side === 'right' && rect.right + TOOLTIP_MARGIN + bubbleW > vw) side = 'left';
  else if (side === 'left' && rect.left - TOOLTIP_MARGIN - bubbleW < 0) side = 'right';

  switch (side) {
    case 'bottom':
      return {
        x: rect.left + rect.width / 2,
        y: rect.bottom + TOOLTIP_MARGIN,
        transform: 'translateX(-50%)',
        side,
      };
    case 'top':
      return {
        x: rect.left + rect.width / 2,
        y: rect.top - TOOLTIP_MARGIN,
        transform: 'translate(-50%, -100%)',
        side,
      };
    case 'right':
      return {
        x: rect.right + TOOLTIP_MARGIN,
        y: rect.top + rect.height / 2,
        transform: 'translateY(-50%)',
        side,
      };
    case 'left':
      return {
        x: rect.left - TOOLTIP_MARGIN,
        y: rect.top + rect.height / 2,
        transform: 'translate(-100%, -50%)',
        side,
      };
  }
}

function TooltipBubble({
  id,
  label,
  coords,
}: {
  id: string;
  label: ReactNode;
  coords: Coords;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const bubbleStyle: CSSProperties = {
    left: coords.x,
    top: coords.y,
    transform: coords.transform,
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    if (r.right > vw - VIEWPORT_PAD) {
      el.style.left = `${vw - VIEWPORT_PAD - r.width}px`;
      el.style.transform = coords.side === 'top' ? 'translateY(-100%)' : '';
    } else if (r.left < VIEWPORT_PAD) {
      el.style.left = `${VIEWPORT_PAD}px`;
      el.style.transform = coords.side === 'top' ? 'translateY(-100%)' : '';
    }
  }, [coords]);

  return (
    <div
      ref={ref}
      role="tooltip"
      id={id}
      className="pointer-events-none fixed z-[9999] select-none whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white shadow-lg shadow-black/15 ct-tooltip-bubble"
      style={bubbleStyle}
    >
      {label}
    </div>
  );
}

export function Tooltip({
  label,
  children,
  side = 'bottom',
  delayMs = 250,
  disabled,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | null>(null);
  const id = useId();

  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current);
    },
    [],
  );

  if (disabled || !label || !isValidElement(children)) return children;

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    setCoords(computePosition(el.getBoundingClientRect(), side));
  };

  const show = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(() => {
      place();
      setOpen(true);
    }, delayMs);
  };

  const hide = () => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    setOpen(false);
  };

  const childProps = children.props;
  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
  } as Record<string, unknown>);

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-flex"
        onMouseEnter={(e) => {
          show();
          childProps.onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          hide();
          childProps.onMouseLeave?.(e);
        }}
        onFocus={(e) => {
          show();
          childProps.onFocus?.(e);
        }}
        onBlur={(e) => {
          hide();
          childProps.onBlur?.(e);
        }}
      >
        {trigger}
      </span>
      {open && coords
        ? createPortal(
            <TooltipBubble id={id} label={label} coords={coords} />,
            document.body,
          )
        : null}
    </>
  );
}
