import { CloudOff, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/ui';
import { RouteGlyph, Wordmark } from './brand';

/**
 * What the app is when it cannot reach the console.
 *
 * This screen only exists because the shell is precached, and it is the reason
 * precaching the shell is safe. Opening offline is the app, immediately, saying
 * exactly one true thing: it cannot see the board. It deliberately shows no
 * board: every status in this console is a claim about a repository being
 * edited right now, and a cached one would be indistinguishable from live and
 * wrong within a minute.
 */
export function Disconnected({
  online,
  detail,
  onRetry,
  retrying = false,
}: {
  online: boolean;
  detail?: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const Icon = online ? CloudOff : WifiOff;
  return (
    <div className="grid min-h-(--app-height) place-items-center bg-ground p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div className="flex items-center gap-2">
          <RouteGlyph size={22} />
          <Wordmark />
        </div>

        <Icon size={28} className="text-ink-faint" aria-hidden />

        <h1 className="text-title font-semibold text-ink">
          {online ? 'The console is not answering' : "You're offline"}
        </h1>

        <p className="text-body text-ink-muted">
          {online
            ? 'The app loaded from this device, but the server behind it did not respond.'
            : 'The app loaded from this device. Reaching the console needs a network.'}{' '}
          The board is not shown because it would be out of date, and an out-of-date board looks exactly like
          a current one.
        </p>

        <Button variant="primary" onClick={onRetry} disabled={retrying}>
          <RefreshCw size={15} className={retrying ? 'animate-spin' : undefined} aria-hidden />
          {retrying ? 'Trying…' : 'Try again'}
        </Button>

        {detail && (
          <p className="max-w-full truncate font-mono text-meta text-ink-faint" title={detail}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
