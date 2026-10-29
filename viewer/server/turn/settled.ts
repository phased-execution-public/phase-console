/**
 * What a person pressed on a projected item (turn-by-turn phase 5,
 * §Architecture 4). A ledger item keeps its own record when it settles, so
 * *Done* lists it; a projected item — an approval card, a gate, a plan a
 * plan-mode phase presented, a relayed question, an ack-bound option — is
 * re-derived from its source on every read and simply VANISHES once pressed.
 * This store keeps one settled record per press, so Done shows it as *Passed*
 * or *Closed*, with who pressed and when.
 *
 * Its records are read off the journal line the press already writes
 * (`settledOfJournal`, the way `handledOfJournal` reads what the AI handled):
 *
 *   - `phase.approval-decided` — a card a PERSON decided (its door, or a
 *     `decidedBy` that is no machine's word): approved → passed, else closed;
 *   - `phase.plan-approved` — not the plan's own `policy` answer — passed, and
 *     `phase.plan-rejected` closed;
 *   - `phase.question-answered` — only a person's answer (`by: human`): passed.
 *
 * Two presses write no run journal line and record here directly: a gate's
 * Approve (`approveGate`) and an option bound to the inbox's ack, which leaves
 * its row standing — its settled record is what moves the item to Done.
 *
 * One JSON file under the instance's state directory, `turn-settled.json`,
 * written atomically and bounded: at most `SETTLED_MAX` records, none older
 * than `SETTLED_TTL_MS` — Done shows a day, and the store keeps two.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { inboxItemId } from '../../shared/attention-model.js';
import { redactSecrets } from '../../shared/human-step-model.js';
import type { TurnSource } from '../../shared/turn-model.js';
import type { JournalLineSeen } from './handled.ts';

/** The file's name under the instance's state directory. */
export const SETTLED_FILE = 'turn-settled.json';

/** How many records the store keeps — the oldest go first. */
export const SETTLED_MAX = 500;

/** A record older than this is forgotten. */
export const SETTLED_TTL_MS = 2 * 24 * 60 * 60_000;

/**
 * How a pressed item ended, as Done says it — `not-doing` is the person's *I
 * can't do this* on an item the console projects (2026-10-20), the word a
 * ledger step's `cannot` reads as too.
 */
export type SettledOutcome = 'passed' | 'closed' | 'not-doing';

/** One press that settled a projected item. */
export type SettledRecord = {
  /** The item it settled — the projected row's id where it can be named, else the press's own. */
  item: string;
  at: string;
  source: TurnSource;
  outcome: SettledOutcome;
  /** Who pressed. */
  by: string;
  /** The item, in words. */
  title: string;
  /** What the press did, in words — "Approved", "Answered “Yes”", "Left for when the branches meet". */
  what: string;
  slug?: string;
  phase?: number;
  runId?: string;
};

/** The words a decider is when no person decided — a timeout, the run ending, a rule, the plan's own row. */
const MACHINE_BY = new Set(['timeout', 'disarm', 'policy', 'manifest', 'rule', 'console', 'relay', 'supervisor', 'auto']);

/** The doors a person presses through (`shared/door-model.js`'s person doors, by name). */
const PERSON_DOORS = new Set(['owner', 'device', 'local']);

const words = (value: unknown, max = 200): string =>
  (typeof value === 'string' ? redactSecrets(value.replace(/\s+/g, ' ').trim()).slice(0, max) : '');

/**
 * The settled record a run's journal line says, or null — a line no person's
 * press wrote. Pure: the line in, the record out.
 */
