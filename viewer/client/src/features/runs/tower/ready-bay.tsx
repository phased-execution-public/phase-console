/**
 * Ready to start — Now's Next-up set, in the Tower (control-tower phase 20,
 * exit criterion 3).
 *
 * The bay is PLANS, not runs: every ready phase of every open plan, which is
 * exactly `toDepartures` — the set Now's Next up draws — ranked by the same
 * order the operator picked there (`prefs.readyRank`), with the same reasons
 * (`reasons`, blockers first). Its one action is **Start**, and Start opens
 * the launch dialog through its LAZY door (`run-setup/lazy-launch-dialog`):
 * the run-setup form is 77.6 KB and is fetched when it is opened, never when
 * the bay is drawn.
 *
 * A phase another session holds is not offered a Start — the dialog would
 * refuse it against the claim anyway — and a console without `--allow-run`
 * offers the phase's page instead, the move no flag guards.
 *
 * The ORDER is the operator's (`prefs.readyRank`), and since 6.0 folded Now
 * into the Tower (control-tower phase 21) the chooser lives here, at the bay's
 * foot — Next up, which used to hold it, is gone, and an order nobody can
 * change is a decision somebody else made.
 */

import { useMemo, useState } from 'react';

import { phaseHref } from '@shared/routes.js';
import { Button, Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { pad2, plural } from '@/lib/format';
import { plainText } from '@/lib/plain-text';
import { usePrefs } from '@/lib/prefs';
import type { RunState } from '@/lib/api';
import { LaunchDialog } from '@/features/run-setup/lazy-launch-dialog';
import { RANKS, isClaimed, rank, reasons, type Departure, type RankId } from '@/features/runs/lanes-model';

/** How many rows show before the rest fold behind one press. */
const SHOWN = 6;

const TONE_CHIP = { good: 'ok', warn: 'accent', bad: 'bad' } as const;

export interface ReadyBayProps {
  /** Now's Next-up set — `toDepartures(plans, details)`, unranked. */
  departures: readonly Departure[];
  /** The runs on record, for the launch request's `run`: the newest of the plan. */
  runs: readonly RunState[];
  allowRun: boolean;
  /** Plan details are still being read — titles and sizes upgrade in place. */
  loading?: boolean;
}

/** The newest run of a plan, which a launch continues from — or none. */
export function latestRunOf(runs: readonly RunState[], slug: string): RunState | null {
  let best: RunState | null = null;
  for (const run of runs) {
    if (run.slug !== slug) continue;
    if (!best || Date.parse(run.createdAt ?? '') > Date.parse(best.createdAt ?? '')) best = run;
  }
  return best;
}

export function ReadyBay({ departures, runs, allowRun, loading = false }: ReadyBayProps) {
  const [prefs, setPrefs] = usePrefs();
  const rankId = (prefs.readyRank ?? 'momentum') as RankId;
  const ranked = useMemo(() => rank(departures, rankId), [departures, rankId]);
  const [every, setEvery] = useState(false);
  const [launching, setLaunching] = useState<Departure | null>(null);
  const shown = every ? ranked : ranked.slice(0, SHOWN);

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="ready-bay" aria-busy={loading || undefined}>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {shown.map((d, index) => (
          <ReadyRow
            key={d.key}
            d={d}
            first={index === 0}
            allowRun={allowRun}
            onStart={() => setLaunching(d)}
          />
        ))}
      </ul>
      {/* `gap-y-4`, not less: "Show all" is a `tap-line`, whose touch overlay
          overhangs its line by 12.5 px — on a phone, where the chooser wraps
          under it, a tighter row let that overlay win the chooser's taps. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-4">
        {ranked.length > SHOWN && (
          <button
            type="button"
            onClick={() => setEvery(!every)}
            className="tap-line text-2xs text-ink-muted hover:text-ink"
          >
            {every ? `Show the first ${SHOWN}` : `Show all ${plural(ranked.length, 'ready phase')}`}
          </button>
        )}
        {/* Pressable words rather than a `<select>`: they wrap on a phone, and
            each carries the sentence that makes the choice mean something. */}
        {ranked.length > 1 && (
          <div
            role="group"
            aria-label="Order the ready phases by"
            className="flex min-w-0 flex-wrap items-center gap-1 sm:ml-auto"
          >
            {RANKS.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant={rankId === option.id ? 'action' : 'ghost'}
                aria-pressed={rankId === option.id}
                title={option.blurb}
                onClick={() => setPrefs({ readyRank: option.id })}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {launching && (
        <LaunchDialog
          request={{
            kind: 'phase',
            slug: launching.slug,
            phase: launching.phase,
            run: latestRunOf(runs, launching.slug),
            ...(launching.lock ? { lock: launching.lock } : {}),
            ...(launching.skills.length ? { planSkills: launching.skills } : {}),
            ...(launching.mcpServers.length ? { planMcp: launching.mcpServers } : {}),
          }}
          onClose={() => setLaunching(null)}
        />
      )}
    </div>
  );
}

function ReadyRow({
  d,
  first,
  allowRun,
  onStart,
}: {
  d: Departure;
  first: boolean;
  allowRun: boolean;
  onStart: () => void;
}) {
  const claimed = isClaimed(d.lock);
  const why = reasons(d).slice(0, 2);
  const title = d.title ? plainText(d.title) : `Phase ${d.phase}`;
  return (
    <li
      data-testid="ready-row"
      data-slug={d.slug}
      data-phase={d.phase}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-rule border-l-4 bg-surface px-3 py-2',
        claimed ? 'border-l-rule' : 'border-l-rule-strong',
      )}
    >
      <a
        href={phaseHref(d.slug, d.phase)}
        className="flex min-w-(--strip-name-floor) flex-1 items-center gap-2.5 hover:underline"
        title={`Open ${d.slug} phase ${d.phase}`}
      >
        <span
          aria-hidden
          className="w-8 shrink-0 font-display text-xl leading-none tabular-nums text-ink-muted"
        >
          {pad2(d.phase)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm text-ink">{title}</span>
          <span className="block truncate font-mono text-2xs text-ink-faint">{d.slug}</span>
        </span>
      </a>
      {why.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {why.map((r) => (
            <Badge key={r.key} tone={TONE_CHIP[r.tone]}>
              {r.text}
            </Badge>
          ))}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center">
        {allowRun && !claimed ? (
          <Button
            size="sm"
            variant={first ? 'action' : 'default'}
            data-testid="ready-start"
            title={`Start ${d.slug} phase ${d.phase} — the launch dialog asks how`}
            onClick={onStart}
          >
            Start
          </Button>
        ) : (
          <Button size="sm" asChild>
            <a href={phaseHref(d.slug, d.phase)} data-testid="ready-open">
              Open phase
            </a>
          </Button>
        )}
      </span>
    </li>
  );
}
