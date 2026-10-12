import { useState } from 'react';
import { Power, Snowflake, WifiOff } from 'lucide-react';
import { Banner, Button, toast } from '@/ui';
import { api, type ConsoleState } from '@/data/api';
import { press, PressRefusal } from '@/data/press';
import type { Stopped } from '@/lib/shutdown';
import type { SseStatus } from '@/data/live';

/**
 * The console's own banners, above every page: a frozen console first, because
 * it EXPLAINS every other symptom on the page; then a server older than its
 * disk; then a console stopped on purpose, which outranks every reading of a
 * dead stream; then the stream itself. Each is one sentence and a way out, in
 * the console's voice, and none is amber: a banner is a note, not a summons.
 */
export function ConsoleBanners({
  state,
  online,
  sse,
  stopped,
}: {
  state: ConsoleState;
  online: boolean;
  sse: SseStatus;
  stopped: Stopped | null;
}) {
  return (
    <>
      {state.fleet?.frozen && <FrozenBanner state={state} />}
      {state.serverStale && (
        <Banner severity="warn">
          <strong>This console is running older code than is on disk.</strong> Node loads the server once, at
          startup — the page reloads from disk but the process cannot. Restart it, or a fix you already have
          will look like it did not work.
        </Banner>
      )}
      {stopped ? (
        <Banner severity="warn">
          <span className="flex items-start gap-2">
            <Power size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              <strong>{sse === 'live' ? 'This console is shutting down.' : 'This console is off.'}</strong>{' '}
              {stopped.via === 'exit'
                ? 'The process has ended.'
                : 'Its unit was unloaded and disabled, and a stop marker holds its work — not even a login brings it back.'}{' '}
              Start it again with <code className="font-mono text-meta">{stopped.hint}</code>.
            </span>
          </span>
        </Banner>
      ) : (
        (!online || sse !== 'live') && (
          <Banner severity={!online || sse === 'offline' ? 'error' : 'info'}>
            <span className="flex items-start gap-2">
              <WifiOff size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                {/* Being offline outranks whatever the stream thinks: it explains
                    the stream, and it is the one the reader can do something about. */}
                {!online
                  ? 'This device is offline. Everything below was loaded before that and is no longer updating.'
                  : sse === 'offline'
                    ? 'Live updates stopped. Reload to reconnect.'
                    : 'Reconnecting to the console — the board may be a moment behind.'}
              </span>
            </span>
          </Banner>
        )
      )}
    </>
  );
}

/** `relativeTime`'s one job here: "12 minutes ago", from an ISO stamp, or nothing. */
function since(iso: string | null): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The panic button's sentence, on every page. A frozen console looks exactly
 * like a console with nothing to do, which is the hardest state to diagnose
 * from the outside; this is what makes the difference legible. Thaw presses
 * through the one door, so a console with an owner key asks the owner.
 */
function FrozenBanner({ state }: { state: ConsoleState }) {
  const [busy, setBusy] = useState(false);
  const fleet = state.fleet!;
  const ago = since(fleet.at);
  const thaw = async () => {
    setBusy(true);
    try {
      const outcome = await press(() => api.fleetThaw());
      if (outcome.state === 'asked') toast('Thawing waits for the owner to confirm it.', 'info');
    } catch (error) {
      toast(
        error instanceof PressRefusal ? error.message : String((error as Error).message ?? error),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      severity="warn"
      action={
        state.allowRun ? (
          <Button size="sm" disabled={busy} onClick={() => void thaw()}>
            {busy ? 'Thawing…' : 'Thaw'}
          </Button>
        ) : undefined
      }
    >
      <span className="flex items-start gap-2">
        <Snowflake size={15} className="mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          <strong>This console is frozen.</strong> Every running session is stopped where it stands and
          nothing new will start.
          {fleet.by ? ` Frozen by ${fleet.by}` : ' Frozen'}
          {ago ? ` ${ago}` : ''}. Thawing puts every run of this console back exactly where it was.
        </span>
      </span>
    </Banner>
  );
}
