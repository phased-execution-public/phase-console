/**
 * A session this console does NOT own, as a page — and the one thing it can
 * honestly do about it (7.0, quiet-console phase 15; the page since Phase 8).
 *
 * The presence hook reports every `claude` on this machine, so the list can
 * always say one EXISTS. Driving it is narrower: a `claude` someone started in
 * their own terminal owns that tty, there is no multiplexer in this tree, and
 * nothing here can put a browser in front of it. What can be done is resume
 * the CONVERSATION — `claude --resume <uuid>` — in a pty this console owns.
 * So the page offers one verb, in two shapes that are not cosmetic:
 *
 *   - presence `ended` → **Resume**: nothing else reads that conversation.
 *   - presence `live` (or `unknown`, read as live) → **Take over**, behind a
 *     confirm that says what actually happens: two processes on one
 *     conversation, and the one you can see does not stop.
 *
 * It never writes to the registry: the hook is the only writer of a foreign
 * record, and a resume becomes an ordinary pty of this console's own.
 */

import { Play } from 'lucide-react';
import type { ForeignSession } from '@/data/api';
import { endedLabel, foreignVehicle, turnsLabel } from '@/data/lanes';
import { phaseHref } from '@/shell/routes';
import { Banner, Button, KeyValue, Mono, Page, RelativeTime } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { AttentionMark, OpsStatus } from '@/ui/status';
import { attentionWords, foreignLabel } from './model';

/** The refusal the server gives for the same request — said here first, verbatim. */
export const AGENT_FLAG_REFUSAL = 'Agent sessions are disabled. Restart with --allow-agent to enable them.';

export type ForeignAction =
  /** Nothing else is reading that conversation. */
  | { kind: 'resume'; verb: 'Resume'; confirm: false }
  /** Something is (or might be) — the confirm says what a second process means. */
  | { kind: 'takeover'; verb: 'Take over'; confirm: true }
  /** The console cannot mint a claude session at all. */
  | { kind: 'refused'; reason: string };

/**
 * What this console may offer for a foreign session, and whether it must ask
 * first. `unknown` folds into `live`: the hook has not vouched for the session
 * recently, and the conservative reading of "might still be running" asks.
 */
export function foreignAction(session: Pick<ForeignSession, 'presence'>, allowAgent: boolean): ForeignAction {
  if (!allowAgent) return { kind: 'refused', reason: AGENT_FLAG_REFUSAL };
  if (session.presence === 'ended') return { kind: 'resume', verb: 'Resume', confirm: false };
  return { kind: 'takeover', verb: 'Take over', confirm: true };
}

/**
 * 🔴 Is this session's directory one the console has any reason to trust?
 *
 * The resume starts in the cwd the registry recorded, and the registry is fed
 * by `POST /hooks/session`, which is deliberately exempt from the console
 * header and the Origin check (the hook is a shell script) — so a forged
 * record chooses a directory, and a directory chooses a project's `CLAUDE.md`
 * and `.claude/settings.json`, which can define hooks. The mint itself is
 * CSRF-guarded, so the attack needs a real click on this page, which is why
 * the guard is here: nothing is refused, but a directory the console does not
 * recognise makes the action take the confirm and puts the path in front of
 * the person clicking.
 *
 * "Recognised" is the open root or a recent one, prefix-matched on a path
 * boundary. A cwd not already in normal form is unfamiliar by that fact alone:
 * a real record comes from a shell's `$PWD`, and the only thing that arrives
 * with a `.` or `..` segment is something that wants to look like somewhere
 * else (`/repo/../../tmp/evil` starts with `/repo/`). An open root of `/`
 * makes every directory familiar — a larger decision already made.
 */
export function unfamiliarDirectory(cwd: string, roots: readonly string[]): boolean {
  if (!cwd || !cwd.startsWith('/')) return true;
  if (normalizePath(cwd) !== cwd) return true;
  return !roots.some(
    (root) => root && (cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)),
  );
}

