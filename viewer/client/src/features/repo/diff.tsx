/**
 * The diff viewer — a file list, one patch at a time, and every cap said aloud.
 *
 * ## Two answers in one response, and they are not the same answer
 *
 * `GET /api/repo/diff` returns `files` from git's `--numstat` and, when a `path`
 * was asked for, `patch` — the raw unified diff of that ONE file. The list is
 * the spine and the patch is the detail; a surface that tried to render every
 * file's hunks at once would ask git for a diff of the whole range and then be
 * unable to say honestly what it had cut.
 *
 * So the patch is fetched per file, which is also what makes `unified` a
 * meaningful control rather than a global knob. (`bytes` is the other
 * per-request budget the endpoint takes; this panel does not offer it — the
 * 256 KB default is well past what a person reads, and `patch.truncated` says
 * so honestly when it is not.)
 *
 * ## The parse happens here
 *
 * The server hands over raw patch text; `shared/diff.js` turns it into files and
 * hunks in the browser. That is the same parser `server/review.ts` runs — one
 * implementation, imported twice — and the whole reason it moved to `shared/`.
 *
 * ## Three refusals, three different sentences
 *
 * `patch.failed` means git could not answer and the empty text means NOTHING.
 * `patch.truncated` means the byte budget cut it — the counts beside the file
 * are still git's own. A well-formed path that simply changed nothing in this
 * range is a 200 with an empty patch, and it says exactly that. Collapsing any
 * two of these into "no changes" is the defect this panel is written against.
 */

import { useMemo, useState } from 'react';
import { FileDiff } from 'lucide-react';
import { Banner, Button, Empty, Spinner, ToggleGroup, ToggleItem } from '@/components/ui';
import { DiffFileRow, DiffHunks } from '@/components/diff-view';
import type { DiffFile, RepoDiff } from '@/lib/api';
import { parseUnifiedDiff } from '@shared/diff.js';

/**
 * The numstat row a file gets before its patch is fetched.
 *
 * `--numstat` reports additions and deletions but not WHETHER the change was an
 * add, a delete or a rename, so every row starts life `modified` and the
 * `oldPath` git did report is what upgrades it. Guessing `added` from
 * `deletions === 0` would be wrong for any file whose change happened to add
 * only lines.
 */
export function listFile(file: RepoDiff['files'][number]): DiffFile {
  return {
    path: file.path,
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath, status: 'renamed' as const } : {}),
    status: file.oldPath !== undefined ? ('renamed' as const) : ('modified' as const),
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    hunks: [],
  };
}

/** The parsed patch for the picked path, or the numstat row when there is none. */
export function patchFile(diff: RepoDiff | undefined, path: string | undefined): DiffFile | undefined {
  if (!diff || !path) return undefined;
  const row = diff.files.find((f) => f.path === path);
  const fallback = row ? listFile(row) : undefined;
  if (!diff.patch || diff.patch.path !== path || diff.patch.failed) return fallback;
  const parsed = parseUnifiedDiff(diff.patch.text);
  // The parser keys on the paths INSIDE the patch, which is what a rename makes
  // interesting: `path` is the new name and the patch's own header carries both.
  const found = parsed.find((f) => f.path === path || f.oldPath === path) ?? parsed[0];
  if (!found) return fallback;
  return diff.patch.truncated ? { ...found, truncated: true } : found;
}

