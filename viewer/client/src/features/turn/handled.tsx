/**
 * What the AI handled instead of asking (control-tower phase 137, #214; the
 * log is phase 136's, `server/turn/handled.ts`).
 *
 * The last section of Your turn, folded with its count: each row says who
 * handled it, what, how many times, where it belongs and when — and links to
 * whatever shows it (a commit, a pull request, an issue, a journal line).
 * Nothing on it is a summons, so nothing here is painted: it is the record of
 * the questions a person was spared, kept so the sparing can be audited.
 */

import type { HANDLED_SOURCES } from '@shared/turn-model.js';
import { phaseHref, planHref } from '@/app/routes';
import { stamp } from '@/components/human-step-card';
import type { HandledRow } from '@/lib/api';

type HandledSource = (typeof HANDLED_SOURCES)[number];

/** Who handled it, in the reader's words. */
export const SOURCE_WORDS: Readonly<Record<HandledSource, string>> = Object.freeze({
  guard: 'A guard answered it',
  'auto-grant': 'A standing grant allowed it',
  'relay-rule': 'A relay rule answered it',
  ladder: 'The recovery ladder handled it',
  supervisor: 'The supervisor handled it',
  session: 'The session handled it itself',
});

const LINK_WORDS: Readonly<Record<HandledRow['links'][number]['kind'], string>> = Object.freeze({
  commit: 'commit',
  pr: 'pull request',
  issue: 'issue',
  journal: 'journal line',
});

/** A link is followed only when it is a web address; a sha or a journal id is shown as itself. */
function HandledLink({ link }: { link: HandledRow['links'][number] }) {
  const web = /^https:\/\//.test(link.ref);
  const label = `${LINK_WORDS[link.kind]} ${link.kind === 'commit' ? link.ref.slice(0, 8) : web ? link.ref.replace(/^.*\//, '#') : link.ref}`;
  return web ? (
    <a href={link.ref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
      {label}
    </a>
  ) : (
    <code className="font-mono break-all">{label}</code>
  );
}

export function HandledList({ rows }: { rows: readonly HandledRow[] }) {
  return (
    <ol data-testid="turn-handled" className="flex list-none flex-col gap-2 p-0">
      {rows.map((row) => (
        <li
          key={row.id}
          data-testid="turn-handled-row"
          data-source={row.source}
          className="flex min-w-0 flex-col gap-0.5 rounded-md border border-rule bg-surface px-3 py-2 text-xs"
        >
          <p className="text-2xs text-ink-muted">{SOURCE_WORDS[row.source] ?? row.source}</p>
          <p className="min-w-0 break-words text-ink">
            {row.what}
            {row.count > 1 && <span className="ms-1.5 text-ink-muted tabular-nums">×{row.count}</span>}
          </p>
          {row.note && <p className="break-words text-ink-muted">{row.note}</p>}
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-ink-muted">
            {row.slug && (
              <a
                className="tap-row underline underline-offset-2"
                href={row.phase ? phaseHref(row.slug, row.phase) : planHref(row.slug)}
              >
                {row.slug}
                {row.phase ? `, phase ${row.phase}` : ''}
              </a>
            )}
            {row.links.map((link) => (
              <HandledLink key={`${link.kind}:${link.ref}`} link={link} />
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
