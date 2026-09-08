import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';
import { Skeleton } from './feedback';
import { Banner } from './status-stack';

/**
 * The two states a surface is in before it holds anything: broken, and not yet.
 *
 * `feedback.tsx` has the RAW shapes (a Skeleton is a grey box, a Banner is a
 * coloured strip). These two are the compositions every page had written out
 * for itself — nine copies of the error frame and seven of the pending guard,
 * agreeing on everything except the one thing that mattered.
 */

/**
 * A page that could not load, in the console's own voice.
 *
 * The nine copies were byte-identical except that none of them offered a way
 * out: `String((error as Error).message ?? error)` inside a `<Banner>`, and
 * then nothing. A failed read is almost always a console that was restarting,
 * so *Try again* is the whole difference between reading the message and
 * reloading the tab.
 *
 * The message is the server's own words. An error with none of its own reads
 * as its `toString`, never as a sentence this component invented — a page that
 * makes up a reason is worse than one that admits it has none.
 */
export function PageError({
  error,
  retry,
  className,
}: {
  error: unknown;
  /** Re-run the read. A query's own `refetch` in practice. */
  retry?: () => void;
  className?: string;
}) {
  const message = error instanceof Error ? (error.message ?? String(error)) : String(error);
  return (
    <Banner severity="error" className={className}>
      {/* `break-words`: a failed read quotes a path or a `bash -c '…'`, and a
          token with no space in it for eighty characters has nothing to wrap at. */}
      <span className="min-w-0 flex-1 break-words">{message || 'The read failed and said nothing.'}</span>
      {retry && (
        <Button size="sm" variant="ghost" className="shrink-0" onClick={retry}>
          Try again
        </Button>
      )}
    </Banner>
  );
}

/**
 * A card that is still reading — deliberately dumb.
 *
 * The seven copies were all `if (isPending && !data) return <Skeleton className="h-64" />`,
 * and the `&& !data` is the part worth keeping: a card that already has an
 * answer must not flash a grey box every time the stream invalidates it. That
 * predicate stays at the call site, where the data is; this only owns the box.
 *
 * `h` is a Tailwind height step (`64`, `48`, `32`), not a pixel count, because
 * a skeleton is a placeholder for a card at one of the sizes cards come in.
 */
export function CardSkeleton({
  loading,
  h = '64',
  className,
  children,
}: {
  /** True while there is nothing to show. Renders `children` once it is false. */
  loading: boolean;
  h?: '32' | '48' | '64' | '80';
  className?: string;
  children?: ReactNode;
}) {
  if (!loading) return <>{children}</>;
  return <Skeleton className={cn(HEIGHT[h], className)} />;
}

/**
 * Spelled out rather than interpolated: Tailwind scans source text for class
 * names, and `h-${n}` is a class it can never find.
 */
const HEIGHT: Record<'32' | '48' | '64' | '80', string> = {
  '32': 'h-32',
  '48': 'h-48',
  '64': 'h-64',
  '80': 'h-80',
};
