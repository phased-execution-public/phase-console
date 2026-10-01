import { CircleDashed, CircleX, Hand, type LucideIcon } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { SEVERITY_UI, type InboxSeverity } from '@shared/attention-model.js';
import { cn } from '@/lib/cn';
import { uiStateTitle } from '@/lib/status-vocab';
import { badgeVariants } from '../badge';

/**
 * The icon each inbox severity wears, so how loudly an item asks is never
 * carried by colour alone (WCAG 1.4.1): red and a cross for urgent, amber and a
 * hand for a summons, the quiet dashed ring for a note worth a look.
 */
const SEVERITY_ICONS: Readonly<Record<InboxSeverity, LucideIcon>> = {
  urgent: CircleX,
  'needs-you': Hand,
  fyi: CircleDashed,
};

/**
 * An inbox item's kind — "Approval", "Errand", "Policy answered" — painted by
 * how loudly the item asks: its severity through the inbox's own `SEVERITY_UI`,
 * the same paint `AttentionMark` wears, so a row and the mark that stands for it
 * are one colour. The word is the kind, the icon and the paint are the
 * severity; `data-attention` carries it for a test or a stylesheet.
 *
 * FIRST PAINT, which is why it is a module of its own and not a view: the bell
 * drawer's rows draw it before any page loads, so it reads `attention-model.js`
 * and three lucide icons — never the status model's tables or the family's
 * icon map, which `scripts/check-dist.mjs` holds out of the preloaded chunks.
 * Import it by its own path in first-paint code, never through `./index`.
 */
export function SeverityBadge({
  severity,
  children,
  className,
  title,
  ...props
}: { severity: string; children: ReactNode } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  const paint = SEVERITY_UI[severity as InboxSeverity] ?? 'queued';
  const Icon = SEVERITY_ICONS[severity as InboxSeverity] ?? CircleDashed;
  return (
    <span
      data-attention={severity}
      data-paint={paint}
      className={cn(badgeVariants({ tone: 'state' }), `state-${paint}`, className)}
      title={title ?? uiStateTitle(paint)}
      {...props}
    >
      <Icon size={11} strokeWidth={2.25} aria-hidden className="shrink-0" />
      {children}
    </span>
  );
}
