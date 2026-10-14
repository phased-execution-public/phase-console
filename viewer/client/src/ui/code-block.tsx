/**
 * One command block (turn-by-turn phase 8) — the one way the console shows a
 * command a person is meant to run, replacing the four it had (a guide step's,
 * a step's own command, the terminal sheet's line, Settings ▸ Reach's).
 *
 *   - **Left to right, always.** A flag or a path read the other way is a
 *     different one, so the block is `dir="ltr"` inside a right-to-left page,
 *     and long lines scroll inside the block — focusable and named, because a
 *     scroller a keyboard cannot enter is one nobody can read the end of.
 *   - **Two ways to take it, never a way to run it:** *Copy*, and *Copy for
 *     Claude Code* — behind `!`, which a person's own Claude Code session runs
 *     as a shell command. The page copies; it never executes.
 *   - **A template says so.** A command holding a `<placeholder>` is not ready
 *     to paste: the block says "Fill in <name> first", marks each placeholder,
 *     and offers *Copy the template* instead of a plain *Copy* — a pasted
 *     `<your-token>` is a command that fails, or worse, one that half works.
 */

import { cn } from '@/lib/cn';
import { CopyButton } from './copy-button';

/** A command, as a person's own Claude Code session runs it: behind `!`. */
export function claudeCodeCommand(command: string): string {
  return `!${command.trim()}`;
}

/**
 * The placeholders a command holds — `<name>` with a letter first, so a shell
 * redirect (`< file`, `2>&1`, `<<EOF`) is never read as one. Each once, in order.
 */
export function placeholdersOf(code: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/<([A-Za-z][\w .:/@-]{0,40})>/g)) {
    const name = match[1]!.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** "Fill in <a> first" / "Fill in <a> and <b> first" — the template's one sentence. */
export function fillInWords(names: readonly string[]): string {
  const marked = names.map((name) => `<${name}>`);
  const list =
    marked.length <= 1
      ? (marked[0] ?? '')
      : `${marked.slice(0, -1).join(', ')} and ${marked[marked.length - 1]}`;
  return `Fill in ${list} first.`;
}

export function CodeBlock({
  code,
  testId = 'code-block',
  label = 'Command',
  claudeCode = true,
  copyLabel,
  className,
}: {
  code: string;
  /** The block's own test id — each surface keeps the one its tests read. */
  testId?: string;
  /** The scroller's accessible name. */
  label?: string;
  /** Offer *Copy for Claude Code* (`!`) — a start line for a person's own terminal does not. */
  claudeCode?: boolean;
  /** What *Copy* is called where one page shows several commands ("Copy the serve command"). */
  copyLabel?: string;
  className?: string;
}) {
  const holes = placeholdersOf(code);
  const template = holes.length > 0;
  const parts = template ? code.split(/(<[A-Za-z][\w .:/@-]{0,40}>)/g) : [code];
  return (
    <div
      data-testid={`${testId}-block`}
      data-template={template ? 'true' : undefined}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      {template && (
        <p data-testid="code-template" className="max-w-prose text-meta text-ink">
          {fillInWords(holes)}
        </p>
      )}
      <pre
        data-testid={testId}
        role="group"
        aria-label={label}
        tabIndex={0}
        dir="ltr"
        className="max-w-full overflow-x-auto overscroll-x-contain rounded border border-rule bg-ground-deep px-3 py-2 font-mono text-meta leading-relaxed text-ink"
      >
        <code>
          {parts.map((part, index) =>
            template && index % 2 === 1 ? (
              <mark
                key={index}
                data-placeholder
                className="rounded-sm bg-transparent text-ink underline decoration-dotted underline-offset-2"
              >
                {part}
              </mark>
            ) : (
              part
            ),
          )}
        </code>
      </pre>
      <div className="flex flex-wrap gap-1.5">
        <CopyButton text={code} label={template ? 'Copy the template' : (copyLabel ?? 'Copy')} />
        {claudeCode && !template && (
          <CopyButton
            text={claudeCodeCommand(code)}
            label="Copy for Claude Code"
            copiedLabel="Copied with !"
          />
        )}
      </div>
    </div>
  );
}
