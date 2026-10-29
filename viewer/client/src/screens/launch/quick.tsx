/**
 * The quick launch — a departure notice (7.0, quiet-console phase 13).
 *
 * Control-tower phase 22 made a launch ONE screen; 7.0 writes that screen in
 * the page grammar. It reads top to bottom, and stops being read the moment a
 * person has what they need:
 *
 *   what runs (the departure line and its route) → the findings, worst first,
 *   each with its own action → the acts this run will need from you → a
 *   preset → the nine categories as one line each, each opening in place →
 *   what differs from a fresh console → the ONE ink Launch, in the frame
 *
 * Nothing it posts moved: the values, the seed and the payload are the form's
 * (`features/run-setup/run-setup.tsx` until phase 14, through the shim
 * `features/run-setup/quick.tsx`), and `launch-flow.test.tsx` holds the default
 * launch to the bytes every dialog before it posted. This file is arrangement.
 */

import { useEffect, useState } from 'react';
import { PRESET_BLURBS, PRESET_LABELS } from '@shared/launch-presets.js';
import { isOpenableUrl } from '@shared/human-step-model.js';
import { Button, ButtonGroup } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import { WHERE_LABEL } from '@/cards/human-step-words';
import { KindMark } from '@/cards/turn/step-parts';
import { useConsoleState } from '@/data/console';
import type { PreludeStep } from '@/data/api';
import { turnHref } from '@/shell/routes';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { Departure } from './departure';
import { showAtDoor } from './door-opens';
import { Findings } from './findings';
import { useSetupForm } from './form-context';
import { MoneyAndStops } from './money-and-stops';
import { CategorySection } from './sections';
import {
  CATEGORIES,
  categoryOf,
  dominantSource,
  fieldsIn,
  tileBadges,
  tileShown,
  type CategoryId,
} from './model/categories';
import { gitLinesOf, openDecisions, useDraftPrelude } from './model/facts';
import { resumeTarget } from './model/modes';
import { PROVENANCE_WORDS } from './model/seed';
import { notableRows, summaryRows, type SummaryRow } from './model/summary';
import { CategoryRow } from './tile';

export function QuickView() {
  const f = useSetupForm();
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="quick-view">
      <Departure />
      <Findings />
      <YourTurns />
      <PresetRow />
      <Categories />
      <WhatDiffers />
      {f.footerNote != null && <div className="text-meta text-ink-muted">{f.footerNote}</div>}
    </div>
  );
}

/** The controls a category opens onto — Money's with its sentence of where the run stops. */
function Panel({ id }: { id: CategoryId }) {
  return id === 'money' ? <MoneyAndStops /> : <CategorySection id={id} />;
}

function PresetRow() {
  const f = useSetupForm();
  const presets = f.presets ?? [];
  if (!presets.length) return null;
  const shown = f.preset ?? null;
  return (
    <section aria-label="Preset" className="flex min-w-0 flex-col gap-1.5">
      <ButtonGroup aria-label="Start from a preset" className="max-w-full flex-wrap self-start">
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
      <p className="max-w-(--measure) text-meta text-ink-muted">
        {shown ? PRESET_BLURBS[shown] : 'Your own mix — no preset matches every value below.'}
      </p>
    </section>
  );
}

/** The nine categories, one line each; one opens at a time, in place, under its line. */
function Categories() {
  const f = useSetupForm();
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
    <ul aria-label="Settings by category" className="flex min-w-0 flex-col gap-0.5">
      {CATEGORIES.filter((category) => tileShown(category.id, f.on)).map((category) => {
        const sources = fieldsIn(category.id)
          .filter(f.live)
          .map((field) => f.src(field));
        const summons =
          (category.id === 'decisions' && decisionsOpen > 0) ||
          (category.id === 'git' && gitLines > 0 && !f.values.gitStrategyAck);
        const isOpen = open === category.id;
        return (
          <CategoryRow
            key={category.id}
            category={category}
            words={tileBadges(category.id, input)}
            source={dominantSource(sources)}
            changed={sources.filter((source) => source === 'changed').length}
            summons={summons}
            open={isOpen}
            onToggle={() => f.goCategory?.(isOpen ? null : category.id)}
          >
            {isOpen ? <Panel id={category.id} /> : null}
          </CategoryRow>
        );
      })}
    </ul>
  );
}

