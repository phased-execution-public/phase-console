/**
 * Two facts about this console that are true on every page (control-tower
 * phase 25): how close its heap is to the limit it chose, and who else it is
 * serving.
 *
 * The heap is #20's number and #32's fourth gap. It was on one page, Debug ▸
 * Health, and #20 was a heap climbing to its limit twice in five minutes with
 * nobody on that page. So it is in the chrome: a small meter that says nothing
 * while there is nothing to say, and gives its reading in words once the heap
 * is near the limit — the same rule as the asks chip beside it. It opens
 * Debug ▸ Health, where the whole runtime strip is.
 *
 * Presence reads `state.access` — what this console has served, and to which
 * phone logins (hashed). It is drawn only once a phone has ever reached the
 * console; a chip that always reads "just you" stops being read. It opens a
 * popover with who and when, and Debug ▸ Access has the rest.
 *
 * Loaded lazily from the header: first paint is held to its budget, and the
 * runtime reader is shared with the Health section's own chunk.
 */

import { Users } from 'lucide-react';

import { debugHref } from '@/features/debug/routes';
import { useRuntime } from '@/features/debug/runtime';
import { Meter, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { useNavigate } from '@/app/router';
import type { ConsoleState } from '@/lib/api';
import { bytes } from '@/lib/format';
import { cn } from '@/lib/cn';

/** At or past this share of the limit the chip speaks, and turns. */
export const HEAP_NEAR = 0.8;
/** A phone seen within this long is "connected now". */
export const PRESENT_MS = 10 * 60_000;
/** The chip polls less often than the Health page does: it is a glance, not a strip. */
const CHIP_POLL_MS = 60_000;

export function RuntimeChip() {
  const navigate = useNavigate();
  const { data } = useRuntime(true, CHIP_POLL_MS);
  const used = data?.heapUsedBytes;
  const limit = data?.heapLimitBytes;
  if (used === undefined || !limit) return null;
  const share = used / limit;
  const near = share >= HEAP_NEAR;
  const reading = `Heap ${bytes(used)} of ${bytes(limit)}`;
  return (
    <button
      type="button"
      data-testid="runtime-chip"
      data-near={near ? 'true' : 'false'}
      onClick={() => navigate(debugHref('health'))}
      aria-label={`${reading} — open Debug ▸ Health`}
      title={`${reading} — open Debug ▸ Health`}
      // Off a 360 px phone's header, which has no room left; the More sheet
      // and Debug ▸ Health carry the same reading there.
      className={cn(
        'hidden min-h-(--tap-min) shrink-0 items-center gap-1.5 rounded px-2 text-ink-muted hover:text-ink sm:flex',
        near && 'text-ink',
      )}
    >
      <Meter
        value={used}
        max={limit}
        label="This console’s heap"
        valueText={`${Math.round(share * 100)} % — ${reading}`}
        paint={near ? 'failed' : 'running'}
        showTicks={false}
        className="w-8"
      />
      {near ? <span className="text-xs tabular-nums">{`Heap ${Math.round(share * 100)} %`}</span> : null}
    </button>
  );
}

type Access = NonNullable<ConsoleState['access']>;

/** The phones seen within `PRESENT_MS` of `now`, most recent first. */
export function presentNow(access: Access, now: number): Access['identities'] {
  return access.identities
    .filter((identity) => now - Date.parse(identity.last) <= PRESENT_MS)
    .sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}

export function PresenceChip({ access, now = Date.now() }: { access: ConsoleState['access']; now?: number }) {
  const navigate = useNavigate();
  if (!access || access.identities.length === 0) return null;
  const present = presentNow(access, now);
  const label = present.length
    ? `${present.length} phone${present.length === 1 ? '' : 's'} connected`
    : 'No phone connected now';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="presence-chip"
          aria-label={label}
          className="flex min-h-(--tap-min) shrink-0 items-center gap-1 rounded px-2 text-ink-muted hover:text-ink"
        >
          <Users size={17} aria-hidden />
          {present.length ? <span className="text-xs tabular-nums">{present.length}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="text-sm text-ink">{label}</p>
        <p className="mt-0.5 text-2xs text-ink-faint">
          {`Served ${access.served.local} request${access.served.local === 1 ? '' : 's'} on this machine and ${access.served.remote} remotely.`}
        </p>
        <ul className="mt-2 flex flex-col gap-1" aria-label="Phones seen">
          {[...access.identities]
            .sort((a, b) => Date.parse(b.last) - Date.parse(a.last))
            .slice(0, 5)
            .map((identity) => (
              <li
                key={`${identity.host}:${identity.loginHash}`}
                className="flex justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate text-ink-muted">
                  {identity.host} · <span className="font-mono">{identity.loginHash.slice(0, 8)}</span>
                </span>
                <span className="shrink-0 text-ink-faint">
                  {present.includes(identity) ? 'now' : new Date(identity.last).toLocaleString()}
                </span>
              </li>
            ))}
        </ul>
        <button
          type="button"
          className="mt-2 text-xs text-action underline"
          onClick={() => navigate(debugHref('access'))}
        >
          Open Debug ▸ Access
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** Both chips, as the header draws them. */
export default function ConsoleChips({ state }: { state: ConsoleState | undefined }) {
  return (
    <>
      <PresenceChip access={state?.access} />
      <RuntimeChip />
    </>
  );
}
