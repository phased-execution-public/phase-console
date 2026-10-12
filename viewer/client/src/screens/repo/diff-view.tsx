/**
 * Rendering a unified diff — a file's line and its hunks, for the two places
 * that show one: Repo's Changes and a phase's review (`screens/plan/phases/
 * review.tsx`). Moved from `components/diff-view.tsx` in quiet-console phase
 * 17, onto the 7.0 kit.
 *
 * One prop is the seam between them. The review anchors inline comments to a
 * `(line, side)` pair; Repo is a reader and never comments on somebody's work.
 * So the comment machinery is `onComment` and `renderComments`, which the
 * review supplies and Repo omits — rather than a review's vocabulary inside a
 * component two places share.
 *
 * `DiffFile` is the shape the review endpoint answers with AND the shape
 * `shared/diff.js` parses into: one parser, which Repo runs in the browser over
 * `GET /api/repo/diff`'s raw patch text.
 */

import { Fragment, type ReactNode } from 'react';
import type { DiffFile } from '@/data/api';
import { cn } from '@/lib/cn';
import { Table, TableWrap } from '@/ui/table';

/** git's own single letters, so a row reads the same here as in a terminal. */
export const STATUS_MARK: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

/** `+12 −3`, or `binary` — git's counts in the diff's own two hues. */
export function DiffCounts({ file }: { file: Pick<DiffFile, 'binary' | 'additions' | 'deletions'> }) {
  if (file.binary) return <span className="shrink-0 text-meta text-ink-faint">binary</span>;
  return (
    <span
      className="tnum shrink-0 text-meta"
      aria-label={`${file.additions} added, ${file.deletions} removed`}
    >
      <span className="text-done">+{file.additions}</span>{' '}
      <span className="text-failed">−{file.deletions}</span>
    </span>
  );
}

/**
 * One file in the list beside a diff. A renamed file shows where it came
 * from: `path` alone makes a rename read as one file appearing from nowhere
 * and another silently vanishing.
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
      // The thumb floor is released by a pointer, never a width: a touch
      // tablet is as coarse a pointer as a phone, and this row is the only
      // way to a file's patch.
      className={cn(
        'flex min-h-(--tap-min) w-full items-center gap-2 rounded px-1.5 py-1 text-start font-mono text-meta',
        '[@media(hover:hover)]:min-h-0 [@media(hover:hover)]:items-baseline',
        active ? 'bg-surface text-ink' : 'text-ink-muted hover:bg-surface-raised',
      )}
    >
      <span className="w-3 shrink-0 text-ink-faint" aria-hidden="true">
        {STATUS_MARK[file.status]}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        title={file.oldPath ? `${file.oldPath}, now ${file.path}` : file.path}
      >
        {file.path}
      </span>
      <DiffCounts file={file} />
    </button>
  );
}

/**
 * One file's hunks. Line numbers on both sides, because a review comment made
 * against the wrong address is worse than none — and the review anchors its
 * comments to exactly this pair. `wrap` folds a long line (a minified file, a
 * prose paragraph); off by default, which is what a diff has always looked like.
 */
export function DiffHunks({
  file,
  onComment,
  renderComments,
  wrap = false,
  emptyNote,
}: {
  file: DiffFile;
  /** Absent when the console cannot write — the gutter button is then not drawn. */
  onComment?: (anchor: { line?: number; side: 'old' | 'new'; hunk: string; code: string }) => void;
  /** Anything to show under a line — the review's inline comments. */
  renderComments?: (line: number | undefined, side: 'old' | 'new') => ReactNode;
  wrap?: boolean;
  /** Replaces the "no textual change" sentence when the caller knows better. */
  emptyNote?: string;
}) {
  if (file.binary) {
    return <p className="px-2 py-3 text-meta text-ink-muted">Binary file: no text to show.</p>;
  }
  if (!file.hunks.length) {
    return (
      <p className="px-2 py-3 text-meta text-ink-muted">
        {file.truncated
          ? "This file was past the diff's size cap, so its hunks were not read. The counts beside it are still " +
            "git's own: read it with `git diff` in a terminal."
          : (emptyNote ?? 'No textual change: a mode or metadata change only.')}
      </p>
    );
  }
  return (
    // `scrolls={false}`: the box around this table is the one scroller (its
    // caller owns it), so the wrapper stands down rather than nesting a second.
    <TableWrap scrolls={false} className="rounded-none border-0">
      {/* hand-rolled because: a diff is not a list of records. Its columns are
          two gutters and a line of source, its rows carry comment threads
          between them, and each hunk is its own `<tbody>` with a spanning
          header — none of which a column array describes, and there is no
          identity to pin. One `<tbody>` per hunk, never nested; the hunk's
          header is a real `<th>`, and the table is named. */}
      <Table aria-label={`Diff of ${file.path}`} className="font-mono text-meta">
        {file.hunks.map((hunk, hi) => (
          <tbody key={`${hunk.header}-${hi}`}>
            <tr>
              <th
                scope="colgroup"
                colSpan={3}
                className="bg-surface px-2 py-0.5 text-start font-normal text-ink-muted"
              >
                {hunk.header}
              </th>
            </tr>
            {hunk.lines.map((line, li) => {
              // A deletion is anchored to the OLD side and everything else to
              // the new one: a remark on a removed line and one on the line
              // that replaced it are two remarks.
              const side: 'old' | 'new' = line.kind === 'del' ? 'old' : 'new';
              const at = side === 'old' ? line.oldLine : line.newLine;
              const under = renderComments?.(at, side);
              return (
                <Fragment key={li}>
                  <tr
                    className={
                      line.kind === 'add' ? 'bg-done/10' : line.kind === 'del' ? 'bg-failed/10' : undefined
                    }
                  >
                    <td className="w-10 select-none px-1 text-end align-top text-ink-faint tabular-nums">
                      {line.oldLine ?? ''}
                    </td>
                    <td className="w-10 select-none px-1 text-end align-top text-ink-faint tabular-nums">
                      {line.newLine ?? ''}
                    </td>
                    <td
                      className={cn(
                        'px-2 align-top',
                        wrap ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre',
                      )}
                    >
                      <span className="select-none text-ink-faint" aria-hidden="true">
                        {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                      </span>
                      {line.text}
                      {onComment && line.kind !== 'meta' && (
                        <button
                          type="button"
                          // Named for the line it anchors to, and the side is in
                          // the name: a hunk that replaces line 4 shows a removed
                          // 4 and an added 4, two buttons that anchor apart.
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
                          // `[tr:hover_&]`, not `group-hover`: the row is a plain
                          // `<tr>` and nothing above it is a `group`; a phone has
                          // no hover, so there it is always drawn.
                          className="ms-2 select-none rounded border border-rule px-1 text-ink-faint opacity-0 transition-opacity hover:text-ink focus:opacity-100 [tr:hover_&]:opacity-100 [@media(hover:none)]:opacity-100"
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
        <p className="px-2 py-1 text-meta text-ink-muted">
          Cut at the per-file line cap: the counts are git&apos;s own, and the lines shown are not all of
          them.
        </p>
      )}
    </TableWrap>
  );
}
