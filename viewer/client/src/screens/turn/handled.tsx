/**
 * What the AI handled instead of asking (control-tower phase 137, #214; the
 * log is phase 136's, `server/turn/handled.ts`; 7.0's rows since
 * quiet-console phase 8).
 *
 * The last section of Your turn, folded with its count: each row says what
 * was handled, who handled it, how many times, where it belongs and when —
 * and links to whatever shows it (a commit, a pull request, an issue, a
 * journal line). Nothing on it is a summons, so nothing here is painted and
 * nothing is a card: rows separated by space, the record of the questions a
 * person was spared, kept so the sparing can be audited.
 */

import type { HANDLED_SOURCES } from '@shared/turn-model.js';
import { stamp } from '@/cards/turn/step-words';
import type { HandledRow } from '@/data/turn';
import { phaseHref, planHref } from '@/shell/routes';

type HandledSource = (typeof HANDLED_SOURCES)[number];

/** Who handled it, in the reader's words. */
export const SOURCE_WORDS: Readonly<Record<HandledSource, string>> = Object.freeze({
  guard: 'A guard answered it',
  'auto-grant': 'A standing grant allowed it',
  'relay-rule': 'A relay rule answered it',
  ladder: 'The recovery ladder handled it',
  supervisor: 'The supervisor handled it',
  session: 'The session handled it itself',
  console: 'The console closed it — nobody needed it any more',
});

const LINK_WORDS: Readonly<Record<HandledRow['links'][number]['kind'], string>> = Object.freeze({
  commit: 'commit',
  pr: 'pull request',
  issue: 'issue',
  journal: 'journal line',
});

const link = 'tap-row underline decoration-rule-strong underline-offset-2 hover:text-ink';

/** A link is followed only when it is a web address; a sha or a journal id is shown as itself. */
function HandledLink({ link: ref }: { link: HandledRow['links'][number] }) {
  const web = /^https:\/\//.test(ref.ref);
  const label = `${LINK_WORDS[ref.kind]} ${ref.kind === 'commit' ? ref.ref.slice(0, 8) : web ? ref.ref.replace(/^.*\//, '#') : ref.ref}`;
  return web ? (
    <a href={ref.ref} target="_blank" rel="noopener noreferrer" className={link}>
      {label}
    </a>
  ) : (
    <code className="font-mono wrap-anywhere">{label}</code>
  );
}

export function HandledList({ rows }: { rows: readonly HandledRow[] }) {
  return (
    <ol data-testid="turn-handled" className="flex list-none flex-col divide-y divide-rule p-0">
      {rows.map((row) => (
        <li
          key={row.id}
          data-testid="turn-handled-row"
          data-source={row.source}
          className="flex min-w-0 flex-col gap-0.5 py-2"
        >
          <p className="min-w-0 max-w-(--measure) break-words text-body text-ink">
            {row.what}
            {/* Both sides: under dir="rtl" an English line and its count are one left-to-right run, and a start margin would land outside it. */}
            {row.count > 1 && <span className="mx-1.5 text-ink-muted tabular-nums">×{row.count}</span>}
          </p>
          {row.note && <p className="max-w-(--measure) break-words text-meta text-ink-muted">{row.note}</p>}
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-meta text-ink-muted">
            <span>{SOURCE_WORDS[row.source] ?? row.source}</span>
            {row.slug && (
              <a className={link} href={row.phase ? phaseHref(row.slug, row.phase) : planHref(row.slug)}>
                {row.slug}
                {row.phase ? `, phase ${row.phase}` : ''}
              </a>
            )}
            {row.links.map((ref) => (
              <HandledLink key={`${ref.kind}:${ref.ref}`} link={ref} />
            ))}
            <span className="tabular-nums">
              {row.count > 1 ? `${stamp(row.first)} to ${stamp(row.at)}` : stamp(row.at)}
            </span>
          </p>
        </li>
      ))}
    </ol>
  );
}
