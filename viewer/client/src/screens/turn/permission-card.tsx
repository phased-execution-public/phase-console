/**
 * The permission card (7.0, quiet-console phase 8; control-tower phase 138,
 * #215; §Architecture 19 "the permission card, by rule").
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
 *   - never offers no Grant through any door: why, and the manual path.
 *
 * Every judgement is the server's (`server/permissions/grants.ts`): the risk
 * of a cell comes from the one table (`riskOf`), the blast radius it computes
 * replaces the card's own preview the moment it answers, and a press the door
 * only wrote down (202) is said to wait for the owner — never as done. The
 * press goes through `data/press.ts` (`grantItem`), and a grant that went
 * through does NOT take the item off the page: it is held, saying so, until
 * the server's `turn` event (#270).
 *
 * A request another door made on the item is the owner's to confirm (#277):
 * the prompt shows WHO asked, through WHICH door, and EXACTLY what the server
 * will replay — the method, the path and the body — never a label the page
 * composed for it.
 */

import { useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GRANT_SCOPE_WORDS, type GrantScope, type RiskTier, type Wall } from '@shared/turn-model.js';
import { CommandBlock } from '@/cards/guide';
import { stamp } from '@/cards/human-step-card';
import type { InboxAction, InboxItem } from '@/data/api';
import type { PermissionRecord } from '@/data/human-steps';
import { keys } from '@/data/keys';
import {
  ownerApi,
  ownerGateOf,
  signInAsOwner,
  useOwner,
  type AuthorityRequest,
  type OwnerGate,
} from '@/data/owner';
import { GRANTS_QUERY_KEY } from '@/data/permissions';
import { PressRefusal, press, replayWords } from '@/data/press';
import { ApiError } from '@/data/http';
import type { TurnItem } from '@/data/turn';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { scrollIntoScroller } from '@/lib/scroll';
import { Button, Input, toast } from '@/ui';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { OpsStatus } from '@/ui/status';
import {
  ASKED_WORDS,
  ReachMarks,
  SCOPE_LABEL,
  blastPreview,
  grantItem,
  grantedWords,
  offeredScopes,
  scopeCovers,
  scopeEnds,
  scopeRisk,
  settlingWords,
  type Lane,
} from './grants';

