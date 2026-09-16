/**
 * A session this console does NOT own, as a page — and the one thing it can
 * honestly do about it.
 *
 * ## What "open" can mean, and what it cannot
 *
 * The session-presence hook reports every `claude` on this machine, so the
 * Sessions list has always been able to say one EXISTS. Driving it is a
 * different question, and the honest answer is narrow: a `claude` someone
 * started in their own terminal owns that tty, there is no multiplexer in this
 * tree, and nothing here can put a browser in front of it.
 *
 * What can be done is resume the CONVERSATION: `claude --resume <uuid>` starts
 * a new process on the same transcript, in a pty this console owns — which is
 * the mechanism the ended-session banner has used since 3.0, pointed at a
 * session the console never started.
 *
 * So the page offers exactly two verbs, and the difference between them is not
 * cosmetic:
 *
 *   - presence `ended` → **Resume**. Nothing else is reading that conversation;
 *     this is the plain, safe case and is offered plainly.
 *   - presence `live` (or `unknown`, which the registry reads as live) →
 *     **Take over**, behind a confirm that says what actually happens: two
 *     processes on one conversation, and the one you can see does not stop.
 *
 * A dialog that said "resume" over a live session would be the same defect the
 * restart dialog had before Phase 7 — a sentence claiming an outcome the code
 * does not produce.
 *
 * ## What it never does
 *
 * It never writes to the registry. The hook is the only writer of a foreign
 * session record; this page reads one, and a resume it starts becomes an
 * ordinary pty of this console's own (with its own new record, written by the
 * hook, when the resumed session reports itself).
 */

import { ExternalLink, Play, Users } from 'lucide-react';
import { phaseHref } from '@shared/routes.js';
import type { ForeignSession } from '@/lib/api';
import { endedLabel, foreignVehicle, turnsLabel } from '@/features/now/model';
import { Button, Chip, ConfirmButton, KeyValue, RelativeTime, StatusBadge, StatusDot } from '@/components/ui';

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
 * first. Pure, and exported for tests: the presence rule is the phase's whole
 * point and belongs somewhere a test can state it without a DOM.
 *
 * `unknown` is deliberately folded into `live`. It means the hook has not
 * vouched for the session recently — the same three-valued presence the
 * registry uses everywhere else — and the conservative reading of "might still
 * be running" is the one that asks.
 */
export function foreignAction(session: Pick<ForeignSession, 'presence'>, allowAgent: boolean): ForeignAction {
  if (!allowAgent) return { kind: 'refused', reason: AGENT_FLAG_REFUSAL };
  if (session.presence === 'ended') return { kind: 'resume', verb: 'Resume', confirm: false };
  return { kind: 'takeover', verb: 'Take over', confirm: true };
}

/**
 * 🔴 Is this session's directory one the console has any reason to trust?
 *
 * Phase 8 turned a DISPLAY field into a spawn parameter: the resume starts in
 * the cwd the presence registry recorded. The registry is fed by
 * `POST /hooks/session`, which is deliberately exempt from the console-header
 * and Origin checks — the hook is a shell script, not a browser — and QA
 * demonstrated that this makes it reachable as a cross-origin *simple request*
 * from any page in the operator's browser. A forged record therefore chooses a
 * directory, and a directory chooses a project `CLAUDE.md` and
 * `.claude/settings.json`, which can define hooks.
 *
 * The mint itself is CSRF-guarded, so the attack still needs a real click on
 * this page — which is exactly why the guard belongs here. Nothing is refused:
 * a directory the console does not recognise makes the action take the confirm
 * (even when the session has ENDED) and puts the path in front of the person
 * clicking. Silently spawning there was the defect; asking is the fix.
 *
 * "Recognised" is the open root or a recent one, prefix-matched on a path
 * boundary so a submodule of the open root counts and a sibling that merely
 * shares its first characters does not.
 *
 * 🔴 **A prefix match over a raw string is not enough, and the first version of
 * this was defeated by its own commit message's example.** `/repo/../../tmp/evil`
 * starts with `/repo/` and would have read as familiar — while `firstDir` on the
 * server resolves it through `statSync` and spawns in `/tmp/evil`. So the path
 * is normalized first, and any cwd that is not already in normal form is
 * unfamiliar *by that fact alone*: a real record comes from a shell's `$PWD` and
 * never contains a `.` or `..` segment, so the only thing that arrives
 * denormalized is something that wants to look like somewhere else. The page
 * still shows the string the record holds — showing a normalized path the record
 * does not contain would hide exactly this.
 *
 * Known limit, deliberately not special-cased: an open root of `/` makes every
 * directory familiar. That is what opening `/` as a source root means, and a
 * console pointed there has already made a larger decision than this one.
 */
export function unfamiliarDirectory(cwd: string, roots: readonly string[]): boolean {
  if (!cwd || !cwd.startsWith('/')) return true;
  if (normalizePath(cwd) !== cwd) return true;
  return !roots.some(
    (root) => root && (cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)),
  );
}

/**
 * `/a/b/../c` → `/a/c`, without `node:path` (this runs in a browser).
 *
 * Only used to ask "was this already normal?" — see `unfamiliarDirectory`. It
 * is deliberately purely lexical: a symlink still resolves to somewhere else at
 * spawn time, which is why the answer here is "ask the operator", never "this
 * path is safe".
 */
