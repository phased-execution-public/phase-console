/**
 * Grants with a scope and an end (7.0, quiet-console phase 8; the scoped grant
 * is control-tower phase 149's, #212, and the page's words phase 138's).
 *
 * The words of a grant — what each scope covers and when it ends, the tier of
 * a cell, the blast radius before the server has said — and the two presses
 * that make one: the item's own Grant (`grantItem`, through the owner door
 * like every press, `data/press.ts`) and *Grant every low-risk ask*. Every
 * judgement is the server's (`server/permissions/grants.ts`): the risk of a
 * cell comes from the one table, and a press an enrolled console only writes
 * down (202) is said to wait for the owner — never as done.
 *
 * And the hold (#270): a pressed item LEAVES THE LIST ONLY ON THE SERVER'S
 * `turn` EVENT. A press that answered 2xx is a press the server took, not a
 * grant the console has applied; until a round says the turn moved, the page
 * keeps drawing the item where it stood, saying what was pressed and that it
 * is waiting on the console — so a grant that fails to apply never vanishes
 * into a list that then looks done.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HUMAN_STEP_SETTLED_STATES, KIND_META } from '@shared/human-step-model.js';
import {
  GRANT_PHASE_MAX_MS,
  GRANT_SCOPES,
  GRANT_SCOPE_WORDS,
  grantScopesOf,
  riskOf,
  type GrantScope,
  type RiskTier,
} from '@shared/turn-model.js';
import type { PermissionRecord } from '@/data/human-steps';
import { keys } from '@/data/keys';
import { onSse } from '@/data/live';
import { GRANTS_QUERY_KEY, permissionsApi, type GrantAnswer } from '@/data/permissions';
import { press, type Pressed } from '@/data/press';
import type { TurnAnswer, TurnItem } from '@/data/turn';
import { cn } from '@/lib/cn';
import { Button, toast } from '@/ui';
import { OpsStatus } from '@/ui/status';
import { itemIds } from './page-model';

/* ------------------------------------------------------------------ *
 * The scopes, in words
 * ------------------------------------------------------------------ */

/** The control's own names for the five scopes — the reach words are `GRANT_SCOPE_WORDS`. */
export const SCOPE_LABEL: Readonly<Record<GrantScope, string>> = Object.freeze({
  call: 'This call',
  phase: 'This phase',
  plan: 'This plan',
  repository: 'This repository',
  always: 'Always',
});

/** The two scopes held to one lane — what a device may grant, and all *Grant every low-risk ask* reaches. */
export const LANE_SCOPES: ReadonlySet<GrantScope> = new Set<GrantScope>(['call', 'phase']);

export const LANE_HOURS = GRANT_PHASE_MAX_MS / 3_600_000;

export type Lane = Pick<TurnItem, 'slug' | 'phase' | 'runId'>;

/** What a scope covers, said for this item's own lane. */
export function scopeCovers(scope: GrantScope, lane: Lane, command?: string): string {
  const phase = lane.slug && lane.phase ? `${lane.slug} phase ${lane.phase}` : 'this phase';
  switch (scope) {
    case 'call':
      return command ? 'Only this exact call, once.' : 'Only this one call, once.';
    case 'phase':
      return `Every call it matches in ${phase}, in this run.`;
    case 'plan':
      return `Every phase of ${lane.slug ?? 'this plan'}, this run and every later one.`;
    case 'repository':
      return "Every plan of this console's repository.";
    default:
      return 'Every plan on this machine, under every console.';
  }
}

/** When a grant at a scope ends. */
export function scopeEnds(scope: GrantScope): string {
  if (scope === 'call') return `Ends when it is used, ${LANE_HOURS} hours at most.`;
  if (scope === 'phase') return `Ends when this phase settles, ${LANE_HOURS} hours at most.`;
  return 'No end until you revoke it.';
}

/** The scopes an item offers: the server's list, else the risk table's, none for a never item. */
export function offeredScopes(permission: PermissionRecord): GrantScope[] {
  if (permission.never) return [];
  return permission.scopes ?? grantScopesOf({ wall: permission.wall, family: permission.family ?? 'any' });
}

