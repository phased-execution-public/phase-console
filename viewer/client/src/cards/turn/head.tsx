/**
 * The card's head (turn-by-turn phase 8; a STRIP's head since Tower strips,
 * 2026-10-20) — what a person reads before anything else, top to bottom:
 *
 *   1. ONE row: the type as a neutral plate (Approval · Task · Decision ·
 *      Heads-up, `TYPE_META` — a glyph and a word, never a colour); NOW, or
 *      NOT YET with its *when*, drawn only while the act is still the
 *      person's (`readinessShown`); the person's status as the card's ONE lead
 *      badge — the typed family's `turn` member on its state's tint, with the
 *      attempt a Redo sent back; the plan's errand ref as an outlined chip;
 *      Inspect at the end. The card's leading edge wears the same status's hue
 *      (`edgeOf`), so the strip and its badge never disagree;
 *   2. the title — the act, as the composer said it (sentence case, at most 80
 *      characters, #377) — the whole words beneath it when the title had to
 *      cut them, and a landing errand's files folded under *Details*, grouped
 *      by repository;
 *   3. the meta — the plan, the phase, the run, what it unblocks, the effort,
 *      when it was assigned and until when it stays open — each its own
 *      outlined chip and each a link where it can be one (never a dotted
 *      string).
 *
 * Why only the person fits it is said ONCE, where the act begins (`WhyLine`).
 */

import type { ReactNode } from 'react';
import { describeWord } from '@shared/status-model.js';
import { REASON_META, readinessShown, type PersonStatus } from '@shared/turn-model.js';
import { TypeMark } from './type-mark';
import type { Timing } from './timing';
import type { HumanStepRecord } from '@/data/human-steps';
import type { TurnItem } from '@/data/turn';
import { cn } from '@/lib/cn';
import { phaseHref, planHref, runHref } from '@/shell/routes';
import { Button } from '@/ui';
import { usePageNow } from '@/ui/clock';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import { TurnReadiness, TurnStatus } from '@/ui/status';
import { span, stamp } from './step-words';

/**
 * The card's strip edge: the hue of the person's status — the paint the lead
 * badge's own view carries (`shared/status-model.js`, vocabulary `turn`), so
 * the hue is chosen in one place and the strip only reads it.
 */
export function edgeOf(status: PersonStatus | undefined): string {
  const view = describeWord('turn', status ?? 'todo');
  return `state-${view.paint}`;
}

const link = 'tap-row text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink';