export function DiffPanel({
  diff,
  loading,
  stale = false,
  picked,
  onPick,
  unified,
  onUnified,
}: {
  diff: RepoDiff | undefined;
  loading: boolean;
  /**
   * This answer is the PREVIOUS request's, held while the next one loads.
   *
   * `useRepoDiff` holds it only while the FILE LIST cannot have moved, so the
   * list is genuinely the right list. Two things about the PATCH in it are not:
   * it may be for another file — rendering that is how "no textual change" got
   * said about a file that changed nine lines (QA round 2, M-1) — or it may be
   * this file at the previous context width, which is not false but is not what
   * the control the reader just pressed says (QA round 4, F-1/F-4).
   */
  stale?: boolean;
  picked?: string | undefined;
  onPick: (path: string | undefined) => void;
  unified: number;
  onUnified: (n: number) => void;
}) {
  const [wrap, setWrap] = useState(false);
  const current = useMemo(() => patchFile(diff, picked), [diff, picked]);
  /**
   * Does this response actually carry the picked file's patch?
   *
   * `patchFile` deliberately falls back to the numstat row when it does not, so
   * the counts stay right — but a fallback row has zero hunks, and zero hunks
   * is also what a genuine mode-only change looks like. Only the call site can
   * tell the two apart, so it does.
   */
  const patchIsForPicked = Boolean(picked && diff?.patch && diff.patch.path === picked && !diff.patch.failed);

  if (loading && !diff) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  if (!diff) return null;

  if (diff.files.length === 0) {
    return (
      <Empty
        icon={<FileDiff size={20} aria-hidden />}
        title="Nothing changed in this range"
        body="git compared the two ends and found no file between them. That is an answer, not a failure — the range is real and it is empty."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs text-ink-muted">
          {diff.fileCount} file{diff.fileCount === 1 ? '' : 's'}
          {diff.base || diff.tip ? (
            <>
              {' '}
              between <code className="font-mono">{diff.base ?? 'the working tree'}</code> and{' '}
              <code className="font-mono">{diff.tip ?? 'HEAD'}</code>
            </>
          ) : (
            ' — the working tree against HEAD, which is what this phase has changed so far'
          )}
        </p>
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={String(unified)}
            onValueChange={(v) => v && onUnified(Number(v))}
            aria-label="Context lines"
          >
            {/* `0` is a real request, not a typo — the route reads absence
                before it coerces, precisely so this item can exist. */}
            <ToggleItem value="0">0</ToggleItem>
            <ToggleItem value="3">3</ToggleItem>
            <ToggleItem value="12">12</ToggleItem>
          </ToggleGroup>
          <Button
            size="sm"
            variant={wrap ? 'default' : 'ghost'}
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
          >
            Wrap
          </Button>
        </div>
      </div>

      {diff.filesTruncated && (
        <Banner severity="warn" data-testid="files-truncated">
          More files changed than are listed. The count above is what git reported for the whole range; the
          list below stops at the cap.
        </Banner>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:items-start">
        <nav
          aria-label="Files changed"
          className="flex flex-col gap-0.5 rounded border border-rule p-1 lg:max-h-[32rem] lg:overflow-y-auto lg:overscroll-contain"
        >
          {diff.files.map((f) => (
            <DiffFileRow
              key={f.path}
              file={listFile(f)}
              active={f.path === picked}
              onPick={() => onPick(f.path)}
            />
          ))}
        </nav>
        {/* THE scroller for the patch — `DiffHunks`' own wrapper stands down
            (`scrolls={false}`), so there is exactly one.

            Sideways at every width, because a patch line is as long as it is.
            Vertically only from `lg`, like the file list one element up, which
            already gated its identical treatment. Ungated, this was a 512px-tall
            nested scroller on a 360px phone with `overscroll-contain` on it:
            a vertical flick anywhere over the patch was swallowed instead of
            chaining to the page, which is the arrangement `components/ui/
            table.tsx` bans in writing for the wrapper it owns. Below `lg` the
            patch simply takes the height it needs and the page scrolls it. */}
        <div className="min-w-0 overflow-x-auto rounded border border-rule lg:max-h-[32rem] lg:overflow-y-auto lg:overscroll-contain">
          {!picked ? (
            <p className="px-2 py-3 text-2xs text-ink-faint">
              Pick a file to read its patch. Nothing is fetched until you do — a range can be thousands of
              files wide.
            </p>
          ) : loading || stale ? (
            // `stale` as well as `loading`: a placeholder makes `isPending`
            // false, so this spinner was unreachable on exactly the path that
            // needed it.
            <div className="grid place-items-center py-10" data-testid="patch-loading">
              <Spinner />
            </div>
          ) : diff.patch?.failed ? (
            <p className="px-2 py-3 text-2xs text-ink-faint" data-testid="patch-failed">
              git could not produce this patch. The empty pane means nothing at all — not that the file is
              unchanged.
            </p>
          ) : current && !patchIsForPicked ? (
            /*
             * The response carries no patch for THIS path — it has one for
             * another file, or none at all. `patchFile` then falls back to the
             * numstat row, which has real counts and zero hunks, and a
             * zero-hunk file is indistinguishable from a genuine mode-only
             * change. That is how a nine-line change came to be told "no
             * textual change": round 1's M2 again, through a third door, found
             * by the test written for round 2's M-1.
             *
             * So the ONE thing this panel must never do is describe content it
             * was not given. It says what it has instead.
             */
            <p className="px-2 py-3 text-2xs text-ink-faint" data-testid="patch-absent">
              This response carries no patch for <code className="font-mono">{picked}</code>. git reported{' '}
              <span className="text-done">+{current.additions}</span>{' '}
              <span className="text-blocked">−{current.deletions}</span> for it, so it did change — the lines
              are simply not in this answer. Pick it again to ask for them.
            </p>
          ) : current ? (
            /*
             * No `emptyNote`. A file WITH its own parsed patch and no hunks is a
             * mode or metadata change, and `DiffHunks` already says so exactly;
             * overriding it with "changed nothing in this range" told a
             * `chmod +x` it had not changed. Between that and the missing
             * sentence below, the panel was written around three refusals and
             * could reach the right one for none of them.
             */
            <DiffHunks file={current} wrap={wrap} />
          ) : (
            /*
             * The picked path has no row in this range's file list at all —
             * which is not the same as "no diff". A `?path=` deep link outlives
             * the range it was made in, and every one of them landed here on a
             * blank pane that said nothing.
             */
            <p className="px-2 py-3 text-2xs text-ink-faint" data-testid="path-not-in-range">
              <code className="font-mono">{picked}</code>{' '}
              {diff.filesTruncated
                ? // The list is capped, so "it did not change" is an absolute
                  // this response cannot support (QA round 2, L-5).
                  'is not in the part of the file list this response carries — which is capped, so it may well have changed. Narrow the range, or find it in a range whose list fits.'
                : 'is not among the files this range changed. A link to a file’s patch outlives the range it was made in — pick one from the list beside this, or compare a range that touches it.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
