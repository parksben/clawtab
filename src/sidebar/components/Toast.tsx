import { useEffect } from 'react';

export function Toast({
  text,
  error,
  onDismiss,
}: {
  text: string;
  error?: boolean;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 2500);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div
      role="status"
      className={
        'fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-[12px] font-medium shadow-lg ' +
        (error ? 'bg-red-500 text-white' : 'bg-slate-900 text-white')
      }
    >
      {text}
    </div>
  );
}
