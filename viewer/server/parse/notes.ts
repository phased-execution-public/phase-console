/**
 * Forward notes — the JS twin of `phase-graph.sh --notes N`.
 *
 * A phase that has not started cannot be told anything: it has no session, no
 * transcript and no inbox. Everything an earlier phase learned about it has to
 * be left somewhere the engine will read when it finally boards, and there are
 * three such places, written by three different hands:
 *
 *   1. a handoff's `## Notes for later phases` bullets — a person writing for
 *      a person, in the file a person will open;
 *   2. the rulings ledger's `deferral` lines — a session recording what it
 *      deliberately left, on its way past rather than remembered until
 *      phase-finish;
 *   3. the messages ledger's `deliver: boot` mail — a peer addressing a PHASE
 *      rather than a session.
 *
 * They are one answer because the question is one — "what was left for me?" —
 * and a session that has to ask three asks none.
 *
 * ------------------------------------------------------------------
 * Why a twin at all
 * ------------------------------------------------------------------
 *
 * The engine is the authority: the boot prompt is built in bash and the
 * console shells out for it. This file exists so the console can DRAW the same
 * answer without a subprocess per phase drawer, and — far more importantly —
 * so `viewer/test/notes-boot-parity.test.ts` can hold the two readings to each
 * other over the same fixtures. A second parser that quietly disagrees is how
 * a phase gets told something it was never handed, which is the one failure
 * this whole feature exists to prevent.
 *
 * Every function here is PURE. The caller reads the files; this decides what
 * they mean. That is the shape of every other module in `parse/`, and it is
 * what lets the parity test feed both halves byte-identical input.
 */

/**
 * What produced a note — the second column of `--notes`. `trailer` is the
 * bound's own row and never a note: it says how many were left out.
 */
export const NOTE_KINDS = Object.freeze(['handoff', 'deferral', 'message', 'trailer'] as const);
export type NoteKind = (typeof NOTE_KINDS)[number];

/** One thing a phase was handed before it started. */
export type Note = {
  /** Who left it: a handoff's basename, or `phase-<N>` for a ledger line. */
  source: string;
  kind: NoteKind;
  /** The message or ruling id — `-` for a handoff bullet, which has none. */
  id: string;
  /** When it was written, ISO. `-` when the handoff never said. */
  at: string;
  text: string;
};

/**
 * How many notes a boot prompt may carry, and how long one may be.
 *
 * The bound is not tidiness. The block is prepended to every boarding prompt
 * of a phase, so an unbounded list is a token bill charged once per attempt
 * and per retry, for text the session mostly already knows. Twelve is what
 * fits on a screen; the trailer says how many older ones were dropped, so
 * nothing is silently swallowed. 500 characters is a note, not an essay —
 * what does not fit belongs in the handoff the note can point at.
 *
 * The same two numbers live in `scripts/phase-graph.sh` (`NOTES_MAX`,
 * `NOTE_TEXT_MAX`) and the parity test is what holds them together.
 */
export const NOTES_MAX = 12;
export const NOTE_TEXT_MAX = 500;

const SECTION_RE = /^##\s+notes for later phases/i;
const HEADING_RE = /^##\s/;
const BULLET_RE = /^\s*[-*]\s/;
const CONTINUATION_RE = /^\s+\S/;

/** A handoff, as `collectNotes` needs it — the caller reads the file. */
export type NoteHandoff = {
  phase: number;
  /** The file's basename without `.md`: what the engine prints as the source. */
  source: string;
  /** Is this phase DONE on the board? Only a finished phase has handed anything over. */
  done: boolean;
  /** The handoff's `completed:` frontmatter, when it has one. */
  completed?: string;
  /** The whole file. */
  body: string;
};

/** A rulings-ledger line, as far as this cares. */
export type NoteRuling = { phase: number; kind: string; for?: string; id?: string; at: string; what: string };

/**
 * A messages-ledger line, already FOLDED: `state` is the last state the ledger
 * gave it, so the caller has applied the `delivery`/`ack` lines. Folding is the
 * ledger's own job (`pro/messaging/messages.ts`) and duplicating it here would
 * be a second answer to "has this been delivered?".
 */
export type NoteMessage = {
  id: string;
  from: string;
  to: string;
  deliver: string;
  priority?: string;
  state: string;
  text: string;
  writtenAt: string;
  expires?: string;
};

