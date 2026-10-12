/**
 * Owner keys — a passkey that proves a press is the owner's (7.0,
 * quiet-console phase 22; control-tower phase 138, #215, and phase 148's
 * owner door, `server/owner/`). Drawn inside Settings ▸ Permissions.
 *
 * ```
 * Owner keys
 * Signed in with “MacBook”. Touched just now — a high-risk press may go.
 * MacBook        https://localhost:4130   ES256   synced passkey   made 3 days ago   last used now   [Remove]
 * [Make a link for another device] [Lock this browser] [Lock every session]
 * What needs the key, once one is enrolled
 * ```
 *
 * The first key is enrolled through the link `phase-console owner enroll`
 * prints at the machine (it opens here with `?enrol=<token>`); a later one
 * inside an owner session — in this browser, or through a link for another
 * device. Each key says where and when it was made and last used, and is
 * removed asked once. Which presses need the key is read from the door table
 * itself (`shared/door-model.js`), never written here; and on an IP address
 * the group offers the same page at `localhost`, because a passkey is bound to
 * a name, never an address.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTHORITY_VERBS, DOOR_MAY, pressRiskOf } from '@shared/door-model.js';
import {
  OWNER_QUERY_KEY,
  ceremonyError,
  enrolOwnerKey,
  isIpHost,
  localhostAddress,
  ownerApi,
  ownerGateOf,
  passkeysSupported,
  signInAsOwner,
  useOwner,
  withOwnerTouch,
  type OwnerKey,
} from '@/data/owner';
import { useNow } from '@/lib/clock';
import { useRoute } from '@/shell/router';
import { turnHref } from '@/shell/routes';
import { Banner, Button, Input, Mono, RelativeTime, Skeleton, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { CopyButton } from '@/ui/copy-button';
import { SettingRow, SettingsGroup } from './setting';

type Verb = (typeof AUTHORITY_VERBS)[number];

/** Each authority press, as a person names it. */
const VERB_WORDS: Readonly<Record<Verb, string>> = Object.freeze({
  grant: 'a grant',
  answer: 'an answer to a card or a decision',
  decline: 'Deny and I can’t',
  attest: 'I’ve done this, taken on your word',
  override: 'Accept anyway',
  'policy-widen': 'a policy rule that widens what runs may do',
  'profile-raise': 'a raise of a run’s permission profile',
  'gate-approve': 'a gate’s approval',
  'plan-approve': 'a plan’s approval',
  capability: 'a capability flag turned on',
  'owner-key': 'adding or removing an owner key',
  trust: 'trusting an agent with your authority',
});

const listWords = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;

/** Which presses need the key, and how — derived from the press risks and the doors' rows. */
export function keyNeeds(): { touch: string; owner: string; device: string; free: string } {
  const anyDoor = new Set(Object.keys(DOOR_MAY.local));
  const phone = new Set(Object.keys(DOOR_MAY.device));
  const high = AUTHORITY_VERBS.filter((verb) => pressRiskOf(verb) === 'high' && verb !== 'grant');
  const owner = AUTHORITY_VERBS.filter((verb) => pressRiskOf(verb) !== 'high' && !anyDoor.has(verb));
  const device = owner.filter((verb) => phone.has(verb));
  const free = AUTHORITY_VERBS.filter((verb) => anyDoor.has(verb));
  const words = (verbs: readonly Verb[]) => listWords(verbs.map((verb) => VERB_WORDS[verb]));
  return { touch: words(high), owner: words(owner), device: words(device), free: words(free) };
}

function NeedsKey() {
  const needs = keyNeeds();
  return (
    <div
      data-testid="owner-needs"
      className="flex min-w-0 max-w-(--measure) flex-col gap-1.5 text-body text-ink"
    >
      <p className="font-medium">What needs the key, once one is enrolled</p>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-meta">
        <li>A touch in the last five minutes: {needs.touch}, and any high-risk grant.</li>
        <li>
          The owner, signed in — from any other door these are asked of the owner: {needs.owner}. A paired
          phone may press the low and medium ones of {needs.device} itself.
        </li>
        <li>Any door, no key: {needs.free}, and Revoke on a grant.</li>
      </ul>
    </div>
  );
}

