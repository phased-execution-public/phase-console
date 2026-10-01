import { FACT_META, type StatusFact } from '@shared/status-model.js';
import { cn } from '@/lib/cn';
import { badgeVariants } from '../badge';
import { statusIcon } from './status-icons';
import type { BadgeChrome } from './view-badge';

/**
 * A fact that stands beside a status and is not one: the count behind a partial
 * finish, the reason a stop went quiet, what a wait is on. Its kind is one of
 * the model's `FACT_KINDS`; it never carries attention, because a fact asks
 * nobody for anything — the status beside it does that.
 */
export function FactBadge({
  fact,
  size = 'sm',
  mono = false,
  className,
  title,
  ...props
}: { fact: StatusFact } & Omit<BadgeChrome, 'pulse' | 'withNote'>) {
  const meta = FACT_META[fact.kind];
  const paint = fact.paint ?? meta.paint;
  const Icon = statusIcon(meta.icon);
  return (
    <span
      data-status={fact.kind}
      data-paint={paint}
      data-attention="none"
      className={cn(badgeVariants({ tone: 'state', size, mono }), `state-${paint}`, className)}
      title={title ?? fact.text}
      {...props}
    >
      <Icon size={size === 'md' ? 13 : 11} strokeWidth={2.25} aria-hidden className="shrink-0" />
      {fact.text}
    </span>
  );
}