export type CollectNotesInput = {
  /** The phase asking. */
  phase: number;
  /** Its dependencies, from the plan graph — what `next` means for it. */
  deps: readonly number[];
  handoffs: readonly NoteHandoff[];
  rulings?: readonly NoteRuling[];
  messages?: readonly NoteMessage[];
  /** The plan's `**Messaging:**` word. `off` suppresses the mail source alone. */
  messaging?: string;
  now?: Date;
  max?: number;
};

/**
 * The `## Notes for later phases` section of one handoff, as `target`/`text`
 * pairs — target being a phase number as written, `next` or `all`.
 *
 * A bullet's label runs to the first colon and the colon sits INSIDE the
 * emphasis (`- **Phase 7:** …`), so the closing `**` has to come off both
 * halves: off the label to read it at all, and off the note so it does not
 * open with two asterisks everywhere it is shown.
 *
 * A wrapped sentence is part of the note above it, not a second instruction.
 * Markdown wraps and a handoff is written by hand, so a note long enough to
 * matter is a note long enough to wrap.
 */
export function parseNoteSection(body: string): { target: string; text: string }[] {
  const out: { target: string; text: string }[] = [];
  let inside = false;
  let target = '';
  let text = '';

  const flush = () => {
    const trimmed = text.trim();
    if (target && trimmed) out.push({ target, text: trimmed });
    target = '';
    text = '';
  };

  let comment = false;
  for (const raw of body.split('\n')) {
    if (SECTION_RE.test(raw)) { inside = true; continue; }
    if (inside && HEADING_RE.test(raw)) { flush(); inside = false; continue; }
    if (!inside) continue;
    // An HTML comment is not content, and skipping it is load-bearing rather
    // than tidy: the SCAFFOLDED section is a comment, and it teaches the
    // grammar by showing `- **Phase 7:** …`. Read as notes, every freshly
    // scaffolded handoff hands phase 7 an example nobody wrote and fails its
    // own plan's F26.
    if (raw.includes('<!--')) comment = true;
    if (comment) { if (raw.includes('-->')) comment = false; continue; }

    if (BULLET_RE.test(raw)) {
      flush();
      let line = raw.replace(/^\s*[-*]\s*/, '').replace(/^\*+/, '');
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const label = line.slice(0, colon).replace(/\*+$/, '').trim().toLowerCase().replace(/^for\s+/, '');
      let rest = line.slice(colon + 1);
      const phaseLabel = /^phase\s+(\d+)$/.exec(label);
      if (phaseLabel) target = phaseLabel[1];
      else if (label === 'next') target = 'next';
      else if (label === 'all') target = 'all';
      else continue;
      rest = rest.replace(/^\*+\s*/, '');
      text = rest;
      continue;
    }
    if (target && CONTINUATION_RE.test(raw)) { text += ` ${raw.trim()}`; continue; }
    if (!raw.trim()) flush();
  }
  flush();
  return out;
}

/**
 * Does a note written by `writer` and addressed `target` reach `want`?
 *
 * `next` is a DEPENDENCY relation, never a phase number. On a DAG "the phase
 * after this one" is every phase that lists the writer, and reading it as
 * `writer + 1` would hand a root's note to a phase it never unblocked — which
 * on a fan-out is most of the plan.
 *
 * A phase is never handed its own note under any of the three targets: it
 * wrote it, and a session reading its own words back as advice from a
 * predecessor is the one way this feature can mislead.
 */
export function noteReaches(target: string, writer: number, want: number, deps: readonly number[]): boolean {
  if (writer === want) return false;
  if (target === 'all') return true;
  if (target === 'next') return deps.includes(writer);
  return target === String(want);
}

type Candidate = Note & { urgency: 0 | 1; seq: number };

const clip = (text: string): string => text.slice(0, NOTE_TEXT_MAX);

/**
 * Everything phase N was handed, in the order it should read it.
 *
 * Urgent mail first — a `high` message is the one thing here that can change
 * what a session does in its first minute — then oldest to newest, because a
 * note is a story and the ending is what you needed. The bound keeps the
 * NEWEST `max`: an old note that still mattered has been read by now, and the
 * trailer names how many were left out rather than pretending there were none.
 */
