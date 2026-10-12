/**
 * Logs ▸ Health, the stray consoles — console server processes on this
 * machine whose code is gone (`GET /api/doctor/strays`): an install moved or
 * deleted under a console that went on running.
 *
 * ```
 * 1 console process on this machine runs code that is gone. The CLI stops it; …
 * phase-console doctor --stop-strays                          [Copy the command]
 * pid 4711, group 4711
 *   node /home/me/old/viewer/server/main.ts --port 4131
 *   root /home/me/old
 * Read just now.                                               [Scan again]
 * ```
 *
 * Listed, never stopped: signalling a process is the CLI's, so the page draws
 * the line that does it, to copy. Each read is one `ps` of the machine, asked
 * on arrival and when a person scans again; none is one quiet line.
 */

import { useStrayConsoles } from '@/data/machine';
import { plural } from '@/lib/format';
import { Button, Mono, RelativeTime, Skeleton } from '@/ui';
import { CopyButton } from '@/ui/copy-button';

export function StrayConsoleList() {
  const { data, error, refetch, isFetching } = useStrayConsoles();
  const again = (
    <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
      {isFetching ? 'Scanning…' : 'Scan again'}
    </Button>
  );
  if (error) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2" data-testid="strays">
        <p className="max-w-(--measure) text-body text-ink-muted">
          The stray consoles could not be listed: {error.message || 'the read failed and said nothing.'}
        </p>
        {again}
      </div>
    );
  }
  if (!data) return <Skeleton className="h-16" data-testid="strays" aria-busy="true" />;

  const { strays } = data;
  if (!strays.length) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2" data-testid="strays">
        <p className="max-w-(--measure) text-body text-ink-muted" data-testid="strays-none">
          None: every console process on this machine still has its code.
        </p>
        {again}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="strays">
      <p className="max-w-(--measure) text-body text-ink">
        {plural(strays.length, 'console process', 'console processes')} on this machine{' '}
        {strays.length === 1 ? 'runs' : 'run'} code that is gone. The CLI stops{' '}
        {strays.length === 1 ? 'it' : 'them'}; this page never signals a process.
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Mono value={data.stop} words className="text-body text-ink" />
        <CopyButton text={data.stop} label="Copy the command" copiedLabel="Copied the command" />
      </div>
      <ul className="flex min-w-0 flex-col divide-y divide-rule" aria-label="Stray consoles">
        {strays.map((stray) => (
          <li key={stray.pid} data-stray={stray.pid} className="flex min-w-0 flex-col gap-1 py-2">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-meta text-ink-muted">
              pid <Mono value={String(stray.pid)} className="text-ink" />, group{' '}
              <Mono value={String(stray.pgid)} />
            </span>
            <Mono value={stray.command} words className="text-body text-ink" />
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-meta text-ink-muted">
              root <Mono value={stray.root} className="min-w-0 wrap-anywhere" />
            </span>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-meta text-ink-muted">
          Read <RelativeTime at={data.at} />.
        </p>
        {again}
      </div>
    </div>
  );
}
