/**
 * The auto reviewer — a second reader for a phase that just finished.
 *
 * A phase's own session is the worst possible judge of its diff: it wrote the
 * diff, it already believes the exit criteria are met (that is why it wrote a
 * handoff), and every blind spot it had while building is still in its context
 * while reviewing. The console's answer everywhere else in this system is the
 * same one — a FRESH session, told what to look at and nothing about how the
 * work went — and that is what this is: the QA subagent's discipline, applied
 * to the diff instead of to the tests, and available on plans whose QA gate is
 * off (which is the default, so on most plans this is the only second reader
 * there is).
 *
 * Three properties are deliberate.
 *
 * **It is off unless somebody turned it on.** `reviewEachPhase` defaults to
 * absent, which reads as false everywhere. A feature that spends money per
 * phase and can PARK the phases behind it must not arrive switched on in a
 * console someone upgraded without reading the changelog.
 *
 * **It is capped like every other extra session.** A quarter of the phase
 * budget and the closeout's turn cap — enough to read a diff and say what is
 * wrong, not enough to start doing the work itself. Its dollars land on the
 * phase's own `costUsd` and the run's `spentUsd` through the same three lines
 * the PR session and the closeout use, so it appears in the cost panels P16
 * built without those panels knowing this feature exists.
 *
 * **Its verdict is a REVIEW, with all the consequences that already has.** A
 * `requested-changes` from this session holds the phase's dependents exactly as
 * a person's does — same file, same rule, same banner. That is the feature, and
 * it is also the risk: an unattended run whose reviewer is strict enough will
 * stop itself. Hence `reviewerVerdicts`, the setting that restricts what the
 * session is ALLOWED to record, so an operator can have the reading without the
 * holding.
 */

import { REVIEW_VERDICTS, isReviewVerdict, type CommentSide, type PhaseDiff, type ReviewVerdict } from './review.ts';
import { REVIEWER_POLICIES } from '../shared/run-lifecycle.js';

/** What an auto reviewer may record, when the run has not narrowed it. */
export const REVIEWER_VERDICT_POLICIES = REVIEWER_POLICIES;
export type ReviewerVerdictPolicy = (typeof REVIEWER_VERDICT_POLICIES)[number];

export function isReviewerVerdictPolicy(value: unknown): value is ReviewerVerdictPolicy {
  return typeof value === 'string' && (REVIEWER_VERDICT_POLICIES as readonly string[]).includes(value);
}

/**
 * The default, and it is the cautious one.
 *
 * `comment-only` means the reviewer's findings are recorded and shown but
 * downgrade `requested-changes` to `commented`, so nothing is held and no
 * unattended run can stop itself on an opinion nobody has read yet. An operator
 * who wants the gate says so with `may-hold`.
 */
export const DEFAULT_REVIEWER_POLICY: ReviewerVerdictPolicy = 'comment-only';

/**
 * What the run's policy lets a verdict BE — one rule, now two readers.
 *
 * The session-based reviewer and the cloud `ultrareview` tier are different
 * machines producing the same kind of claim, and an operator who said "record
 * what you find but hold nothing" said it about both. Lifting the two-line rule
 * out of `parseReviewerReport` is what makes that true by construction rather
 * than by two people remembering: a second copy is where the downgrade quietly
 * stops applying to whichever reviewer was added last.
 */
export function applyVerdictPolicy(
  asked: ReviewVerdict, policy: ReviewerVerdictPolicy,
): { verdict: ReviewVerdict; askedFor?: ReviewVerdict } {
  const verdict: ReviewVerdict = policy === 'may-hold' || asked !== 'requested-changes'
    ? asked
    : 'commented';
  return { verdict, ...(verdict !== asked ? { askedFor: asked } : {}) };
}

/** How much of the diff the reviewer is shown. Beyond this it is told what was cut. */
export const MAX_REVIEW_DIFF_BYTES = 60 * 1024;
/** The reviewer's own comment cap — a finding list, not a line-by-line annotation. */
export const MAX_REVIEWER_COMMENTS = 25;

export type ReviewerFacts = {
  slug: string;
  phase: number;
  title?: string;
  /** The phase's exit criteria, verbatim from the plan. */
  exitCriteria?: string;
  /** The plan's §Verification commands for this phase, and whether they passed. */
  verification?: { commands: string[]; ok?: boolean; summary?: string };
  diff: PhaseDiff;
  policy: ReviewerVerdictPolicy;
};

/** A finding the reviewer session reported, before it becomes a stored comment. */
export type ReviewerFinding = {
  path: string;
  line?: number;
  side?: CommentSide;
  body: string;
};

export type ReviewerReport = {
  verdict: ReviewVerdict;
  note?: string;
  findings: ReviewerFinding[];
  /** The verdict the session actually asked for, when policy downgraded it. */
  askedFor?: ReviewVerdict;
};

