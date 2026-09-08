import { Chip } from '@/components/ui';

/** Scope chips shown before the row starts eliding. The rest go in the title. */
const SCOPE_SHOWN = 2;

/**
 * The repos a phase touches, as chips — the fact that decides what may run
 * beside it, and what a queued phase overlaps. A blank cell is `all`, which is
 * the honest rendering of "this might touch anything": it is why the phase
 * runs alone, and it used to be invisible.
 *
 * Elided rather than wrapped: a plan with five repos per phase turns any
 * column of these into the widest one on the page, and the full list is a
 * hover away.
 *
 * Shared by the run phases table and the plan's phases tab — one component so
 * the two surfaces cannot drift on what a scope looks like.
 */
export function ScopeChips({ tokens, conflicts }: { tokens: string[]; conflicts?: string[] | undefined }) {
  const shown = tokens.slice(0, SCOPE_SHOWN);
  const hidden = tokens.length - shown.length;
  const title =
    tokens.join(', ') + (conflicts?.length ? `\n\nwould collide with: ${conflicts.join(', ')}` : '');

  return (
    // `min-w-0`, and the chips may break. A scope token is a repository path an
    // operator wrote — a two-segment submodule path is 167px of `nowrap`
    // chip — and every table that carries this cell declares a track for it: the
    // departures board gives it 112px. A chip that will not break does not widen
    // its column under `table-fixed`, it escapes it, and the whole board then
    // reads as 15px of overflow with the sticky header gone. The vocabulary
    // badges stay `nowrap` (a `needs-you` split over two lines reads as two
    // states); this is arbitrary content and wraps, like every other value in
    // this client that came out of a plan file.
    <div className="flex min-w-0 flex-wrap items-center gap-1" title={title}>
      {shown.map((token) => (
        <Chip
          key={token}
          mono
          tone={token === 'all' ? 'warn' : undefined}
          className="max-w-full break-all whitespace-normal"
        >
          {token}
        </Chip>
      ))}
      {hidden > 0 && <span className="font-mono text-2xs text-ink-faint">+{hidden}</span>}
    </div>
  );
}
