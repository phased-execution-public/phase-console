/**
 * A plan item's words, composed at READ time from the CURRENT plan
 * (turn-by-turn phase 2, §Architecture 3 and 9). A ledger item born `plan`
 * holds what the launch door saw; this reads the bullet it came from again —
 * matched by its `## Operator errands` ref first ("(E-N…)", read off a 7.0
 * item's title too), then by its exact text — and answers its guide, options,
 * deadline, effort, what it unblocks and its reason as the plan says them NOW,
 * so a plan edit flows to the card without a ledger write, and an item the 7.0
 * door raised with none of them reads well after the upgrade.
 *
 * The guide comes from the first that exists: the bullet's `guide:` FILE (read
 * now, `readGuideFile`), the guide the ledger stored at the ask, then the
 * plan's `## Operator errands` row bound by the ref (`parse/errands.ts`) —
 * steps from its `! cmd` markers and its prose, never invented. Nothing is
 * written to `human-steps.ndjson`.
 *
 * Cached per plan revision (the store's `revision`, which every edit of the
 * plan moves) and per the guide files' mtimes, which live in the handoffs tree.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { humanStepsFor, type HumanStepDirective, type Plan } from '../parse/plan.ts';
import type { ErrandRow, ErrandsTable } from '../parse/errands.ts';
import { erefOf } from '../../shared/human-step-model.js';
import { parseGuide, GUIDE_MAX_STEPS, type Guide } from '../../shared/guide-grammar.js';
import type { WhyPerson } from '../../shared/turn-model.js';
import type { HumanStep, StepOption } from '../human-steps.ts';
import { readGuideFile } from './guide-file.ts';

/** Where a plan item's guide came from. */
export type PlanGuideFrom = 'plan-file' | 'ledger' | 'errands-table';

/** A plan item's words as the current plan says them. */
export type PlanItemWords = {
  /** The bullet it was matched to: by its ref, or by its exact text. */
  matched: 'eref' | 'title';
  /** The bullet's text now. */
  what: string;
  eref?: string;
  guide?: Guide;
  guideFrom?: PlanGuideFrom;
  /** Why the bullet's guide file was not read, in a sentence — the item still reads, from the next source. */
  guideRefused?: string;
  options?: StepOption[];
  deadline?: string;
  effortMin?: number;
  unblocks?: { slug: string; phase: number }[];
  why?: WhyPerson;
  /** The `## Operator errands` row the ref binds, and the section's "runs from". */
  errand?: ErrandRow & { runsFrom?: string };
  /** The bullet's `proof:` now — what a check reads when it changed since the item was raised (one-pool phase 13, #345). */
  proof?: string;
};

/**
 * The bullet a ledger item came from: the same phase and kind, then the same
 * ref — the ledger title's "(E-N…)" against the bullet's — else the same text.
 */
export function bulletOf(
  step: Pick<HumanStep, 'phase' | 'kind' | 'title'>, plan: Plan,
): { bullet: HumanStepDirective; matched: 'eref' | 'title' } | undefined {
  const mine = humanStepsFor(plan, step.phase).filter((bullet) => bullet.kind === step.kind);
  const eref = erefOf(step.title);
  const byRef = eref ? mine.find((bullet) => bullet.eref === eref) : undefined;
  if (byRef) return { bullet: byRef, matched: 'eref' };
  const title = step.title.trim();
  const byTitle = mine.find((bullet) => bullet.what === title);
  return byTitle ? { bullet: byTitle, matched: 'title' } : undefined;
}

/** One line of a guide: control characters folded, a newline never carried. */
function line(text: string): string {
  return text.replace(/[\u0000-\u001f]+/g, ' ').trim();
}

/**
 * A table row as a guide, through the one grammar — so its secret screen and
 * its hidden-character rule hold for a table's text as for a file's. A
 * `<placeholder>` command carries a warning to fill it in; the row's
 * "Expected" is the last step's Expect. Undefined when the row has no steps
 * or the grammar refuses it.
 */
export function rowGuide(row: ErrandRow, runsFrom?: string): Guide | undefined {
  if (!row.steps.length) return undefined;
  const summary = [line(row.what), runsFrom ? `Commands run from \`${line(runsFrom)}\`.` : ''].filter(Boolean).join(' ');
  const steps = row.steps.slice(0, GUIDE_MAX_STEPS);
  const body = steps.map((step, i) => {
    const out = [`${i + 1}. ${line(step.text)}`];
    if (step.command) out.push('   ```sh', `   ${line(step.command)}`, '   ```');
    if (step.template) out.push('   Warning: fill in the part in angle brackets before you run it.');
    if (i === steps.length - 1 && row.expected) out.push(`   Expect: ${line(row.expected)}`);
    return out.join('\n');
  });
  const read = parseGuide([summary || line(row.id), '', '## Steps', ...body].join('\n'));
  return read.ok ? read.guide : undefined;
}

/** A bullet's options as the ledger keeps them — the recommended one marked. */
function optionsOf(bullet: HumanStepDirective): StepOption[] | undefined {
  if (!bullet.options?.length) return undefined;
  return bullet.options.map((option) => ({
    ...option, ...(option.id === bullet.recommended ? { recommended: true as const } : {}),
  }));
}

