/**
 * The queue, in words (control-tower phase 99, #135 A) — why an entry sits
 * where it does, what it waits on, and what a lane holding it is doing.
 *
 * ONE set of sentences for every reader: `GET /api/queue` writes them into
 * the view (`server/queue-view.ts`) so a terminal, the CLI and the supervisor
 * read exactly what the queue page draws, and the page renders them rather
 * than composing its own. "queued" alone is the non-answer this exists to end:
 * an operator must be able to say, from one page, what is queued, why in that
 * order, what each entry waits on, and who holds what.
 *
 * ⚠️ Pure and dependency-light: the client may bundle it and `node --test`
 * imports it directly.
 */

import { DEFAULT_PRIORITY, QUEUE_ORDER_KEYS, bumpReason, runPriority } from './orchestration-model.js';

const MINUTE = 60_000;

/** Whole minutes, never below one — "0 min" reads as nothing happening. */
function mins(ms) {
  return Math.max(1, Math.round(ms / MINUTE));
}

/**
 * What a LANE is doing while it holds a scope somebody is queued behind, when
 * it is in a wait chain (control-tower phase 47's chains; #67's last ask: "make
 * lock holding while polling visible to the queue"). `null` for a lane doing
 * anything else — a working lane needs no excuse.
 *
 * @param {{ signal?: string, since?: string, scope?: string, chain?: { calls?: number } }|null|undefined} stall
 *   the holder lane's `record.stall`
 * @param {number} nowMs
 * @returns {{ scope: 'local'|'external', minutes: number, calls?: number, text: string }|null}
 */
export function laneWaitOf(stall, nowMs) {
  if (!stall || stall.signal !== 'external-wait' || !stall.since) return null;
  const since = Date.parse(stall.since);
  if (!Number.isFinite(since)) return null;
  const minutes = mins(nowMs - since);
  const scope = stall.scope === 'local' ? 'local' : 'external';
  const calls = stall.chain?.calls;
  const text =
    scope === 'local' ? `polling its own job, ${minutes} min` : `waiting on an outside clock, ${minutes} min`;
  return { scope, minutes, ...(calls ? { calls } : {}), text };
}

/**
 * One holder in words — the cell an operator reads to learn who is in the way.
 *
 * A lane (`grant`) says what it is doing when it is in a wait chain; a BRANCH
 * hold names the run that holds it, how many phases that run has left and its
 * ETA, because the hold is run-long (#150) and "waiting on beta" reads as a
 * lock beta could let go of; a clock or a policy is its own sentence.
 *
 * @param {{ kind: string, slug: string, phase: number|null, owner: string, branch?: string, repo?: string,
 *           overlaps?: string[], scope?: string[], leaseUntil?: number,
 *           holderRun?: { run: string, slug: string, remainingPhases?: number },
 *           eta?: { label?: string } }} holder
 * @param {{ laneWait?: { text: string }|null }} [extra]
 * @returns {string}
 */
export function holderWords(holder, extra = {}) {
  const where = holder.phase != null ? `${holder.slug} P${holder.phase}` : holder.slug;
  switch (holder.kind) {
    case 'grant':
      return `${where} — a live lane${extra.laneWait ? `, ${extra.laneWait.text}` : ''}`;
    case 'lock':
      return `${where} — a lock${holder.leaseUntil ? `, lease ends ${new Date(holder.leaseUntil).toISOString()}` : ''}`;
    case 'session':
      return `${where} — a live session with no lock`;
    case 'after':
      return holder.phase != null
        ? `its dependency P${holder.phase}, not done`
        : 'a dependency that is not done';
    case 'branch': {
      const repo = holder.repo ?? holder.overlaps?.[0] ?? holder.scope?.[0] ?? '';
      const run = holder.holderRun;
      const left =
        run?.remainingPhases != null
          ? `, ${run.remainingPhases} phase${run.remainingPhases === 1 ? '' : 's'} left`
          : '';
      const eta = holder.eta?.label ? `, ${holder.eta.label}` : '';
      return (
        `${holder.slug}'s branch${holder.branch ? ` ${holder.branch}` : ''}${repo ? ` on ${repo}` : ''}` +
        ` — held by run ${run?.run ?? '?'} until it finishes${left}${eta}`
      );
    }
    default:
      // A clock or a policy (`reserved`): its owner line IS the sentence.
      return holder.owner || holder.slug;
  }
}

