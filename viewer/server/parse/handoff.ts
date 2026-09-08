/**
 * Handoff parser — `docs/handoffs/<slug>/phase-NN-<title>.md`.
 *
 * The handoff is the baton a finishing phase hands to the next session, so the
 * console surfaces three things from it: the front-matter contract
 * (status/depends_on/blocks/skills/key_files), the body sections, and the
 * fenced boot prompts under `▶ Start next phase(s)` which are copied verbatim.
 */

import {
  parseFrontMatter, stripFrontMatter, fmString, fmList, fmPhaseList,
  type FrontMatter,
} from './frontmatter.ts';
import { sections, findSection, fences, type Section } from './markdown.ts';
import { HANDOFF_STATUSES, HANDOFF_STATUS_WORDS } from '../../shared/plan-vocab.js';

/**
 * ⚠️ FROZEN vocabulary (`CLAUDE.md`) — the four words a handoff may declare,
 * owned by `shared/plan-vocab.js`, plus `unknown` for a file whose `status:`
 * is none of them.
 */
export type HandoffStatus = (typeof HANDOFF_STATUS_WORDS)[number];

export type BootPrompt = {
  /** Phase the prompt starts, when it can be read out of the text. */
  phase?: number;
  gated: boolean;
  text: string;
};

export type Handoff = {
  slug: string;
  phase: number;
  file: string;
  path: string;
  title: string;
  status: HandoffStatus;
  rawStatus?: string;
  completed?: string;
  nextPhase?: string;
  dependsOn: number[];
  blocks: number[];
  parallelSafe: number[];
  skillsUsed: string[];
  keyFiles: string[];
  memoryKey?: string;
  frontMatter: FrontMatter;
  sections: Section[];
  whatItDid?: string;
  stateNow?: string;
  filesChanged?: string;
  decisions?: string;
  outstanding?: string;
  prompts: BootPrompt[];
  /** True for `## 🏁 Final phase — closeout` handoffs. */
  finalPhase: boolean;
  body: string;
  bytes: number;
  mtime: number;
};

const KNOWN: readonly string[] = HANDOFF_STATUSES;

export function normaliseStatus(raw?: string): HandoffStatus {
  const v = (raw ?? '').trim().toLowerCase();
  return (KNOWN as string[]).includes(v) ? (v as HandoffStatus) : 'unknown';
}

/** `phase-07-cart-api-endpoint.md` → `{ phase: 7, title: 'cart-api-endpoint' }` */
export function parseHandoffFilename(file: string): { phase?: number; title: string } {
  const m = /^phase-(\d+)-(.+)\.md$/.exec(file);
  if (!m) return { title: file.replace(/\.md$/, '') };
  return { phase: Number.parseInt(m[1], 10), title: m[2] };
}

/**
 * A frontmatter `phase:` reduced to the number it starts with, else the
 * filename's, else 0.
 *
 * `parseFrontMatter` is deliberately tolerant — it strips a ` # comment` suffix
 * and quotes and leaves everything else — so the value reaching here is
 * whatever the author typed. Reading the LEADING digits keeps the shapes that
 * do carry a phase (`1-5`, `3 (rework)`, `07`), and anything with no digits at
 * all defers to the filename, which is the key the engine uses.
 */
function phaseNumber(fromFrontMatter: string | undefined, fromName?: number): number {
  const digits = /^\s*(\d+)/.exec(fromFrontMatter ?? '')?.[1];
  const parsed = digits === undefined ? Number.NaN : Number.parseInt(digits, 10);
  if (Number.isFinite(parsed)) return parsed;
  return Number.isFinite(fromName) ? (fromName as number) : 0;
}

function extractPrompts(section?: Section): BootPrompt[] {
  if (!section) return [];
  return fences(section.body).map((f) => {
    const phase = /start Phase (\d+)/i.exec(f.code)?.[1];
    return {
      phase: phase ? Number(phase) : undefined,
      gated: /GATED phase/i.test(f.code),
      text: f.code.trim(),
    };
  }).filter((p) => p.text.length > 0);
}

export function parseHandoff(
  text: string,
  slug: string,
  file: string,
  path: string,
  stat: { size: number; mtimeMs: number },
): Handoff {
  const frontMatter = parseFrontMatter(text);
  const body = stripFrontMatter(text, frontMatter);
  const secs = sections(body);
  const fromName = parseHandoffFilename(file);

  const rawStatus = fmString(frontMatter, 'status');
  const startNext = secs.find((s) => /start next phase/i.test(s.title));
  const closeout = secs.find((s) => /final phase|closeout/i.test(s.title));

  return {
    slug,
    // The FILENAME is the fallback, and NaN is not a phase number.
    //
    // `Number()` over the tolerant frontmatter reader turned any non-numeric
    // `phase:` into NaN — `phase: 1-5` (the collapsed-range convention), a
    // stray comment, a quoted value with a trailing word. NaN then loses every
    // comparison, so the handoff belonged to no phase at all: the board read
    // the phase as not-started while the file sat there saying `complete`, and
    // the engine, which finds a handoff by its FILENAME, disagreed. Parse
    // defensively and fall back to the name the engine itself keys on.
    phase: phaseNumber(fmString(frontMatter, 'phase'), fromName.phase),
    file,
    path,
    title: fmString(frontMatter, 'title') ?? fromName.title,
    status: normaliseStatus(rawStatus),
    rawStatus,
    completed: fmString(frontMatter, 'completed'),
    nextPhase: fmString(frontMatter, 'next_phase'),
    dependsOn: fmPhaseList(frontMatter, 'depends_on'),
    blocks: fmPhaseList(frontMatter, 'blocks'),
    parallelSafe: fmPhaseList(frontMatter, 'parallel_safe'),
    skillsUsed: fmList(frontMatter, 'skills_used'),
    keyFiles: fmList(frontMatter, 'key_files'),
    memoryKey: fmString(frontMatter, 'memory'),
    frontMatter,
    sections: secs,
    whatItDid: findSection(secs, 'What this phase')?.body,
    stateNow: findSection(secs, 'State now')?.body,
    filesChanged: findSection(secs, 'Files changed')?.body,
    decisions: findSection(secs, 'Key decisions')?.body,
    outstanding: findSection(secs, 'Outstanding')?.body,
    prompts: extractPrompts(startNext ?? closeout),
    finalPhase: Boolean(closeout),
    body,
    bytes: stat.size,
    mtime: stat.mtimeMs,
  };
}
