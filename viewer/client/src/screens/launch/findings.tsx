/**
 * What the console already knows that should change a person's mind before
 * Launch (7.0, quiet-console phase 13; control-tower phase 22's findings kept).
 *
 * Three ranks, always in this order: what HOLDS Launch until it is answered
 * (an open decision, the plan's git lines) — the summons, in the one amber;
 * what the run will MEET if it starts now (a failing probe, a silent delivery
 * channel, phases that will park at boarding); and what is merely worth
 * knowing (a tree another run holds, a boarding note). Each finding is one
 * line with its own way forward — a verb that opens the row of settings that
 * answers it — so nothing here is a sentence to read and then go and find.
 */

import { Hand } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { NOTE_ROWS } from '@shared/status-notes.js';
import { ISOLATED } from '@shared/worktree-model.js';
import { Button, NoteIcon } from '@/ui';
import type { Prelude, TreesDetail } from '@/data/api';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { PREFLIGHT_LABEL, willPark } from '@/lib/preflight';
import { useSetupForm } from './form-context';
import type { CategoryId } from './model/categories';
import { gitLinesOf, useDraftPrelude, useLaunchFacts } from './model/facts';
import type { RunSetupValues } from './model/schema';

export type FindingRank = 'blocking' | 'warning' | 'advice';

/** The ranks, worst first — the order every reader draws them in. */
export const FINDING_RANKS: readonly FindingRank[] = Object.freeze(['blocking', 'warning', 'advice']);

/** A rank's paint: the summons for what holds Launch; a caution and a note for the rest. */
const RANK_PAINT: Readonly<Record<FindingRank, UiState>> = Object.freeze({
  blocking: 'needs-you',
  warning: NOTE_ROWS.warn.paint,
  advice: NOTE_ROWS.info.paint,
});

export interface Finding {
  id: string;
  rank: FindingRank;
  /** What it is, in one sentence. */
  title: string;
  /** The detail the title stands on — the server's words. */
  body?: ReactNode;
  /** Its own way forward. */
  action?: ReactNode;
}

/**
 * Why Launch is held by what the door will judge, in the words its title and
 * the footer say — an open decision first, then the plan's git lines this
 * launch does not honour (#18: the start door would refuse it by name, and a
 * refusal after the press is the answer asked too late), then the prelude's
 * first read still in flight (it fills a fresh start's account list, and a
 * press before it landed was refused for having none — control-tower phase
 * 33). Undefined: nothing the prelude says holds it. `asks` is whether this
 * launch asks the prelude at all, `gitAsked` whether it shows the git answer,
 * `pending` whether the first read has not landed.
 */
export function launchHold(
  values: Pick<RunSetupValues, 'manifestOverride' | 'gitStrategyAck'>,
  prelude: Prelude | undefined,
  { asks, gitAsked, pending }: { asks: boolean; gitAsked: boolean; pending: boolean },
): string | undefined {
  if (!asks) return undefined;
  const decision = values.manifestOverride.trim() ? null : (prelude?.blocking[0] ?? null);
  if (decision) return `Decision outstanding: ${decision.key} — ${decision.why}`;
  if (gitAsked && gitLinesOf(prelude).length > 0 && !values.gitStrategyAck)
    return 'Answer the plan’s git lines first — honour or override, in Git.';
  if (pending) return 'Reading this plan’s decisions…';
  return undefined;
}

