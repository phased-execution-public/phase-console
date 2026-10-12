import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** A key, as a keycap: mono, the meta size, a hairline, no shadow. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-rule-strong bg-surface px-1',
        'font-mono text-meta leading-none text-ink-muted',
        className,
      )}
      {...props}
    />
  );
}

/** Keys pressed together — `⌘` `K` — with the joining word hidden from a screen reader, which hears the keys. */
export function KbdChord({
  keys,
  conjunction = ' ',
  className,
}: {
  keys: readonly string[];
  /** What is drawn between the keys; blank draws a thin space. */
  conjunction?: string;
  className?: string;
}) {
  const join = conjunction.trim() || '';
  return (
    <span className={cn('inline-flex items-center gap-0.5 whitespace-nowrap', className)}>
      {keys.map((key, i) => (
        <span key={`${key}-${i}`} className="inline-flex items-center gap-0.5">
          {i > 0 && join && (
            <span aria-hidden className="text-meta text-ink-faint">
              {join}
            </span>
          )}
          <Kbd>{key}</Kbd>
        </span>
      ))}
    </span>
  );
}
