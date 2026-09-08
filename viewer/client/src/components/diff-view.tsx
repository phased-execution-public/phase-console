/**
 * Rendering a unified diff — the file row and the hunk table, for both surfaces
 * that show one.
 *
 * These were private to `features/plans/review-panel.tsx`, where they render the
 * diff of a phase under review. Phase 9's Repo destination shows the diff of an
 * arbitrary range in a repository, which is the same picture over a different
 * question, and the plan's instruction for that seam is *generalize, don't
 * duplicate*.
 *
 * The generalization is one prop. The review panel anchors inline comments to a
 * `(line, side)` pair; the repo browser has no comments and never will, because
 * a remark about a commit is a remark about somebody's work and this surface is
 * a reader. So the comment machinery leaves as **`renderComments`**, a render
 * prop that the review panel supplies and the browser omits — rather than as a
 * `ReviewComment[]`, which would put the review's vocabulary in a component that
 * two features share.
 *
 * `DiffFile` itself stays imported from `@/lib/api`: it is the shape the review
 * endpoint answers with AND the shape `shared/diff.js` parses into, which is not
 * a coincidence — there is one parser now, and the Repo destination runs it in
 * the browser over `GET /api/repo/diff`'s raw patch text.
 */

import { Fragment, type ReactNode } from 'react';
import { Table, TableWrap } from '@/components/ui';
import type { DiffFile } from '@/lib/api';

/** git's own single letters, so a row reads the same here as in a terminal. */
export const STATUS_MARK: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

/**
 * One file in the list beside a diff.
 *
 * A renamed file shows where it came from, because `path` alone makes a rename
 * read as a file that appeared from nowhere and one that silently vanished.
 */
export function DiffFileRow({
  file,
  active,
  onPick,
}: {
  file: DiffFile;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active ? 'true' : undefined}
      // The thumb floor below `sm`: this row is the only way to fetch a patch
      // at all ("Nothing is fetched until you do"), and at `text-2xs` with
      // `py-1` it was a 20px target against a 44px `--tap-min`. Released at
      // `sm` so a long file list stays as dense as it was on a desktop.
      className={`flex min-h-(--tap-min) w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-2xs sm:min-h-0 sm:items-baseline ${
        active ? 'bg-surface text-ink' : 'text-ink-muted hover:bg-surface/60'
      }`}
    >
      <span className="w-3 shrink-0 text-ink-faint" aria-hidden="true">
        {STATUS_MARK[file.status]}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        {file.path}
      </span>
      {file.binary ? (
        <span className="shrink-0 text-ink-faint">binary</span>
      ) : (
        <span className="shrink-0 whitespace-nowrap">
          <span className="text-done">+{file.additions}</span>{' '}
          <span className="text-blocked">−{file.deletions}</span>
        </span>
      )}
    </button>
  );
}

/**
 * One file's hunks.
 *
 * Line numbers are shown for both sides because a review comment made against
 * the wrong address is worse than no comment — and because the review panel
 * anchors its follow-up comments to exactly this pair.
 *
 * `wrap` is the Repo destination's addition: a browse reader looking at a
 * minified file or a long prose line wants it folded, and a reviewer reading
 * code wants the columns to line up. Neither is right for both, so it is a
 * control rather than a decision. Default off — `whitespace-pre` is what a diff
 * has always looked like.
 */
