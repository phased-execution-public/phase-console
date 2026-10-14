/**
 * *Export* — one Markdown document of the open items, with their guides
 * (control-tower phase 137, #214, exit criterion 2; 7.0's page since
 * quiet-console phase 8).
 *
 * What the page shows, as text a person can keep, mail or print: the round
 * and its headline, then each open section in the page's order, and for each
 * item what it is, why only a person can do it, where it belongs, when it is
 * due, how it is checked — and its guide through the one grammar's own
 * renderer (`renderGuide`), its headings set under the item's. An item with no
 * guide carries its own lines and its command. Never a value: the turn holds
 * none, so the document cannot either.
 *
 * Since turn-by-turn phase 9 an item also carries what the card draws: its
 * type, status and readiness, *Goes to*, the timing grid's clocks (assigned,
 * starts, deadline, open until), an approval's block — what, who asked, what a
 * yes and a no each do — and a decision's options, the recommended one named.
 */

import { renderGuide } from '@shared/guide-grammar.js';
import { KIND_META } from '@shared/human-step-model.js';
import {
  PERSON_STATUS_LABEL,
  READINESS_LABEL,
  ROUTE_META,
  TYPE_META,
  whyPersonWords,
} from '@shared/turn-model.js';
import { guideOf } from '@/cards/guide';
import type { HumanStepRecord } from '@/data/human-steps';
import type { TurnAnswer, TurnItem } from '@/data/turn';
import { openSections, type TurnSection } from './page-model';

/** A fence long enough that the text inside it cannot close it. */
function fence(text: string, info = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}${info}\n${text}\n${marks}`;
}

function itemMarkdown(item: TurnItem, record: HumanStepRecord | undefined): string {
  const out: string[] = [`### ${record?.title ?? item.step?.title ?? item.title}`, ''];
  const why = record?.why ?? item.step?.why ?? item.why;
  const facts: string[] = [];
  if (item.type) facts.push(`- Type: ${TYPE_META[item.type]?.label ?? item.type}`);
  if (item.personStatus) {
    const ready = item.readiness
      ? `, ${READINESS_LABEL[item.readiness]?.toUpperCase() ?? item.readiness}`
      : '';
    facts.push(`- Status: ${PERSON_STATUS_LABEL[item.personStatus] ?? item.personStatus}${ready}`);
  }
  facts.push(
    `- What: ${KIND_META[item.kind]?.label ?? item.kind}`,
    `- Only you: ${whyPersonWords(why).replace(/\.$/, '')}`,
  );
  if (item.slug) facts.push(`- Plan: ${item.slug}${item.phase ? `, phase ${item.phase}` : ''}`);
  // The timing grid's clocks, as the card draws them — the window is never called a deadline.
  const timing = item.timing;
  if (timing?.assignedAt) facts.push(`- Assigned: ${timing.assignedAt}`);
  if (timing?.startAt || timing?.startWhen) facts.push(`- Starts: ${timing.startAt ?? timing.startWhen}`);
  if (timing?.deadline) facts.push(`- Deadline: ${timing.deadline}`);
  const due = timing?.openUntil ?? record?.windowEnd ?? record?.until ?? item.step?.until ?? item.expiresAt;
  if (due) facts.push(`- Open until: ${due}`);
  const effort = record?.effortMin ?? item.step?.effortMin;
  if (effort != null) facts.push(`- Effort: about ${effort} min`);
  const proof =
    item.check || record?.proofWords || item.step?.proofWords || record?.proof || item.step?.proof;
  if (proof) facts.push(`- How it is checked: ${proof}`);
  if (item.route) facts.push(`- Goes to: ${ROUTE_META[item.route]?.label ?? item.route}`);
  const verdict = record?.verdict;
  if (verdict && verdict.state !== 'passed') {
    facts.push(`- Back to you, attempt ${verdict.attempt}: ${verdict.note}`);
    for (const line of verdict.redo) facts.push(`  - Redo: ${line}`);
  }
  out.push(...facts, '');
  // An approval's block: what a yes is about, who asked, and what each answer does.
  const approval = item.approval;
  if (approval) {
    out.push(
      '#### The approval',
      '',
      `- What: ${approval.what}`,
      `- Asked by: ${approval.askedBy}`,
      `- If approved: ${approval.ifApproved}`,
      `- If denied: ${approval.ifDenied}`,
    );
    if (approval.scopes?.length) out.push(`- Scopes: ${approval.scopes.join(', ')}`);
    out.push('');
  }
  // A decision's options, the recommended one named — never chosen for the person.
  const options = item.options?.length ? item.options : (record?.options ?? item.step?.options ?? []);
  if (options.length) {
    out.push('#### The options', '');
    for (const option of options) {
      const mark = option.recommended ? ' (recommended)' : '';
      out.push(`- ${option.label}${mark}${option.consequence ? `: ${option.consequence}` : ''}`);
    }
    out.push('');
  }
  const guide = guideOf(record?.guide ?? item.step?.guide);
  if (guide) {
    out.push(renderGuide(guide).replace(/^## /gm, '#### ').trimEnd(), '');
  } else {
    // The composer's steps when no guide was authored, else the record's own lines.
    const composed = (item.steps ?? []).map((step) => step.text).filter(Boolean);
    const lines = composed.length ? composed : (record?.lines ?? item.humanStep?.lines ?? []);
    lines.forEach((line, index) => out.push(`${index + 1}. ${line}`));
    if (lines.length) out.push('');
    const command = record?.openCommand ?? item.humanStep?.openCommand;
    if (command) out.push(fence(command, 'sh'), '');
    if (!lines.length && !command && item.need) out.push(item.need, '');
  }
  return out.join('\n');
}

/**
 * The document. `sections` are the page's, filtered as the page is — what a
 * person narrowed the page to is what they export.
 */
export function turnMarkdown(
  answer: Pick<TurnAnswer, 'round' | 'headline'>,
  sections: readonly TurnSection[],
  records: ReadonlyMap<string, HumanStepRecord>,
): string {
  const out: string[] = [
    '# Your turn',
    '',
    `Read ${answer.round.at}, round ${answer.round.n}.`,
    '',
    answer.headline,
    '',
  ];
  for (const section of openSections(sections)) {
    if (!section.items.length) continue;
    out.push(`## ${section.label}`, '');
    for (const item of section.items) out.push(itemMarkdown(item, records.get(item.item)));
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** Hand the document to the browser as a download — nothing leaves the machine. */
export function downloadMarkdown(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
