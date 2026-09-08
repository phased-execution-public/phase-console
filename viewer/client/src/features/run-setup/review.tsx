/**
 * Stage 4 — Review, and the desktop ticket.
 *
 * The same facts twice, at two lengths. `LaunchReview` is the stage: the
 * departure line, every choice that is not the shipped default with where it
 * came from and a way back to its stage, every boarding-preflight finding,
 * what will hold, the ceilings and the stops. `LaunchTicket` is the pane a
 * desk keeps beside the other stages — the departure line, the notable
 * choices, and one line each for warnings and money — so the summary is in
 * sight while a value is being changed, which is the whole reason the desk
 * has two panes.
 *
 * Nothing here is computed twice: both read `summary.ts` and `facts.ts`, and
 * the payload reads the same values, so the review cannot describe a
 * different run from the one that launches.
 */

import { TriangleAlert } from 'lucide-react';
import { Banner, Chip, CopyButton, Disclosure, SectionHeading } from '@/components/ui';
import { cn } from '@/lib/cn';
import { countdown, plural } from '@/lib/format';
import { PREFLIGHT_LABEL, PREFLIGHT_TONE, willPark } from '@/lib/preflight';
import { useConsoleState } from '@/lib/queries';
import { composeStartCommand } from '@/features/settings/start-command';
import { gateWho, liveClaim, useLaunchFacts } from './facts';
import { Provenance } from './fields';
import { useSetupForm } from './form-context';
import { StopsGlance } from './money-and-stops';
import { ceilings, departureLine, notableRows, stopsWhen, summaryRows, type SummaryRow } from './summary';

/** The label without its unit — "Budget per phase", beside "$5.00". */
const plain = (label: string) => label.replace(/ \(\$\)$/, '');

function useReview() {
  const f = useSetupForm();
  const facts = useLaunchFacts();
  const names = { permission: f.permissionName, account: f.accountName };
  const rows = summaryRows(f.mode, f.values, f.seed, f.origins, names);
  const notable = notableRows(rows);
  const line = departureLine(
    f.mode,
    f.values,
    f.context,
    {
      slug: facts.slug,
      ready: facts.ready.map((p) => p.phase),
      scoped: facts.scoped,
      resumeRunId: facts.resumeRunId,
    },
    names,
  );
  const cost = ceilings(f.values, facts.willRun.length || undefined);
  const stops = stopsWhen(f.values);
  return { f, facts, rows, notable, line, cost, stops };
}