/** Every finding for this launch, worst first. */
export function useFindings(): Finding[] {
  const f = useSetupForm();
  const facts = useLaunchFacts();
  const { data: prelude } = useDraftPrelude();
  const out: Finding[] = [];
  const go = (label: string, id: CategoryId) => (
    <Button size="sm" variant="default" onClick={() => f.goCategory?.(id)}>
      {label}
    </Button>
  );

  // Holds Launch — until each is answered.
  const blocking = f.values.manifestOverride.trim() ? [] : (prelude?.blocking ?? []);
  if (blocking.length) {
    const first = blocking[0]!;
    out.push({
      id: 'decisions',
      rank: 'blocking',
      title:
        blocking.length === 1
          ? 'Launch waits for a decision.'
          : `Launch waits for ${blocking.length} decisions.`,
      body: (
        <>
          <code className="font-mono text-meta">{first.key}</code>: {first.why}
          {blocking.length > 1 ? ` And ${blocking.length - 1} more.` : ''}
        </>
      ),
      action: go('Answer', 'decisions'),
    });
  }
  const lines = f.on('gitStrategyAck') ? gitLinesOf(prelude) : [];
  if (lines.length && !f.values.gitStrategyAck) {
    out.push({
      id: 'git-lines',
      rank: 'blocking',
      title: 'Launch waits for the plan’s git lines.',
      body: `${plural(lines.length, 'git line')} of the plan ${lines.length === 1 ? 'is' : 'are'} not honoured by this launch. Honour or override.`,
      action: go('Choose', 'git'),
    });
  }

  // Meets — the run starts, and meets these.
  const probes = prelude?.probes;
  const failing: [keyof NonNullable<typeof probes>, string, CategoryId][] = [
    ['accounts', 'Accounts', 'accounts'],
    ['mcp', 'MCP servers', 'tools'],
    ['credentials', 'Credentials', 'decisions'],
  ];
  for (const [key, label, category] of failing) {
    const verdict = probes?.[key];
    if (verdict?.status !== 'fail') continue;
    out.push({
      id: `probe-${key}`,
      rank: 'warning',
      title: `${label}:`,
      body: verdict.reason,
      action: go('Open', category),
    });
  }
  if (probes?.delivery.status === 'fail' && !f.values.acknowledgedWaivers.includes('announce')) {
    out.push({
      id: 'delivery',
      rank: 'warning',
      title: 'Nobody will hear this run.',
      body: probes.delivery.reason,
      action: go('Acknowledge', 'decisions'),
    });
  }
  const warnings = facts.warnings ?? [];
  const parking = willPark(warnings);
  if (parking.length) {
    out.push({
      id: 'boarding-park',
      rank: 'warning',
      title: `${plural(parking.length, 'phase')} will park at boarding`,
      body: '— nothing runnable in its §Verification.',
      ...(f.on('onlyPhases') ? { action: go('Narrow the scope', 'scope') } : {}),
    });
  } else if (warnings.length) {
    out.push({
      id: 'boarding-notes',
      rank: 'advice',
      title: `${plural(warnings.length, 'phase')} with something to know before it boards:`,
      body: warnings[0]!.warnings[0]?.message ?? '',
    });
  }

  // Worth knowing — probe 6 (control-tower phase 40): another run holds a tree
  // this plan needs, and the console can give this run trees of its own.
  const trees = probes?.trees;
  const held = trees?.detail as TreesDetail | undefined;
  if (trees && held?.held?.length && !held.isolated) {
    const canIsolate = held.grantable !== false && f.on('isolation') && f.on('gitMode');
    out.push({
      id: 'trees',
      rank: 'advice',
      title: 'Another run holds a tree this plan needs.',
      body: trees.reason,
      ...(canIsolate
        ? {
            action: (
              <Button
                size="sm"
                variant="default"
                onClick={() => {
                  f.set('gitMode', 'new-branch');
                  f.set('isolation', ISOLATED);
                  f.goCategory?.('git');
                }}
              >
                Give this run its own checkout
              </Button>
            ),
          }
        : {}),
    });
  }
  return FINDING_RANKS.flatMap((rank) => out.filter((finding) => finding.rank === rank));
}

/** The findings, as one list — nothing at all when there are none. */
export function Findings() {
  const findings = useFindings();
  if (!findings.length) return null;
  return (
    <ul aria-label="Before you launch" data-testid="launch-findings" className="flex min-w-0 flex-col gap-2">
      {findings.map((finding) => (
        <FindingLine key={finding.id} finding={finding} />
      ))}
    </ul>
  );
}

function FindingLine({ finding }: { finding: Finding }) {
  const paint = RANK_PAINT[finding.rank];
  return (
    <li
      data-finding={finding.id}
      data-rank={finding.rank}
      className={cn(
        'flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5 border-s-2 border-state py-1 ps-3',
        `state-${paint}`,
      )}
    >
      <span className="mt-0.5 text-state">
        {finding.rank === 'blocking' ? (
          <Hand size={14} strokeWidth={2.25} role="img" aria-label="Holds Launch" className="shrink-0" />
        ) : (
          <NoteIcon severity={finding.rank === 'warning' ? 'warn' : 'info'} />
        )}
      </span>
      <p className="min-w-0 flex-1 basis-56 text-body text-ink">
        <strong className="font-semibold">{finding.title}</strong>
        {finding.body != null && finding.body !== '' && (
          <>
            {' '}
            <span className="break-words text-ink-muted">{finding.body}</span>
          </>
        )}
      </p>
      {finding.action != null && <div className="shrink-0">{finding.action}</div>}
    </li>
  );
}

/**
 * Every boarding-preflight finding, per phase — under the departure's fold; the
 * finding above says the count. A server that could not say shows nothing,
 * never a claim that the plan is clean.
 */
export function BoardingNotes() {
  const facts = useLaunchFacts();
  const warnings = facts.warnings;
  if (!warnings) return null;
  const parking = willPark(warnings);
  return (
    <section aria-label="Before it boards" className="flex min-w-0 flex-col gap-2">
      <h4 className="text-body font-semibold text-ink">Before it boards</h4>
      {warnings.length === 0 ? (
        <p className="text-meta text-ink-muted">The plan file raises nothing at boarding.</p>
      ) : (
        <>
          <p className="text-meta text-ink-muted">
            {parking.length
              ? `${plural(parking.length, 'phase')} will park at boarding — nothing runnable in its §Verification.`
              : `${plural(warnings.length, 'phase')} with something to know before it boards.`}
          </p>
          <ul className="flex min-w-0 flex-col gap-2">
            {warnings.map(({ phase, warnings: found }) => (
              <li key={phase} className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 text-body">
                <span className="text-meta text-ink-muted tabular-nums">P{phase}</span>
                <ul className="flex min-w-0 flex-col gap-1">
                  {found.map((warning, i) => (
                    <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-ink">{PREFLIGHT_LABEL[warning.kind]}</span>
                      {/* `break-words` is load-bearing: a `human-check` message
                          quotes the held-back command verbatim, and a
                          `bash -c '! grep -rnE …'` has no space in it for
                          eighty characters. */}
                      <span className="min-w-0 break-words text-ink-muted">{warning.message}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