/** The tier of granting this item at one scope — `GRANT_RISK`'s, the server's own table. */
export function scopeRisk(permission: PermissionRecord, scope: GrantScope): RiskTier {
  return riskOf({ wall: permission.wall, family: permission.family ?? 'any', scope });
}

/** What a grant at a scope reaches, before the server has said — the shape of its own sentence. */
export function blastPreview(scope: GrantScope, rule: string, lane: Lane, command?: string): string {
  const words = GRANT_SCOPE_WORDS[scope];
  if (LANE_SCOPES.has(scope)) {
    const call = scope === 'call' && command ? `, the call ${command} only` : '';
    return `${rule} for ${words}: phase ${lane.phase ?? '?'} of ${lane.slug ?? 'its plan'} (run ${lane.runId ?? '?'})${call}, until it ends, ${LANE_HOURS} hours at most.`;
  }
  if (scope === 'plan') {
    return `${rule} for ${words}: every phase of ${lane.slug ?? 'its plan'}, every live run of it now and every later one, until it is revoked.`;
  }
  if (scope === 'repository') {
    return `${rule} for ${words}: every plan of this console, every live run now, until it is revoked.`;
  }
  return `${rule} for ${words}: every plan of every console here, until it is revoked.`;
}

/** The reach of a scope, drawn: five marks, the first N filled. */
export function ReachMarks({ scope }: { scope: GrantScope }) {
  const reach = GRANT_SCOPES.indexOf(scope);
  return (
    <span aria-hidden className="flex shrink-0 gap-0.5">
      {GRANT_SCOPES.map((step, index) => (
        <span
          key={step}
          className={cn('h-1.5 w-2 rounded-xs', index <= reach ? 'bg-ink-muted' : 'bg-rule')}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * The presses
 * ------------------------------------------------------------------ */

export type GrantBody = { scope: GrantScope; rule?: string; reason?: string };

/** The item's Grant, through the owner door — `done` with the server's row, or `asked` of the owner. */
export function grantItem(id: string, body: GrantBody): Promise<Pressed<GrantAnswer>> {
  return press(() => permissionsApi.grant(id, body));
}

/** What a grant that went through says — and how the session goes on. */
export function grantedWords(rule: string, scope: GrantScope, answer: GrantAnswer): string {
  const road = answer.resumes.some((one) => one.launched)
    ? 'the session carries on by itself.'
    : (answer.resumes.find((one) => one.why)?.why ?? 'the session picks it up when it next runs.');
  return `Granted ${rule || 'it'} for ${GRANT_SCOPE_WORDS[scope]}: ${road}`;
}

const SETTLED: ReadonlySet<string> = new Set(HUMAN_STEP_SETTLED_STATES);

/**
 * The open low-risk asks, each at its narrowest scope when that scope is held
 * to one lane (`call` or `phase`) — and nothing else: no projected card, no
 * never item, nothing a wider scope or a high tier would take.
 */
export function lowRiskGrants(items: readonly TurnItem[]): { item: string; scope: GrantScope }[] {
  const picks: { item: string; scope: GrantScope }[] = [];
  for (const one of items) {
    if (one.record !== 'ledger') continue;
    const state = one.step?.state ?? one.humanStep?.state ?? 'notified';
    if (SETTLED.has(state) || state === 'upcoming' || state === 'checking') continue;
    const permission = one.permission ?? one.step?.permission;
    if (!permission || permission.never) continue;
    if (!one.actions.some((action) => action.verb === 'grant' && !action.flag)) continue;
    const scope = offeredScopes(permission)[0];
    if (!scope || !LANE_SCOPES.has(scope) || scopeRisk(permission, scope) !== 'low') continue;
    picks.push({ item: one.item, scope });
  }
  return picks;
}

/** The page's one press over every open low-risk ask (§Architecture 19) — Do now's one control. */
export function GrantEveryLowRisk({
  items,
  onSettled,
}: {
  items: readonly TurnItem[];
  /** Each item pressed is held on the page until the server's `turn` event (#270). */
  onSettled?: ((item: TurnItem, words: string) => void) | undefined;
}) {
  const client = useQueryClient();
  const picks = useMemo(() => lowRiskGrants(items), [items]);
  const [busy, setBusy] = useState(false);
  if (!picks.length) return null;

  async function grantAll() {
    setBusy(true);
    let granted = 0;
    let asked = 0;
    const refused: string[] = [];
    for (const pick of picks) {
      try {
        const pressed = await grantItem(pick.item, { scope: pick.scope });
        const item = items.find((one) => one.item === pick.item);
        if (pressed.state === 'asked') {
          asked += 1;
          if (item) onSettled?.(item, ASKED_WORDS);
        } else {
          granted += 1;
          if (item) onSettled?.(item, settlingWords(pick.scope));
        }
      } catch (cause) {
        refused.push(cause instanceof Error ? cause.message : String(cause));
      }
    }
    setBusy(false);
    const words = [
      granted ? `Granted ${granted}` : '',
      asked ? `${asked} asked of the owner` : '',
      refused.length ? `${refused.length} refused: ${refused[0]}` : '',
    ].filter(Boolean);
    toast(`${words.join(', ')}.`, refused.length ? 'warn' : 'ok', refused.length ? 8000 : undefined);
    void client.invalidateQueries({ queryKey: keys.inbox() });
    void client.invalidateQueries({ queryKey: GRANTS_QUERY_KEY });
  }

  return (
    <div
      data-testid="grant-every-low"
      data-print="hide"
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <Button size="sm" disabled={busy} onClick={() => void grantAll()}>
        {busy ? 'Granting…' : `Grant every low-risk ask (${picks.length})`}
      </Button>
      <span className="text-meta text-ink-muted">Each for this call or this phase only.</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The hold — an item leaves the list only on the server's `turn` event (#270)
 * ------------------------------------------------------------------ */

export const ASKED_WORDS =
  'Asked of the owner. It waits for a confirm with the owner key, and leaves this list once the console records the answer.';

/** What a granted item says while it waits on the console's word. */
export function settlingWords(scope: GrantScope): string {
  return `Granted for ${GRANT_SCOPE_WORDS[scope]}. It leaves this list once the console confirms the grant applied.`;
}

/** An item pressed on this page whose answer the server has not yet folded into the turn. */
export interface Settling {
  item: TurnItem;
  words: string;
  at: string;
}

/**
 * The page's holds: what was pressed here, drawn where it stood until the
 * `turn` event says the turn moved. An item the fresh answer still holds is
 * not held — it is drawn by the answer, as it now reads (a grant that did not
 * apply is one that came back).
 */
export function useSettling(answer: TurnAnswer | undefined): {
  settling: readonly Settling[];
  settle: (item: TurnItem, words: string) => void;
} {
  const [held, setHeld] = useState<ReadonlyMap<string, Settling>>(() => new Map());
  // The server's word: a round changed the turn, and every hold ends with it.
  useEffect(
    () =>
      onSse('turn', () => {
        setHeld((prev) => (prev.size ? new Map() : prev));
      }),
    [],
  );
  const settle = useCallback((item: TurnItem, words: string) => {
    setHeld((prev) => new Map(prev).set(item.item, { item, words, at: new Date().toISOString() }));
  }, []);
  const present = useMemo(() => itemIds(answer), [answer]);
  const settling = useMemo(
    () => [...held.values()].filter((one) => !present.has(one.item.item)),
    [held, present],
  );
  return { settling, settle };
}

/** A held item, as its own row: the title, the kind, and what was pressed — nothing to press again. */
export function SettlingRow({ settling }: { settling: Settling }) {
  const { item, words } = settling;
  return (
    <article
      id={`turn-item-${item.item}`}
      data-testid="turn-item"
      data-item={item.item}
      data-kind={item.kind}
      data-group={item.group}
      data-record={item.record}
      data-state="settling"
      data-settling=""
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-rule bg-surface p-4 sm:p-5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <OpsStatus vocab="step" word="checking" />
        <span className="text-meta text-ink-muted">{KIND_META[item.kind]?.label ?? item.kind}</span>
      </div>
      <h3 className="max-w-(--measure) text-section font-semibold text-ink">
        {item.step?.title ?? item.title}
      </h3>
      <p data-testid="turn-settling" className="max-w-(--measure) text-body text-ink-muted">
        {words}
      </p>
    </article>
  );
}
