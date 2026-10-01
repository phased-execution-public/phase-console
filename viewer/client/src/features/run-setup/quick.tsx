/**
 * The quick view — starting a run on one screen (control-tower phase 22).
 *
 * The operator asked for a start that is "straightforward, extra info hidden
 * unless wanted, properly iconed, badged and categorised". So a staged launch
 * no longer walks five stages: it is ONE screen, read top to bottom —
 *
 *   what runs → the findings that hold or warn → a preset → nine category
 *   tiles, each its state in badges → how many values differ → Launch
 *
 * — with every control one Edit away, expanded in place on a desk and pushed
 * as a sub-view on a phone (inside the same scroller, under the same fixed
 * footer). Nothing it posts changed: the values, the seed and the payload are
 * `RunSetup`'s, exactly as before; this file is arrangement.
 */

import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button, ButtonGroup, CopyButton, Disclosure, StatusStack, type StatusNote } from '@/components/ui';
import { KindMark, WHERE_LABEL } from '@/components/human-step-card';
import type { Prelude, PreludeStep, TreesDetail } from '@/lib/api';
import { usePhone } from '@/lib/media';
import { plural } from '@/lib/format';
import { willPark } from '@/lib/preflight';
import { PRESET_BLURBS, PRESET_LABELS } from '@shared/launch-presets.js';
import { ISOLATED } from '@shared/worktree-model.js';
import {
  CATEGORIES,
  categoryById,
  dominantSource,
  fieldsIn,
  tileBadges,
  tileShown,
  type CategoryId,
} from './categories';
import { CategoryTile } from './category-tile';
import { useDraftPrelude } from './decisions';
import { useLaunchFacts } from './facts';
import { useSetupForm } from './form-context';
import { gitLinesOf } from './git-reconcile';
import { MoneyAndStops } from './money-and-stops';
import { BoardingNotes, useDeparture, ValuesDiffer } from './review';
import { CategorySection } from './sections';
import { WhatRuns } from './what-runs';

/** How many blocking decisions still hold Launch — none once a person signed the override. */
export function openDecisions(prelude: Prelude | undefined, override: string): number {
  return override.trim() ? 0 : (prelude?.blocking.length ?? 0);
}

export function QuickView() {
  const f = useSetupForm();
  const phone = usePhone();
  const open = f.openCategory ?? null;
  // A phone pushes the tile's controls as a sub-view: the list steps aside,
  // and Back brings it back — one scroller, one footer, the same Launch.
  if (phone && open) return <SubView id={open} />;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="quick-view">
      <Departure />
      <Findings />
      <YourTurns />
      <PresetRow />
      <Tiles />
      <ValuesDiffer />
      {f.footerNote != null && <p className="text-2xs text-ink-muted">{f.footerNote}</p>}
    </div>
  );
}

/** The controls a tile opens onto — the Money tile's with its sentence of where the run stops. */
function Panel({ id }: { id: CategoryId }) {
  return id === 'money' ? <MoneyAndStops /> : <CategorySection id={id} />;
}

function SubView({ id }: { id: CategoryId }) {
  const f = useSetupForm();
  const category = categoryById(id);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="tile-subview" data-category={id}>
      <Button variant="ghost" size="sm" className="self-start" onClick={() => f.goCategory?.(null)}>
        <ChevronLeft size={15} aria-hidden /> All settings
      </Button>
      <section aria-label={category.label} className="flex min-w-0 flex-col gap-4">
        <h3 className="font-display text-lg leading-tight text-ink">{category.label}</h3>
        <p className="max-w-prose text-xs text-ink-muted">{category.blurb}</p>
        <Panel id={id} />
      </section>
    </div>
  );
}

/** What runs: the departure line, with the plan, its phases and what will hold one fold away. */
function Departure() {
  const f = useSetupForm();
  const { line, facts } = useDeparture();
  const narrow = f.mode === 'phase' || f.mode === 'live' || facts.scoped;
  return (
    <section aria-label="What runs" className="flex min-w-0 flex-col gap-1.5">
      <p className="font-display text-xl leading-snug text-ink">{line}</p>
      {!narrow && facts.ready.length > 0 && (
        <p className="text-xs text-ink-muted">
          Then whatever those unblock, until the plan ends or a stop condition hits.
        </p>
      )}
      <Disclosure label="The plan, its phases and what will hold">
        <div className="mt-3 flex flex-col gap-5">
          <WhatRuns />
          <BoardingNotes />
        </div>
      </Disclosure>
    </section>
  );
}