function KeyItem({ entry, busy, onRemove }: { entry: OwnerKey; busy: boolean; onRemove: () => void }) {
  return (
    <li
      data-testid="owner-key"
      className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-rule pt-3 first:border-t-0 first:pt-0"
    >
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="min-w-0 break-words text-body font-medium text-ink">{entry.label}</span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-meta text-ink-muted">
          <Mono value={entry.origin} className="wrap-anywhere" />
          <span>{entry.alg}</span>
          <span>{entry.backedUp ? 'a synced passkey' : 'on this device only'}</span>
        </span>
        <span className="flex min-w-0 flex-wrap gap-x-3 text-meta text-ink-muted">
          <span>
            made <RelativeTime at={entry.createdAt} />
          </span>
          <span>
            {entry.lastUsedAt ? (
              <>
                last used <RelativeTime at={entry.lastUsedAt} />
              </>
            ) : (
              'not used yet'
            )}
          </span>
        </span>
      </div>
      <ConfirmButton
        size="sm"
        variant="ghost"
        destructive
        title={`Remove the key “${entry.label}”?`}
        description="Its sessions end at once. With no key left, the console works as it did before keys: a press from this machine does what it says."
        busy={busy}
        onConfirm={onRemove}
      >
        Remove
      </ConfirmButton>
    </li>
  );
}

