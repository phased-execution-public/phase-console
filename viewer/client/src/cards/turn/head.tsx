/**
 * The card's head (turn-by-turn phase 8) — what a person reads before anything
 * else, top to bottom:
 *
 *   1. NOW, or NOT YET with its *when* — drawn only while the act is still the
 *      person's (`readinessShown`); the type's mark (Approval · Task · Decision ·
 *      Heads-up, `TYPE_META`); the person's status as a dot and a word (the
 *      typed family's `turn` member); Inspect at the end;
 *   2. the title — the act, as the composer said it (sentence case, at most 80
 *      characters, #377) — with the plan's errand ref as a chip beside it, the
 *      whole words beneath it when the title had to cut them, and a landing
 *      errand's files folded under *Details*, grouped by repository;
 *   3. the meta — the plan, the phase, the run, what it unblocks, the effort —
 *      each its own fact and each a link where it can be one (never a dotted
 *      string);
 *   4. why only the person fits it, said ONCE.
 */

import type { ReactNode } from 'react';
import { REASON_META, readinessShown } from '@shared/turn-model.js';
import { TypeMark } from './type-mark';
import type { HumanStepRecord } from '@/data/human-steps';
import type { TurnItem } from '@/data/turn';
import { cn } from '@/lib/cn';
import { phaseHref, planHref, runHref } from '@/shell/routes';
import { Button } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import { TurnReadiness, TurnStatus } from '@/ui/status';

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

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid={testId}>
      <dt className="text-meta text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-meta break-words text-ink">{children}</dd>
    </div>
  );
}

/** The meta: where it belongs, what it unblocks and what it costs — each a fact, each a link where it can be. */
export function Meta({ item, record }: { item: TurnItem; record: HumanStepRecord | undefined }) {
  const unblocks = unblocksOf(item, record);
  const effort = record?.effortMin ?? item.step?.effortMin;
  const runId = item.runId ?? record?.runId;
  // An item with no plan (a console's own ask) says the composer's meta, fact by fact.
  const loose = !item.slug && item.meta ? item.meta.split(' · ').filter(Boolean) : [];
  if (!item.slug && !loose.length && !unblocks.length && effort == null) return null;
  return (
    <dl data-testid="turn-meta" className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">
      {item.slug && (
        <Fact label="Plan">
          <a className={link} href={planHref(item.slug)}>
            {item.slug}
          </a>
        </Fact>
      )}
      {item.slug && item.phase != null && (
        <Fact label="Phase">
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
      {loose.map((part) => (
        <dd key={part} className="text-meta text-ink-muted">
          {part}
        </dd>
      ))}
    </dl>
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
    <p data-testid="turn-why" className="max-w-prose text-body text-ink">
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
  onInspect,
  children,
}: {
  item: TurnItem;
  titleId: string;
  title: string;
  /** NOT YET's *when*, in words. */
  when?: string | undefined;
  onInspect?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const status = item.personStatus ?? 'todo';
  return (
    <header className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        {readinessShown(status) && (
          <TurnReadiness
            readiness={item.readiness ?? 'now'}
            when={item.readiness === 'not-yet' ? when : undefined}
          />
        )}
        <TypeMark type={item.type} />
        <span data-testid="turn-state">
          <TurnStatus status={status} />
        </span>
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
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id={titleId} data-testid="turn-title" className="max-w-prose text-section font-semibold text-ink">
          {title}
        </h3>
        {item.errandRef && (
          <span
            data-testid="turn-errand-ref"
            title={`The plan's errand ${item.errandRef}`}
            className="rounded-sm border border-rule px-1.5 font-mono text-meta text-ink-muted"
          >
            {item.errandRef}
          </span>
        )}
      </div>
      {item.headline && item.headline !== title && (
        <p data-testid="turn-headline" className="max-w-prose text-meta break-words text-ink-muted">
          {item.headline}
        </p>
      )}
      {item.files?.length ? <FilesDetails files={item.files} /> : null}
    </header>
  );
}