/** Which wall stopped the AI, as a person says it. */
export const WALL_WORDS: Readonly<Record<Wall, string>> = Object.freeze({
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

/** "Raised because the AI lacks permission to <do Y>" — the Y. */
function doing(permission: PermissionRecord) {
  if (permission.command) {
    return (
      <>
        run <code className="font-mono text-meta wrap-anywhere">{permission.command}</code>
      </>
    );
  }
  if (permission.wall === 'capability' && permission.rule) {
    return (
      <>
        work with <code className="font-mono text-meta wrap-anywhere">{permission.rule}</code> off
      </>
    );
  }
  if (permission.tool) {
    return (
      <>
        use <code className="font-mono text-meta wrap-anywhere">{permission.tool}</code>
      </>
    );
  }
  return 'do this';
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
  let pressWords: string | null = null;
  if (gate === 'unkeyed') {
    if (high) {
      words =
        'This console has no owner key, so the rule typed back is what grants it. Enrol a key in Settings ▸ Permissions ▸ Owner keys.';
    }
  } else if (gate === 'sign-in') {
    words = high
      ? 'A high-risk grant is the owner’s: sign in with your owner key to grant it here.'
      : 'This console has an owner key. From this browser without it, a grant is asked of the owner. Sign in to grant it here.';
    pressWords = 'Sign in with the owner key';
  } else if (gate === 'touch' && high) {
    words = 'Touch your owner key again: a high-risk grant needs a touch inside the last five minutes.';
    pressWords = 'Touch the owner key';
  } else if (gate === 'fresh' && high && freshUntil) {
    words = `Owner key touched, good until ${clockOf(freshUntil)}.`;
  }
  if (!words) return null;
  return (
    <div
      data-testid="grant-owner"
      className="flex max-w-(--measure) flex-wrap items-center gap-x-3 gap-y-1.5 text-meta text-ink"
    >
      <p className="min-w-0 flex-1 basis-60">{words}</p>
      {pressWords && (
        <Button size="sm" disabled={busy} onClick={onTouch}>
          {busy ? 'Waiting for the key…' : pressWords}
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A request another door made — the owner's to confirm (#277)
 * ------------------------------------------------------------------ */

/** The press, replayed: the method and the path on one line, the body under it, exactly as the server holds them. */
export function RequestReplay({ request }: { request: AuthorityRequest }) {
  const body =
    request.body && Object.keys(request.body).length ? JSON.stringify(request.body, null, 2) : null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <code data-testid="turn-owner-replay" className="font-mono text-meta wrap-anywhere text-ink">
        {request.method} {request.path}
      </code>
      {body && (
        <pre
          data-testid="turn-owner-body"
          className="max-w-full overflow-x-auto rounded bg-ground px-2 py-1.5 font-mono text-meta text-ink"
        >
          {body}
        </pre>
      )}
    </div>
  );
}

/**
 * Every open request on an item — who asked, through which door, and exactly
 * what will be replayed — with Confirm and Refuse, the owner door's. A settled
 * one is one line: what was asked, and how it ended.
 */
export function OwnerRequests({ requests }: { requests: readonly AuthorityRequest[] | undefined }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  if (!requests?.length) return null;

  async function answer(request: AuthorityRequest, how: 'confirm' | 'refuse') {
    setBusy(`${request.id}:${how}`);
    try {
      const pressed = await press(() =>
        how === 'confirm' ? ownerApi.ownerConfirm(request.id) : ownerApi.ownerRefuse(request.id),
      );
      if (pressed.state === 'asked') toast(pressed.words, 'info', 8000);
      else
        toast(how === 'confirm' ? 'Confirmed, pressed as the owner.' : 'Refused. Nothing was pressed.', 'ok');
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
      void client.invalidateQueries({ queryKey: keys.owner() });
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
            data-request={request.id}
            className="state-needs-you flex min-w-0 max-w-(--measure) flex-col gap-2 border-s-2 border-state ps-3 text-body text-ink"
          >
            <p>
              <span className="font-medium">{request.label}</span>
              {request.claims && request.claims !== request.label ? (
                <>
                  {' '}
                  (which calls itself{' '}
                  <span data-testid="turn-owner-claims" className="text-ink-muted">
                    “{request.claims}”
                  </span>
                  )
                </>
              ) : null}{' '}
              asked through the {request.door} door, {stamp(request.at)}
              {request.repeats > 0 ? `, ${request.repeats + 1} times` : ''}. The owner confirms exactly this:
            </p>
            <RequestReplay request={request} />
            <div className="flex flex-wrap gap-1.5" data-print="hide">
              <Button
                size="sm"
                variant="primary"
                data-testid="turn-owner-confirm"
                disabled={busy !== null}
                onClick={() => void answer(request, 'confirm')}
              >
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="turn-owner-refuse"
                disabled={busy !== null}
                onClick={() => void answer(request, 'refuse')}
              >
                Refuse
              </Button>
            </div>
          </div>
        ) : (
          <p
            key={request.id}
            data-testid="turn-owner-request"
            data-request={request.id}
            className="max-w-(--measure) text-meta text-ink-muted"
          >
            Asked of the owner by {request.label}: {replayWords(request).replace(/^.*?: /, '')}.{' '}
            {request.state}
            {request.settledAt ? `, ${stamp(request.settledAt)}` : ''}.
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
  /** A grant went through, or was asked of the owner: the page holds the item until the `turn` event (#270). */
  onSettled?: ((words: string) => void) | undefined;
}

export function PermissionCard({
  item,
  permission,
  row,
  perform,
  busy,
  live = true,
  onSettled,
}: PermissionCardProps) {
  const client = useQueryClient();
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
  const [held, setHeld] = useState<string | null>(null);
  const owner = useOwner();
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
  const canGrant = Boolean(scope) && !pressing && !held && (!high || (ruleTyped && ownerOk));
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
      void client.invalidateQueries({ queryKey: keys.owner() });
    }
  }

  async function grantNow() {
    if (!scope) return;
    setPressing(true);
    const note = reason.trim();
    try {
      const pressed = await grantItem(item.item, {
        scope,
        ...(high ? { rule: typed.trim() } : {}),
        ...(note ? { reason: note } : {}),
      });
      if (pressed.state === 'asked') {
        // Written down for the owner, not done: the item waits here, saying so.
        setHeld(ASKED_WORDS);
        onSettled?.(ASKED_WORDS);
        toast(`Asked of the owner: ${replayWords(pressed.request)}.`, 'info', 8000);
        void client.invalidateQueries({ queryKey: keys.owner() });
      } else {
        // Taken by the server, not yet confirmed applied: held until the `turn` event (#270).
        const words = settlingWords(scope);
        setHeld(words);
        onSettled?.(words);
        toast(grantedWords(rule, scope, pressed.result), 'ok');
      }
    } catch (cause) {
      const body = (cause instanceof ApiError ? cause.body : undefined) as
        { rule?: string; blast?: { sentence?: string } } | undefined;
      if (cause instanceof PressRefusal && cause.status === 400 && body?.rule) {
        setSaid({ scope, rule: body.rule, ...(body.blast?.sentence ? { blast: body.blast.sentence } : {}) });
      }
      if (cause instanceof PressRefusal && cause.door) {
        void client.invalidateQueries({ queryKey: keys.owner() });
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
        className="flex min-w-0 max-w-(--measure) flex-col gap-1.5 text-body text-ink"
      >
        <p>Raised because the AI lacks permission to {doing(permission)}.</p>
        {permission.need && (
          <p>
            <span className="font-medium">Why the phase needs it. </span>
            {permission.need}
          </p>
        )}
        {permission.command && !permission.never && <CommandBlock code={permission.command} />}
        <p className="text-meta text-ink-muted">
          Stopped by {WALL_WORDS[permission.wall] ?? permission.wall}
          {permission.rule ? (
            <>
              , the rule <code className="font-mono wrap-anywhere text-ink">{permission.rule}</code>
            </>
          ) : null}
          .
        </p>
      </div>

      <OwnerRequests requests={item.requests} />

      {permission.never ? (
        <div
          data-testid="turn-permission-never"
          className="flex max-w-(--measure) flex-col gap-1.5 text-body text-ink"
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
        live &&
        !held && (
          <div className="flex min-w-0 flex-col gap-2">
            <p id={headingId} className="text-meta font-medium text-ink">
              How far the grant reaches
            </p>
            <RadioGroup
              aria-labelledby={headingId}
              data-testid="grant-scopes"
              value={scope}
              onValueChange={(next) => setChosen(next as GrantScope)}
              className="sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]"
            >
              {scopes.map((one) => (
                <div
                  key={one}
                  data-testid="grant-scope"
                  data-scope={one}
                  data-risk={scopeRisk(permission, one)}
                >
                  <RadioItem
                    id={`${headingId}-${one}`}
                    value={one}
                    className="h-full"
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <span data-part="name" className="font-medium">
                          {SCOPE_LABEL[one]}
                        </span>
                        <span className="ms-auto">
                          <ReachMarks scope={one} />
                        </span>
                      </span>
                    }
                    description={
                      <>
                        <span data-part="covers" className="block text-ink">
                          {scopeCovers(one, lane, permission.command)}
                        </span>
                        <span data-part="ends" className="block">
                          {scopeEnds(one)}
                        </span>
                      </>
                    }
                  />
                </div>
              ))}
            </RadioGroup>

            {high && (
              <div
                data-testid="grant-high"
                className="flex min-w-0 max-w-(--measure) flex-col gap-2 rounded-md border border-failed/40 bg-failed/5 p-2.5"
              >
                <p data-testid="grant-blast" className="text-body text-ink">
                  <span className="font-medium">What it reaches. </span>
                  {server?.blast ?? blastPreview(scope, rule || 'the rule', lane, permission.command)}
                </p>
                <label className="flex min-w-0 flex-col gap-1 text-body text-ink">
                  <span>
                    {rule ? (
                      <>
                        Type the rule to grant it:{' '}
                        <code data-testid="grant-rule" className="font-mono text-meta wrap-anywhere">
                          {rule}
                        </code>
                      </>
                    ) : (
                      'Type the rule to grant it. The item names none, so the first press asks the console which.'
                    )}
                  </span>
                  <Input
                    value={typed}
                    data-testid="grant-typed"
                    block
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={rule}
                    onFocus={(event) => scrollIntoScroller(event.currentTarget, 'center')}
                    onChange={(event) => setTyped(event.target.value)}
                    className="font-mono text-meta"
                  />
                </label>
              </div>
            )}
          </div>
        )
      )}

      {held && (
        <p data-testid="grant-settling" className="max-w-(--measure) text-body text-ink-muted">
          {held}
        </p>
      )}

      {live && !held && (
        <>
          {grantable && owner.isError && (
            <p data-testid="grant-owner" className="max-w-(--measure) text-meta text-ink">
              The owner key’s state could not be read, so a high-risk grant waits.{' '}
              <Button variant="ghost" size="sm" onClick={() => void owner.refetch()}>
                Read it again
              </Button>
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
            <label className="flex max-w-(--measure) flex-col gap-1 text-meta text-ink-muted">
              Why (optional). The session reads it.
              <Input
                value={reason}
                block
                placeholder="What it is for, or what to do instead"
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}
          <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-moves" data-print="hide">
            <span data-testid="grant-risk">
              <OpsStatus vocab="risk" word={tier} />
            </span>
            {!permission.never && scope && (
              <Button
                variant="primary"
                data-testid="turn-primary"
                data-move="grant"
                data-verb="grant"
                className={cn('shrink whitespace-normal h-auto min-h-8', high && 'min-h-(--tap-min)')}
                disabled={!canGrant}
                onClick={() => void grantNow()}
              >
                {pressing
                  ? 'Granting…'
                  : high && !rule
                    ? 'Show the rule to type'
                    : `Grant, ${SCOPE_LABEL[scope].toLowerCase()}`}
              </Button>
            )}
            {convert && (
              <Button
                variant={permission.never ? 'primary' : 'default'}
                {...(permission.never ? { 'data-testid': 'turn-primary', 'data-move': 'row' } : {})}
                data-verb="convert"
                className="shrink whitespace-normal h-auto min-h-8"
                disabled={busy === `${row.id}:convert`}
                onClick={() => perform(row, convert)}
              >
                {convert.label}
              </Button>
            )}
            {deny && (
              <Button
                variant="danger"
                data-verb="deny"
                className="shrink whitespace-normal h-auto min-h-8"
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

/** The scope a Grant row action carries — what the row's own primary would press. */
export function scopeOfAction(action: Pick<InboxAction, 'body'> | undefined): GrantScope | undefined {
  const scope = (action?.body as { scope?: unknown } | undefined)?.scope;
  return typeof scope === 'string' && scope in GRANT_SCOPE_WORDS ? (scope as GrantScope) : undefined;
}
