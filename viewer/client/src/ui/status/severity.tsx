import type { HTMLAttributes, ReactNode } from 'react';
import { SEVERITY_UI, type InboxSeverity } from '@shared/attention-model.js';
import { cn } from '@/lib/cn';
import { uiStateTitle } from '@/lib/status-vocab';

/**
 * An inbox item's kind — "Approval", "Errand", "Policy answered" — as a dot
 * and a word painted by how loudly the item asks: its severity through the
 * inbox's own `SEVERITY_UI`, the same paint `AttentionMark` wears, so a row
 * and the mark that stands for it are one colour. The word is the kind, the
 * dot is the severity; `data-attention` carries it for a test or a stylesheet.
 *
 * FIRST PAINT, which is why it is a module of its own and draws no view: the
 * bell's rows draw it before any page loads, so it reads `attention-model.js`
 * alone — never the status model's tables or the family's icon map, which
 * `scripts/check-dist.mjs` holds out of the preloaded chunks. Import it by its
 * own path in first-paint code, never through `./index`.
 */
export function SeverityMark({
  severity,
  children,
  className,
  title,
  ...props
}: { severity: string; children: ReactNode } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  const paint = SEVERITY_UI[severity as InboxSeverity] ?? 'queued';
  return (
    <span
      data-attention={severity}
      data-paint={paint}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-meta text-ink tabular-nums',
        `state-${paint}`,
        className,
      )}
      title={title ?? uiStateTitle(paint)}
      {...props}
    >
      <i aria-hidden data-dot className="inline-block size-1.5 shrink-0 rounded-full bg-state" />
      <span>{children}</span>
    </span>
  );
}
