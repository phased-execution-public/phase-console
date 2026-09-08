/**
 * The landing packet, on the plan page.
 *
 * The console never pushes (`server/landing.ts` says why, and
 * `test/never-push.test.ts` keeps it true), so the last thing a finished plan
 * owes its operator is not a green tick — it is the work, in a form they can
 * carry somewhere else. That is what this card hands over: the branch it is
 * on, whether it exists anywhere but here, the commits, and two files git can
 * read back.
 *
 * Collapsed by default and open on a finished plan. The read behind it is a
 * `git status` over the whole tree plus a `git log` over the plan's range, so
 * it fires when the card is open, never on every plan render.
 */

import { useState } from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  CopyButton,
  Spinner,
} from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useApiMutation, useLanding } from '@/lib/queries';
import type { LandingArtifact, LandingView, PlanDetail } from '@/lib/api';

/** Bytes as an operator reads them. A bundle is KB–MB; nothing here is a gigabyte. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one-line answer to "is this work anywhere but this laptop?" */
export function branchLine(view: LandingView): string {
  const { repo } = view;
  if (!repo.available) return 'This source directory is not a git repository.';
  const where = repo.branch ? `on ${repo.branch}` : 'on a detached HEAD';
  const remote = repo.upstream
    ? `tracking ${repo.upstream}${repo.ahead ? `, ${repo.ahead} ahead` : ''}${repo.behind ? `, ${repo.behind} behind` : ''}`
    : 'with no upstream — it exists only here';
  return `${view.commitCount} commit${view.commitCount === 1 ? '' : 's'} ${where}, ${remote}.`;
}

function ArtifactRow({ slug, file }: { slug: string; file: LandingArtifact }) {
  return (
    <li className="flex items-center justify-between gap-3 border-t border-rule px-(--tile-pad-x) py-(--tile-pad-y) first:border-t-0">
      <a
        className="min-w-0 truncate font-mono text-xs underline decoration-rule underline-offset-2"
        href={api.landingFileHref(slug, file.name)}
        // A real download, not a fetch: the browser names the file from
        // `content-disposition` and writes it to disk itself.
        download
      >
        {file.name}
      </a>
      <span className="shrink-0 text-2xs text-ink-faint">{fileSize(file.bytes)}</span>
    </li>
  );
}

export function LandingCard({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const [open, setOpen] = useState(false);
  const { data: view, isLoading } = useLanding(slug, open);

  // Only the packet's own read — composing writes two files under the plan's
  // handoff folder and moves nothing the board can see. A refused compose
  // answers `{ok:false}` rather than throwing, so the banner below is where a
  // refusal is read; a thrown failure is the toast.
  const compose = useApiMutation<void, { ok: boolean; detail: string }>({
    fn: () => api.composeLanding(slug),
    invalidates: [keys.landing(slug)],
  });

  const packet = view?.packet ?? null;
  const failed = compose.data && !compose.data.ok ? compose.data.detail : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Landing packet</CardTitle>
        <div className="flex items-center gap-2">
          {view?.finished && <Chip tone="ok">every phase done</Chip>}
          <Button size="sm" variant="ghost" onClick={() => setOpen((was) => !was)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'}
          </Button>
        </div>
      </CardHeader>

      {open && (
        <CardBody className="flex flex-col gap-2 text-sm">
          {isLoading && <Spinner />}

          {view && (
            <>
              <p className="text-ink-muted">{branchLine(view)}</p>
              <p className="text-2xs text-ink-faint">{view.window.note}</p>

              {/* The invariant, said where the button is — not only in a doc.
                  Somebody looking for a Push button should find the reason
                  there is none at the moment they look for it. */}
              <p className="text-2xs text-ink-faint">
                This console never pushes. The packet is written to this machine; where it goes is yours to
                decide.
              </p>

              {!view.writable && (
                <Banner severity="info">
                  Composing writes files, so it needs <code>--allow-writes</code>. Everything above is
                  readable without it.
                </Banner>
              )}

              {failed && <Banner severity="warn">{failed}</Banner>}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => compose.mutate()}
                  disabled={!view.writable || !view.repo.available || compose.isPending}
                >
                  {compose.isPending ? 'Composing…' : packet ? 'Compose again' : 'Compose landing packet'}
                </Button>
                {packet && (
                  <span className="text-2xs text-ink-faint">
                    composed {new Date(packet.at).toLocaleString()} · {packet.commitCount} commit
                    {packet.commitCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              {packet && (
                <>
                  {packet.notes.map((note) => (
                    <Banner key={note} severity="warn">
                      {note}
                    </Banner>
                  ))}

                  <ul className="m-0 list-none rounded border border-rule p-0">
                    {packet.files.map((file) => (
                      <ArtifactRow key={file.name} slug={slug} file={file} />
                    ))}
                  </ul>

                  {packet.bundle?.prerequisites.length ? (
                    <p className="text-2xs text-ink-faint">
                      The receiving repository must already contain{' '}
                      <code className="font-mono">{packet.bundle.prerequisites.join(', ')}</code>.
                    </p>
                  ) : null}

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-2xs text-ink-faint">To land it:</span>
                    <CopyButton text={packet.apply.join('\n')} label="Copy the commands" />
                  </div>
                  <pre className="m-0 overflow-auto rounded border border-rule bg-ground-deep p-2 font-mono text-2xs leading-relaxed whitespace-pre">
                    {packet.apply.join('\n')}
                  </pre>
                </>
              )}
            </>
          )}
        </CardBody>
      )}
    </Card>
  );
}
