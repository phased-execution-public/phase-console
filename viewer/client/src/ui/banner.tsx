import type { HTMLAttributes, ReactNode } from 'react';
import { NOTE_ROWS, type NoteSeverity } from '@shared/status-notes.js';
import { cn } from '@/lib/cn';
import { NOTE_ICONS } from './status/note-icons';

/**
 * A note about the screen — an error the server sent, a caution, a hint, a
 * confirmation. Its severity is a note severity (`shared/status-notes.js`),
 * and FIRST PAINT: it reads the four note rows and their four icons, never the
 * status model's tables (`scripts/check-dist.mjs` holds those out).
 *
 * The shape is a line with a leading rule in the severity's paint — no fill,
 * no card: a note is read, not acted on as a unit. A caution is never amber;
 * amber is a summons.
 */
export type Severity = NoteSeverity;

/** The severity's icon, named for a screen reader — the one place a note draws a glyph. */
export function NoteIcon({ severity, className }: { severity: Severity; className?: string }) {
  const row = NOTE_ROWS[severity];
  const Icon = NOTE_ICONS[row.icon]!;
  return (
    <Icon
      size={14}
      strokeWidth={2.25}
      role="img"
      aria-label={row.label}
      className={cn('shrink-0', className)}
    />
  );
}

export function Banner({
  severity = 'info',
  action,
  className,
  children,
  ...props
}: { severity?: Severity; action?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const row = NOTE_ROWS[severity];
  return (
    <div
      role="status"
      data-severity={severity}
      className={cn(
        'flex min-w-0 items-start gap-2 border-s-2 border-state py-1.5 ps-3 text-body text-ink',
        `state-${row.paint}`,
        className,
      )}
      {...props}
    >
      <span className="mt-0.5 text-state">
        <NoteIcon severity={severity} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action != null && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