export function LaunchReview() {
  const { f, facts, rows, notable, line, cost, stops } = useReview();
  const warnings = facts.warnings;
  const parking = warnings ? willPark(warnings) : [];
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <SectionHeading as="h3" tone="muted">
          Departure
        </SectionHeading>
        <p className="font-display text-xl leading-snug text-ink">{line}</p>
        {!facts.scoped && f.mode !== 'phase' && f.mode !== 'live' && facts.ready.length > 0 && (
          <p className="text-xs text-ink-muted">
            Then whatever those unblock, until the plan ends or a stop condition hits.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading as="h3" tone="muted">
          Every choice that is not the default
        </SectionHeading>
        {notable.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing — every value is what a fresh console ships with.</p>
        ) : (
          <RowList rows={notable} onChange={f.goStage} />
        )}
        <Disclosure label={`Every value this launch sends (${rows.length})`}>
          <RowList rows={rows} onChange={f.goStage} className="mt-2" />
        </Disclosure>
      </section>

      {warnings && (
        <section className="flex flex-col gap-2">
          <SectionHeading as="h3" tone="muted">
            Before it boards
          </SectionHeading>
          {warnings.length === 0 ? (
            <p className="text-sm text-ink-muted">The plan file raises nothing at boarding.</p>
          ) : (
            <>
              <p className="text-2xs text-ink-muted">
                {parking.length
                  ? `${plural(parking.length, 'phase')} will park at boarding — nothing runnable in its §Verification.`
                  : `${plural(warnings.length, 'phase')} with something to know before it boards.`}
              </p>
              <ul className="flex flex-col gap-2">
                {warnings.map(({ phase, warnings: found }) => (
                  <li key={phase} className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 text-sm">
                    <span className="shrink-0 font-mono text-2xs text-ink-muted">P{phase}</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {found.map((warning, i) => (
                        <div key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                          <Chip tone={PREFLIGHT_TONE[warning.kind]}>{PREFLIGHT_LABEL[warning.kind]}</Chip>
                          {/* `break-words` is load-bearing: a `human-check`
                              message quotes the held-back command verbatim,
                              and a `bash -c '! grep -rnE …'` has no space in
                              it for eighty characters. */}
                          <span className="min-w-0 break-words text-ink-muted">{warning.message}</span>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {(facts.gated.length > 0 || facts.claimed.length > 0) && (
        <section className="flex flex-col gap-2">
          <SectionHeading as="h3" tone="muted">
            Will hold
          </SectionHeading>
          <ul className="flex flex-col gap-1 text-sm text-ink-muted">
            {facts.gated.map((p) => (
              <li key={`g${p.phase}`} className="min-w-0 break-words">
                <span className="font-mono text-2xs text-ink-muted">P{p.phase}</span> gate — {gateWho(p)}
              </li>
            ))}
            {facts.claimed.map((p) => {
              const claim = liveClaim(p)!;
              return (
                <li key={`c${p.phase}`} className="min-w-0 break-words">
                  <span className="font-mono text-2xs text-ink-muted">P{p.phase}</span> claimed by{' '}
                  <span className="font-mono">{claim.owner}</span>
                  {claim.leaseUntil ? `, ${countdown(claim.leaseUntil)}` : ''} — the run queues behind it
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SectionHeading as="h3" tone="muted">
          Money
        </SectionHeading>
        <ul className="flex flex-col gap-0.5 text-sm text-ink-muted">
          {cost.lines.map((text) => (
            <li key={text}>{text}</li>
          ))}
          {facts.detail?.summary.remainingWeight ? (
            <li className="text-2xs text-ink-muted">
              The plan's own sizes put what is left at ≈{' '}
              {plural(facts.detail.summary.remainingSessions, 'session')} of work — a size, not a price.
            </li>
          ) : null}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading as="h3" tone="muted">
          Where it stops
        </SectionHeading>
        <StopsGlance stops={stops.stops} carriesOn={stops.carriesOn} />
      </section>

      {f.footerNote != null && <p className="text-2xs text-ink-muted">{f.footerNote}</p>}
    </div>
  );
}

/** The desk's pane — the same review, cut to what fits beside a stage. */
export function LaunchTicket() {
  const { f, facts, notable, line, cost } = useReview();
  const shown = notable.slice(0, 8);
  const more = notable.length - shown.length;
  const warnings = facts.warnings;
  const parking = warnings ? willPark(warnings) : [];
  const holds = facts.gated.length + facts.claimed.length;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-1.5">
        <SectionHeading as="h3" tone="muted">
          Departure
        </SectionHeading>
        <p className="font-display text-lg leading-snug text-ink">{line}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <SectionHeading as="h3" tone="muted">
          Not the default
        </SectionHeading>
        {shown.length === 0 ? (
          <p className="text-xs text-ink-muted">Nothing — every value is what a fresh console ships with.</p>
        ) : (
          <RowList rows={shown} onChange={f.goStage} compact />
        )}
        {more > 0 && f.goStage && (
          <button
            type="button"
            className="self-start text-2xs text-ink-muted underline underline-offset-2 hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
            onClick={() => f.goStage?.('review')}
          >
            {more} more on the review
          </button>
        )}
      </div>
      <dl className="flex flex-col gap-1 text-xs text-ink-muted">
        {warnings && (
          <div className="flex items-baseline gap-2">
            <dt className="sr-only">Before it boards</dt>
            <dd className={cn('m-0 flex items-baseline gap-1', parking.length && 'text-failed')}>
              {warnings.length ? (
                <>
                  <TriangleAlert size={11} className="inline shrink-0 align-[-1px]" aria-hidden />
                  {parking.length
                    ? `${plural(parking.length, 'phase')} will park at boarding`
                    : `${plural(warnings.length, 'phase')} with a boarding note`}
                </>
              ) : (
                'Nothing raised at boarding'
              )}
            </dd>
          </div>
        )}
        {holds > 0 && (
          <div>
            <dt className="sr-only">Will hold</dt>
            <dd className="m-0">
              {plural(holds, 'hold')}: {facts.gated.length ? `${facts.gated.length} gated` : ''}
              {facts.gated.length && facts.claimed.length ? ', ' : ''}
              {facts.claimed.length ? `${facts.claimed.length} claimed` : ''}
            </dd>
          </div>
        )}
        <div>
          <dt className="sr-only">Money</dt>
          <dd className="m-0">{cost.lines[cost.lines.length - 1]}</dd>
        </div>
      </dl>
    </div>
  );
}

function RowList({
  rows,
  onChange,
  className,
  compact = false,
}: {
  rows: readonly SummaryRow[];
  onChange?: (stage: SummaryRow['stage']) => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <ul className={cn('flex flex-col divide-y divide-rule', className)}>
      {rows.map((row) => (
        <li key={row.field} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
          <span className={cn('min-w-0 text-ink-muted', compact ? 'text-xs' : 'text-sm')}>
            {plain(row.label)}
          </span>
          <span className={cn('min-w-0 flex-1 break-words text-ink', compact ? 'text-xs' : 'text-sm')}>
            {row.value}
          </span>
          <Provenance source={row.source} />
          {/* Only where the control is actually drawn. A row can be true and
              not editable here — `mcpPolicy` is posted whether or not any
              server is attached, and `reviewerPolicy` reaches the payload
              through the cloud reviewer too — and a link that lands on a stage
              with nothing to change is worse than no link. */}
          {onChange && row.live && (
            <button
              type="button"
              aria-label={`Change ${plain(row.label)}`}
              className="tap-cell text-2xs text-ink-muted underline underline-offset-2 hover:text-ink"
              onClick={() => onChange(row.stage)}
            >
              Change
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The honest state for a console that cannot start a run: it says so, and
 * offers the line that would. Every stage shows it, because a form that lets
 * somebody fill in three stages before telling them the button is off is a
 * form that wasted three stages.
 */
export function NoAllowRun() {
  const { data: state } = useConsoleState();
  const command = composeStartCommand(state ?? {});
  return (
    <Banner severity="warn">
      <strong>This console cannot start runs.</strong> It was started without{' '}
      <code className="font-mono">--allow-run</code>, so Launch is off here. Restart it with every capability
      on:
      <span className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-ground px-2 py-1 font-mono text-2xs">
          {command}
        </code>
        <CopyButton text={command} label="Copy the command" copiedLabel="Copied" />
      </span>
    </Banner>
  );
}