/**
 * WHY an entry sits where it does — the scan's keys (`QUEUE_ORDER_KEYS`), each
 * that applies in words, most significant first; `key`/`text` is the first.
 *
 * @param {{ waitingOn?: { kind: string, phase: number|null }[], reserving?: boolean, reserve?: boolean,
 *           priority?: string, bumped?: boolean, since: number, pinned?: boolean,
 *           laneReserved?: { by?: string, reason?: string }|null,
 *           promotion?: { policy: string, rank: number, text: string }|null,
 *           share?: { round: number, lanes?: number }|null }} entry
 * @param {{ nowMs: number, bump?: { by?: string, reason?: string }|null,
 *           pin?: { by?: string, reason?: string }|null,
 *           seniority?: { clock: string, since: string }|null }} ctx
 * @returns {{ key: string, text: string, all: { key: string, text: string }[] }}
 */
export function queueOrderReason(entry, ctx) {
  /** @type {{ key: string, text: string }[]} */
  const all = [];
  const head = entry.waitingOn?.[0];
  if (head?.kind === 'after') {
    all.push({
      key: 'dependency',
      text: `after its dependency P${head.phase} — a dependency always goes first`,
    });
  }
  if (entry.laneReserved) {
    const r = entry.laneReserved;
    all.push({
      key: 'reserved',
      text: `a lane is reserved for it${r.by ? ` by ${r.by}` : ''}${r.reason ? ` — ${r.reason}` : ''} — it boards before anything else on its scope`,
    });
  } else if (entry.reserving || entry.reserve) {
    all.push({
      key: 'reserved',
      text: entry.reserve
        ? 'reserved at birth — its watch landed, so it goes ahead of its scope'
        : 'reserved — it waited past its bound, so it holds its scope against everything behind it',
    });
  }
  const klass = runPriority(entry.priority);
  if (klass !== DEFAULT_PRIORITY) {
    all.push({
      key: 'class',
      text:
        klass === 'high'
          ? 'class high — scanned before every normal entry'
          : 'class low — scanned after every normal entry',
    });
  }
  if (entry.pinned) {
    const pin = ctx.pin;
    all.push({
      key: 'pinned',
      text: `pinned next in its plan${pin?.by ? ` by ${pin.by}` : ''}${pin?.reason ? ` — ${pin.reason}` : ''} — its run's other phases wait for it`,
    });
  }
  if (entry.bumped) all.push({ key: 'bumped', text: `${bumpReason(ctx.bump)} — first in its class` });
  if (entry.promotion) all.push({ key: 'policy', text: entry.promotion.text });
  if (entry.share && entry.share.round > 0) {
    const { lanes = 0, round } = entry.share;
    const ahead = round - lanes;
    const parts = [
      lanes ? `its plan holds ${lanes} lane${lanes === 1 ? '' : 's'}` : '',
      ahead > 0 ? `${ahead} of its plan's entr${ahead === 1 ? 'y is' : 'ies are'} ahead of it` : '',
    ].filter(Boolean);
    all.push({
      key: 'share',
      text: `fair share — ${parts.join(' and ')}, so other plans in its class take their turn first`,
    });
  }
  const waited = mins(ctx.nowMs - entry.since);
  const clock =
    ctx.seniority && ctx.seniority.clock !== 'queue'
      ? ` (its seniority: ${ctx.seniority.clock === 'hint' ? 'a re-board' : ctx.seniority.clock === 'park' ? 'a park that ended' : ctx.seniority.clock} at ${ctx.seniority.since})`
      : '';
  all.push({
    key: 'seniority',
    text: `first come, first served — waiting since ${new Date(entry.since).toISOString()}, ${waited} min${clock}`,
  });
  // Ordered by the vocabulary, whatever order the checks ran in.
  all.sort((a, b) => QUEUE_ORDER_KEYS.indexOf(a.key) - QUEUE_ORDER_KEYS.indexOf(b.key));
  const [first] = all;
  return { key: first.key, text: first.text, all };
}