export function collectNotes(input: CollectNotesInput): Note[] {
  const { phase, deps } = input;
  const max = input.max ?? NOTES_MAX;
  const now = (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const candidates: Candidate[] = [];
  let seq = 0;

  // ---- source 1: the handoffs ---------------------------------------------
  // DONE phases only. A phase still working may yet change its mind and a
  // blocked one has not finished the thought; neither has handed anything
  // over, and a note read off an unfinished handoff is advice its author
  // withdrew. Oldest phase first, so `seq` breaks ties the way bash's file
  // walk does.
  for (const handoff of [...input.handoffs].sort((a, b) => a.phase - b.phase)) {
    if (!handoff.done || handoff.phase === phase) continue;
    const at = handoff.completed?.trim() || '-';
    for (const { target, text } of parseNoteSection(handoff.body)) {
      if (!noteReaches(target, handoff.phase, phase, deps)) continue;
      candidates.push({ urgency: 1, seq: ++seq, source: handoff.source, kind: 'handoff', id: '-', at, text: clip(text) });
    }
  }

  // ---- source 2: the rulings ledger ---------------------------------------
  // `deferral` alone. An ambiguity or a deviation is a session explaining
  // ITSELF; only a deferral is addressed to somebody — which is why `--for`
  // exists on that kind and is refused on the other two. A line written before
  // `--for` existed carries no addressee and reads as the default, `next`.
  for (const ruling of input.rulings ?? []) {
    if (ruling.kind !== 'deferral') continue;
    const target = (ruling.for || 'next').toLowerCase();
    if (!noteReaches(target, ruling.phase, phase, deps)) continue;
    candidates.push({
      urgency: 1, seq: ++seq, source: `phase-${ruling.phase}`, kind: 'deferral',
      id: ruling.id || '-', at: ruling.at || '-', text: clip(ruling.what),
    });
  }

  // ---- source 3: the messages ledger --------------------------------------
  // Suppressed wholesale by `**Messaging:** off`: that line says this plan's
  // sessions do not write to each other, and a reader that went on delivering
  // their mail would be answering a question the plan closed. It says nothing
  // about the plan's own rulings or its handoffs, so those two stay.
  if (input.messaging !== 'off') {
    for (const message of input.messages ?? []) {
      // `boot` alone waits for a phase. `now` and `next-turn` are addressed to
      // a SESSION, and a session that never started cannot have been meant.
      if (message.deliver !== 'boot') continue;
      // A message whose state has MOVED off queued/held has been dealt with —
      // delivered, refused, expired — so a boot prompt cannot hand over the
      // same note twice.
      if (message.state !== 'queued' && message.state !== 'held') continue;
      if (message.expires && message.expires <= now) continue;
      const target = addressTarget(message.to);
      if (target === null) continue;
      const writer = Number(message.from.slice(message.from.indexOf('/') + 1));
      if (!Number.isInteger(writer)) continue;
      if (!noteReaches(target, writer, phase, deps)) continue;
      candidates.push({
        urgency: message.priority === 'high' ? 0 : 1, seq: ++seq,
        source: `phase-${writer}`, kind: 'message', id: message.id,
        at: message.writtenAt || '-', text: clip(message.text),
      });
    }
  }

  if (!candidates.length) return [];

  const newestFirst = [...candidates].sort(
    (a, b) => a.urgency - b.urgency || cmp(b.at, a.at) || b.seq - a.seq,
  );
  const kept = newestFirst.slice(0, max);
  const dropped = candidates.length - kept.length;
  const out: Note[] = kept
    .sort((a, b) => a.urgency - b.urgency || cmp(a.at, b.at) || a.seq - b.seq)
    .map(({ urgency: _u, seq: _s, ...note }) => note);
  if (dropped > 0) {
    out.push({ source: '-', kind: 'trailer', id: '-', at: '-', text: `… and ${dropped} older notes, not shown` });
  }
  return out;
}

/**
 * Which target an address names, or `null` for one no phase can be handed.
 *
 * `phase:<slug>/<N>` is read for its phase alone: the slug is the plan the
 * ledger belongs to, so a line carrying another plan's slug is a line in the
 * wrong file, and reading it would be believing the address over the folder.
 */
function addressTarget(to: string): string | null {
  if (to === 'all:') return 'all';
  if (to === 'next:') return 'next';
  const slash = to.indexOf('/');
  if (!to.startsWith('phase:') || slash < 0) return null;
  const target = to.slice(slash + 1);
  return /^\d+$/.test(target) ? target : null;
}

/** Byte order, so the two halves agree whatever locale the shell is in. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
