import { SEVERITY_UI } from '@shared/attention-model.js';
import { ATTENTION_META, type AttentionLevel } from '@shared/status-model.js';
import { cn } from '@/lib/cn';
import { badgeVariants } from '../badge';
import { statusIcon } from './status-icons';
import type { BadgeChrome } from './view-badge';

/**
 * Does a person have to act — the attention axis on its own, for a row whose
 * status badge says what it is and needs this said beside it. Painted through
 * the inbox's own `SEVERITY_UI`, so a mark and the inbox row it stands for are
 * one colour. `none` draws nothing: an absence of attention is not a datum
 * worth a chip.
 */
export function AttentionMark({
  level,
  size = 'sm',
  className,
  title,
  ...props
}: { level: AttentionLevel } & Omit<BadgeChrome, 'pulse' | 'withNote' | 'mono'>) {
  if (level === 'none') return null;
  const meta = ATTENTION_META[level];
  const paint = SEVERITY_UI[level];
  const Icon = statusIcon(meta.icon);
  return (
    <span
      data-status={level}
      data-paint={paint}
      data-attention={level}
      className={cn(badgeVariants({ tone: 'state', size }), `state-${paint}`, className)}
      title={title ?? meta.label}
      {...props}
    >
      <Icon size={size === 'md' ? 13 : 11} strokeWidth={2.25} aria-hidden className="shrink-0" />
      {meta.label}
    </span>
  );
}
