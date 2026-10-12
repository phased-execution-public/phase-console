/**
 * The source picker (7.0, quiet-console phase 21) — `#/source`, the one page
 * drawn INSTEAD of the shell, because until a source is open there is nothing
 * to navigate to. It frames itself: a title, what it reads, then the choice.
 *
 * ```
 * Choose a source directory
 * Point the console at a repository that holds docs/plans. …
 * This console reads ~/code/repo now.  Back to the console
 * Recent        repo   /home/me/code/repo                                 [Open]
 * Browse
 *   Path [ /home/me/code                                                       ]
 *   ✓ 3 plans and 2 handoff folders found in /home/me/code/docs
 *   [Open this directory]
 *   [Parent directory] [Home directory]
 *   ▸ repo                                                             Has plans
 *   ▸ scratch
 * ```
 *
 * The verdict is the point: the root check (`GET /api/root`) answers WHY a
 * directory is not a source — no `docs/plans`, no such directory — and how
 * much is in one when it is, so Open is enabled by a fact rather than by hope.
 * The decision sits ABOVE the listing, so a home directory of eighty folders
 * never pushes the button out of reach. A pinned console still draws the
 * picker — someone who navigated here must not be left staring at nothing —
 * but Open is off, and the banner says which console this is and what to run
 * instead. A refusal is the server's own words, beside the button.
 */

import { useEffect, useId, useState } from 'react';
import { ChevronUp, Folder, House } from 'lucide-react';
import { useConsoleState } from '@/data/console';
import { ApiError } from '@/data/http';
import { useDirListing, useOpenRoot, useRootCheck } from '@/data/machine';
import { homePath, plural } from '@/lib/format';
import { navigate, plansHref, runsHref } from '@/shell/routes';
import { Banner, Button, Empty, Input, Label, Mono, Page, SectionHeading, Skeleton, toast } from '@/ui';

const LINK = 'tap-line text-ink underline decoration-ink-faint underline-offset-2';

/** Why an open was refused, in the server's words: a bad root's reason, a pinned console's sentence. */
function refusalWords(cause: unknown): string {
  const body =
    cause instanceof ApiError ? (cause.body as { check?: { reason?: unknown } } | undefined) : undefined;
  if (typeof body?.check?.reason === 'string' && body.check.reason) return body.check.reason;
  return cause instanceof Error && cause.message
    ? cause.message
    : 'The console did not open it and said nothing.';
}