function PresetRow() {
  const f = useSetupForm();
  const presets = f.presets ?? [];
  if (!presets.length) return null;
  const shown = f.preset ?? null;
  return (
    <section aria-label="Preset" className="flex min-w-0 flex-col gap-1.5">
      <ButtonGroup aria-label="Start from a preset" className="w-full [&>button]:flex-1">
        {presets.map((id) => (
          <Button
            key={id}
            size="sm"
            variant="ghost"
            aria-pressed={shown === id}
            title={PRESET_BLURBS[id]}
            onClick={() => f.choosePreset?.(id)}
          >
            {PRESET_LABELS[id]}
          </Button>
        ))}
      </ButtonGroup>
      <p className="text-2xs text-ink-muted">
        {shown ? PRESET_BLURBS[shown] : 'Your own mix — no preset matches every value below.'}
      </p>
    </section>
  );
}

function Tiles() {
  const f = useSetupForm();
  const phone = usePhone();
  const { data: prelude } = useDraftPrelude();
  const decisionsOpen = openDecisions(prelude, f.values.manifestOverride);
  const gitLines = f.on('gitStrategyAck') ? gitLinesOf(prelude).length : 0;
  const input = {
    values: f.values,
    on: f.on,
    permission: f.permissionName,
    account: f.accountName,
    ...(f.ladderCaps ? { ladderCaps: f.ladderCaps } : {}),
    ...(f.mode === 'phase' && f.context.phase != null ? { phase: f.context.phase } : {}),
    gitLines,
    decisionsOpen,
  };
  const open = f.openCategory ?? null;
  return (
    <ul
      aria-label="Settings by category"
      className={
        phone
          ? 'flex min-w-0 flex-col'
          : 'grid min-w-0 grid-flow-row-dense grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'
      }
    >
      {CATEGORIES.filter((category) => tileShown(category.id, f.on)).map((category) => {
        const sources = fieldsIn(category.id)
          .filter(f.live)
          .map((field) => f.src(field));
        const summons =
          (category.id === 'decisions' && decisionsOpen > 0) ||
          (category.id === 'git' && gitLines > 0 && !f.values.gitStrategyAck);
        const isOpen = open === category.id;
        return (
          <CategoryTile
            key={category.id}
            category={category}
            badges={tileBadges(category.id, input)}
            source={dominantSource(sources)}
            changed={sources.filter((source) => source === 'changed').length}
            summons={summons}
            open={isOpen}
            phone={phone}
            onToggle={() => f.goCategory?.(isOpen ? null : category.id)}
          >
            {isOpen && !phone ? <Panel id={category.id} /> : null}
          </CategoryTile>
        );
      })}
    </ul>
  );
}

/**
 * "This run will need you N times" (control-tower phase 42): the plan's own
 * human steps for the phases this run drives, each proof already run at the
 * door (phase 44). A step whose proof holds is shown done; each of the rest
 * offers *Do it now* — its link opened in a new tab, its command copied for a
 * terminal of the person's own — BEFORE anything spawns, rather than at three
 * in the morning. *Check again* re-reads the door, which re-runs every proof.
 */
export function YourTurns() {
  const { data: prelude, refetch, isFetching } = useDraftPrelude();
  const steps = prelude?.humanSteps ?? [];
  if (!steps.length) return null;
  const done = steps.filter((step) => step.state === 'pre-cleared').length;
  return (
    <section
      aria-label="Your turns in this run"
      data-testid="door-steps"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-needs-you/45 bg-surface px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-ink" data-testid="door-steps-title">
          This run will need you {plural(steps.length, 'time')}
          {done ? ` — ${done === steps.length ? 'every one' : done} already done` : ''}.
        </p>
        {done < steps.length && (
          <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching ? 'Checking…' : 'Check again'}
          </Button>
        )}
      </div>
      <ul className="flex min-w-0 flex-col gap-2">
        {steps.map((step, index) => (
          <DoorStep key={`${step.phase}-${step.kind}-${index}`} step={step} />
        ))}
      </ul>
    </section>
  );
}

