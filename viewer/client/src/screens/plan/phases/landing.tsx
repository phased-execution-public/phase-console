/**
 * The landing packet — how a finished plan's work leaves this machine (7.0,
 * quiet-console phase 10).
 *
 * The console never pushes (`server/landing.ts` says why, and
 * `test/never-push.test.ts` keeps it true), so the last thing a finished plan
 * owes its operator is not a tick but the work, in a form they can carry: the
 * branch it is on, whether it exists anywhere but here, the commits, and two
 * files git can read back.
 *
 * Folded, and read only once opened: the read behind it is a `git status` over
 * the whole tree and a `git log` over the plan's range, which no plan render
 * should pay for.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type LandingArtifact, type LandingPacket, type LandingView, type PlanDetail } from '@/data/api';
import { keys } from '@/data/keys';
import { useLanding } from '@/data/plans';
import { press } from '@/data/press';
import { plural } from '@/lib/format';
import { Banner, Button, Empty, Mono, RelativeTime, Spinner, toast } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';

/** Bytes as an operator reads them. A bundle is KB to MB; nothing here is a gigabyte. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one-line answer to "is this work anywhere but this machine?" */
export function branchLine(view: LandingView): string {
  const { repo } = view;
  if (!repo.available) return 'This source directory is not a git repository.';
  const where = repo.branch ? `on ${repo.branch}` : 'on a detached HEAD';
  const remote = repo.upstream
    ? `tracking ${repo.upstream}${repo.ahead ? `, ${repo.ahead} ahead` : ''}${repo.behind ? `, ${repo.behind} behind` : ''}`
    : 'with no upstream, so it exists only here';
  return `${plural(view.commitCount, 'commit')} ${where}, ${remote}.`;
}

/** A refusal in the server's own words; the honest floor when it said nothing. */
const words = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.';

export function LandingCard({ detail }: { detail: PlanDetail }) {
  return (
    <section aria-label="Landing packet" data-testid="landing-card" className="min-w-0">
      <Disclosure
        label="Landing packet"
        openLabel="Landing packet"
        testId="landing-toggle"
        bodyClassName="flex min-w-0 flex-col items-start gap-3 pt-2 ps-4"
      >
        <LandingBody slug={detail.summary.slug} />
      </Disclosure>
    </section>
  );
}

/** Mounted only while open — mounting is the read. */
function LandingBody({ slug }: { slug: string }) {
  const client = useQueryClient();
  const { data: view, error, isPending, refetch } = useLanding(slug);
  const [busy, setBusy] = useState(false);
  // A refused compose answers `{ok:false}` rather than throwing: its sentence
  // is read here, beside the button; a thrown failure is the toast.
  const [refusal, setRefusal] = useState<string | null>(null);

  if (error) {
    return (
      <Empty
        title={words(error)}
        action={
          <Button size="sm" onClick={() => void refetch()}>
            Read it again
          </Button>
        }
      />
    );
  }
  if (isPending || !view) return <Spinner label="Reading the branch" />;

  const packet = view.packet;
  const compose = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const pressed = await press(() => api.composeLanding(slug));
      if (pressed.state === 'asked') {
        toast(pressed.words, 'info');
        return;
      }
      if (!pressed.result.ok)
        setRefusal(pressed.result.detail || 'The compose was refused and said nothing.');
    } catch (cause) {
      toast(words(cause), 'error');
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: keys.landing(slug) });
    }
  };

  return (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        {view.finished && <p className="text-body text-ink">Every phase is done.</p>}
        <p className="min-w-0 break-words text-body text-ink">{branchLine(view)}</p>
        <p className="min-w-0 break-words text-meta text-ink-muted">{view.window.note}</p>
      </div>
      {/* Said where a Push button would be: somebody looking for one learns
          why there is none at the moment they look. */}
      <p className="max-w-(--measure) text-meta text-ink-muted">
        This console never pushes. The packet is written to this machine; where it goes is yours to decide.
      </p>
      {!view.writable && (
        <Banner severity="info">
          Composing writes files, so it needs <Mono value="--allow-writes" />. Everything above reads without
          it.
        </Banner>
      )}
      {refusal && <Banner severity="warn">{refusal}</Banner>}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="sm"
          onClick={() => void compose()}
          disabled={!view.writable || !view.repo.available || busy}
        >
          {busy ? 'Composing…' : packet ? 'Compose again' : 'Compose landing packet'}
        </Button>
        {packet && (
          <span className="text-meta text-ink-muted">
            Composed <RelativeTime at={packet.at} />, {plural(packet.commitCount, 'commit')}
          </span>
        )}
      </div>
      {packet && <Packet slug={slug} packet={packet} />}
    </>
  );
}

function Packet({ slug, packet }: { slug: string; packet: LandingPacket }) {
  const commands = packet.apply.join('\n');
  return (
    <>
      {/* A packet composed over a dirty tree leaves the uncommitted work out,
          and its note is the only thing that says so. */}
      {packet.notes.map((note) => (
        <Banner key={note} severity="warn">
          {note}
        </Banner>
      ))}
      <ul aria-label="Files in the packet" className="flex w-full min-w-0 flex-col gap-1">
        {packet.files.map((file) => (
          <ArtifactLine key={file.name} slug={slug} file={file} />
        ))}
      </ul>
      {packet.bundle?.prerequisites.length ? (
        <p className="min-w-0 break-words text-meta text-ink-muted">
          The receiving repository must already contain{' '}
          <Mono value={packet.bundle.prerequisites.join(', ')} />.
        </p>
      ) : null}
      <div className="flex w-full min-w-0 flex-col items-start gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-body text-ink">To land it</span>
          <CopyButton text={commands} label="Copy the commands" />
        </div>
        <pre className="m-0 w-full overflow-x-auto rounded-(--radius) bg-ground-deep p-3 font-mono text-meta leading-relaxed whitespace-pre">
          {commands}
        </pre>
      </div>
    </>
  );
}

function ArtifactLine({ slug, file }: { slug: string; file: LandingArtifact }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <a
        className="tap-line min-w-0 wrap-anywhere font-mono text-meta text-ink underline-offset-2 hover:underline"
        href={api.landingFileHref(slug, file.name)}
        // A real download, not a fetch: the browser names the file from
        // `content-disposition` and writes it to disk itself.
        download
      >
        {file.name}
      </a>
      <span className="text-meta text-ink-muted tabular-nums">{fileSize(file.bytes)}</span>
    </li>
  );
}
