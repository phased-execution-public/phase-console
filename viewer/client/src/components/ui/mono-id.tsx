import { cn } from '@/lib/cn';
import { copy } from './toast';

/**
 * A short id, with the whole one one hover away.
 *
 * Run ids, session ids and lock owners are long enough that printing them
 * whole makes a table column nothing but hex — so every surface printed
 * `id.slice(0, 8)` and lost the rest. Truncating is right; truncating with no
 * way back to the full value is what left an operator reading eight characters
 * off the screen and typing them into `grep`.
 *
 * So: the short form is what is drawn, the full value is the `title`, and
 * `copyable` puts it on the clipboard through the SHARED `copy()` — the one
 * that falls back to a hidden textarea when the clipboard API is refused and
 * says so either way. Two surfaces still call `navigator.clipboard.writeText`
 * directly and fail silently when it is denied; this is what they should use.
 */
export function MonoId({
  id,
  chars = 8,
  title,
  copyable = false,
  className,
}: {
  id: string;
  /** How much of it to draw. Eight is enough to recognise, short enough to scan. */
  chars?: number;
  /** Overrides the hover. The default is the full id, which is nearly always what is wanted. */
  title?: string;
  /** Make it pressable. Off by default: most of these sit inside a link already. */
  copyable?: boolean;
  className?: string;
}) {
  const short = id.length > chars ? id.slice(0, chars) : id;
  const label = title ?? id;
  const code = (
    <code className={cn('font-mono text-2xs text-ink-faint', className)} title={copyable ? undefined : label}>
      {short}
    </code>
  );

  if (!copyable) return code;

  return (
    <button
      type="button"
      // The tap floor only where there is no hover — an 8px-tall id in a dense
      // table is unpressable on a phone, and 44px of chrome around one on a
      // desktop turns a table row into a form.
      className="[@media(hover:none)]:min-h-(--tap-min) inline-flex items-center rounded hover:text-ink"
      title={`${label} — press to copy`}
      onClick={() => void copy(id, 'Copied the id')}
    >
      {code}
    </button>
  );
}
