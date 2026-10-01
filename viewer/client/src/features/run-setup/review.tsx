/**
 * The review, collapsed (control-tower phase 22).
 *
 * The launch used to end on a Review stage and keep a ticket beside the
 * others; the quick view says the same things where they are read. The
 * departure line opens the screen (`useDeparture`); every boarding-preflight
 * finding is a banner with its own action, and the per-phase list sits under
 * the plan's fold (`BoardingNotes`); the money and the stops are the Money
 * tile's; and what is left here is the one line that says how many values
 * differ from what a fresh console ships with — every one listed, with its
 * source and a way back to its tile, one press away.
 *
 * Nothing here is computed twice: everything reads `summary.ts` and
 * `facts.ts`, and the payload reads the same values, so the review cannot
 * describe a different run from the one that launches.
 */

import { Banner, Badge, CopyButton, Disclosure, SectionHeading } from '@/components/ui';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { PREFLIGHT_LABEL, PREFLIGHT_TONE, willPark } from '@/lib/preflight';
import { useConsoleState } from '@/lib/queries';
import { composeStartCommand } from '@/features/settings/start-command';
import { categoryOf } from './categories';
import { useLaunchFacts } from './facts';
import { Provenance } from './fields';
import { useSetupForm } from './form-context';
import { departureLine, notableRows, summaryRows, type SummaryRow } from './summary';

/** The label without its unit — "Budget per phase", beside "$5.00". */
const plain = (label: string) => label.replace(/ \(\$\)$/, '');

/** The departure line and the facts it was read from — the quick view's first words. */
export function useDeparture() {
  const f = useSetupForm();
  const facts = useLaunchFacts();
  const names = { permission: f.permissionName, account: f.accountName };
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
  return { line, facts };
}

/** How many values differ from the shipped defaults — and each of them, one press away. */
export function ValuesDiffer() {
  const f = useSetupForm();
  const names = { permission: f.permissionName, account: f.accountName };
  const rows = summaryRows(f.mode, f.values, f.seed, f.origins, names);
  const notable = notableRows(rows);
  const change = f.goCategory ? (row: SummaryRow) => f.goCategory?.(categoryOf(row.field)) : undefined;
  return (
    <section aria-label="What differs" className="flex min-w-0 flex-col gap-2 border-t border-rule pt-3">
      {notable.length === 0 ? (
        <p className="text-sm text-ink-muted">Every value is what a fresh console ships with.</p>
      ) : (
        <Disclosure
          label={`${plural(notable.length, 'value')} ${notable.length === 1 ? 'differs' : 'differ'} from a fresh console`}
        >
          <RowList rows={notable} onChange={change} className="mt-2" />
        </Disclosure>
      )}
      <Disclosure label={`Every value this launch sends (${rows.length})`}>
        <RowList rows={rows} onChange={change} className="mt-2" />
      </Disclosure>
    </section>
  );
}

/** Every boarding-preflight finding, per phase — under the plan's fold; the banner above says the count. */
export function BoardingNotes() {
  const facts = useLaunchFacts();
  const warnings = facts.warnings;
  if (!warnings) return null;
  const parking = willPark(warnings);
  return (
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
                      <Badge tone={PREFLIGHT_TONE[warning.kind]}>{PREFLIGHT_LABEL[warning.kind]}</Badge>
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
  );
}

function RowList({
  rows,
  onChange,
  className,
  compact = false,
}: {
  rows: readonly SummaryRow[];
  onChange?: ((row: SummaryRow) => void) | undefined;
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
              through the cloud reviewer too — and a link that opens a tile
              with nothing to change is worse than no link. */}
          {onChange && row.live && (
            <button
              type="button"
              aria-label={`Change ${plain(row.label)}`}
              className="tap-cell text-2xs text-ink-muted underline underline-offset-2 hover:text-ink"
              onClick={() => onChange(row)}
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
