/**
 * The permission card (control-tower phase 138, #215; §Architecture 19 "the
 * permission card, by rule"; the design spec §6 and §8).
 *
 * A permission item is answered here in ONE press. The card says why it was
 * raised — "Raised because the AI lacks permission to …", the command, why the
 * phase needs it, the wall and its rule — then offers the scopes the item's
 * wall allows as ONE control, narrowest first, each saying what it covers and
 * when it ends, with the chosen scope's risk beside the press:
 *
 *   - low and medium are one press;
 *   - high shows what the grant reaches, asks for the rule typed back, and on
 *     a console with an owner key waits for a touch of the key inside the
 *     last five minutes — with no key, the card says so and the typed rule
 *     alone grants it;
 *   - never offers no Grant through any door: why, and the manual path as a
 *     guide.
 *
 * Every judgement is the server's (`server/permissions/grants.ts`): the risk
 * of a cell comes from the one table (`riskOf`), the blast radius it computes
 * replaces the card's own preview the moment it answers, and a press an
 * enrolled console only writes down (202 `{requested}`) is said to wait for
 * the owner — never as done. A request another door made on the item reads
 * "asked by … — confirm?", and Confirm and Refuse are the owner's.
 */

import { useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { HUMAN_STEP_SETTLED_STATES } from '@shared/human-step-model.js';
import {
  GRANT_PHASE_MAX_MS,
  GRANT_SCOPES,
  GRANT_SCOPE_WORDS,
  grantScopesOf,
  riskOf,
  type GrantScope,
  type RiskTier,
  type Wall,
} from '@shared/turn-model.js';
import { Button, Input, toast } from '@/components/ui';
import { OpsBadge } from '@/components/ui/status/ops-badge';
import { ApiError } from '@/lib/api/client';
import type { PermissionRecord } from '@/lib/api/human-steps';
import type { InboxAction, InboxItem, TurnItem } from '@/lib/api';
import { GRANTS_QUERY_KEY, permissionsApi } from '@/lib/api/permissions';
import type { AuthorityRequest } from '@/lib/api/owner';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { keys } from '@/lib/queries';
import { scrollIntoScroller } from '@/lib/scroll';
import { CommandBlock } from './guide';
import {
  OWNER_QUERY_KEY,
  ownerApi,
  ownerGateOf,
  reassertOf,
  requestedOf,
  signInAsOwner,
  withOwnerTouch,
  type OwnerGate,
} from './owner-key';

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
const LANE_SCOPES: ReadonlySet<GrantScope> = new Set<GrantScope>(['call', 'phase']);

const LANE_HOURS = GRANT_PHASE_MAX_MS / 3_600_000;

/** Which wall stopped the AI, as a person says it. */
const WALL_WORDS: Readonly<Record<Wall, string>> = Object.freeze({
  deny: 'the deny list',
  ask: 'an ask with nobody there to answer it',
  'allow-list': 'a tool outside the allow list',
  mcp: 'an MCP tool this plan was not given',
  capability: 'a capability flag that is off',
  credential: 'a missing credential',
  guard: "the console's own guard",
  sandbox: 'a sandbox or network wall',
  classifier: "Claude Code's own classifier",
});

type Lane = Pick<TurnItem, 'slug' | 'phase' | 'runId'>;

/** What a scope covers, said for this item's own lane. */
export function scopeCovers(scope: GrantScope, lane: Lane, command?: string): string {
  const phase = lane.slug && lane.phase ? `${lane.slug} phase ${lane.phase}` : 'this phase';
  switch (scope) {
    case 'call':
      return command ? 'Only this exact call, once.' : 'Only this one call, once.';
    case 'phase':
      return `Every call it matches in ${phase}, in this run.`;
    case 'plan':
      return `Every phase of ${lane.slug ?? 'this plan'} — this run and every later one.`;
    case 'repository':
      return "Every plan of this console's repository.";
    default:
      return 'Every plan on this machine, under every console.';
  }
}

/** When a grant at a scope ends. */
export function scopeEnds(scope: GrantScope): string {
  if (scope === 'call') return `Ends when it is used — ${LANE_HOURS} hours at most.`;
  if (scope === 'phase') return `Ends when this phase settles — ${LANE_HOURS} hours at most.`;
  return 'No end — until you revoke it.';
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
    return `${rule} for ${words}: phase ${lane.phase ?? '?'} of ${lane.slug ?? 'its plan'} (run ${lane.runId ?? '?'})${call}, until it ends — ${LANE_HOURS} hours at most.`;
  }
  if (scope === 'plan') {
    return `${rule} for ${words}: every phase of ${lane.slug ?? 'its plan'} — every live run of it now, and every later one — until it is revoked.`;
  }
  if (scope === 'repository') {
    return `${rule} for ${words}: every plan of this console — every live run now — until it is revoked.`;
  }
  return `${rule} for ${words}: every plan of every console here — until it is revoked.`;
}