function normalizePath(input: string): string {
  const out: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`;
}

/** What the page calls the session — the row's three facts, in the row's order. */
export function foreignTitle(session: ForeignSession): string {
  return session.plan
    ? `${session.plan.slug} · P${session.plan.phase}`
    : (session.owner ?? foreignVehicle(session));
}

/** The sentence the confirm must say before a second process is started. */
export function takeoverConsequence(session: ForeignSession): string {
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
  const title = foreignTitle(session);
  const ended = session.presence === 'ended';
  const unfamiliar = unfamiliarDirectory(session.cwd, roots);
  // Either reason is enough to ask: a second process on one conversation, or a
  // directory this console cannot place. They are different questions, so the
  // dialog asks whichever one applies (or both).
  const mustConfirm = action.kind === 'takeover' || unfamiliar;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Users size={16} className="shrink-0 text-ink-muted" aria-hidden />
            <h1 className="font-display text-lg text-ink">{title}</h1>
            <span className="flex items-center gap-1.5 text-sm text-ink-muted">
              <StatusDot
                state={ended ? 'done' : session.presence === 'live' ? 'running' : 'waiting'}
                pulse={session.presence === 'live'}
              />
              {session.presence}
            </span>
            {session.waiting && (
              <StatusBadge
                state="needs-you"
                label={session.waiting.kind === 'permission' ? 'needs permission' : 'needs input'}
              />
            )}
          </div>
          <p className="text-sm text-ink-muted">
            A Claude session on this machine that this console did not start — the session-presence hook
            reported it. It cannot be attached to; its conversation can be resumed here.
          </p>
        </header>

        <KeyValue
          items={[
            ['session', <span className="font-mono text-2xs break-all">{session.sessionId}</span>],
            ['what', foreignVehicle(session)],
            ['directory', <span className="font-mono text-2xs break-all">{session.cwd}</span>],
            session.owner ? ['owner', <span className="font-mono text-2xs">{session.owner}</span>] : null,
            session.scope ? ['scope', <span className="font-mono text-2xs">{session.scope}</span>] : null,
            session.plan
              ? [
                  'phase',
                  <a
                    className="inline-flex items-center gap-1 text-action underline underline-offset-2"
                    href={phaseHref(session.plan.slug, session.plan.phase)}
                  >
                    {session.plan.slug} · P{session.plan.phase}
                    <ExternalLink size={12} aria-hidden />
                    {!session.plan.strong && <Chip>correlated by owner + clock</Chip>}
                  </a>,
                ]
              : null,
            [
              'turns',
              session.turnsSource === 'unknown' ? (
                <span title="This record moved many times and never saw a Stop hook, so its count of 0 was never counted.">
                  unknown
                </span>
              ) : (
                turnsLabel(session)
              ),
            ],
            ['last seen', <RelativeTime at={session.lastSeen} />],
            session.endedAt
              ? [
                  endedLabel(session) ?? 'ended',
                  session.endedBy === 'probe' ? (
                    <span>
                      after <RelativeTime at={session.endedAt} /> — its last sign of life; the process was
                      found gone{' '}
                      {session.endedDetectedAt ? <RelativeTime at={session.endedDetectedAt} /> : 'later'}
                    </span>
                  ) : (
                    <span>
                      <RelativeTime at={session.endedAt} /> — reported by the session
                    </span>
                  ),
                ]
              : null,
            session.pid ? ['pid', <span className="font-mono text-2xs">{session.pid}</span>] : null,
          ]}
        />

        {action.kind === 'refused' ? (
          <p className="rounded border border-rule bg-surface p-3 text-sm text-ink-muted">{action.reason}</p>
        ) : (
          <div className="flex flex-col gap-2 rounded border border-rule bg-surface p-3">
            <p className="text-sm text-ink-muted">
              {ended
                ? 'Resuming starts a new Claude on this conversation, in this console, with its history.'
                : takeoverConsequence(session)}{' '}
              {/* Where it will run, said before it runs — the server takes this
                  from the registry record, never from anything sent here. It is
                  the difference between continuing this session and starting a
                  session that merely remembers it: `--resume` finds a
                  conversation from anywhere, so a wrong directory is silent. */}
              It starts in <span className="font-mono text-2xs">{session.cwd}</span>, where the session was
              working.
            </p>
            {unfamiliar && (
              <p className="rounded border border-warn/40 bg-warn/5 p-2 text-2xs text-ink-muted">
                <strong className="text-ink">This console does not know that directory.</strong> A session
                record is written by the presence hook, and a resume starts where the record says — so a
                directory outside the open root (and the recent ones) is worth reading before you start
                anything in it: a project there can carry its own settings and hooks.
              </p>
            )}
            {mustConfirm ? (
              <ConfirmButton
                variant="action"
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
                        It starts in <span className="font-mono text-2xs">{session.cwd}</span>, which is not
                        the open root or one of the recent ones. Whatever settings and hooks that project
                        carries apply to the session you are about to start.
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
                variant="action"
                className="self-start"
                disabled={busy || Boolean(capNote)}
                title={capNote}
                onClick={onResume}
              >
                <Play size={15} aria-hidden /> {action.verb}
              </Button>
            )}
            {capNote && <p className="text-2xs text-ink-faint">{capNote}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