export function settledOfJournal(line: JournalLineSeen, at: string = new Date().toISOString()): SettledRecord | null {
  const { slug, runId, entry } = line;
  const data = entry.data ?? {};
  const phase = typeof entry.phase === 'number' ? entry.phase : typeof data.phase === 'number' ? data.phase : undefined;
  const where = { slug, runId, ...(phase !== undefined ? { phase } : {}) };
  const scope = phase !== undefined && phase > 0 ? `Phase ${phase} of ${slug}` : `the plan ${slug}`;
  switch (entry.event) {
    case 'phase.approval-decided': {
      const by = words(data.decidedBy, 80);
      const door = words(data.door, 20);
      const person = door ? PERSON_DOORS.has(door) : Boolean(by) && !MACHINE_BY.has(by);
      const approvalId = words(data.approvalId, 80);
      // A question card is settled by its answers (`phase.question-answered`), one record each.
      if (!person || !approvalId || data.kind === 'question') return null;
      const approved = data.decision === 'approved';
      return {
        ...where, at,
        item: inboxItemId({ kind: 'approval', slug, ...(phase !== undefined ? { phase } : {}), runId, subject: approvalId }),
        source: data.kind === 'verify' ? 'person-check' : 'approval',
        outcome: approved ? 'passed' : 'closed',
        by,
        title: words(data.title) || `The ask of ${scope}`,
        what: approved ? 'Approved' : data.decision === 'denied' ? 'Denied' : `Closed (${words(data.decision, 40) || 'decided'})`,
      };
    }
    case 'phase.plan-approved':
    case 'phase.plan-rejected': {
      const by = words(data.by, 80);
      if (!by || MACHINE_BY.has(by) || phase === undefined) return null;
      const approved = entry.event === 'phase.plan-approved';
      return {
        ...where, at,
        item: `settled:plan-approval:${runId}:${phase}`,
        source: 'plan-approval',
        outcome: approved ? 'passed' : 'closed',
        by,
        title: `The plan ${scope} presented, before it acts`,
        what: approved ? 'Approved the plan' : `Rejected the plan${words(data.reason) ? ` — ${words(data.reason)}` : ''}`,
      };
    }
    case 'phase.question-answered': {
      if (data.by !== 'human') return null;
      const approvalId = words(data.approvalId, 80);
      const key = words(data.key, 120);
      return {
        ...where, at,
        item: approvalId
          ? inboxItemId({ kind: 'question', slug, ...(phase !== undefined ? { phase } : {}), runId, subject: `${approvalId}:${key}` })
          : `settled:question:${runId}:${entry.seq ?? at}`,
        source: 'question',
        outcome: 'passed',
        by: words(data.who, 80) || 'a person',
        title: words(data.question) || `A question from ${scope}`,
        what: `Answered “${words(data.answer, 120)}”`,
      };
    }
    default:
      return null;
  }
}

/** Every journal event `settledOfJournal` reads — `docs/journal-events.md` names each. */
export const SETTLED_EVENTS = Object.freeze(['phase.approval-decided', 'phase.plan-approved', 'phase.plan-rejected', 'phase.question-answered']);

export class SettledStore {
  readonly file: string;
  private memo: SettledRecord[] | null = null;

  constructor(file: string) {
    this.file = file;
  }

  private read(): SettledRecord[] {
    if (this.memo) return this.memo;
    let out: SettledRecord[] = [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { records?: unknown };
      out = Array.isArray(raw?.records)
        ? (raw.records as SettledRecord[]).filter((one) => typeof one?.item === 'string' && Number.isFinite(Date.parse(one?.at)))
        : [];
    } catch { /* no file, or a torn one: an empty store */ }
    this.memo = out;
    return out;
  }

  private write(records: SettledRecord[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, records })}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* a convenience: a failed write costs Done a line, never the press */ }
  }

  /** Keep one press — a second press of the same item replaces the first (a re-approval, an answer changed). */
  record(record: SettledRecord, now: number = Date.now()): SettledRecord {
    const kept = this.read().filter((one) => one.item !== record.item && now - Date.parse(one.at) <= SETTLED_TTL_MS);
    kept.push(record);
    const bounded = kept.slice(-SETTLED_MAX);
    this.memo = bounded;
    this.write(bounded);
    return record;
  }

  /** The records of the last `withinMs`, newest last. */
  recent(withinMs: number, now: number = Date.now()): SettledRecord[] {
    return this.read().filter((one) => now - Date.parse(one.at) <= withinMs);
  }
}
