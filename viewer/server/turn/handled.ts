/**
 * What the AI handled instead of asking (control-tower phase 136, #213,
 * §Architecture 19 "Rounds, and what the AI handled").
 *
 * `handled.ndjson` is one append-only ledger per console, beside
 * `human-steps.ndjson` and `grants.ndjson`, and a retention sink. A row says
 * what was done instead of asking a person, who did it (`HANDLED_SOURCES`), and
 * what shows it — a commit, a pull request, an issue or the journal line:
 *
 *   `{id, at, first, slug?, phase?, runId?, source, what, note?, count, links}`
 *
 * Its writers:
 *   - `guard` — the door of Your turn refused to ask a person because the AI
 *     could run it (`phase.turn-refused`, G4 and G5);
 *   - `auto-grant` — a card the rule table answered (`phase.approval-auto-granted`);
 *   - `relay-rule` — a relayed question the console answered by rule
 *     (`phase.question-answered`, `by` anything but `human`);
 *   - `ladder` — a recovery that let the run carry on (`run.recovery-continue`);
 *   - `supervisor` (Pro) — what the supervisor pressed, written by its engine;
 *   - `session` — a session's own `phase-outcome.sh <slug> <N> handled`, which
 *     appends to a file of the SESSIONS' own beside it, `handled-sessions.ndjson`
 *     (`$PE_HANDLED_FILE`). A session is never handed the console's ledger, and
 *     every line of its file reads as `session` whatever it claims: never a
 *     console source, never a fold, never a console row's count (the push review
 *     of b5542fdd — a session appending `"source":"guard"` spoke as the console).
 * The first four are read off the journal line as it is written
 * (`handledOfJournal`), so each row links the line that says it.
 *
 * A console source FOLDS: one row per rule per phase, with a count — 452
 * auto-grants of one rule on one phase are ONE row that reads 452. The ledger
 * stays append-only, so a fold is a further line with the same `id` and the
 * new count, and the reader keeps the last line per id. A session's row never
 * folds: it is one thing the session did.
 *
 * Never an outcome, and never a secret: every field passes the redaction
 * floor and is bounded, and a link is held to the four kinds — anything else
 * is dropped, never stored as a URL somebody might open.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { redactSecrets } from '../../shared/human-step-model.js';
import { HANDLED_LINK_KINDS, HANDLED_SOURCES } from '../../shared/turn-model.js';

export type HandledSource = (typeof HANDLED_SOURCES)[number];
export type HandledLinkKind = (typeof HANDLED_LINK_KINDS)[number];
export type HandledLink = { kind: HandledLinkKind; ref: string };

export type HandledRow = {
  id: string;
  /** When it last happened — the newest of a folded row's events. */
  at: string;
  /** When it first happened. */
  first: string;
  source: HandledSource;
  what: string;
  slug?: string;
  phase?: number;
  runId?: string;
  note?: string;
  /** How many times — one for a session's row; a folded row counts every event. */
  count: number;
  links: HandledLink[];
};

export type HandledInput = {
  source: HandledSource;
  what: string;
  slug?: string;
  phase?: number;
  runId?: string;
  note?: string;
  /** Links as records or as the words a session types (`commit:<sha>`, a GitHub URL, `#12`, `journal:<slug>/<run>#<n>`). */
  links?: readonly (HandledLink | string)[];
  /** What a console source folds by — the rule, the question's rule, the situation. Absent: never folded. */
  fold?: string;
  at?: string;
};

/** The ledger's file name, under the console's instance state. */
export const HANDLED_FILE = 'handled.ndjson';

/** The sessions' own file beside it — what `$PE_HANDLED_FILE` names; every line of it is a session's. */
export const HANDLED_SESSION_FILE = 'handled-sessions.ndjson';

/** How many rows `GET /api/turn` carries — the newest. */
export const HANDLED_RECENT = 50;

const WHAT_MAX = 300;
const NOTE_MAX = 600;
const LINKS_MAX = 8;
const LINE_VERSION = 1;

const clean = (value: unknown, max: number): string =>
  typeof value === 'string' ? redactSecrets(value.replace(/[\u0000-\u001f]+/g, ' ').trim()).slice(0, max) : '';

const SHA = /^[0-9a-f]{7,40}$/i;
const REPO = '[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}';
const GITHUB_COMMIT = new RegExp(`^https://github\\.com/(${REPO})/commit/([0-9a-fA-F]{7,40})/?$`);
const GITHUB_PULL = new RegExp(`^https://github\\.com/(${REPO})/pull/(\\d{1,7})/?$`);
const GITHUB_ISSUE = new RegExp(`^https://github\\.com/(${REPO})/issues/(\\d{1,7})/?$`);
const NUMBERED = new RegExp(`^(?:(${REPO}))?#(\\d{1,7})$`);
const JOURNAL = /^([a-z0-9][a-z0-9._-]{0,99})\/([A-Za-z0-9._-]{1,64})#(\d{1,9})$/;