/**
 * Compose one plan item's words from the plan. `docsRoot` is where a bullet's
 * guide file is read from; without one, the file is skipped.
 */
export function composePlanItem(
  step: Pick<HumanStep, 'slug' | 'phase' | 'kind' | 'title' | 'guide'>, plan: Plan, docsRoot?: string,
): PlanItemWords | undefined {
  const found = bulletOf(step, plan);
  if (!found) return undefined;
  const { bullet, matched } = found;
  const table: ErrandsTable | undefined = plan.errandsTable;
  const row = bullet.eref ? table?.rows.find((r) => r.id === bullet.eref) : undefined;
  let guide: Guide | undefined;
  let guideFrom: PlanGuideFrom | undefined;
  let guideRefused: string | undefined;
  if (bullet.guide && docsRoot) {
    const read = readGuideFile(docsRoot, bullet.guide);
    if (read.ok) { guide = read.guide; guideFrom = 'plan-file'; } else guideRefused = read.why;
  }
  if (!guide && step.guide) { guide = step.guide; guideFrom = 'ledger'; }
  if (!guide && row) {
    guide = rowGuide(row, table?.runsFrom);
    if (guide) guideFrom = 'errands-table';
  }
  const options = optionsOf(bullet);
  return {
    matched, what: bullet.what,
    ...(bullet.eref ? { eref: bullet.eref } : {}),
    ...(guide ? { guide, guideFrom } : {}),
    ...(guideRefused ? { guideRefused } : {}),
    ...(options ? { options } : {}),
    ...(bullet.deadline ? { deadline: bullet.deadline } : {}),
    ...(bullet.effortMinutes !== undefined ? { effortMin: bullet.effortMinutes } : {}),
    ...(bullet.unblocks?.length ? { unblocks: bullet.unblocks.map((phase) => ({ slug: step.slug, phase })) } : {}),
    ...(bullet.why ? { why: bullet.why } : {}),
    ...(bullet.proof ? { proof: bullet.proof } : {}),
    ...(row ? { errand: { ...row, ...(table?.runsFrom ? { runsFrom: table.runsFrom } : {}) } } : {}),
  };
}

/** A plan's `## Operator errands` row no bullet names — a heads-up, with its steps as a guide. */
export type HeadsUp = { slug: string; id: string; what: string; guide?: Guide };

/** What the composition reads a plan through: the store's parsed plan and its revision, and the docs root. */
export type PlanItemsDeps = {
  plan: (slug: string) => { plan: Plan; revision: number } | undefined;
  docsRoot: () => string | undefined;
};

/** The guide files a plan's bullets name, stamped by mtime — a guide edit moves the cache key though the plan did not. */
function guideStamp(plan: Plan, docsRoot: string | undefined): string {
  if (!docsRoot) return '';
  const files = new Set<string>();
  for (const bullet of [...(plan.operatorErrands ?? []), ...Object.values(plan.phases).flatMap((p) => p.humanSteps ?? [])]) {
    if (bullet.guide) files.add(bullet.guide);
  }
  return [...files].sort().map((file) => {
    try { return `${file}@${statSync(join(docsRoot, file)).mtimeMs}`; } catch { return `${file}@-`; }
  }).join(',');
}

/**
 * The read-time composer with its cache: one entry per plan, dropped when the
 * plan's revision or a guide file's mtime moves; inside it, one answer per
 * ledger item.
 */
export class PlanItems {
  private readonly cache = new Map<string, { key: string; items: Map<string, PlanItemWords | null> }>();

  private readonly deps: PlanItemsDeps;

  constructor(deps: PlanItemsDeps) {
    this.deps = deps;
  }

  /** A plan-born ledger item's words from its plan now, or undefined (another birth, no plan, no bullet). */
  wordsFor(step: HumanStep): PlanItemWords | undefined {
    if (step.birth !== 'plan') return undefined;
    const record = this.deps.plan(step.slug);
    if (!record) return undefined;
    const docsRoot = this.deps.docsRoot();
    const key = `${record.revision}|${guideStamp(record.plan, docsRoot)}`;
    let entry = this.cache.get(step.slug);
    if (!entry || entry.key !== key) {
      entry = { key, items: new Map() };
      this.cache.set(step.slug, entry);
    }
    const held = entry.items.get(step.id);
    if (held !== undefined) return held ?? undefined;
    const words = composePlanItem(step, record.plan, docsRoot) ?? null;
    entry.items.set(step.id, words);
    return words ?? undefined;
  }

  /** The `## Operator errands` rows no bullet names — heads-ups, which nothing checks or waits on. */
  unbound(slug: string): ErrandRow[] {
    return (this.deps.plan(slug)?.plan.errandsTable?.rows ?? []).filter((row) => !row.bound);
  }

  /**
   * The plan's heads-ups (turn-by-turn phase 4, §Architecture 6): each
   * unbound row with its steps as a guide, read from the plan as it is now.
   */
  headsUp(slug: string): HeadsUp[] {
    const table = this.deps.plan(slug)?.plan.errandsTable;
    return (table?.rows ?? []).filter((row) => !row.bound).map((row) => {
      const guide = rowGuide(row, table?.runsFrom);
      return { slug, id: row.id, what: row.what, ...(guide ? { guide } : {}) };
    });
  }
}
