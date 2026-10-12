/**
 * Changes — a range, the files it changed, and one file's patch at a time
 * (7.0, quiet-console phase 17).
 *
 * ```
 * [Find a file…]  Filter  View 3 lines
 * Base [the working tree]  Tip [HEAD]  [Compare]
 * 3 files changed in the working tree against HEAD.
 * ›  viewer/client/src/screens/repo/diff.tsx                 +212 −0
 * ⌄  viewer/client/src/screens/repo/graph.tsx                 +40 −18
 *    │ @@ -1,4 +1,6 @@  …the patch, scrolling sideways only…
 * ```
 *
 * With no range at all the server compares the working tree against HEAD —
 * what a phase in flight has changed so far — so arriving here is already an
 * answer. `base` alone is the working tree against it; `tip` alone is that one
 * commit (`<sha>^!`), which is what History's "What this commit changed" opens.
 *
 * The list is git's `--numstat` over the whole range and a patch is one file,
 * fetched when that file is opened (`?path=`), so the byte budget is per file
 * and its truncation is honest. A file opens IN PLACE, under its own line —
 * the expand door — and its patch scrolls sideways only: one scroller, the
 * page's, at every width.
 *
 * Three refusals, three sentences, never "no changes": git could not produce
 * the patch (`failed`, an empty text that means nothing); the answer on screen
 * carries no patch for this file (a held-over answer, or none); the file is
 * not in this range at all (a link that outlived its range).
 */

import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { parseUnifiedDiff } from '@shared/diff.js';
import type { DiffFile, RepoDiff, RepoDiffFile } from '@/data/api';
import { useRepoDiff } from '@/data/repo';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { navigate, type Route } from '@/shell/routes';
import { Banner, Button, Empty, Input, Spinner } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Toolbar } from '@/ui/toolbar';
import { DiffCounts, DiffHunks } from './diff-view';
import { inspectFile } from './inspector';
import { PanelChoices, PathWords, ReadError, RowsLoading, TargetPanel, useTargets } from './parts';
import { DEFAULT_UNIFIED, UNIFIED_CHOICES, repoSectionHref, repoTargetOf, unifiedOf } from './routes';

/**
 * The numstat row a file gets before its patch is read. `--numstat` reports
 * the counts but not whether the change was an add or a delete, so a row
 * starts `modified` and only the `oldPath` git did report upgrades it — a file
 * that only gained lines is not therefore new.
 */
export function listFile(file: RepoDiffFile): DiffFile {
  return {
    path: file.path,
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    status: file.oldPath !== undefined ? 'renamed' : 'modified',
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    hunks: [],
  };
}

/** The parsed patch for the opened path, or its numstat row when the answer carries none. */
export function patchFile(diff: RepoDiff | undefined, path: string | undefined): DiffFile | undefined {
  if (!diff || !path) return undefined;
  const row = diff.files.find((f) => f.path === path);
  const fallback = row ? listFile(row) : undefined;
  if (!diff.patch || diff.patch.path !== path || diff.patch.failed) return fallback;
  const parsed = parseUnifiedDiff(diff.patch.text);
  // The parser keys on the paths INSIDE the patch, where a rename carries both.
  const found = parsed.find((f) => f.path === path || f.oldPath === path) ?? parsed[0];
  if (!found) return fallback;
  return diff.patch.truncated ? { ...found, truncated: true } : found;
}

/** What a range compares, as the line above its files. */
function rangeLine(diff: RepoDiff): string {
  const files = plural(diff.fileCount, 'file');
  if (!diff.base && !diff.tip) return `${files} changed in the working tree against HEAD.`;
  if (!diff.base) return `${files} changed by ${diff.tip}.`;
  return `${files} changed between ${diff.base} and ${diff.tip ?? 'the working tree'}.`;
}