/**
 * One link, held to the four kinds — or null. The grammar `phase-outcome.sh`
 * screens with, read again here so a line written by hand is held to it too:
 * `commit:<sha>` or a bare sha, a GitHub commit URL; `pr:[owner/name]#<n>` or a
 * GitHub pull URL; `issue:[owner/name]#<n>`, `#<n>` or a GitHub issue URL;
 * `journal:<slug>/<runId>#<line>`.
 */
export function parseHandledLink(raw: unknown): HandledLink | null {
  if (raw && typeof raw === 'object') {
    const link = raw as { kind?: unknown; ref?: unknown };
    if (typeof link.kind !== 'string' || typeof link.ref !== 'string') return null;
    return parseHandledLink(`${link.kind}:${link.ref}`);
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 300 || redactSecrets(text) !== text) return null;
  let m = GITHUB_COMMIT.exec(text);
  if (m) return { kind: 'commit', ref: `${m[1]}@${m[2]!.toLowerCase()}` };
  if ((m = GITHUB_PULL.exec(text))) return { kind: 'pr', ref: `${m[1]}#${m[2]}` };
  if ((m = GITHUB_ISSUE.exec(text))) return { kind: 'issue', ref: `${m[1]}#${m[2]}` };
  if (SHA.test(text)) return { kind: 'commit', ref: text.toLowerCase() };
  if (NUMBERED.test(text)) return { kind: 'issue', ref: text };
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  if (kind === 'commit') {
    const at = rest.lastIndexOf('@');
    const sha = at >= 0 ? rest.slice(at + 1) : rest;
    const repo = at >= 0 ? rest.slice(0, at) : '';
    if (!SHA.test(sha) || (repo && !new RegExp(`^${REPO}$`).test(repo))) return null;
    return { kind: 'commit', ref: `${repo ? `${repo}@` : ''}${sha.toLowerCase()}` };
  }
  if (kind === 'pr' || kind === 'issue') return NUMBERED.test(rest) ? { kind, ref: rest } : null;
  if (kind === 'journal') return JOURNAL.test(rest) ? { kind: 'journal', ref: rest } : null;
  return null;
}

/** The link a journal line is. */
export function journalLink(slug: string, runId: string, seq: number): HandledLink {
  return { kind: 'journal', ref: `${slug}/${runId}#${seq}` };
}

