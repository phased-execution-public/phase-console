/**
 * Ready to start — the group that is plans, not runs (7.0, quiet-console
 * phase 7; the Tower's bay since control-tower phase 20).
 *
 * Every ready phase of every open plan — `toDepartures`, the set Now's Next up
 * drew — ranked by the order the operator picked (`prefs.readyRank`), with the
 * same reasons (`reasons`, blockers first). Its one action is **Start**, which
 * opens the launch dialog through its lazy door (`screens/launch/door`): the
 * run-setup form is fetched when it is opened, never when the
 * group is drawn. A phase another session holds is not offered a Start — the
 * dialog would refuse it against the claim anyway — and a console without
 * `--allow-run` offers the phase's page instead, the move no flag guards.
 */

import { useMemo, useState } from 'react';
import { phaseHref } from '@shared/routes.js';
import { Button, ButtonGroup } from '@/ui';
import { isClaimed, rank, reasons, RANKS, type Departure, type RankId, type RunLike } from '@/data/lanes';
import { useRun } from '@/data/runs';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { plainText } from '@/lib/plain-text';
import { usePrefs } from '@/lib/prefs';
import { LaunchDoor } from '@/screens/launch/door';
import { latestRunOf } from './model';

/** How many rows show before the rest fold behind one press. */
const SHOWN = 6;

export interface ReadyProps {
  /** `toDepartures(plans, details)`, unranked. */
  departures: readonly Departure[];
  /** The runs on record, for the launch request's `run`: the newest of the plan. */
  runs: readonly RunLike[];
  allowRun: boolean;
  /** Plan details are still being read — titles and sizes upgrade in place. */
  loading?: boolean;
}

export function Ready({ departures, runs, allowRun, loading = false }: ReadyProps) {
  const [prefs, setPrefs] = usePrefs();
  const rankId = (prefs.readyRank ?? 'momentum') as RankId;
  const ranked = useMemo(() => rank(departures, rankId), [departures, rankId]);
  const [every, setEvery] = useState(false);
  const [launching, setLaunching] = useState<Departure | null>(null);
  const shown = every ? ranked : ranked.slice(0, SHOWN);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="ready-bay" aria-busy={loading || undefined}>
      <ul className="flex min-w-0 flex-col divide-y divide-rule">
        {shown.map((d) => (
          <ReadyRow key={d.key} d={d} allowRun={allowRun} onStart={() => setLaunching(d)} />
        ))}
      </ul>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        {ranked.length > SHOWN && (
          <Button size="sm" variant="ghost" onClick={() => setEvery(!every)}>
            {every ? `Show the first ${SHOWN}` : `Show all ${plural(ranked.length, 'ready phase')}`}
          </Button>
        )}
        {/* Pressable words rather than a select: they wrap on a phone, and each
            carries the sentence that makes the choice mean something. */}
        {ranked.length > 1 && (
          <ButtonGroup
            aria-label="Order the ready phases by"
            className="max-w-full shrink flex-wrap sm:ms-auto"
          >
            {RANKS.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant="ghost"
                aria-pressed={rankId === option.id}
                title={option.blurb}
                onClick={() => setPrefs({ readyRank: option.id })}
              >
                {option.label}
              </Button>
            ))}
          </ButtonGroup>
        )}
      </div>
      {launching && <Launch departure={launching} runs={runs} onClose={() => setLaunching(null)} />}
    </div>
  );
}

/**
 * The launch is an opening: the dialog wants the plan's newest WHOLE record,
 * which the slim list does not carry — so Start reads it, once, for this plan.
 */
function Launch({
  departure,
  runs,
  onClose,
}: {
  departure: Departure;
  runs: readonly RunLike[];
  onClose: () => void;
}) {
  const latest = latestRunOf(runs, departure.slug);
  const { data: detail, isPending } = useRun(departure.slug, latest != null);
  if (latest && isPending) return null;
  const run = detail?.run ?? null;
  return (
    <LaunchDoor
      request={{
        kind: 'phase',
        slug: departure.slug,
        phase: departure.phase,
        run: run && run.id === latest?.id ? run : (detail?.history.find((r) => r.id === latest?.id) ?? run),
        ...(departure.lock ? { lock: departure.lock } : {}),
        ...(departure.skills.length ? { planSkills: departure.skills } : {}),
        ...(departure.mcpServers.length ? { planMcp: departure.mcpServers } : {}),
      }}
      onClose={onClose}
    />
  );
}

function ReadyRow({ d, allowRun, onStart }: { d: Departure; allowRun: boolean; onStart: () => void }) {
  const claimed = isClaimed(d.lock);
  const why = reasons(d).slice(0, 2);
  const title = d.title ? plainText(d.title) : `Phase ${d.phase}`;
  return (
    <li
      data-testid="ready-row"
      data-slug={d.slug}
      data-phase={d.phase}
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2"
    >
      <a
        href={phaseHref(d.slug, d.phase)}
        className="flex min-w-(--strip-name-floor) flex-1 items-baseline gap-2.5 hover:underline"
        title={`Open ${d.slug} phase ${d.phase}`}
      >
        <span aria-hidden className="w-8 shrink-0 text-body text-ink-muted tnum">
          P{d.phase}
        </span>
        <span className="min-w-0">
          <span className={cn('block truncate text-body', claimed ? 'text-ink-muted' : 'text-ink')}>
            {title}
          </span>
          <span className="block truncate text-meta text-ink-faint">{d.slug}</span>
        </span>
      </a>
      {why.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-ink-muted">
          {why.map((r) => (
            <span key={r.key} data-reason={r.key} className={cn(r.tone === 'bad' && 'text-failed')}>
              {r.text}
            </span>
          ))}
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center">
        {allowRun && !claimed ? (
          <Button
            size="sm"
            data-testid="ready-start"
            title={`Start ${d.slug} phase ${d.phase} — the launch dialog asks how`}
            onClick={onStart}
          >
            Start
          </Button>
        ) : (
          <Button size="sm" variant="ghost" asChild>
            <a href={phaseHref(d.slug, d.phase)} data-testid="ready-open">
              Open phase
            </a>
          </Button>
        )}
      </span>
    </li>
  );
}