/** The opened file's patch — or, said exactly, why there is none to draw. */
function PatchPane({
  diff,
  path,
  loading,
  wrap,
}: {
  diff: RepoDiff;
  path: string;
  /** The answer on screen is the previous request's, held while this one loads. */
  loading: boolean;
  wrap: boolean;
}) {
  const current = patchFile(diff, path);
  // Whether this answer carries THIS file's patch. A fallback row has real
  // counts and no hunks, which is also what a mode-only change looks like —
  // only here can the two be told apart.
  const carried = Boolean(diff.patch && diff.patch.path === path && !diff.patch.failed);
  let body;
  if (loading) {
    body = (
      <div className="grid place-items-center py-8" data-testid="patch-loading">
        <Spinner label="Reading the patch" />
      </div>
    );
  } else if (diff.patch?.failed && diff.patch.path === path) {
    body = (
      <p className="px-2 py-3 text-meta text-ink-muted" data-testid="patch-failed">
        git could not produce this patch. The empty pane means nothing at all, not that the file is unchanged.
      </p>
    );
  } else if (current && !carried) {
    body = (
      <p className="px-2 py-3 text-meta text-ink-muted" data-testid="patch-absent">
        This answer carries no patch for <code className="font-mono">{path}</code>. git counted{' '}
        <span className="text-done">+{current.additions}</span>{' '}
        <span className="text-failed">−{current.deletions}</span> for it, so it did change: the lines are not
        in this answer. Open it again to ask for them.
      </p>
    );
  } else if (current) {
    body = <DiffHunks file={current} wrap={wrap} />;
  } else {
    return null;
  }
  return (
    // Sideways only, at every width: a patch line is as long as it is, and the
    // page is the one vertical scroller — no height cap, so nothing nests.
    <div
      className="min-w-0 overflow-x-auto overscroll-x-contain rounded-md border border-rule bg-surface"
      data-testid="patch-pane"
    >
      {body}
    </div>
  );
}

