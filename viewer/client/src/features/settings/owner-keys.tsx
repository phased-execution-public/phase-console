/**
 * Settings ▸ Permissions ▸ Owner keys (control-tower phase 138, #215; the
 * owner door is phase 148's `server/owner/`).
 *
 * A passkey proves a press is the owner's. This card enrols one — the first
 * through the link `phase-console owner enroll` prints at the machine (it
 * opens here, `?enrol=<token>`), a later one inside an owner session, in this
 * browser or through a link for another device — names it, lists every key
 * with where and when it was made and last used, and removes one, asked once.
 * It signs in, asks for a fresh touch, and locks. It says which presses need
 * the key, read from the door table itself (`shared/door-model.js`), and on
 * an IP address it offers the same page at `localhost`: a passkey is bound to
 * a name, never an address.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AUTHORITY_VERBS, DOOR_MAY, pressRiskOf } from '@shared/door-model.js';
import { useRoute } from '@/app/router';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ConfirmButton,
  CopyButton,
  Input,
  PageError,
  RelativeTime,
  Skeleton,
  toast,
} from '@/components/ui';
import type { OwnerKey } from '@/lib/api/owner';
import { useNow } from '@/lib/clock';
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
  withOwnerTouch,
} from '@/features/turn/owner-key';

type Verb = (typeof AUTHORITY_VERBS)[number];

/** Each authority press, as a person names it. */
const PRESS_WORDS: Readonly<Record<Verb, string>> = Object.freeze({
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

const join = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;

/** Which presses need the key, and how — derived from `PRESS_RISK` and the `local` door's row. */
function NeedsKey() {
  const anyDoor = new Set(Object.keys(DOOR_MAY.local));
  const phone = new Set(Object.keys(DOOR_MAY.device));
  const high = AUTHORITY_VERBS.filter((verb) => pressRiskOf(verb) === 'high' && verb !== 'grant');
  const owner = AUTHORITY_VERBS.filter((verb) => pressRiskOf(verb) !== 'high' && !anyDoor.has(verb));
  const device = owner.filter((verb) => phone.has(verb));
  const free = AUTHORITY_VERBS.filter((verb) => anyDoor.has(verb));
  return (
    <div data-testid="owner-needs" className="flex max-w-prose flex-col gap-1.5 text-xs text-ink">
      <p className="font-medium">What needs the key, once one is enrolled</p>
      <ul className="flex list-disc flex-col gap-1 ps-5">
        <li>
          A touch inside the last five minutes: {join(high.map((verb) => PRESS_WORDS[verb]))}, and any
          high-risk grant.
        </li>
        <li>
          The owner, signed in — from any other door these are asked of the owner:{' '}
          {join(owner.map((verb) => PRESS_WORDS[verb]))}. A paired phone may press the low and medium ones of{' '}
          {join(device.map((verb) => PRESS_WORDS[verb]))} itself.
        </li>
        <li>Any door, no key: {join(free.map((verb) => PRESS_WORDS[verb]))}, and Revoke on a grant.</li>
      </ul>
    </div>
  );
}

function KeyRow({ entry, busy, onRemove }: { entry: OwnerKey; busy: boolean; onRemove: () => void }) {
  return (
    <li
      data-testid="owner-key"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule py-2.5 last:border-b-0"
    >
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">{entry.label}</span>
        <span className="text-2xs text-ink-muted">
          {entry.origin} · {entry.alg} · {entry.backedUp ? 'synced passkey' : 'this device only'}
        </span>
        <span className="text-2xs text-ink-muted">
          Made <RelativeTime at={entry.createdAt} />
          {entry.lastUsedAt ? (
            <>
              {' '}
              · last used <RelativeTime at={entry.lastUsedAt} />
            </>
          ) : (
            ' · not used yet'
          )}
        </span>
      </div>
      <ConfirmButton
        size="sm"
        variant="danger"
        className="min-h-(--tap-min)"
        title={`Remove the key “${entry.label}”?`}
        description="Its sessions end at once. With no key left, the console works as it did before keys: a press from this machine does what it says."
        destructive
        busy={busy}
        onConfirm={onRemove}
      >
        Remove
      </ConfirmButton>
    </li>
  );
}

export function OwnerKeysCard() {
  const client = useQueryClient();
  const route = useRoute();
  const token = route.query.enrol ?? undefined;
  const read = useQuery({
    queryKey: OWNER_QUERY_KEY,
    queryFn: () => ownerApi.owner(),
    retry: false,
    refetchOnMount: 'always',
  });
  const view = read.data;
  const now = useNow(view?.state === 'unlocked', 15_000);
  const gate = ownerGateOf(view, now);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [links, setLinks] = useState<string[] | null>(null);
  // A link is good once: after it enrolled a key, a later one is the session's.
  const [spent, setSpent] = useState(false);
  const supported = passkeysSupported();
  const onIp = (view && 'refused' in view.relyingParty) || isIpHost(window.location.hostname);
  const open = view?.requests.filter((request) => request.state === 'open').length ?? 0;

  async function act(which: string, call: () => Promise<unknown>, said: string) {
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
      () => (viaLink ? enrolOwnerKey(name, token) : withOwnerTouch(() => enrolOwnerKey(name))),
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
      const minted = await withOwnerTouch(() => ownerApi.ownerEnrolLink());
      setLinks([minted.link, ...(minted.links ?? [])]);
    } catch (cause) {
      toast(ceremonyError(cause), 'warn', 8000);
    } finally {
      setBusy(null);
    }
  }

  // The machine's link enrols the first key; an owner-minted link enrols a later
  // one on a device with no session (a phone reads `enrolled`); a session enrols here.
  const linked = Boolean(token) && !spent;
  const enrolling = view && (view.state === 'unlocked' || linked);

  return (
    <Card className="lg:col-span-2" data-testid="owner-keys-card">
      <CardHeader>
        <CardTitle id="owner-keys">Owner keys</CardTitle>
        <span className="text-2xs text-ink-faint">a passkey for what carries risk</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {read.isLoading ? (
          <Skeleton className="h-16" />
        ) : read.isError || !view ? (
          <PageError error={read.error} retry={() => void read.refetch()} />
        ) : (
          <>
            <Banner
              data-testid="owner-state"
              severity={view.state === 'unenrolled' ? 'warn' : 'info'}
              className="max-w-prose text-xs"
            >
              {view.state === 'unenrolled'
                ? 'No owner key. The console works as it always has: a press from this machine does what it says, and a high-risk grant takes the rule typed back.'
                : view.state === 'enrolled'
                  ? 'An owner key is enrolled, and this browser is not signed in with it: a risky press from here is asked of the owner.'
                  : `Signed in with “${view.session?.label ?? 'the owner key'}”. ${
                      gate === 'fresh'
                        ? 'Touched just now — a high-risk press may go.'
                        : 'Touch the key again before a high-risk press.'
                    } The session ends after twelve idle hours, or when you lock it.`}
            </Banner>

            {onIp && (
              <p data-testid="owner-localhost" className="max-w-prose text-xs text-ink">
                A passkey is bound to a name, never an address — open this page at{' '}
                <a
                  href={localhostAddress(window.location)}
                  className="tap-row font-mono underline decoration-rule-strong underline-offset-2"
                >
                  {localhostAddress(window.location)}
                </a>
                .
              </p>
            )}
            {!supported && (
              <p data-testid="owner-unsupported" className="text-xs text-ink-muted">
                This browser cannot make or use a passkey.
              </p>
            )}

            {view.state === 'unenrolled' && !token && (
              <div data-testid="owner-first" className="flex max-w-prose flex-col gap-1.5 text-xs text-ink">
                <p>The first key is enrolled at the machine. Run this there, and open the link it prints:</p>
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 rounded-sm bg-surface-raised px-2 py-1 font-mono break-all">
                    phase-console owner enroll
                  </code>
                  <CopyButton text="phase-console owner enroll" />
                </div>
              </div>
            )}

            {view.keys.length > 0 && (
              <ul className="flex min-w-0 flex-col" aria-labelledby="owner-keys">
                {view.keys.map((entry) => (
                  <KeyRow
                    key={entry.id}
                    entry={entry}
                    busy={busy === `remove:${entry.id}`}
                    onRemove={() =>
                      void act(
                        `remove:${entry.id}`,
                        () => withOwnerTouch(() => ownerApi.ownerKeyRemove(entry.id)),
                        `Removed “${entry.label}”.`,
                      )
                    }
                  />
                ))}
              </ul>
            )}

            {enrolling && supported && (
              <form
                className="flex max-w-prose flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void enrol();
                }}
              >
                <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-2xs text-ink-muted">
                  Name this key
                  <Input
                    value={label}
                    placeholder="MacBook, phone, studio…"
                    onChange={(event) => setLabel(event.target.value)}
                    className="h-9 text-xs"
                  />
                </label>
                <Button
                  type="submit"
                  size="md"
                  variant="action"
                  className="min-h-(--tap-min)"
                  disabled={busy !== null}
                >
                  {busy === 'enrol'
                    ? 'Waiting for the passkey…'
                    : linked && view.state !== 'unlocked'
                      ? 'Enrol a passkey'
                      : 'Add a passkey in this browser'}
                </Button>
              </form>
            )}

            <div className="flex flex-wrap gap-1.5">
              {gate === 'sign-in' && supported && (
                <Button
                  size="sm"
                  className="min-h-(--tap-min)"
                  disabled={busy !== null}
                  onClick={() => void act('sign-in', () => signInAsOwner(), 'Signed in as the owner.')}
                >
                  Sign in with the owner key
                </Button>
              )}
              {gate === 'touch' && supported && (
                <Button
                  size="sm"
                  className="min-h-(--tap-min)"
                  disabled={busy !== null}
                  onClick={() => void act('touch', () => signInAsOwner(), 'Touched — good for five minutes.')}
                >
                  Touch the key again
                </Button>
              )}
              {view.state === 'unlocked' && (
                <>
                  <Button
                    size="sm"
                    className="min-h-(--tap-min)"
                    disabled={busy !== null}
                    onClick={() => void mintLink()}
                  >
                    Make a link for another device
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-(--tap-min)"
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
                  className="min-h-(--tap-min)"
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
              <div data-testid="owner-links" className="flex max-w-prose flex-col gap-1.5 text-xs text-ink">
                <p>Open one of these on the other device within ten minutes — it is good once:</p>
                {links.map((one) => (
                  <div key={one} className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 font-mono text-2xs break-all">{one}</code>
                    <CopyButton text={one} />
                  </div>
                ))}
              </div>
            )}

            {open > 0 && (
              <p className="text-xs text-ink">
                {open} request{open === 1 ? '' : 's'} wait for the owner on{' '}
                <a href="#/turn" className="tap-row underline underline-offset-2">
                  Your turn
                </a>
                .
              </p>
            )}

            <NeedsKey />
          </>
        )}
      </CardBody>
    </Card>
  );
}
