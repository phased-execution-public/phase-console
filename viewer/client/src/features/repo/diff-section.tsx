/**
 * The Changes section — a range, its files, and one file's patch at a time.
 *
 * ## The empty range is the useful default
 *
 * With neither `base` nor `tip`, `GET /api/repo/diff` compares the **working
 * tree against HEAD** — what an in-flight phase has changed so far, which is the
 * question this destination exists to answer without a terminal. So arriving at
 * `#/repo/diff` with no query is not an empty form: it is already showing you
 * something, and the range controls are how you ask about something else.
 *
 * `base` alone means the working tree against that base; `tip` alone means that
 * one commit (`<sha>^!`, which is correct for a root commit too), which is what
 * "what this commit changed" links to from the History section.
 *
 * ## Why the patch is a second request
 *
 * The file list is git's `--numstat` over the whole range; the patch is one
 * file. Fetching every file's hunks at once would make the byte budget a global
 * knob and the truncation report a guess. So picking a file adds `?path=`, and
 * the URL is the state here as everywhere else in this destination.
 */

import type { ViewProps } from '@/app/router';
import { navigate } from '@/app/router';
import { Button, Input, PageError } from '@/components/ui';
import { useRepoDiff } from '@/lib/queries';
import { DiffPanel } from './diff';
import { repoHref } from './routes';

/** git's own default, and the value an absent `unified=` gets on the server. */
const DEFAULT_UNIFIED = 3;

export default function DiffSection({ route }: { route: ViewProps['route'] }) {
  const { repo, base, tip, path } = route.query;
  // `0` is a legal request meaning *no context lines*, so absence is tested
  // before the coercion — `Number(undefined)` is NaN, but `Number('')` is 0 and
  // an empty parameter is silence, not zero. This is the client half of the
  // rule P8's round-2 High was about.
  // ...and a value that is not a number at all falls back HERE, once, rather
  // than being sanitised for the request and left raw for the links — which
  // spliced a literal `NaN` into every href on the page.
  const asked =
    route.query.unified === undefined || route.query.unified === ''
      ? DEFAULT_UNIFIED
      : Number(route.query.unified);
  const unified = Number.isFinite(asked) ? asked : DEFAULT_UNIFIED;

  const params = {
    ...(repo ? { repo } : {}),
    ...(base ? { base } : {}),
    ...(tip ? { tip } : {}),
    ...(path ? { path } : {}),
    unified,
  };
  const { data, isPending, isPlaceholderData, error, refetch } = useRepoDiff(params);

  const link = (next: Record<string, string | number | undefined>) =>
    repoHref('diff', {
      repo,
      base,
      tip,
      path,
      unified: unified === DEFAULT_UNIFIED ? undefined : unified,
      ...next,
    });

  if (error) return <PageError error={error} retry={() => void refetch()} />;

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const nextBase = String(form.get('base') ?? '').trim();
          const nextTip = String(form.get('tip') ?? '').trim();
          // A new range invalidates the picked file — a path that changed in the
          // old range need not exist in the new one, and carrying it over is how
          // a viewer ends up reporting "nothing changed" about the wrong file.
          navigate(link({ base: nextBase || undefined, tip: nextTip || undefined, path: undefined }));
        }}
      >
        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Base</span>
          <Input name="base" defaultValue={base ?? ''} placeholder="the working tree" className="w-48" />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Tip</span>
          <Input name="tip" defaultValue={tip ?? ''} placeholder="HEAD" className="w-48" />
        </label>
        <Button size="sm" type="submit" variant="ghost">
          Compare
        </Button>
        {(base || tip || path) && (
          <Button size="sm" variant="ghost" onClick={() => navigate(repoHref('diff', { repo }))}>
            Working tree
          </Button>
        )}
      </form>

      <DiffPanel
        diff={data}
        loading={isPending}
        stale={isPlaceholderData}
        {...(path !== undefined ? { picked: path } : {})}
        onPick={(next) => navigate(link({ path: next }))}
        unified={unified}
        onUnified={(n) =>
          navigate(link({ unified: n === DEFAULT_UNIFIED ? undefined : n }), { replace: true })
        }
      />
    </div>
  );
}