/** How many values differ from what a fresh console ships with — each one press from its row. */
function WhatDiffers() {
  const f = useSetupForm();
  const names = { permission: f.permissionName, account: f.accountName };
  const rows = summaryRows(f.mode, f.values, f.seed, f.origins, names);
  const notable = notableRows(rows);
  const change = f.goCategory ? (row: SummaryRow) => f.goCategory?.(categoryOf(row.field)) : undefined;
  const differ = `${plural(notable.length, 'value')} ${notable.length === 1 ? 'differs' : 'differ'} from a fresh console`;
  const every = `Every value this launch sends (${rows.length})`;
  return (
    <section aria-label="What differs" className="flex min-w-0 flex-col gap-1.5 border-t border-rule pt-3">
      {notable.length === 0 ? (
        <p className="text-meta text-ink-muted">Every value is what a fresh console ships with.</p>
      ) : (
        <Disclosure label={differ} openLabel={differ}>
          <ValueList rows={notable} onChange={change} />
        </Disclosure>
      )}
      <Disclosure label={every} openLabel={every}>
        <ValueList rows={rows} onChange={change} />
      </Disclosure>
    </section>
  );
}

/** The label without its unit — "Budget per phase", beside "$5.00". */
const plain = (label: string) => label.replace(/ \(\$\)$/, '');

