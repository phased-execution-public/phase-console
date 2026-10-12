import { Fragment, type HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { copy } from './toast';

/**
 * A machine's value — a sha, a path, a command, a key, an id — in the mono
 * face (design.md §2: mono for machine values ONLY; money, durations and
 * counts are the sans). The short form is drawn and the whole value is one
 * hover or one copy away, so an id never has to be read in full to be used.
 *
 * A copyable value is a button, a thumb high on touch as a BOX, not an
 * overlay: such values sit in stacks — a table's column, a list of facts —
 * where an overhang would win a neighbour's taps (design.md §6). Its text is
 * centred in that box, which keeps it on the line of a table row or a
 * sentence; a stack that wants the text at the box's top instead — so the
 * extra height hangs below the line — finds the box by `data-copy`, as
 * `KeyValue` does.
 */
export function Mono({
  value,
  chars,
  copyable = false,
  words = false,
  title,
  className,
  ...props
}: {
  value: string;
  /** Draw only the first N characters; the title carries the whole value. */
  chars?: number;
  /** Pressing it copies the whole value and says so. */
  copyable?: boolean;
  /**
   * A command: drawn as words that wrap between them and never inside one — a
   * line may otherwise break after the hyphen of `--flag`. A word longer than the
   * line still wraps within itself.
   */
  words?: boolean;
} & Omit<HTMLAttributes<HTMLElement>, 'children'>) {
  const shown = chars && value.length > chars ? value.slice(0, chars) : value;
  const code = (
    <code
      className={cn('font-mono text-meta text-ink-muted', !copyable && className)}
      title={copyable ? undefined : (title ?? (shown === value ? undefined : value))}
      {...(copyable ? {} : props)}
    >
      {words
        ? shown.split(' ').map((word, index) => (
            <Fragment key={index}>
              {index > 0 && ' '}
              <span className="inline-block max-w-full wrap-anywhere">{word}</span>
            </Fragment>
          ))
        : shown}
    </code>
  );
  if (!copyable) return code;
  return (
    <button
      type="button"
      data-copy
      title={title ?? `${value} — press to copy`}
      onClick={() => void copy(value, 'Copied')}
      className={cn(
        'inline-flex items-center rounded-sm text-start hover:text-ink [@media(hover:none)]:min-h-(--tap-min)',
        className,
      )}
    >
      {code}
    </button>
  );
}