/** `Review <slug> P<N>` — reads as a row on the board beside the phase itself. */
export function reviewerLabel(facts: { slug: string; phase: number }): string {
  return `Review ${facts.slug} P${facts.phase}`;
}

/**
 * Render the diff for the prompt.
 *
 * Truncation is announced rather than silent, and it is announced with the
 * file list intact: a reviewer told "12 files, here are the first 8" reviews 8
 * files and knows it; one handed a quietly-cut diff reviews 8 files and reports
 * on 12.
 */
export function renderDiff(diff: PhaseDiff, maxBytes = MAX_REVIEW_DIFF_BYTES): string {
  const head: string[] = [];
  head.push(`Window: ${diff.window.base ?? '(start of history)'}..${diff.window.tip ?? '(working tree)'}`
    + ` — ${diff.window.kind}.`);
  head.push(diff.window.note);
  if (diff.commits.length) {
    head.push('', 'Commits in the window:');
    for (const c of diff.commits.slice(0, 40)) head.push(`  ${c.sha.slice(0, 8)}  ${c.subject ?? ''}`);
  }
  head.push('', `${diff.files.length} file(s), +${diff.additions}/−${diff.deletions}:`);
  for (const f of diff.files) {
    head.push(`  ${f.status.padEnd(8)} ${f.path}  +${f.additions}/−${f.deletions}`
      + `${f.binary ? '  (binary)' : ''}${f.truncated ? '  (hunks cut)' : ''}`);
  }
  if (diff.failed) {
    head.push('', 'git could not produce a diff for this window at all. The file list above means '
      + 'nothing — say so rather than reviewing an empty diff.');
  }

  const body: string[] = [];
  let budget = maxBytes;
  let cut = 0;
  for (const f of diff.files) {
    if (!f.hunks.length) continue;
    const chunk: string[] = [`--- ${f.path} ---`];
    for (const h of f.hunks) {
      chunk.push(h.header);
      for (const l of h.lines) {
        const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'meta' ? '' : ' ';
        const num = l.kind === 'del' ? l.oldLine : l.newLine;
        chunk.push(`${String(num ?? '').padStart(6)} ${sign}${l.text}`);
      }
    }
    const text = chunk.join('\n');
    if (text.length > budget) { cut += 1; continue; }
    budget -= text.length;
    body.push(text);
  }
  if (cut) {
    body.push(`\n[${cut} file(s) had their hunks omitted here for length — they are named in the `
      + 'list above with their real counts. Review what you were shown and say that the rest was not shown.]');
  }
  return [...head, '', ...body].join('\n');
}

/**
 * What the reviewer session is told.
 *
 * The shape of the ask matters as much as the diff: a session asked "review
 * this" writes an essay, and an essay cannot be recorded as anything. It is
 * asked for a specific machine-readable block, told exactly which verdicts it
 * may use, and told the one thing a reviewer of generated code most needs to
 * hear — that "I would have written it differently" is not a finding.
 */
export function reviewerPrompt(facts: ReviewerFacts): string {
  const mayHold = facts.policy === 'may-hold';
  const verdicts = mayHold ? REVIEW_VERDICTS : REVIEW_VERDICTS.filter((v) => v !== 'requested-changes');
  const lines: string[] = [];

  lines.push(
    `You are reviewing phase ${facts.phase}${facts.title ? ` ("${facts.title}")` : ''} of the plan `
      + `"${facts.slug}". You did not write this code and you are not going to change it — you are `
      + 'the second reader, and your whole job is to say whether the diff below actually does what '
      + 'the phase was asked to do.',
    '',
    'Read the diff. Do not run the build, do not edit any file, do not commit anything, and do not '
      + 'start doing the work yourself. If you need to open a file for context you may read it.',
  );

  if (facts.exitCriteria) {
    lines.push('', '## What this phase was asked to deliver', '', facts.exitCriteria.trim());
  }
  if (facts.verification?.commands.length) {
    lines.push(
      '', '## Its verification',
      '', ...facts.verification.commands.map((c) => `  ${c}`),
      '',
      facts.verification.ok === undefined
        ? 'Whether these passed is not recorded here.'
        : facts.verification.ok
          ? `These ran and passed${facts.verification.summary ? ` — ${facts.verification.summary}` : ''}. `
            + 'A green suite is not the same as a correct diff; that gap is what you are for.'
          : `These did NOT pass${facts.verification.summary ? ` — ${facts.verification.summary}` : ''}.`,
    );
  }

  lines.push(
    '', '## The diff', '', renderDiff(facts.diff),
    '',
    '## What counts as a finding',
    '',
    'A finding is something that is WRONG or MISSING: a bug, an exit criterion the diff does not '
      + 'meet, a claim in a comment or doc the code does not support, an error path that cannot '
      + 'happen as written, a test that would pass with the implementation deleted, a security or '
      + 'data-loss hazard. Style you would have done differently is NOT a finding. Neither is '
      + 'work the phase was never asked to do — check the exit criteria above before calling '
      + 'something missing.',
    '',
    'If the diff is fine, say so. An approval that means it is far more useful than a list of '
      + 'nitpicks manufactured to look thorough.',
    '',
    '## How to answer',
    '',
    'End your final message with exactly one fenced block tagged `review`, and nothing after it:',
    '',
    '```review',
    '{',
    `  "verdict": ${verdicts.map((v) => `"${v}"`).join(' | ')},`,
    '  "note": "one paragraph: what you read, and the headline",',
    '  "findings": [',
    '    { "path": "<a path from the file list>", "line": <a line number from the diff>, '
      + '"side": "new" | "old", "body": "what is wrong here" }',
    '  ]',
    '}',
    '```',
    '',
    `Use \`"path"\` values copied from the file list — a path that is not in the diff cannot be `
      + 'anchored and will be dropped. `line` is the number shown in the left column of the diff '
      + 'above; omit it for a comment about the file as a whole. At most '
      + `${MAX_REVIEWER_COMMENTS} findings.`,
  );

  lines.push(
    '',
    mayHold
      ? 'This run allows a reviewer to hold: `requested-changes` will PARK every phase that depends '
        + 'on this one until somebody clears it. Use it for something that must be fixed before the '
        + 'work built on top of it, not for a nitpick — a held plan stops.'
      : 'This run does not allow a reviewer to hold work: your findings are recorded and shown, and '
        + '`requested-changes` is not available to you. Report what is wrong; a person decides '
        + 'whether it stops anything.',
  );

  return lines.join('\n');
}