export function DiffHunks({
  file,
  onComment,
  renderComments,
  wrap = false,
  emptyNote,
}: {
  file: DiffFile;
  /** Absent when the console cannot write — the gutter button is then not rendered. */
  onComment?: (anchor: { line?: number; side: 'old' | 'new'; hunk: string; code: string }) => void;
  /** Anything to show under a line — the review panel's inline comments. */
  renderComments?: (line: number | undefined, side: 'old' | 'new') => ReactNode;
  wrap?: boolean;
  /** Replaces the "no textual change" sentence when the caller knows better. */
  emptyNote?: string;
}) {
  if (file.binary) {
    return <p className="px-2 py-3 text-2xs text-ink-faint">Binary file — no text to show.</p>;
  }
  if (!file.hunks.length) {
    return (
      <p className="px-2 py-3 text-2xs text-ink-faint">
        {file.truncated
          ? 'This file was past the diff size cap, so its hunks were not read. The counts beside it are ' +
            "still git's own — read it with `git diff` in a terminal."
          : (emptyNote ?? 'No textual change — a mode or metadata change only.')}
      </p>
    );
  }
  return (
    /*
     * `scrolls={false}`, and it is the whole of the nesting fix.
     *
     * The diff used to sit in three scroll containers stacked inside each
     * other: the panel body, a `max-h-96 overflow-y-auto` box, and this
     * wrapper — whose `overflow-x: auto` computes `overflow-y` to `auto` as
     * well, so it was a vertical scroller nobody declared. A touch flick on a
     * diff had to choose between three, and the one it chose was rarely the
     * one under the finger.
     *
     * So the BOX around this table is the one scroller, in both directions
     * (the caller owns it), and the wrapper stands down. The shared wrapper is
     * still what is used, rather than a bare `<div>`, because it is also what
     * carries the table's border and padding decisions.
     */
    <TableWrap scrolls={false} className="rounded-none border-0">
      {/* One `<tbody>` PER HUNK, and never nested: a table may hold several
          bodies, which is exactly what a hunk is — a run of rows with its own
          header. Nesting them is invalid HTML and the a11y harness says so. */}
      {/* The table is NAMED, and each hunk's header is a real `<th>` spanning
          its section. It was a `<td>` before, so the one row that says which
          lines these are was announced as data — and the table itself had no
          accessible name at all, on a card that can hold twenty of them. */}
      {/* hand-rolled because: a diff is not a list of records. Its "columns"
          are two gutters and a line of source, its rows carry inline comment
          threads between them, and each hunk is its own `<tbody>` with a
          spanning header — none of which a column array describes. There is no
          identity column to pin and nothing a card rendering would say. */}
      <Table aria-label={`Diff of ${file.path}`} className="font-mono text-2xs">
        {file.hunks.map((hunk, hi) => (
          <tbody key={`${hunk.header}-${hi}`}>
            <tr>
              <th
                scope="colgroup"
                colSpan={3}
                className="bg-surface px-2 py-0.5 text-left font-normal text-ink-faint"
              >
                {hunk.header}
              </th>
            </tr>
            {hunk.lines.map((line, li) => {
              // A deletion is anchored to the OLD side and everything else to
              // the new one: commenting on a removed line and on the line that
              // replaced it are two different remarks, and a single side would
              // silently merge them.
              const side: 'old' | 'new' = line.kind === 'del' ? 'old' : 'new';
              const at = side === 'old' ? line.oldLine : line.newLine;
              const under = renderComments?.(at, side);
              return (
                <Fragment key={li}>
                  <tr
                    className={
                      line.kind === 'add' ? 'bg-done/10' : line.kind === 'del' ? 'bg-blocked/10' : undefined
                    }
                  >
                    <td className="w-10 select-none px-1 text-right align-top text-ink-faint tabular-nums">
                      {line.oldLine ?? ''}
                    </td>
                    <td className="w-10 select-none px-1 text-right align-top text-ink-faint tabular-nums">
                      {line.newLine ?? ''}
                    </td>
                    <td
                      className={`px-2 align-top ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
                    >
                      <span className="select-none text-ink-faint" aria-hidden="true">
                        {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                      </span>
                      {line.text}
                      {onComment && line.kind !== 'meta' && (
                        <button
                          type="button"
                          // Named for the line it anchors to, because a page of
                          // buttons all called "Comment" is unusable with a
                          // screen reader and indistinguishable in a test.
                          // The SIDE is in the name for a reason found by
                          // writing that test: a hunk that replaces line 4
                          // has a removed 4 and an added 4, so without it two
                          // buttons on screen at once carry the same name —
                          // and they anchor to different code.
                          aria-label={
                            side === 'old'
                              ? `Comment on ${file.path} removed line ${at ?? '?'}`
                              : `Comment on ${file.path} line ${at ?? '?'}`
                          }
                          title="Comment on this line"
                          onClick={() =>
                            onComment({
                              ...(at != null ? { line: at } : {}),
                              side,
                              hunk: hunk.header,
                              code: line.text,
                            })
                          }
                          // `[tr:hover_&]`, not `group-hover`: the row is a
                          // plain `<tr>` and nothing above it is a `group`, so
                          // the group variant was a class that never matched.
                          className="ml-2 select-none rounded border border-rule px-1 text-ink-faint opacity-0 transition-opacity hover:text-ink focus:opacity-100 [tr:hover_&]:opacity-100 [@media(hover:none)]:opacity-100"
                        >
                          +
                        </button>
                      )}
                    </td>
                  </tr>
                  {under}
                </Fragment>
              );
            })}
          </tbody>
        ))}
      </Table>
      {file.truncated && (
        <p className="px-2 py-1 text-2xs text-ink-faint">
          Cut at the per-file line cap — the counts above are git&apos;s own, the lines shown are not all of
          them.
        </p>
      )}
    </TableWrap>
  );
}