/** "Raised because the AI lacks permission to <do Y>" — the Y. */
function doing(permission: PermissionRecord) {
  if (permission.command) {
    return (
      <>
        run <code className="font-mono break-all">{permission.command}</code>
      </>
    );
  }
  if (permission.wall === 'capability' && permission.rule) {
    return (
      <>
        work with <code className="font-mono break-all">{permission.rule}</code> off
      </>
    );
  }
  if (permission.tool) {
    return (
      <>
        use <code className="font-mono break-all">{permission.tool}</code>
      </>
    );
  }
  return 'do this';
}

/* ------------------------------------------------------------------ *
 * Grant every low-risk ask
 * ------------------------------------------------------------------ */

const SETTLED: ReadonlySet<string> = new Set(HUMAN_STEP_SETTLED_STATES);

/**
 * The open low-risk asks, each at its narrowest scope when that scope is held
 * to one lane (`call` or `phase`) — and nothing else: no projected card, no
 * never item, nothing a wider scope or a high tier would take (exit criterion 2).
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

/** The page's one press over every open low-risk ask (§Architecture 19). */
export function GrantEveryLowRisk({ items }: { items: readonly TurnItem[] }) {
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
        const answer: unknown = await permissionsApi.grant(pick.item, { scope: pick.scope });
        if (requestedOf(answer)) asked += 1;
        else granted += 1;
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
    toast(`${words.join(' · ')}.`, refused.length ? 'warn' : 'ok', refused.length ? 8000 : undefined);
    void client.invalidateQueries({ queryKey: keys.inbox() });
    void client.invalidateQueries({ queryKey: GRANTS_QUERY_KEY });
  }

  return (
    <div
      data-testid="grant-every-low"
      data-print="hide"
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <Button size="sm" disabled={busy} onClick={() => void grantAll()} className="min-h-(--tap-min)">
        {busy ? 'Granting…' : `Grant every low-risk ask (${picks.length})`}
      </Button>
      <span className="text-2xs text-ink-muted">Each for this call or this phase only.</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The owner key, as a high press needs it
 * ------------------------------------------------------------------ */

function clockOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function OwnerLine({
  gate,
  high,
  freshUntil,
  busy,
  onTouch,
}: {
  gate: OwnerGate;
  high: boolean;
  freshUntil: string | undefined;
  busy: boolean;
  onTouch: () => void;
}) {
  let words: string | null = null;
  let press: string | null = null;
  if (gate === 'unkeyed') {
    if (high) {
      words =
        'This console has no owner key, so the rule typed back is what grants it. Enrol a key in Settings ▸ Permissions ▸ Owner keys.';
    }
  } else if (gate === 'sign-in') {
    words = high
      ? 'A high-risk grant is the owner’s: sign in with your owner key to grant it here.'
      : 'This console has an owner key. From this browser without it, a grant is asked of the owner — sign in to grant it here.';
    press = 'Sign in with the owner key';
  } else if (gate === 'touch' && high) {
    words = 'Touch your owner key again — a high-risk grant needs a touch inside the last five minutes.';
    press = 'Touch the owner key';
  } else if (gate === 'fresh' && high && freshUntil) {
    words = `Owner key touched — good until ${clockOf(freshUntil)}.`;
  }
  if (!words) return null;
  return (
    <div
      data-testid="grant-owner"
      className="flex max-w-prose flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink"
    >
      <p className="min-w-0 flex-1 basis-60">{words}</p>
      {press && (
        <Button size="sm" disabled={busy} onClick={onTouch} className="min-h-(--tap-min)">
          {busy ? 'Waiting for the key…' : press}
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A request another door made — the owner's to confirm
 * ------------------------------------------------------------------ */

/** Every open request on an item: "asked by … — confirm?", with Confirm and Refuse (the owner door only). */
export function OwnerRequests({ requests }: { requests: readonly AuthorityRequest[] | undefined }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  if (!requests?.length) return null;

  async function answer(request: AuthorityRequest, how: 'confirm' | 'refuse') {
    setBusy(`${request.id}:${how}`);
    try {
      await withOwnerTouch(() =>
        how === 'confirm' ? ownerApi.ownerConfirm(request.id) : ownerApi.ownerRefuse(request.id),
      );
      toast(how === 'confirm' ? 'Confirmed — pressed as the owner.' : 'Refused — nothing was pressed.', 'ok');
    } catch (cause) {
      // A replay that failed answers 409 with the press's own words inside.
      const inner = (cause instanceof ApiError ? cause.body : undefined) as
        { result?: { answer?: { error?: string } } } | undefined;
      toast(
        inner?.result?.answer?.error ?? (cause instanceof Error ? cause.message : String(cause)),
        'warn',
        8000,
      );
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: keys.inbox() });
      void client.invalidateQueries({ queryKey: OWNER_QUERY_KEY });
      void client.invalidateQueries({ queryKey: GRANTS_QUERY_KEY });
    }
  }

  return (
    <>
      {requests.map((request) =>
        request.state === 'open' ? (
          <div
            key={request.id}
            data-testid="turn-owner-request"
            className="flex max-w-prose flex-wrap items-center gap-x-3 gap-y-1.5 border-s-2 border-accent ps-2.5 text-xs text-ink"
          >
            <p className="min-w-0 flex-1 basis-60">{request.ask}</p>
            <div className="flex gap-1.5" data-print="hide">
              <Button
                size="sm"
                variant="default"
                className="min-h-(--tap-min)"
                disabled={busy !== null}
                onClick={() => void answer(request, 'confirm')}
              >
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="min-h-(--tap-min)"
                disabled={busy !== null}
                onClick={() => void answer(request, 'refuse')}
              >
                Refuse
              </Button>
            </div>
          </div>
        ) : (
          <p key={request.id} data-testid="turn-owner-request" className="max-w-prose text-xs text-ink-muted">
            Asked of the owner: {request.summary} — {request.state}.
          </p>
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

export interface PermissionCardProps {
  item: TurnItem;
  permission: PermissionRecord;
  /** The item's row, its own actions pressed verbatim (*Deny*, *I'll do it myself*). */
  row: InboxItem;
  perform: (item: InboxItem, action: InboxAction, says?: string) => void;
  /** `${rowId}:${verb}` of whatever row action is in flight. */
  busy?: string | undefined;
  /** Open, due and not being checked: the moves are drawn. */
  live?: boolean;
}

export function PermissionCard({ item, permission, row, perform, busy, live = true }: PermissionCardProps) {
  const client = useQueryClient();
  const name = useId();
  const headingId = useId();
  const scopes = useMemo(() => offeredScopes(permission), [permission]);
  const [chosen, setChosen] = useState<GrantScope | undefined>(undefined);
  const scope = chosen && scopes.includes(chosen) ? chosen : scopes[0];
  const tier: RiskTier = permission.never || !scope ? 'never' : scopeRisk(permission, scope);
  const high = tier === 'high';
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [said, setSaid] = useState<{ scope: GrantScope; rule?: string; blast?: string } | null>(null);
  const [pressing, setPressing] = useState(false);
  const [touching, setTouching] = useState(false);
  const owner = useQuery({
    queryKey: OWNER_QUERY_KEY,
    queryFn: () => ownerApi.owner(),
    staleTime: 30_000,
    retry: 1,
  });
  const now = useNow(high && live, 15_000);
  const gate = ownerGateOf(owner.data, now);
  const lane: Lane = { slug: item.slug, phase: item.phase, runId: item.runId };
  const server = said && said.scope === scope ? said : null;
  const rule = server?.rule ?? permission.rule ?? '';
  // A rule the item does not name is the server's to say: the first press of a
  // high grant asks for it (400 `{rule, blast}`), and nothing is applied.
  const ruleTyped = rule ? typed.trim() === rule : true;
  // Until the owner door has answered, a high press waits: an enrolled console
  // must never read as keyless — not while it is asked, not when the read failed.
  const known = owner.isSuccess;
  const ownerOk = known && (gate === 'unkeyed' || gate === 'fresh');
  const canGrant = Boolean(scope) && !pressing && (!high || (ruleTyped && ownerOk));
  const grantable = !permission.never && Boolean(scope);
  const deny = item.actions.find((action) => action.verb === 'deny' && !action.flag);
  const convert = item.actions.find((action) => action.verb === 'convert' && !action.flag);

  async function touch() {
    setTouching(true);
    try {
      await signInAsOwner();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'warn', 8000);
    } finally {
      setTouching(false);
      void client.invalidateQueries({ queryKey: OWNER_QUERY_KEY });
    }
  }

  async function grantNow() {
    if (!scope) return;
    setPressing(true);
    const note = reason.trim();
    try {
      const answer: unknown = await permissionsApi.grant(item.item, {
        scope,
        ...(high ? { rule: typed.trim() } : {}),
        ...(note ? { reason: note } : {}),
      });
      const resumes = (answer as { resumes?: { launched: boolean; why?: string }[] } | null)?.resumes ?? [];
      const road = resumes.some((one) => one.launched)
        ? 'the session carries on by itself.'
        : (resumes.find((one) => one.why)?.why ?? 'the session picks it up when it next runs.');
      if (requestedOf(answer)) void client.invalidateQueries({ queryKey: OWNER_QUERY_KEY });
      toast(
        requestedOf(answer)
          ? 'Asked of the owner — it waits for a confirm with the owner key.'
          : `Granted ${rule || 'it'} for ${GRANT_SCOPE_WORDS[scope]} — ${road}`,
        'ok',
      );
    } catch (cause) {
      const body = (cause instanceof ApiError ? cause.body : undefined) as
        { rule?: string; blast?: { sentence?: string } } | undefined;
      if (cause instanceof ApiError && cause.status === 400 && body?.rule) {
        setSaid({ scope, rule: body.rule, ...(body.blast?.sentence ? { blast: body.blast.sentence } : {}) });
      }
      if (reassertOf(cause) || (cause instanceof ApiError && cause.status === 403)) {
        void client.invalidateQueries({ queryKey: OWNER_QUERY_KEY });
      }
      toast(cause instanceof Error ? cause.message : String(cause), 'warn', 8000);
    } finally {
      setPressing(false);
      void client.invalidateQueries({ queryKey: keys.inbox() });
      void client.invalidateQueries({ queryKey: GRANTS_QUERY_KEY });
    }
  }

  return (
    <div data-testid="permission-card" data-risk={tier} className="flex min-w-0 flex-col gap-3">
      <div
        data-testid="turn-permission"
        className="flex min-w-0 max-w-prose flex-col gap-1.5 text-xs text-ink"
      >
        <p className="text-sm">Raised because the AI lacks permission to {doing(permission)}.</p>
        {permission.need && (
          <p>
            <span className="font-medium">Why the phase needs it. </span>
            {permission.need}
          </p>
        )}
        {permission.command && !permission.never && <CommandBlock code={permission.command} />}
        <p className="text-ink-muted">
          Stopped by {WALL_WORDS[permission.wall] ?? permission.wall}
          {permission.rule ? (
            <>
              {' '}
              — the rule <code className="font-mono break-all text-ink">{permission.rule}</code>
            </>
          ) : null}
          .
        </p>
      </div>

      <OwnerRequests requests={item.requests} />

      {permission.never ? (
        <div
          data-testid="turn-permission-never"
          className="flex max-w-prose flex-col gap-1.5 text-xs text-ink"
        >
          <p>
            <span className="font-medium">Never granted, through any door: </span>
            {permission.never.why}.
          </p>
          <p className="font-medium">The manual path</p>
          <ol className="flex list-decimal flex-col gap-1.5 ps-5">
            <li>{permission.never.manual}</li>
            {permission.command && (
              <li className="flex flex-col gap-1">
                <span>The command, to run yourself if you mean it:</span>
                <CommandBlock code={permission.command} />
              </li>
            )}
            <li>
              Then press <em>I’ll do it myself</em>: the item becomes your own act, and its check resumes the
              session.
            </li>
          </ol>
        </div>
      ) : (
        scope &&
        live && (
          <div className="flex min-w-0 flex-col gap-2">
            <p id={headingId} className="text-xs font-medium text-ink">
              How far the grant reaches
            </p>
            <div
              role="radiogroup"
              aria-labelledby={headingId}
              data-testid="grant-scopes"
              className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]"
            >
              {scopes.map((one) => {
                const selected = one === scope;
                const reach = GRANT_SCOPES.indexOf(one);
                return (
                  <label
                    key={one}
                    data-testid="grant-scope"
                    data-scope={one}
                    data-risk={scopeRisk(permission, one)}
                    className={cn(
                      'flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-md border p-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-action',
                      selected ? 'border-action bg-action/6' : 'border-rule hover:border-rule-strong',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <input
                        type="radio"
                        name={name}
                        value={one}
                        checked={selected}
                        onChange={() => setChosen(one)}
                        className="size-4 shrink-0 accent-(--color-action)"
                      />
                      <span data-part="name" className="text-sm font-medium text-ink">
                        {SCOPE_LABEL[one]}
                      </span>
                      <span aria-hidden className="ms-auto flex shrink-0 gap-0.5">
                        {GRANT_SCOPES.map((step, index) => (
                          <span
                            key={step}
                            className={cn(
                              'h-1.5 w-2 rounded-xs',
                              index <= reach ? 'bg-ink-muted' : 'bg-rule',
                            )}
                          />
                        ))}
                      </span>
                    </span>
                    <span data-part="covers" className="text-2xs text-ink">
                      {scopeCovers(one, lane, permission.command)}
                    </span>
                    <span data-part="ends" className="text-2xs text-ink-muted">
                      {scopeEnds(one)}
                    </span>
                  </label>
                );
              })}
            </div>

            {high && (
              <div
                data-testid="grant-high"
                className="flex min-w-0 max-w-prose flex-col gap-2 rounded-md border border-failed/40 bg-failed/5 p-2.5"
              >
                <p data-testid="grant-blast" className="text-xs text-ink">
                  <span className="font-medium">What it reaches. </span>
                  {server?.blast ?? blastPreview(scope, rule || 'the rule', lane, permission.command)}
                </p>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-ink">
                  <span>
                    {rule ? (
                      <>
                        Type the rule to grant it:{' '}
                        <code data-testid="grant-rule" className="font-mono break-all">
                          {rule}
                        </code>
                      </>
                    ) : (
                      'Type the rule to grant it — the item names none, so the first press asks the console which.'
                    )}
                  </span>
                  <Input
                    value={typed}
                    data-testid="grant-typed"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={rule}
                    onFocus={(event) => scrollIntoScroller(event.currentTarget, 'center')}
                    onChange={(event) => setTyped(event.target.value)}
                    className="font-mono text-xs"
                  />
                </label>
              </div>
            )}
          </div>
        )
      )}

      {live && (
        <>
          {grantable && owner.isError && (
            <p data-testid="grant-owner" className="max-w-prose text-xs text-ink">
              The owner key’s state could not be read, so a high-risk grant waits.{' '}
              <button
                type="button"
                className="tap-row underline underline-offset-2"
                onClick={() => void owner.refetch()}
              >
                Read it again
              </button>
            </p>
          )}
          {grantable && known && (
            <OwnerLine
              gate={gate}
              high={high}
              freshUntil={owner.data?.session?.freshUntil}
              busy={touching}
              onTouch={() => void touch()}
            />
          )}
          {!permission.never && scope && (
            <label className="flex max-w-prose flex-col gap-1 text-2xs text-ink-muted">
              Why (optional) — the session reads it
              <Input
                value={reason}
                placeholder="What it is for, or what to do instead"
                onChange={(event) => setReason(event.target.value)}
                className="h-9 text-xs"
              />
            </label>
          )}
          <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-moves" data-print="hide">
            <span data-testid="grant-risk">
              <OpsBadge vocab="risk" word={tier} />
            </span>
            {!permission.never && scope && (
              <Button
                size="lg"
                variant="action"
                data-testid="turn-primary"
                data-move="grant"
                data-verb="grant"
                className="min-h-(--tap-min)"
                disabled={!canGrant}
                onClick={() => void grantNow()}
              >
                {pressing
                  ? 'Granting…'
                  : high && !rule
                    ? 'Show the rule to type'
                    : `Grant — ${SCOPE_LABEL[scope].toLowerCase()}`}
              </Button>
            )}
            {convert && (
              <Button
                size={permission.never ? 'lg' : 'sm'}
                variant={permission.never ? 'action' : 'default'}
                {...(permission.never ? { 'data-testid': 'turn-primary', 'data-move': 'row' } : {})}
                data-verb="convert"
                className="min-h-(--tap-min)"
                disabled={busy === `${row.id}:convert`}
                onClick={() => perform(row, convert)}
              >
                {convert.label}
              </Button>
            )}
            {deny && (
              <Button
                size="sm"
                variant="danger"
                data-verb="deny"
                className="min-h-(--tap-min)"
                disabled={busy === `${row.id}:deny`}
                onClick={() => perform(row, deny, reason.trim() || undefined)}
              >
                {deny.label}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