export function OwnerKeysGroup() {
  const client = useQueryClient();
  const route = useRoute();
  const token = route.query.enrol ?? undefined;
  const read = useOwner();
  const view = read.data;
  const now = useNow(view?.state === 'unlocked', 15_000);
  const gate = ownerGateOf(view, now);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [links, setLinks] = useState<string[] | null>(null);
  // A link is good once: after it enrolled a key, a later one is the session's.
  const [spent, setSpent] = useState(false);
  const supported = passkeysSupported();
  const onIp = Boolean(view && 'refused' in view.relyingParty) || isIpHost(window.location.hostname);
  const open = view?.requests.filter((request) => request.state === 'open').length ?? 0;

  async function act(which: string, call: () => Promise<unknown>, said: string): Promise<boolean> {
    setBusy(which);
    try {
      await call();
      toast(said, 'ok');
      return true;
    } catch (cause) {
      toast(ceremonyError(cause), 'warn', 8000);
      return false;
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: OWNER_QUERY_KEY });
    }
  }

  async function enrol() {
    const name = label.trim() || 'This browser';
    const viaLink = Boolean(token) && !spent && view?.state !== 'unlocked';
    const made = await act(
      'enrol',
      () => (viaLink ? enrolOwnerKey(name, token) : withOwnerTouch(() => enrolOwnerKey(name), signInAsOwner)),
      `Enrolled “${name}” — this browser holds an owner key now.`,
    );
    if (made) {
      setLabel('');
      if (viaLink) setSpent(true);
    }
  }

  async function mintLink() {
    setBusy('link');
    try {
      const minted = await withOwnerTouch(() => ownerApi.ownerEnrolLink(), signInAsOwner);
      setLinks([minted.link, ...(minted.links ?? [])]);
    } catch (cause) {
      toast(ceremonyError(cause), 'warn', 8000);
    } finally {
      setBusy(null);
    }
  }

  // The machine's link enrols the first key; an owner-minted link enrols a later one on a device with no
  // session (a phone reads `enrolled`); a session enrols here.
  const linked = Boolean(token) && !spent;
  const enrolling = Boolean(view && (view.state === 'unlocked' || linked));

  return (
    <SettingsGroup
      id="owner-keys"
      title="Owner keys"
      lead="A passkey for what carries risk: with one enrolled, a risky press from any door but the owner’s is asked of the owner first."
    >
      {read.isPending ? (
        <Skeleton className="h-16" aria-busy="true" aria-label="Reading the owner keys" />
      ) : read.isError || !view ? (
        <Banner
          severity="error"
          action={
            <Button size="sm" onClick={() => void read.refetch()}>
              Try again
            </Button>
          }
        >
          {read.error instanceof Error && read.error.message
            ? read.error.message
            : 'The owner keys could not be read, and the server said nothing.'}
        </Banner>
      ) : (
        <div className="flex min-w-0 flex-col gap-4" data-testid="owner-keys">
          <p data-testid="owner-state" className="max-w-(--measure) text-body text-ink">
            {view.state === 'unenrolled'
              ? 'No owner key. The console works as it always has: a press from this machine does what it says, and a high-risk grant takes the rule typed back.'
              : view.state === 'enrolled'
                ? 'An owner key is enrolled, and this browser is not signed in with it: a risky press from here is asked of the owner.'
                : `Signed in with “${view.session?.label ?? 'the owner key'}”. ${
                    gate === 'fresh'
                      ? 'Touched just now — a high-risk press may go.'
                      : 'Touch the key again before a high-risk press.'
                  } The session ends after twelve idle hours, or when you lock it.`}
          </p>
          {onIp && (
            <p data-testid="owner-localhost" className="max-w-(--measure) text-body text-ink">
              A passkey is bound to a name, never an address — open this page at{' '}
              {/* A whole address cannot wrap at a space, so it breaks anywhere — inside one box, which a thumb lands on whole. */}
              <a
                href={localhostAddress(window.location)}
                className="tap-line inline-block max-w-full wrap-anywhere align-top font-mono underline decoration-ink-faint underline-offset-2"
              >
                {localhostAddress(window.location)}
              </a>
            </p>
          )}
          {!supported && (
            <p data-testid="owner-unsupported" className="text-meta text-ink-muted">
              This browser cannot make or use a passkey.
            </p>
          )}
          {view.state === 'unenrolled' && !token && (
            <div
              data-testid="owner-first"
              className="flex min-w-0 max-w-(--measure) flex-col gap-1.5 text-body"
            >
              <p>The first key is enrolled at the machine. Run this there, and open the link it prints:</p>
              <span className="flex min-w-0 items-center gap-2">
                <Mono value="phase-console owner enroll" className="min-w-0 wrap-anywhere" />
                <CopyButton text="phase-console owner enroll" label="Copy the command" />
              </span>
            </div>
          )}
          {view.keys.length > 0 && (
            <ul className="flex min-w-0 flex-col gap-3" aria-label="Enrolled owner keys">
              {view.keys.map((entry) => (
                <KeyItem
                  key={entry.id}
                  entry={entry}
                  busy={busy === `remove:${entry.id}`}
                  onRemove={() =>
                    void act(
                      `remove:${entry.id}`,
                      () => withOwnerTouch(() => ownerApi.ownerKeyRemove(entry.id), signInAsOwner),
                      `Removed “${entry.label}”.`,
                    )
                  }
                />
              ))}
            </ul>
          )}
          {enrolling && supported && (
            <form
              data-testid="owner-enrol"
              onSubmit={(event) => {
                event.preventDefault();
                void enrol();
              }}
            >
              <SettingRow
                label="Name this key"
                hint="How the key is listed here — the device it lives on, say."
              >
                {({ id, describedBy }) => (
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={label}
                      placeholder="MacBook, phone, studio…"
                      className="w-full sm:w-48"
                      onChange={(event) => setLabel(event.target.value)}
                    />
                    <Button type="submit" size="sm" variant="primary" disabled={busy !== null}>
                      {busy === 'enrol'
                        ? 'Waiting for the passkey…'
                        : linked && view.state !== 'unlocked'
                          ? 'Enrol a passkey'
                          : 'Add a passkey in this browser'}
                    </Button>
                  </span>
                )}
              </SettingRow>
            </form>
          )}
          <div className="flex min-w-0 flex-wrap gap-2">
            {gate === 'sign-in' && supported && (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void act('sign-in', () => signInAsOwner(), 'Signed in as the owner.')}
              >
                Sign in with the owner key
              </Button>
            )}
            {gate === 'touch' && supported && (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void act('touch', () => signInAsOwner(), 'Touched — good for five minutes.')}
              >
                Touch the key again
              </Button>
            )}
            {view.state === 'unlocked' && (
              <>
                <Button size="sm" disabled={busy !== null} onClick={() => void mintLink()}>
                  Make a link for another device
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      'lock',
                      () => ownerApi.ownerLock(),
                      'Locked — this browser is no longer the owner’s.',
                    )
                  }
                >
                  Lock this browser
                </Button>
              </>
            )}
            {view.state !== 'unenrolled' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void act('lock-all', () => ownerApi.ownerLock(true), 'Every owner session is locked.')
                }
              >
                Lock every session
              </Button>
            )}
          </div>
          {links && (
            <div
              data-testid="owner-links"
              className="flex min-w-0 max-w-(--measure) flex-col gap-1.5 text-body"
            >
              <p>Open one of these on the other device within ten minutes — each is good once:</p>
              {links.map((one) => (
                <span key={one} className="flex min-w-0 items-center gap-2">
                  <Mono value={one} className="min-w-0 wrap-anywhere" />
                  <CopyButton text={one} label="Copy the link" />
                </span>
              ))}
            </div>
          )}
          {open > 0 && (
            <p className="text-body text-ink" data-testid="owner-requests">
              {open} {open === 1 ? 'request waits' : 'requests wait'} for the owner on{' '}
              <a href={turnHref()} className="tap-line underline decoration-ink-faint underline-offset-2">
                Your turn
              </a>
              .
            </p>
          )}
          <NeedsKey />
        </div>
      )}
    </SettingsGroup>
  );
}
