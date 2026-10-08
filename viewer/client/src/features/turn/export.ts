/**
 * *Export* — one Markdown document of the open items, with their guides
 * (control-tower phase 137, #214, exit criterion 2).
 *
 * What the page shows, as text a person can keep, mail or print: the round
 * and its headline, then each open section in the page's order, and for each
 * item what it is, why only a person can do it, where it belongs, when it is
 * due, how it is checked — and its guide through the one grammar's own
 * renderer (`renderGuide`), its headings set under the item's. An item with no
 * guide carries its own lines and its command. Never a value: the turn holds
 * none, so the document cannot either.
 */

import { renderGuide } from '@shared/guide-grammar.js';
import { KIND_META } from '@shared/human-step-model.js';
import { REASON_META } from '@shared/turn-model.js';
import type { HumanStepRecord, TurnAnswer, TurnItem } from '@/lib/api';
import { guideOf } from './guide';
import type { Section } from './page-model';

/** The open sections — every one but *Done* and the handled log. */
export function openSections(sections: readonly Section[]): Section[] {
  return sections.filter((section) => section.id !== 'done' && section.id !== 'handled');
}

/** A fence long enough that the text inside it cannot close it. */
function fence(text: string, info = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}${info}\n${text}\n${marks}`;
}

function itemMarkdown(item: TurnItem, record: HumanStepRecord | undefined): string {
  const out: string[] = [`### ${record?.title ?? item.step?.title ?? item.title}`, ''];
  const why = record?.why ?? item.step?.why ?? item.why;
  const facts: string[] = [
    `- What: ${KIND_META[item.kind]?.label ?? item.kind}`,
    `- Only you: ${REASON_META[why]?.sentence ?? why}`,
  ];
  if (item.slug) facts.push(`- Plan: ${item.slug}${item.phase ? `, phase ${item.phase}` : ''}`);
  const due = record?.windowEnd ?? record?.until ?? item.step?.until ?? item.expiresAt;
  if (due) facts.push(`- Due: ${due}`);
  const effort = record?.effortMin ?? item.step?.effortMin;
  if (effort != null) facts.push(`- Effort: about ${effort} min`);
  const proof = record?.proofWords ?? item.step?.proofWords ?? record?.proof ?? item.step?.proof;
  if (proof) facts.push(`- How it is checked: ${proof}`);
  const verdict = record?.verdict;
  if (verdict && verdict.state !== 'passed') {
    facts.push(`- Back to you, attempt ${verdict.attempt}: ${verdict.note}`);
    for (const line of verdict.redo) facts.push(`  - Redo: ${line}`);
  }
  out.push(...facts, '');
  const guide = guideOf(record?.guide ?? item.step?.guide);
  if (guide) {
    out.push(renderGuide(guide).replace(/^## /gm, '#### ').trimEnd(), '');
  } else {
    const lines = record?.lines ?? item.humanStep?.lines ?? [];
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
  sections: readonly Section[],
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