/** A line, as the reader trusts it: known words, bounded, redacted — else null. */
function rowOf(raw: unknown): HandledRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const line = raw as Record<string, unknown>;
  const source = typeof line.source === 'string' && (HANDLED_SOURCES as readonly string[]).includes(line.source)
    ? (line.source as HandledSource) : null;
  const what = clean(line.what, WHAT_MAX);
  const at = typeof line.at === 'string' && Number.isFinite(Date.parse(line.at)) ? line.at : null;
  if (!source || !what || !at) return null;
  const id = typeof line.id === 'string' && /^[a-z0-9-]{4,40}$/.test(line.id) ? line.id : `h-${createHash('sha256').update(`${at}\n${what}`).digest('hex').slice(0, 12)}`;
  const note = clean(line.note, NOTE_MAX);
  const count = Number.isInteger(line.count) && (line.count as number) > 0 ? (line.count as number) : 1;
  const links = (Array.isArray(line.links) ? line.links : []).map(parseHandledLink).filter((one): one is HandledLink => one !== null).slice(0, LINKS_MAX);
  const first = typeof line.first === 'string' && Number.isFinite(Date.parse(line.first)) ? line.first : at;
  return {
    id, at, first, source, what, count, links,
    ...(typeof line.slug === 'string' && line.slug ? { slug: clean(line.slug, 128) } : {}),
    ...(Number.isInteger(line.phase) && (line.phase as number) >= 0 ? { phase: line.phase as number } : {}),
    ...(typeof line.runId === 'string' && line.runId ? { runId: clean(line.runId, 64) } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * A line of the SESSIONS' file, as the reader trusts it: a session's whatever it
 * claims — its source `session`, counted once, its fold key ignored, and named
 * apart (`hs-…`) so it can never stand in for, or out-count, a console row.
 */
function sessionRowOf(raw: unknown, now: number): HandledRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = rowOf({ ...(raw as Record<string, unknown>), source: 'session' });
  if (!row) return null;
  const claimed = typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : '';
  const id = `hs-${createHash('sha256').update(`${claimed}\n${row.at}\n${row.what}`).digest('hex').slice(0, 12)}`;
  // A session's clock is its own: a line dated after the read reads as the
  // read, so it can never sit atop the log — or count as new — for ever.
  const at = Date.parse(row.at) > now ? new Date(now).toISOString() : row.at;
  const first = Date.parse(row.first) > Date.parse(at) ? at : row.first;
  return { ...row, id, at, first, count: 1 };
}

/** The key one console source folds under: one row per rule per phase. */
function foldKey(input: Pick<HandledInput, 'source' | 'slug' | 'phase' | 'runId' | 'fold'>): string | null {
  if (!input.fold || input.source === 'session') return null;
  return [input.source, input.slug ?? '', input.phase ?? '', input.runId ?? '', input.fold].join('\n');
}

/**
 * The one writer and reader of `handled.ndjson`, and the reader of the
 * sessions' file beside it. Reads fold each rotated copy and live file — the
 * last line per id wins — and are cached by size and modification time, since
 * the page asks on every round.
 */
export class HandledLedger {
  /** The fold index: key → the row's id, its count and its first time. Built from the file on first use. */
  private folds: Map<string, { id: string; count: number; first: string }> | null = null;
  private cache: { stamp: string; rows: HandledRow[] } | null = null;

  readonly file: string;
  /** The sessions' own file (`HANDLED_SESSION_FILE`, beside `file`) — read, never written, here. */
  readonly sessionFile: string;
  private readonly now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.sessionFile = join(dirname(file), HANDLED_SESSION_FILE);
    this.now = now;
  }

  /** Record one thing handled — folded into its row when it has a fold key. Null when there is nothing to say. */
  record(input: HandledInput): HandledRow | null {
    const source = (HANDLED_SOURCES as readonly string[]).includes(input.source) ? input.source : null;
    const what = clean(input.what, WHAT_MAX);
    if (!source || !what) return null;
    const at = input.at && Number.isFinite(Date.parse(input.at)) ? input.at : this.now().toISOString();
    const key = foldKey(input);
    const folds = key ? this.foldIndex() : null;
    const held = key ? folds!.get(key) : undefined;
    const id = held?.id ?? `h-${randomBytes(6).toString('hex')}`;
    const count = (held?.count ?? 0) + 1;
    const first = held?.first ?? at;
    const note = clean(input.note, NOTE_MAX);
    const links = (input.links ?? []).map(parseHandledLink).filter((one): one is HandledLink => one !== null).slice(0, LINKS_MAX);
    const row: HandledRow = {
      id, at, first, source, what, count, links,
      ...(input.slug ? { slug: clean(input.slug, 128) } : {}),
      ...(Number.isInteger(input.phase) && input.phase! >= 0 ? { phase: input.phase } : {}),
      ...(input.runId ? { runId: clean(input.runId, 64) } : {}),
      ...(note ? { note } : {}),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    // `f` is the fold key, so the index can be rebuilt from the file after a restart.
    appendFileSync(this.file, `${JSON.stringify({ v: LINE_VERSION, ...row, ...(key ? { f: key } : {}) })}\n`, { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* the append set it on a new file */ }
    if (key) folds!.set(key, { id, count, first });
    this.cache = null;
    return row;
  }

  /** Every row, newest first — a folded row once, at its newest. */
  rows(): HandledRow[] {
    const stamp = [this.file, `${this.file}.1`, this.sessionFile, `${this.sessionFile}.1`].map((path) => {
      try { const s = statSync(path); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; }
    }).join('|');
    if (this.cache?.stamp === stamp) return this.cache.rows;
    const byId = new Map<string, HandledRow>();
    const now = this.now().getTime();
    const session = (raw: unknown) => sessionRowOf(raw, now);
    const reads: [string, (raw: unknown) => HandledRow | null][] = [
      [`${this.file}.1`, rowOf], [this.file, rowOf], [`${this.sessionFile}.1`, session], [this.sessionFile, session],
    ];
    for (const [path, read] of reads) {
      let text = '';
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const row = read(parsed);
        if (!row) continue;
        const was = byId.get(row.id);
        // A folded row keeps its first time and the highest count it reached.
        byId.set(row.id, was ? { ...row, first: was.first < row.first ? was.first : row.first, count: Math.max(was.count, row.count) } : row);
      }
    }
    const rows = [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    this.cache = { stamp, rows };
    return rows;
  }

  /** The newest rows — what `GET /api/turn` carries. */
  recent(limit = HANDLED_RECENT): HandledRow[] {
    return this.rows().slice(0, limit);
  }

  /** How many rows moved after `iso` — "handled since you last looked". */
  since(iso: string): number {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return 0;
    return this.rows().filter((row) => Date.parse(row.at) > at).length;
  }

  private foldIndex(): Map<string, { id: string; count: number; first: string }> {
    if (this.folds) return this.folds;
    const folds = new Map<string, { id: string; count: number; first: string }>();
    for (const path of [`${this.file}.1`, this.file]) {
      let text = '';
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (typeof parsed.f !== 'string') continue;
        const row = rowOf(parsed);
        if (!row || row.source === 'session') continue;
        const was = folds.get(parsed.f);
        folds.set(parsed.f, { id: was?.id ?? row.id, count: Math.max(row.count, was?.count ?? 0), first: was?.first ?? row.first });
      }
    }
    this.folds = folds;
    return folds;
  }
}

/* ------------------------------------------------------------------ *
 * The journal's lines that are things handled
 * ------------------------------------------------------------------ */

/** One journal line as the append hook hands it over. */
export type JournalLineSeen = {
  slug: string;
  runId: string;
  entry: { seq?: number; event: string; phase?: number; data?: Record<string, unknown> };
};

const words = (value: unknown, max = 160): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The relay's words for who answered when nobody did in the window. */
const RELAY_BY: Record<string, string> = {
  rule: 'by rule',
  recommended: 'with the recommended option',
  'first-option': 'with the first option',
};

/**
 * A journal line that is a thing handled, as the row it writes — or null. Pure:
 * the append hook calls it for every line every run writes.
 */
export function handledOfJournal(line: JournalLineSeen): HandledInput | null {
  const { slug, runId, entry } = line;
  const data = entry.data ?? {};
  const phase = typeof entry.phase === 'number' ? entry.phase : typeof data.phase === 'number' ? data.phase : undefined;
  const at = { slug, runId, ...(phase !== undefined ? { phase } : {}) };
  const links = typeof entry.seq === 'number' ? [journalLink(slug, runId, entry.seq)] : [];
  switch (entry.event) {
    case 'phase.turn-refused': {
      if (data.rule !== 'G4' && data.rule !== 'G5') return null;
      const commands = Array.isArray(data.commands) ? data.commands.filter((c): c is string => typeof c === 'string').slice(0, 4) : [];
      return {
        ...at, source: 'guard', links,
        what: data.rule === 'G4'
          ? `Did not ask a person: the AI can run it itself${commands.length ? ` — ${commands.map((c) => words(c, 80)).join('; ')}` : ''}`
          : 'Did not ask a person: nothing refused it, so the AI runs it',
        note: words(data.sentence, NOTE_MAX),
        fold: `${data.rule}\n${commands.join('\n')}`,
      };
    }
    case 'phase.approval-auto-granted': {
      const rule = words(data.rule) || words(data.matched) || words(data.tool);
      if (!rule) return null;
      const exception = (data.exception ?? null) as { why?: unknown } | null;
      return {
        ...at, source: 'auto-grant', links,
        what: `Allowed ${rule} without asking — ${data.level === 'manifest' || data.answeredBy ? 'the plan’s permission.destructive row' : 'the rule table'} answered its card`,
        ...(exception && typeof exception.why === 'string' ? { note: words(exception.why, NOTE_MAX) } : {}),
        fold: rule,
      };
    }
    case 'phase.question-answered': {
      const by = words(data.by);
      if (!by || by === 'human' || !RELAY_BY[by]) return null;
      const rule = words(data.ruleId);
      return {
        ...at, source: 'relay-rule', links,
        what: `Answered “${words(data.question, 140)}” ${RELAY_BY[by]}${rule ? ` (${rule})` : ''}: ${words(data.answer, 80)}`,
        fold: `${by}\n${rule}`,
      };
    }
    case 'run.recovery-continue': {
      if (phase === undefined) return null;
      const situation = words(data.situation);
      const rung = words(data.rung);
      return {
        ...at, source: 'ladder', links,
        what: `Recovered phase ${phase}${situation ? ` from ${situation}` : ''}${rung ? ` (${rung})` : ''}, and the run carried on`,
        fold: `${situation}\n${rung}`,
      };
    }
    default:
      return null;
  }
}

/** Every journal event `handledOfJournal` reads — `docs/journal-events.md` names each. */
export const HANDLED_EVENTS = Object.freeze([
  'phase.turn-refused',
  'phase.approval-auto-granted',
  'phase.question-answered',
  'run.recovery-continue',
] as const);
