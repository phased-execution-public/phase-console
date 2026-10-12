/**
 * Logs' glance: what this console is, in one sentence under the title.
 *
 * ```
 * Logs
 * Watching pe-hub on darwin. Supervised by launchd, so a clean exit comes back.
 * ```
 *
 * This is the page a person opens BECAUSE the console misbehaves, so the file
 * watcher is read three ways, never two: watching (it said so), stopped (it
 * said so, and why), and unknown (nothing said anything). Folding the third
 * into "watching" is how a diagnostics page reassures you about the very thing
 * that is broken. The supervisor's own sentence and the paths ride on hover
 * here and in full on Health ▸ This process.
 */

import type { ConsoleState } from '@/data/api';
import { plural } from '@/lib/format';
import { Button } from '@/ui';

type Facts = Pick<ConsoleState, 'watcher' | 'root' | 'platform' | 'supervisor'>;

/**
 * The watcher as `/api/state` carries it — `server/watch.ts` `status()`:
 * `healthy`, and how many of the folders it should watch it does. The wire
 * type declares only `ok` and `detail`, which the server does not send, so
 * both spellings are read: reading `ok` alone called every deaf watcher
 * "watching".
 */
type WatcherStatus = NonNullable<ConsoleState['watcher']> & {
  healthy?: boolean;
  watching?: number;
  expected?: number;
};

/** The file watcher, read three ways. */
export function watcherReading(state: Pick<ConsoleState, 'watcher'> | undefined): {
  word: 'watching' | 'stopped' | 'unknown';
  detail?: string;
} {
  const watcher: WatcherStatus | undefined = state?.watcher;
  if (!watcher) return { word: 'unknown' };
  if (watcher.ok === false || watcher.healthy === false) {
    const counted =
      watcher.watching !== undefined && watcher.expected !== undefined
        ? `${watcher.watching} of ${plural(watcher.expected, 'folder')} watched`
        : undefined;
    return { word: 'stopped', detail: watcher.detail ?? counted };
  }
  // A status that says neither has said nothing: it is not "watching".
  if (watcher.ok === true || watcher.healthy === true) return { word: 'watching' };
  return { word: 'unknown' };
}

const SUPERVISED_BY: Readonly<Record<string, string>> = {
  launchd: 'launchd',
  systemd: 'systemd',
  declared: 'the supervisor it was started under',
};

/** The supervisor, as the lead's second sentence. */
function supervisorSentence(supervisor: Facts['supervisor']): string {
  if (!supervisor) return 'Nothing says what restarts it.';
  const by = supervisor.kind ? SUPERVISED_BY[supervisor.kind] : undefined;
  if (!supervisor.supervised || !by) return 'Nothing restarts it if it exits.';
  return `Supervised by ${by}${supervisor.assumed ? ', as far as it can tell' : ''}, so a clean exit comes back.`;
}

/** The lead: inline words only, because the page draws it inside a paragraph. */
export function LogsFacts({
  state,
  error,
  retry,
}: {
  state: Facts | undefined;
  error?: unknown;
  retry?: () => void;
}) {
  if (error) {
    const said = error instanceof Error && error.message ? error.message : 'the read failed and said nothing';
    return (
      <span data-testid="logs-facts" data-watcher="unknown">
        This console’s state could not be read: {said}.{' '}
        {retry && (
          <Button size="sm" variant="ghost" className="-my-1 align-baseline" onClick={retry}>
            Try again
          </Button>
        )}
      </span>
    );
  }
  if (!state) return <span data-testid="logs-facts">Reading what this console is.</span>;

  const watcher = watcherReading(state);
  const source = state.root?.label ?? state.root?.path;
  const where = state.platform ? ` on ${state.platform}` : '';
  return (
    <span data-testid="logs-facts" data-watcher={watcher.word}>
      {watcher.word === 'watching' ? (
        <>
          Watching{' '}
          {source ? (
            <span className="text-ink" title={state.root?.path}>
              {source}
            </span>
          ) : (
            'no source'
          )}
          {where}.
        </>
      ) : watcher.word === 'stopped' ? (
        <span className="text-ink">
          The file watcher stopped{watcher.detail ? ` (${watcher.detail})` : ''}, so the board is not
          following {source ?? 'the docs'}
          {where}.
        </span>
      ) : (
        <>
          Nothing said whether the file watcher runs for {source ?? 'this console'}
          {where}.
        </>
      )}{' '}
      <span title={state.supervisor?.detail}>{supervisorSentence(state.supervisor)}</span>
    </span>
  );
}