export default function ChangesSection({ route }: { route: Route }) {
  const repo = repoTargetOf(route.query);
  const base = route.query.base || undefined;
  const tip = route.query.tip || undefined;
  const path = route.query.path || undefined;
  const unified = unifiedOf(route.query.unified);
  const targets = useTargets();
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState('');
  const listId = useId();

  const params = useMemo(
    () => ({
      ...(repo ? { repo } : {}),
      ...(base ? { base } : {}),
      ...(tip ? { tip } : {}),
      ...(path ? { path } : {}),
      unified,
    }),
    [repo, base, tip, path, unified],
  );
  const { data, isPending, isPlaceholderData, error, refetch } = useRepoDiff(params);

  const link = (next: Record<string, string | number | undefined>) =>
    repoSectionHref('changes', {
      repo,
      base,
      tip,
      path,
      unified: unified === DEFAULT_UNIFIED ? undefined : unified,
      ...next,
    });

  const q = query.trim().toLowerCase();
  const files = useMemo(
    () =>
      (data?.files ?? []).filter(
        (f) => !q || f.path.toLowerCase().includes(q) || (f.oldPath ?? '').toLowerCase().includes(q),
      ),
    [data, q],
  );

  const toolbar = (
    <Toolbar
      label="Changes"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: 'Find a file',
        label: 'Find a changed file by path',
      }}
      {...(targets.length > 1
        ? {
            filter: {
              active: repo ? 1 : 0,
              panel: <TargetPanel section="changes" current={repo} targets={targets} />,
            },
          }
        : {})}
      view={{
        value: unified === 0 ? 'No context' : plural(unified, 'line'),
        active: (unified === DEFAULT_UNIFIED ? 0 : 1) + (wrap ? 1 : 0),
        panel: (
          <div className="flex min-w-0 flex-col gap-4">
            <PanelChoices
              name="Context around each change"
              value={String(unified)}
              options={UNIFIED_CHOICES.map((n) => ({
                id: String(n),
                label: n === 0 ? 'No context' : plural(n, 'line'),
                ...(n === DEFAULT_UNIFIED ? { blurb: "git's own default." } : {}),
              }))}
              // `0` is a real request — no context lines — and is sent as such.
              onChange={(next) =>
                navigate(link({ unified: Number(next) === DEFAULT_UNIFIED ? undefined : Number(next) }), {
                  replace: true,
                })
              }
              testId="diff-context"
            />
            <label className="flex min-w-0 items-center gap-2 text-body text-ink [@media(hover:none)]:min-h-(--tap-min)">
              <Checkbox checked={wrap} onCheckedChange={(next) => setWrap(next === true)} />
              Wrap long lines
            </label>
          </div>
        ),
      }}
      note={
        q && data ? (
          <>
            <span className="tnum" aria-live="polite">
              {files.length} of {plural(data.files.length, 'file')} match.
            </span>
            <Button size="sm" variant="ghost" onClick={() => setQuery('')}>
              Clear the search
            </Button>
          </>
        ) : undefined
      }
    />
  );

  const range = (
    <form
      // A new address re-seeds the two fields from it.
      key={`${base ?? ''}|${tip ?? ''}`}
      className="flex min-w-0 flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const nextBase = String(form.get('base') ?? '').trim();
        const nextTip = String(form.get('tip') ?? '').trim();
        // A new range drops the opened file: a path that changed in the old
        // range need not exist in the new one.
        navigate(link({ base: nextBase || undefined, tip: nextTip || undefined, path: undefined }));
      }}
      data-testid="diff-range-form"
    >
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-meta text-ink-muted">Base</span>
        <Input
          name="base"
          defaultValue={base ?? ''}
          placeholder="the working tree"
          className="w-48 max-w-full"
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-meta text-ink-muted">Tip</span>
        <Input name="tip" defaultValue={tip ?? ''} placeholder="HEAD" className="w-48 max-w-full" />
      </label>
      <Button size="sm" type="submit">
        Compare
      </Button>
      {(base || tip) && (
        <Button size="sm" variant="ghost" asChild>
          <a href={repoSectionHref('changes', { repo })}>The working tree</a>
        </Button>
      )}
    </form>
  );

  if (error) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        {range}
        <ReadError error={error} retry={() => void refetch()} />
      </div>
    );
  }
  if (isPending || !data) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        {range}
        <RowsLoading label="Reading the changes" />
      </div>
    );
  }

  const listed = path ? data.files.some((f) => f.path === path) : true;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {toolbar}
      {range}
      <p className="text-body text-ink-muted" data-testid="diff-range">
        {rangeLine(data)}
      </p>
      {data.filesTruncated && (
        <Banner severity="warn" data-testid="files-truncated">
          More files changed than are listed. The count is git&rsquo;s for the whole range; the list stops at
          its cap.
        </Banner>
      )}
      {path && !listed && (
        <Banner data-testid="path-not-in-range">
          <code className="font-mono text-meta">{path}</code>{' '}
          {data.filesTruncated
            ? 'is not in the part of the file list this answer carries — which is capped, so it may well have changed. Narrow the range, or open it from a range whose list fits.'
            : 'is not among the files this range changed. A link to a file outlives the range it was made in: open one from the list, or compare a range that touches it.'}
        </Banner>
      )}

      {data.files.length === 0 ? (
        <Empty title="Nothing changed in this range: git compared its two ends and found no file between them." />
      ) : files.length === 0 ? (
        <Empty
          title={`No changed file matches “${query.trim()}”.`}
          action={
            <Button size="sm" onClick={() => setQuery('')}>
              Clear the search
            </Button>
          }
        />
      ) : (
        <ul aria-label="Files changed" className="flex min-w-0 flex-col" data-testid="diff-files">
          {files.map((file, i) => {
            const open = file.path === path;
            const region = `${listId}-${i}`;
            return (
              <li key={file.path} className="min-w-0" data-testid="diff-file" data-path={file.path}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={open ? region : undefined}
                  onClick={() => navigate(link({ path: open ? undefined : file.path }))}
                  className={cn(
                    'flex min-h-(--tap-min) w-full min-w-0 items-center gap-2 py-1.5 text-start',
                    '[@media(hover:hover)]:min-h-10 hover:bg-surface-raised',
                    open && 'bg-surface-raised',
                  )}
                >
                  <ChevronRight
                    size={14}
                    aria-hidden
                    className={cn(
                      'shrink-0 text-ink-faint transition-transform duration-fast rtl:-scale-x-100',
                      open && 'rotate-90',
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <PathWords path={file.path} className="block text-body text-ink" />
                    {file.oldPath && (
                      <span className="min-w-0 break-words text-meta text-ink-muted">
                        Renamed from <PathWords path={file.oldPath} />
                      </span>
                    )}
                  </span>
                  <DiffCounts file={file} />
                </button>
                {open && (
                  <div id={region} className="flex min-w-0 flex-col gap-2 pb-3">
                    <PatchPane diff={data} path={file.path} loading={isPlaceholderData} wrap={wrap} />
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="-ms-2 max-w-[calc(100%+0.5rem)]"
                        onClick={() => inspectFile({ file, repo, base, tip })}
                      >
                        Inspect this file
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