function DoorStep({ step }: { step: PreludeStep }) {
  const [opened, setOpened] = useState(0);
  const done = step.state === 'pre-cleared';
  const url = step.open && 'url' in step.open ? step.open.url : undefined;
  const command = step.open && 'command' in step.open ? step.open.command : undefined;
  return (
    <li data-testid="door-step" data-state={step.state} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <KindMark kind={step.kind} />
        <span className="text-2xs text-ink-muted">{WHERE_LABEL[step.where]}</span>
        <span className="min-w-40 flex-1 text-2xs text-ink">
          Phase {step.phase}: {step.what}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span data-testid="door-step-state" className="text-2xs text-ink-muted">
          {done
            ? 'Done — its proof already holds.'
            : step.state === 'needed'
              ? `Needed${step.read ? ` — the proof read: ${step.read}` : '.'}`
              : 'Not checked — its proof could not be run here.'}
        </span>
        {!done && url && (
          <Button
            size="sm"
            variant="action"
            data-testid="door-step-do"
            onClick={() => {
              window.open(url, '_blank', 'noopener,noreferrer');
              setOpened((n) => n + 1);
            }}
          >
            {opened ? 'Open again' : 'Do it now'}
          </Button>
        )}
        {!done && command && (
          <>
            <code className="min-w-0 truncate font-mono text-2xs text-ink" title={command}>
              {command}
            </code>
            <CopyButton text={command} label="Do it now — copy the command" size="sm" />
          </>
        )}
      </div>
    </li>
  );
}

/**
 * What the console already knows that should change a person's mind before
 * Launch — each a banner with its own action, the ones that HOLD Launch first,
 * then the warnings, then the advice.
 */
function Findings() {
  const notes = useFindings();
  if (!notes.length) return null;
  return <StatusStack notes={notes} order="given" max={notes.length} />;
}

type Ranked = StatusNote & { rank: 0 | 1 | 2 };

export function useFindings(): StatusNote[] {
  const f = useSetupForm();
  const facts = useLaunchFacts();
  const { data: prelude } = useDraftPrelude();
  const out: Ranked[] = [];
  const go = (label: string, id: CategoryId) => (
    <Button size="sm" variant="ghost" onClick={() => f.goCategory?.(id)}>
      {label}
    </Button>
  );

  // Blocking — Launch is held until each is answered.
  const blocking = f.values.manifestOverride.trim() ? [] : (prelude?.blocking ?? []);
  if (blocking.length) {
    const first = blocking[0]!;
    out.push({
      id: 'decisions',
      rank: 0,
      severity: 'warn',
      title:
        blocking.length === 1
          ? 'Launch waits for a decision.'
          : `Launch waits for ${blocking.length} decisions.`,
      body: (
        <>
          <code>{first.key}</code> — {first.why}
          {blocking.length > 1 ? ` (and ${blocking.length - 1} more)` : ''}
        </>
      ),
      action: go('Answer', 'decisions'),
    });
  }
  const lines = f.on('gitStrategyAck') ? gitLinesOf(prelude) : [];
  if (lines.length && !f.values.gitStrategyAck) {
    out.push({
      id: 'git-lines',
      rank: 0,
      severity: 'warn',
      title: 'Launch waits for the plan’s git lines.',
      body: `${plural(lines.length, 'git line')} of the plan ${lines.length === 1 ? 'is' : 'are'} not honoured by this launch — honour or override.`,
      action: go('Choose', 'git'),
    });
  }

  // Warnings — the run starts, and meets these.
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
      rank: 1,
      severity: 'warn',
      title: `${label}:`,
      body: verdict.reason,
      action: go('Open', category),
    });
  }
  if (probes?.delivery.status === 'fail' && !f.values.acknowledgedWaivers.includes('announce')) {
    out.push({
      id: 'delivery',
      rank: 1,
      severity: 'warn',
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
      rank: 1,
      severity: 'warn',
      title: `${plural(parking.length, 'phase')} will park at boarding`,
      body: '— nothing runnable in its §Verification.',
      ...(f.on('onlyPhases') ? { action: go('Narrow the scope', 'scope') } : {}),
    });
  } else if (warnings.length) {
    out.push({
      id: 'boarding-notes',
      rank: 2,
      severity: 'info',
      title: `${plural(warnings.length, 'phase')} with something to know before it boards:`,
      body: warnings[0]!.warnings[0]?.message ?? '',
    });
  }

  // Advice — probe 6 (control-tower phase 40): another run holds a tree this
  // plan needs, and the console can give this run trees of its own.
  const trees = probes?.trees;
  const held = trees?.detail as TreesDetail | undefined;
  if (trees && held?.held?.length && !held.isolated) {
    const canIsolate = held.grantable !== false && f.on('isolation') && f.on('gitMode');
    out.push({
      id: 'trees',
      rank: 2,
      severity: 'info',
      title: 'Another run holds a tree this plan needs.',
      body: trees.reason,
      ...(canIsolate
        ? {
            action: (
              <Button
                size="sm"
                variant="ghost"
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
  return out.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...note }) => note);
}
