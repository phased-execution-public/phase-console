/**
 * The fleet's vital signs, at the top of Runs: what is moving RIGHT NOW, with
 * its clock running — and what is waiting or queued, with the reason on it.
 *
 * Built from the same `nowLanes()` fold the Now page and the Sessions list
 * read — one vocabulary, one worst-first order, no fetch of its own. The
 * buckets are the status vocabulary's, not a prose list: `gated`, `parked` and
 * `awaiting-verification` are needs-a-person and are never laundered into
 * "waiting" (amber appears exactly on that bucket). Lanes that are live
 * (running · verifying) get the full row — heartbeat, ticking elapsed, spend,
 * model; everything else gets one honest line naming what it is behind.
 *
 * Renders nothing at all when no lane exists: the page subtitle already says
 * "Nothing running right now", and a second empty state would just be taller.
 */

import { planHref } from '@shared/routes.js';
import { StatusBadge, StatusDot, asUiState } from '@/components/ui';
import { LaneFactRow, laneFacts } from '@/components/lane-facts';
import { elapsed, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/clock';
import { UI_STATES, phaseStatusTitle, phaseUiState, type UiState } from '@/lib/status-vocab';
import type { NowLane } from '@/features/now/model';

/**
 * The strip's buckets, worst-first — DERIVED as the UI-state order minus the
 * settled, rather than written out again. The hand-written list said it was that
 * derivation in a comment; a comment is not a derivation, and a new UI state
 * would have been left out of the strip with nothing to say so.
 */
const SETTLED = ['skipped', 'done'] as const;
type Bucket = Exclude<UiState, (typeof SETTLED)[number]>;
const BUCKETS = UI_STATES.filter((s): s is Bucket => !(SETTLED as readonly string[]).includes(s));

const BUCKET_LABELS: Record<Bucket, string> = {
  'needs-you': 'need you',
  failed: 'failed',
  running: 'running',
  verifying: 'verifying',
  waiting: 'waiting',
  queued: 'queued',
};

export type StripBuckets = Record<Bucket, NowLane[]>;

/**
 * Every lane through the one status vocabulary. A word this build has never
 * heard of maps through `asUiState` (→ waiting), so a newer server's lane is
 * misfiled gently rather than dropped; `skipped`/`done` lanes do not occur in
 * `nowLanes` output, and land in `queued` if one ever does.
 */
export function stripBuckets(lanes: readonly NowLane[]): StripBuckets {
  const out: StripBuckets = {
    'needs-you': [],
    failed: [],
    running: [],
    verifying: [],
    waiting: [],
    queued: [],
  };
  for (const lane of lanes) {
    const ui: UiState = asUiState(phaseUiState(lane.status, lane.stop));
    const bucket: Bucket = (BUCKETS as readonly string[]).includes(ui) ? (ui as Bucket) : 'queued';
    out[bucket].push(lane);
  }
  return out;
}

/** One line's worth of why a lane is not moving, in the reason's own words. */
export function laneNote(lane: NowLane, now: number): string {
  const ui = asUiState(phaseUiState(lane.status, lane.stop));
  if (ui === 'queued') {
    return lane.lockWaitSince
      ? `queued behind a lock since ${relativeTime(Date.parse(lane.lockWaitSince))}`
      : 'queued';
  }
  if (ui === 'waiting') {
    if (!lane.parkedUntil) return lane.parkReason ?? 'waiting';
    const until = Date.parse(lane.parkedUntil);
    const when = until > now ? `parked ${elapsed(until - now)} more` : `due to wake ${relativeTime(until)}`;
    return lane.parkReason ? `${when} — ${lane.parkReason}` : when;
  }
  return lane.status;
}

export function LiveStrip({ lanes }: { lanes: readonly NowLane[] }) {
  // One clock for the whole strip, ticking only while something is actually
  // moving — a strip of parked lanes costs nothing per second.
  const anyLive = lanes.some(
    (lane) => !lane.frozen && (lane.status === 'running' || lane.status === 'verifying'),
  );
  const now = useNow(anyLive);
  if (!lanes.length) return null;

  const buckets = stripBuckets(lanes);
  const live = [...buckets.running, ...buckets.verifying];
  const rest = [...buckets['needs-you'], ...buckets.failed, ...buckets.waiting, ...buckets.queued];

  return (
    <section aria-label="Live sessions" data-testid="live-strip" className="flex flex-col gap-2">
      {/* The counts row: only what exists, worst-first, painted by the one
          vocabulary (StatusDot) — never a hand-picked hue. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        {BUCKETS.filter((bucket) => buckets[bucket].length > 0).map((bucket) => (
          <span key={bucket} className="flex items-center gap-1.5 text-2xs text-ink-muted">
            <StatusDot state={bucket} pulse={bucket === 'running'} />
            <span>{BUCKET_LABELS[bucket]}</span>
            <span className="font-mono tabular-nums text-ink">{buckets[bucket].length}</span>
          </span>
        ))}
      </div>

      {(live.length > 0 || rest.length > 0) && (
        <ul className="flex flex-col gap-1.5">
          {live.map((lane) => {
            const running = !lane.frozen;
            return (
              <li
                key={lane.key}
                data-testid="strip-lane"
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-rule bg-surface px-3 py-2"
              >
                {/* The same fold as every other surface. It happens to be safe
                    today — only `running` and `verifying` reach this strip, and
                    both are valid UI states — but that is a fact about the
                    filter above, not about this line, and it is exactly the
                    shape that made the Now row read "Waiting" over every ask. */}
                <StatusBadge
                  state={phaseUiState(lane.status, lane.stop)}
                  label={lane.status}
                  pulse={running}
                  title={phaseStatusTitle(lane.status, lane.stop)}
                />
                <a
                  href={planHref(lane.slug, 'run')}
                  className="min-w-0 truncate font-mono text-sm hover:underline"
                >
                  {lane.slug}
                </a>
                <span className="font-mono text-2xs text-ink-faint">P{lane.phase}</span>
                {lane.title && <span className="min-w-0 truncate text-2xs text-ink-muted">{lane.title}</span>}
                {/* The facts, in the ONE order — `components/lane-facts.tsx`.
                    This row picked and formatted its own until phase 18, as did
                    three other renderings of the same lane. */}
                <LaneFactRow facts={laneFacts(lane)} live={running} className="ml-auto" />
              </li>
            );
          })}
          {rest.map((lane) => (
            <li
              key={lane.key}
              data-testid="strip-wait"
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 text-2xs text-ink-muted"
            >
              <StatusDot state={asUiState(phaseUiState(lane.status, lane.stop))} />
              <a href={planHref(lane.slug, 'run')} className="font-mono hover:underline">
                {lane.slug}
              </a>
              <span className="font-mono text-ink-faint">P{lane.phase}</span>
              <span className="min-w-0 truncate">{laneNote(lane, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
