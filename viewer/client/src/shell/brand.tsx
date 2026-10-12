import { cn } from '@/lib/cn';

/**
 * The mark: a line with three stations — two behind, one ahead and still open.
 * The console's one graphic (design.md 7.0, "the line and its stations"),
 * drawn in the same tokens as every track on the page, so it never drifts from
 * them: `--track` for the line, `--status-done` for the stations passed, and
 * `--action` (ink) for the one ahead.
 */
export function RouteGlyph({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <path
        d="M5 22h8l6-12h8"
        fill="none"
        stroke="var(--track)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="5" cy="22" r="3.2" fill="var(--status-done)" />
      <circle cx="13" cy="22" r="3.2" fill="var(--status-done)" />
      <circle cx="27" cy="10" r="3.2" fill="none" stroke="var(--action)" strokeWidth="2.5" />
    </svg>
  );
}

/** The wordmark — the UI face at 600, as every title is in 7.0; no condensed cut, no caps. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('text-body leading-none font-semibold text-ink', className)}>Phase Console</span>
  );
}

/**
 * The count that rides a nav item. Capped, because 1,284 is not a badge.
 *
 * `cap` is lower where the badge is pinned to the corner of a glyph: nine is as
 * much as a corner can say, and the exact figure is one press away. `hot` is
 * the summons — the one place the accent hue appears in the chrome (design.md
 * principle 4: amber is a summons, and only a person being waited on is one):
 * a FILLED pill, the ground's ink on the hue, because at twelve pixels the hue
 * as ink on a tint of itself reads 4.1:1 and fails the register (measured on
 * the 7.0 tour at every stop). A decoration on a glyph: no role and no label
 * of its own, because the item it rides names the count in its accessible name.
 */
export function NavBadge({
  count,
  hot = false,
  cap = 99,
  className,
}: {
  count: number;
  hot?: boolean;
  cap?: number;
  className?: string;
}) {
  if (!count) return null;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex min-w-[1.125rem] items-center justify-center rounded-full px-1 py-px',
        'text-meta leading-tight font-semibold tabular-nums',
        hot ? 'bg-accent text-ground' : 'bg-rule text-ink-muted',
        className,
      )}
    >
      {count > cap ? `${cap}+` : count}
    </span>
  );
}