/**
 * Pull the report out of what the session said.
 *
 * Deliberately forgiving about WHERE the block is and strict about what is in
 * it. A session that obeys the format puts one fenced `review` block at the
 * end; a session that half-obeys puts it in the middle, or tags it `json`, or
 * emits the bare object. All three are worth recovering — the alternative is
 * throwing away a review that was performed and paid for over a fence label.
 *
 * What it will NOT do is guess a verdict. No parseable block means no report,
 * which the caller records as "the reviewer produced nothing" — a fact — rather
 * than defaulting to `approved`, which would be a fabricated clean bill of
 * health, or to `requested-changes`, which would park the plan on a parser bug.
 */
export function parseReviewerReport(
  text: string, policy: ReviewerVerdictPolicy = DEFAULT_REVIEWER_POLICY,
  knownPaths?: readonly string[],
): ReviewerReport | null {
  const raw = extractJson(text);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!isReviewVerdict(obj.verdict)) return null;

  const asked = obj.verdict;
  // The policy is enforced HERE, on the way in, not in the prompt. A prompt is
  // a request; a run that said a reviewer may not hold work must not depend on
  // the reviewer having read that sentence.
  const { verdict, askedFor } = applyVerdictPolicy(asked, policy);

  const allowed = knownPaths?.length ? new Set(knownPaths) : null;
  const findings: ReviewerFinding[] = [];
  for (const item of Array.isArray(obj.findings) ? obj.findings : []) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const path = typeof f.path === 'string' ? f.path : '';
    const body = typeof f.body === 'string' ? f.body.trim() : '';
    if (!path || !body) continue;
    // A path the diff never mentioned cannot be anchored to anything a reader
    // can click, and a reviewer that invents paths is reporting on a file it
    // did not see. Dropped, and the drop is counted by the caller.
    if (allowed && !allowed.has(path)) continue;
    const line = typeof f.line === 'number' && Number.isInteger(f.line) && f.line > 0 ? f.line : undefined;
    const side: CommentSide | undefined = f.side === 'old' ? 'old' : f.side === 'new' ? 'new' : undefined;
    findings.push({
      path, body,
      ...(line != null ? { line } : {}),
      ...(side ? { side } : {}),
    });
    if (findings.length >= MAX_REVIEWER_COMMENTS) break;
  }

  return {
    verdict,
    ...(typeof obj.note === 'string' && obj.note.trim() ? { note: obj.note.trim().slice(0, 8_000) } : {}),
    findings,
    ...(askedFor ? { askedFor } : {}),
  };
}

/** The last fenced `review`/`json` block, else the last bare object with a `verdict`. */
function extractJson(text: string): string | null {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:review|json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const body = fenced[i][1].trim();
    if (body.startsWith('{') && body.includes('"verdict"')) return body;
  }
  const at = text.lastIndexOf('"verdict"');
  if (at < 0) return null;
  const start = text.lastIndexOf('{', at);
  if (start < 0) return null;
  // Brace-match forward: a body containing braces in a string is why this is
  // not a regex. Strings are tracked so a `}` inside one does not close it.
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (!depth) return text.slice(start, i + 1); }
  }
  return null;
}