/** `/a/b/../c` → `/a/c`, lexically (a browser has no `node:path`) — only to ask "was this already normal?". */
function normalizePath(input: string): string {
  const out: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`;
}

/** The sentence the confirm must say before a second process is started. */
export function takeoverConsequence(session: Pick<ForeignSession, 'presence'>): string {
  const what = session.presence === 'live' ? 'is running' : 'may still be running';
  return (
    `This session ${what}. Nothing can attach to a terminal someone else is typing in — ` +
    'there is no multiplexer here — so this starts a SECOND claude on the same conversation. ' +
    'Both processes write to the same transcript, and the session you can see keeps running: ' +
    'this does not stop it.'
  );
}

export function ForeignSessionPage({
  session,
  allowAgent,
  busy,
  capNote,
  roots = [],
  onResume,
}: {
  session: ForeignSession;
  allowAgent: boolean;
  /** A mint is in flight — the button must not start a second one. */
  busy?: boolean;
  /** Why a session cannot be started right now (the cap), when that is so. */
  capNote?: string | undefined;
  /** Directories this console knows: the open root and the recent ones. */
  roots?: readonly string[];
  onResume: () => void;
}) {
  const action = foreignAction(session, allowAgent);
  const title = foreignLabel(session);
  const ended = session.presence === 'ended';
  const unfamiliar = unfamiliarDirectory(session.cwd, roots);
  // Either reason is enough to ask — a second process on one conversation, or
  // a directory the console cannot place — and the dialog asks whichever applies.
  const mustConfirm = action.kind === 'takeover' || unfamiliar;
  const where = (
    <>
      It starts in <Mono value={session.cwd} className="wrap-anywhere" />, where the session was working.
    </>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="foreign-session">
      <Page
        title={title}
        lead="A Claude session on this machine that this console did not start — the session-presence hook reported it. It cannot be attached to; its conversation can be resumed here."
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <OpsStatus vocab="presence" word={session.presence} size="md" live={session.presence === 'live'} />
          {session.presence === 'live' && session.waiting && (
            <>
              <AttentionMark level="needs-you" size="md" />
              <span className="text-body text-ink-muted">{attentionWords(session.waiting)}</span>
            </>
          )}
        </div>

        <KeyValue
          items={[
            ['Session', <Mono key="id" value={session.sessionId} copyable className="wrap-anywhere" />],
            ['What', foreignVehicle(session)],
            ['Directory', <Mono key="cwd" value={session.cwd} className="wrap-anywhere" />],
            session.owner ? ['Owner', <Mono key="owner" value={session.owner} />] : null,
            session.scope ? ['Scope', <Mono key="scope" value={session.scope} />] : null,
            session.plan
              ? [
                  'Phase',
                  <a
                    key="phase"
                    className="underline-offset-2 hover:underline"
                    href={phaseHref(session.plan.slug, session.plan.phase)}
                  >
                    {session.plan.slug} P{session.plan.phase}
                    {!session.plan.strong && (
                      <span className="text-ink-muted">, correlated by its owner and its clock</span>
                    )}
                  </a>,
                ]
              : null,
            [
              'Turns',
              session.turnsSource === 'unknown' ? (
                <span title="This record moved many times and never saw a Stop hook, so its count of 0 was never counted.">
                  unknown
                </span>
              ) : (
                turnsLabel(session)
              ),
            ],
            ['Last seen', <RelativeTime key="seen" at={session.lastSeen} />],
            session.endedAt
              ? [
                  endedLabel(session) ?? 'Ended',
                  session.endedBy === 'probe' ? (
                    <span key="ended">
                      after <RelativeTime at={session.endedAt} /> — its last sign of life; the process was
                      found gone{' '}
                      {session.endedDetectedAt ? <RelativeTime at={session.endedDetectedAt} /> : 'later'}
                    </span>
                  ) : (
                    <span key="ended">
                      <RelativeTime at={session.endedAt} /> — reported by the session
                    </span>
                  ),
                ]
              : null,
            session.pid ? ['Process', <Mono key="pid" value={String(session.pid)} />] : null,
          ]}
        />

        {action.kind === 'refused' ? (
          <p className="text-body text-ink-muted" data-testid="foreign-refused">
            {action.reason}
          </p>
        ) : (
          <section
            aria-label={action.verb}
            className="flex min-w-0 max-w-(--measure) flex-col gap-3 rounded-lg border border-rule bg-surface p-4 sm:p-5"
          >
            <p className="text-body text-ink">
              {ended
                ? 'Resuming starts a new Claude on this conversation, in this console, with its history.'
                : takeoverConsequence(session)}{' '}
              {where}
            </p>
            {unfamiliar && (
              <Banner severity="warn" data-testid="foreign-unfamiliar">
                This console does not know that directory. A resume starts where the record says, and a
                project outside the open root (and the recent ones) can carry its own settings and hooks —
                read it before you start anything there.
              </Banner>
            )}
            {mustConfirm ? (
              <ConfirmButton
                variant="primary"
                className="self-start"
                disabled={busy || Boolean(capNote)}
                title={
                  action.kind === 'takeover' ? `Take over ${title}?` : `Start ${title} in ${session.cwd}?`
                }
                description={
                  <>
                    {action.kind === 'takeover' && <>{takeoverConsequence(session)} </>}
                    {unfamiliar && (
                      <>
                        It starts in <Mono value={session.cwd} className="wrap-anywhere" />, which is not the
                        open root or one of the recent ones. Whatever settings and hooks that project carries
                        apply to the session you are about to start.
                      </>
                    )}
                  </>
                }
                confirmLabel={action.kind === 'takeover' ? 'Start a second session' : 'Start it there'}
                onConfirm={onResume}
              >
                <Play size={15} aria-hidden /> {action.verb}
              </ConfirmButton>
            ) : (
              <Button
                variant="primary"
                className="self-start"
                disabled={busy || Boolean(capNote)}
                onClick={onResume}
              >
                <Play size={15} aria-hidden /> {action.verb}
              </Button>
            )}
            {capNote && <p className="text-meta text-ink-muted">{capNote}</p>}
          </section>
        )}
      </Page>
    </div>
  );
}