function ValueList({
  rows,
  onChange,
}: {
  rows: readonly SummaryRow[];
  onChange?: ((row: SummaryRow) => void) | undefined;
}) {
  return (
    <ul className="flex min-w-0 flex-col pt-1.5">
      {rows.map((row) => (
        <li
          key={row.field}
          className="flex min-w-0 flex-wrap items-baseline gap-x-3 py-1 sm:grid sm:grid-cols-[13rem_minmax(0,1fr)_auto_auto]"
        >
          <span className="min-w-0 text-meta text-ink-muted sm:text-body">{plain(row.label)}</span>
          <span className="min-w-0 flex-1 basis-40 break-words text-body text-ink">{row.value}</span>
          <span
            data-source={row.source}
            className={cn('text-meta', row.source === 'changed' ? 'text-ink' : 'text-ink-muted')}
          >
            {PROVENANCE_WORDS[row.source]}
          </span>
          {/* Only where the control is actually drawn: a row can be true and
              not editable here — `mcpPolicy` is posted whether or not a server
              is attached — and a way into a row with nothing to change is
              worse than none. */}
          {onChange && row.live && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Change ${plain(row.label)}`}
              onClick={() => onChange(row)}
            >
              Change
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * "This run will need you N times" (control-tower phase 42): the plan's own
 * human steps for the phases this run drives, each proof already run at the
 * door (phase 44), each drawn as the ITEM it becomes at launch (phase 139,
 * #216) — the kind's mark, where, what, and ONE way to do it. A step whose
 * proof holds is shown done. *Do it now* opens the item on Your turn when a
 * launch before this one already raised it; before that, its link in a new tab
 * or its command to copy — BEFORE anything spawns, rather than at three in the
 * morning. A plan step marked `auto-open: host` shows its link IN FULL and
 * opens on this machine when you launch — behind --allow-terminal or
 * --allow-agent, never a session's step (`door-opens.ts`). *Check again*
 * re-reads the door, which re-runs every proof.
 */
export function YourTurns() {
  const f = useSetupForm();
  const { data: prelude, refetch, isFetching } = useDraftPrelude();
  const { data: state } = useConsoleState();
  const steps = prelude?.humanSteps ?? [];
  // A resume asks nothing at the door (the server re-reads none of it), and a
  // launch of ONE phase asks only that phase's steps — so only those promise to open.
  const resuming = resumeTarget(f.mode, f.context.run ?? null) !== undefined;
  const canOpen = Boolean(state?.allowTerminal || state?.allowAgent) && !resuming;
  const launched = (step: PreludeStep) =>
    f.mode !== 'phase' || f.context.phase == null || step.phase === f.context.phase;
  const opens = canOpen
    ? steps
        .filter(launched)
        .map(autoOpenOf)
        .filter((url): url is string => Boolean(url))
    : [];
  const slug = f.context.slug ?? '';
  const shownKey = opens.join('\n');
  // Recorded while the door shows it; the launch form forgets it as it closes (`run-setup.tsx`).
  useEffect(() => {
    if (slug) showAtDoor(slug, shownKey ? shownKey.split('\n') : []);
  }, [slug, shownKey]);
  if (!steps.length) return null;
  const done = steps.filter((step) => step.state === 'pre-cleared').length;
  return (
    <section
      aria-label="Your turns in this run"
      data-testid="door-steps"
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-section font-semibold text-ink" data-testid="door-steps-title">
          This run will need you {plural(steps.length, 'time')}
          {done ? ` — ${done === steps.length ? 'every one' : done} already done` : ''}.
        </h3>
        {done < steps.length && (
          <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching ? 'Checking…' : 'Check again'}
          </Button>
        )}
      </div>
      <ul className="flex min-w-0 flex-col gap-2">
        {steps.map((step, index) => (
          <DoorStep
            key={`${step.phase}-${step.kind}-${index}`}
            step={step}
            canOpen={canOpen}
            opens={launched(step) && !resuming}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The link a step asks the machine to open at launch — an owed plan step, due
 * now, with an http(s) link, and not one a launch before this one already
 * raised (that item is asked once; Do it now opens it on Your turn).
 */
export function autoOpenOf(step: PreludeStep): string | undefined {
  if (step.autoOpen !== 'host' || step.state === 'pre-cleared' || step.due || step.item) return undefined;
  const url = step.open && 'url' in step.open ? step.open.url : undefined;
  return url && isOpenableUrl(url) ? url : undefined;
}

function DoorStep({ step, canOpen, opens }: { step: PreludeStep; canOpen: boolean; opens: boolean }) {
  const [opened, setOpened] = useState(0);
  const done = step.state === 'pre-cleared';
  const url = step.open && 'url' in step.open ? step.open.url : undefined;
  const command = step.open && 'command' in step.open ? step.open.command : undefined;
  const auto = opens ? autoOpenOf(step) : undefined;
  // An owed act is the one summons on the line; a done one has lost its hue.
  const paint = done ? undefined : 'needs-you';
  return (
    <li
      data-testid="door-step"
      data-state={step.state}
      {...(step.item ? { 'data-item': step.item } : {})}
      className={cn(
        'flex min-w-0 flex-col gap-1 border-s-2 py-1 ps-3',
        paint ? `state-${paint} border-state` : 'border-rule',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <KindMark kind={step.kind} />
        <span className="text-meta text-ink-muted">{WHERE_LABEL[step.where]}</span>
        <span className="min-w-40 flex-1 text-body text-ink">
          Phase {step.phase}: {step.what}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span data-testid="door-step-state" className="text-meta text-ink-muted">
          {done
            ? 'Done — its proof already holds.'
            : step.state === 'needed'
              ? `Needed${step.read ? ` — the proof read: ${step.read}` : '.'}`
              : 'Not checked — its proof could not be run here.'}
        </span>
        {!done && step.item ? (
          <Button size="sm" variant="default" asChild>
            <a href={turnHref(step.item)} data-testid="door-step-do" data-move="item">
              Do it now
            </a>
          </Button>
        ) : (
          <>
            {!done && url && (
              <Button
                size="sm"
                variant="default"
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
                <code className="min-w-0 truncate font-mono text-meta text-ink" title={command}>
                  {command}
                </code>
                <CopyButton text={command} label="Do it now — copy the command" />
              </>
            )}
          </>
        )}
      </div>
      {auto && (
        <p data-testid="door-step-auto" className="max-w-(--measure) text-meta text-ink">
          {canOpen ? (
            <>
              Opens on this machine when you launch: <code className="font-mono wrap-anywhere">{auto}</code>
            </>
          ) : (
            <>
              The plan asks to open <code className="font-mono wrap-anywhere">{auto}</code> on this machine at
              launch; this console was started without{' '}
              <code className="font-mono whitespace-nowrap">--allow-terminal</code> or{' '}
              <code className="font-mono whitespace-nowrap">--allow-agent</code>, so open it yourself.
            </>
          )}
        </p>
      )}
    </li>
  );
}