export default function SourcePage() {
  const { data: state } = useConsoleState();
  const pathId = useId();
  const browseId = useId();
  const recentId = useId();

  // Both start at the source this console reads now; `null` is "not moved yet",
  // so a state that answers after the first render still seeds them.
  const start = state?.root?.path ?? '';
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const here = browsing ?? start;
  const path = typed ?? start;

  const listingQuery = useDirListing(here);
  const listing = listingQuery.data;
  const { data: check } = useRootCheck(path);
  const open = useOpenRoot();
  const [refusal, setRefusal] = useState<string | null>(null);

  // The server resolves `~`, `.` and a relative path into a real one, so the
  // box shows what was walked to rather than what was asked. Keyed on the
  // listing's own path, and never on the previous directory's answer held on
  // screen while the next one loads — that would stamp the old path back over
  // the one just chosen.
  const walked = listingQuery.isPlaceholderData ? undefined : listing?.path;
  useEffect(() => {
    if (walked && walked !== here) setTyped(walked);
  }, [walked, here]);

  const walkTo = (target: string) => {
    setBrowsing(target);
    setTyped(target);
  };

  const pinned = state?.instance?.pinned === true;
  const canOpen = Boolean(check?.ok) && !open.isPending && !pinned;
  const current = state?.root?.ok && state.root.path ? state.root.path : null;
  const recents = state?.recentRoots ?? [];

  const openRoot = (target: string) => {
    setRefusal(null);
    open.mutate(target, {
      onSuccess: (result) => {
        if (!result.check?.ok) {
          setRefusal(result.check?.reason ?? 'That directory is not a source.');
          return;
        }
        toast(`Opened ${result.check.label}`, 'ok');
        navigate(plansHref());
      },
      onError: (cause) => setRefusal(refusalWords(cause)),
    });
  };

  return (
    <main className="min-w-0">
      <Page
        title="Choose a source directory"
        className="max-w-3xl"
        lead={
          <>
            Point the console at a repository that holds <Mono value="docs/plans" />. A{' '}
            <Mono value="docs/handoffs" /> folder beside it is read too, when there is one.
          </>
        }
      >
        <p className="max-w-(--measure) text-body text-ink-muted">
          Everything on screen comes from those files and from the phased-execution scripts. The plans stay
          where they are: nothing is written unless the server was started with{' '}
          <Mono value="--allow-writes" />.
        </p>

        {pinned ? (
          <Banner severity="warn" data-testid="source-pinned">
            This console is pinned to {state?.instance?.name}
            {state?.root?.path ? (
              <>
                {' '}
                (<Mono value={state.root.path} />)
              </>
            ) : null}
            . To open a different project, run <Mono value="phase-console start" /> in that project: it gets
            its own console, port and state.
          </Banner>
        ) : current ? (
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-body text-ink-muted">
            <span className="min-w-0">
              This console reads{' '}
              <Mono value={homePath(current, state?.home) ?? current} className="wrap-anywhere" /> now.
            </span>
            <a href={runsHref()} className={LINK}>
              Back to the console
            </a>
          </p>
        ) : null}

        {recents.length ? (
          <section aria-labelledby={recentId} className="flex min-w-0 flex-col gap-2">
            <SectionHeading id={recentId}>Recent</SectionHeading>
            <ul className="flex min-w-0 flex-col gap-2">
              {recents.map((recent) => (
                <li key={recent.path} className="flex min-w-0 items-center justify-between gap-3">
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 break-words text-body text-ink">{recent.label}</span>
                    <Mono value={recent.path} className="min-w-0 wrap-anywhere" />
                  </span>
                  <Button
                    size="sm"
                    disabled={open.isPending || pinned}
                    aria-label={`Open ${recent.label}`}
                    onClick={() => openRoot(recent.path)}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby={browseId} className="flex min-w-0 flex-col gap-3">
          <SectionHeading id={browseId}>Browse</SectionHeading>

          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={pathId}>Path</Label>
            <Input
              id={pathId}
              block
              dir="ltr"
              className="font-mono"
              value={path}
              placeholder="/path/to/your-repo"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canOpen) {
                  event.preventDefault();
                  openRoot(path);
                }
              }}
            />
          </div>

          <div className="min-w-0" data-testid="source-verdict">
            {check?.ok ? (
              <Banner severity="ok">
                {plural(check.planCount, 'plan')} and {plural(check.handoffCount, 'handoff folder')} found in{' '}
                <Mono value={check.docsDir ?? check.path} className="wrap-anywhere" />
              </Banner>
            ) : check ? (
              <Banner severity="warn">{check.reason ?? 'Not a source directory.'}</Banner>
            ) : (
              <p className="text-body text-ink-muted">
                Pick a directory that contains <Mono value="docs/plans" />.
              </p>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <div>
              <Button variant="primary" disabled={!canOpen} onClick={() => openRoot(path)}>
                {open.isPending ? 'Opening…' : 'Open this directory'}
              </Button>
            </div>
            {refusal ? (
              <Banner severity="error" data-testid="source-refusal">
                {refusal}
              </Banner>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-wrap gap-2">
            {listing?.parent ? (
              <Button size="sm" onClick={() => walkTo(listing.parent!)}>
                <ChevronUp size={14} aria-hidden /> Parent directory
              </Button>
            ) : null}
            <Button size="sm" onClick={() => walkTo('~')}>
              <House size={14} aria-hidden /> Home directory
            </Button>
          </div>

          <div className="min-w-0" data-testid="source-listing">
            {listingQuery.error && !listing ? (
              <p className="text-body text-ink-muted">
                This directory could not be read: {listingQuery.error.message}
              </p>
            ) : !listing ? (
              <div aria-busy="true" className="flex min-w-0 flex-col gap-1">
                {[0, 1, 2].map((row) => (
                  <Skeleton key={row} className="h-8" />
                ))}
              </div>
            ) : listing.entries.length ? (
              <ul className="flex min-w-0 flex-col" aria-label={`Directories in ${listing.path}`}>
                {listing.entries.map((entry) => (
                  <li key={entry.path} className="min-w-0">
                    <Button
                      variant="ghost"
                      className="w-full justify-start gap-2 px-2 font-normal text-ink"
                      onClick={() => walkTo(entry.path)}
                    >
                      <Folder size={14} aria-hidden className="text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate text-start">{entry.name}</span>
                      {/* The space is for a screen reader, which would otherwise run the name into the mark. */}
                      {entry.hasDocs ? (
                        <>
                          {' '}
                          <span className="text-meta text-ink-muted">Has plans</span>
                        </>
                      ) : null}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Nothing to browse here: this directory has no sub-directories." />
            )}
          </div>
        </section>
      </Page>
    </main>
  );
}