/** What it unblocks: the declared phases and every waiting session's, once each. */
export function unblocksOf(
  item: Pick<TurnItem, 'step'>,
  record?: Pick<HumanStepRecord, 'unblocks' | 'waiters'>,
): { slug: string; phase: number }[] {
  const seen = new Set<string>();
  const out: { slug: string; phase: number }[] = [];
  const all = [
    ...(record?.unblocks ?? item.step?.unblocks ?? []),
    ...(record?.waiters ?? item.step?.waiters ?? []),
  ];
  for (const { slug, phase } of all) {
    const key = `${slug}/${phase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug, phase });
  }
  return out;
}

function effortWords(minutes: number): string {
  if (minutes < 60) return `About ${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `About ${hours} h`;
}

/**
 * One fact of the meta, as a chip (Tower strips, 2026-10-20): a small outlined
 * box that wraps with its neighbours — its label muted, its value in ink, a
 * link where it can be one. Never coloured: the card's one hue is its edge and
 * its lead badge.
 */
function Fact({
  label,
  children,
  testId,
  quiet = false,
}: {
  /** What the fact is, said before it — or, `quiet`, heard and not shown, where the value names itself ("Phase 4"). */
  label: string;
  children: ReactNode;
  testId?: string;
  quiet?: boolean;
}) {
  return (
    <li
      data-testid={testId}
      className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-1 rounded-sm border border-rule px-1.5 py-px text-meta"
    >
      <span className={quiet ? 'sr-only' : 'text-ink-muted'}>{label}</span>
      <span className="min-w-0 break-words text-ink">{children}</span>
    </li>
  );
}

/** "2 h ago" on the page clock — a leaf, so a tick re-renders this figure and never the card. */
function AgoWords({ at }: { at: string }) {
  const now = usePageNow();
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return <>{at}</>;
  return <span className="tabular-nums">{now - ms < 60_000 ? 'just now' : `${span(now - ms)} ago`}</span>;
}

/**
 * The meta: where it belongs, what it unblocks, what it costs and its two
 * standing clocks — when it became the person's and, while it is open, until
 * when it stays open — each its own chip, each a link where it can be one
 * (never a dotted string). The deadline is the Timing fold's head
 * (`record.tsx`), said where the whole grid is one press away.
 */
export function Meta({
  item,
  record,
  timing,
  live = true,
}: {
  item: TurnItem;
  record: HumanStepRecord | undefined;
  /** The item's clocks (`timingOf`), when the card has them. */
  timing?: Timing | undefined;
  /** The act is still the person's: the window is drawn. */
  live?: boolean;
}) {
  const unblocks = unblocksOf(item, record);
  const effort = record?.effortMin ?? item.step?.effortMin;
  const runId = item.runId ?? record?.runId;
  // An item with no plan (a console's own ask) says the composer's meta, fact by fact.
  const loose = !item.slug && item.meta ? item.meta.split(' · ').filter(Boolean) : [];
  const assigned = timing?.assignedAt;
  const openUntil = live ? timing?.openUntil : undefined;
  if (!item.slug && !loose.length && !unblocks.length && effort == null && !assigned && !openUntil)
    return null;
  return (
    <ul data-testid="turn-meta" className="flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0">
      {item.slug && (
        <Fact label="Plan">
          <a className={link} href={planHref(item.slug)}>
            {item.slug}
          </a>
        </Fact>
      )}
      {item.slug && item.phase != null && (
        <Fact label="Phase" quiet={Boolean(item.phase)}>
          {item.phase ? (
            <a className={link} href={phaseHref(item.slug, item.phase)}>
              Phase {item.phase}
            </a>
          ) : (
            'The plan itself'
          )}
        </Fact>
      )}
      {item.slug && runId && (
        <Fact label="Run">
          <a className={cn(link, 'font-mono')} href={runHref(item.slug)} title={runId}>
            {runId.slice(0, 8)}
          </a>
        </Fact>
      )}
      {unblocks.length > 0 && (
        <Fact label="Unblocks" testId="turn-unblocks">
          {unblocks.map(({ slug, phase }, index) => (
            <span key={`${slug}/${phase}`}>
              {index > 0 && ', '}
              <a className={link} href={phaseHref(slug, phase)}>
                {slug === item.slug ? `phase ${phase}` : `${slug} phase ${phase}`}
              </a>
            </span>
          ))}
        </Fact>
      )}
      {effort != null && (
        <Fact label="Effort" testId="turn-effort">
          {effortWords(effort)}
        </Fact>
      )}
      {assigned && (
        <Fact label="Assigned" testId="turn-meta-assigned">
          <AgoWords at={assigned} />
        </Fact>
      )}
      {openUntil && (
        <Fact label="Open until" testId="turn-meta-open-until">
          <span className="tabular-nums">{stamp(openUntil)}</span>
        </Fact>
      )}
      {loose.map((part) => (
        <li
          key={part}
          className="inline-flex min-w-0 max-w-full rounded-sm border border-rule px-1.5 py-px text-meta break-words text-ink-muted"
        >
          {part}
        </li>
      ))}
    </ul>
  );
}

/** Why only the person fits it — once: the composer's need for a projected item, else the reason's sentence. */
export function WhyLine({
  item,
  why,
  inferred,
}: {
  item: TurnItem;
  why: TurnItem['why'];
  inferred: boolean;
}) {
  const said = item.record !== 'ledger' && item.need ? item.need : (REASON_META[why]?.sentence ?? why);
  if (!said) return null;
  return (
    <p data-testid="turn-why" className="max-w-(--measure) text-body text-ink">
      <span className="font-medium">Only you: </span>
      {said}
      {inferred && <span className="text-ink-muted"> (inferred from its kind)</span>}
    </p>
  );
}

/** "12 files in aws · 3 in web" — the server's `landingFilesWords`, said the same way. */
export function filesWords(files: NonNullable<TurnItem['files']>): string {
  return files
    .filter((group) => group.paths.length)
    .map(
      (group, i) =>
        `${group.paths.length}${i === 0 ? ` file${group.paths.length === 1 ? '' : 's'}` : ''} in ${group.repo}`,
    )
    .join(' · ');
}

/** A landing errand's files, folded under *Details*: each repository's paths, and one copy of them all. */
export function FilesDetails({ files }: { files: NonNullable<TurnItem['files']> }) {
  const groups = files.filter((group) => group.paths.length);
  if (!groups.length) return null;
  const all = groups.map((group) => [`# ${group.repo}`, ...group.paths].join('\n')).join('\n\n');
  return (
    <Disclosure
      label={`Details — ${filesWords(groups)}`}
      openLabel="Hide the details"
      testId="turn-files-toggle"
      bodyClassName="flex min-w-0 flex-col gap-3 pt-2"
    >
      <div data-testid="turn-files" className="flex min-w-0 flex-col gap-3">
        {groups.map((group) => (
          <section key={group.repo} className="flex min-w-0 flex-col gap-1">
            <h4 className="text-meta font-medium text-ink">
              {group.paths.length} {group.paths.length === 1 ? 'file' : 'files'} in {group.repo}
            </h4>
            <ul className="flex min-w-0 flex-col gap-0.5">
              {group.paths.map((path) => (
                <li key={path} className="font-mono text-meta break-all text-ink-muted">
                  {path}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <CopyButton
          text={all}
          label="Copy the file list"
          className="self-start"
          data-testid="turn-files-copy"
        />
      </div>
    </Disclosure>
  );
}

export function Head({
  item,
  titleId,
  title,
  when,
  attempt,
  facts,
  size = 'section',
  onInspect,
  children,
}: {
  item: TurnItem;
  titleId: string;
  title: string;
  /** NOT YET's *when*, in words. */
  when?: string | undefined;
  /** The attempt a check sent back, said beside a Redo. */
  attempt?: number | undefined;
  /** The meta's chips (`Meta`), under the title and its whole words. */
  facts?: ReactNode;
  /** `title` where the card is the panel's whole subject; `section` among other cards. */
  size?: 'section' | 'title';
  onInspect?: (() => void) | undefined;
  /** More of the head row's badges, outlined (a permission's risk). */
  children?: ReactNode;
}) {
  const status = item.personStatus ?? 'todo';
  return (
    <header className="flex min-w-0 flex-col gap-2">
      <div data-testid="turn-head-row" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <TypeMark type={item.type} plate />
        {readinessShown(status) && (
          <TurnReadiness
            chrome="badge"
            readiness={item.readiness ?? 'now'}
            when={item.readiness === 'not-yet' ? when : undefined}
          />
        )}
        <span data-testid="turn-state" className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
          <TurnStatus status={status} chrome="tint" />
          {status === 'redo' && attempt ? (
            <span
              data-testid="turn-state-attempt"
              title={`Attempt ${attempt} was sent back`}
              className="rounded-sm border border-rule px-1.5 py-px text-meta text-ink-muted tabular-nums"
            >
              Attempt {attempt}
            </span>
          ) : null}
        </span>
        {item.errandRef && (
          <span
            data-testid="turn-errand-ref"
            title={`The plan's errand ${item.errandRef}`}
            className="rounded-sm border border-rule px-1.5 py-px font-mono text-meta text-ink-muted"
          >
            {item.errandRef}
          </span>
        )}
        {children}
        {onInspect && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="turn-inspect"
            data-print="hide"
            className="ms-auto"
            onClick={onInspect}
          >
            Inspect
          </Button>
        )}
      </div>
      <h3
        id={titleId}
        data-testid="turn-title"
        className={cn(
          'max-w-(--measure) font-semibold text-ink',
          size === 'title' ? 'text-title' : 'text-section',
        )}
      >
        {title}
      </h3>
      {item.headline && item.headline !== title && (
        <p data-testid="turn-headline" className="max-w-(--measure) text-meta break-words text-ink-muted">
          {item.headline}
        </p>
      )}
      {item.files?.length ? <FilesDetails files={item.files} /> : null}
      {facts}
    </header>
  );
}
