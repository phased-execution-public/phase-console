/**
 * When a projected item was first seen (turn-by-turn phase 3, §Architecture
 * 2's `timing.assignedAt`). A ledger item carries its own birth — the moment
 * it was declared, or became due — but a projected one (a gate, an approval,
 * a relayed question, a ladder errand) is re-derived from its source on every
 * read and many sources hold no stable start clock. This store remembers the
 * first read that showed each id, so "assigned 3 h ago" is the same answer on
 * every read and after a restart.
 *
 * One JSON file under the instance's state directory, `turn-first-seen.json`,
 * written only when an id is new — atomically, through a temporary file — and
 * bounded: past `FIRST_SEEN_MAX` ids the oldest are dropped, and an id unseen
 * for `FIRST_SEEN_TTL_MS` is forgotten, so an item that went away and comes
 * back weeks later is assigned anew.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The file's name under the instance's state directory. */
export const FIRST_SEEN_FILE = 'turn-first-seen.json';

/** How many ids the store keeps — the oldest go first. */
export const FIRST_SEEN_MAX = 2000;

/** An id no read has shown for this long is forgotten. */
export const FIRST_SEEN_TTL_MS = 14 * 24 * 60 * 60_000;

/** One id's record: when it was first seen, and when it was last seen. */
type Seen = { first: string; last: string };

/** What one read hands the store: the id, and the source's own clock when it has one. */
export type SeenEntry = { id: string; since?: string | null };

export class FirstSeen {
  readonly file: string;
  private memo: Map<string, Seen> | null = null;

  constructor(file: string) {
    this.file = file;
  }

  private read(): Map<string, Seen> {
    if (this.memo) return this.memo;
    const out = new Map<string, Seen>();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { ids?: Record<string, Seen> };
      for (const [id, seen] of Object.entries(raw?.ids ?? {})) {
        if (typeof seen?.first === 'string' && Number.isFinite(Date.parse(seen.first))) {
          out.set(id, { first: seen.first, last: typeof seen.last === 'string' ? seen.last : seen.first });
        }
      }
    } catch { /* no file, or a torn one: an empty store */ }
    this.memo = out;
    return out;
  }

  private write(map: Map<string, Seen>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, ids: Object.fromEntries(map) })}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* the store is a convenience: a failed write costs a stable clock, never the read */ }
  }

  /**
   * Stamp what one read shows, and answer each id's first-seen instant. A new
   * id is assigned the earlier of the source's own clock and `now` — a gate
   * opened yesterday is not "assigned just now" because the store is new.
   */
  stamp(entries: readonly SeenEntry[], now: number = Date.now()): Map<string, string> {
    const map = this.read();
    const nowIso = new Date(now).toISOString();
    let changed = false;
    for (const [id, seen] of map) {
      if (now - Date.parse(seen.last) > FIRST_SEEN_TTL_MS) { map.delete(id); changed = true; }
    }
    const answer = new Map<string, string>();
    for (const entry of entries) {
      const known = map.get(entry.id);
      if (known) {
        answer.set(entry.id, known.first);
        // The last-seen clock moves at most hourly: a read is not a write.
        if (now - Date.parse(known.last) > 60 * 60_000) { known.last = nowIso; changed = true; }
        continue;
      }
      const own = Date.parse(entry.since ?? '');
      const first = Number.isFinite(own) && own < now ? new Date(own).toISOString() : nowIso;
      map.set(entry.id, { first, last: nowIso });
      answer.set(entry.id, first);
      changed = true;
    }
    if (map.size > FIRST_SEEN_MAX) {
      const oldest = [...map.entries()].sort((a, b) => Date.parse(a[1].last) - Date.parse(b[1].last));
      for (const [id] of oldest.slice(0, map.size - FIRST_SEEN_MAX)) map.delete(id);
      changed = true;
    }
    if (changed) this.write(map);
    return answer;
  }
}
