/**
 * Settings ▸ Permissions ▸ Owner keys (quiet-console phase 22; control-tower
 * phase 138, #215, over phase 148's owner door): a passkey that proves a press
 * is the owner's.
 *
 * With no key the group says the console works as it always has, and that the
 * first key is enrolled at the machine. The link the machine prints
 * (`?enrol=<token>`) enrols a passkey here under the name given, and so does a
 * link the owner made, on a device with no session; either link is good once.
 * Each key says where and when it was made and last used, and is removed asked
 * once — touching the key first when the session's touch is stale. Signing in,
 * touching again and locking are offered by the session's state, and a
 * signed-in owner enrols another browser or makes a link for another device.
 * Which presses need the key is read from the door table, never written here,
 * and on an address a passkey cannot be bound to the group offers the same
 * page at localhost.
 *
 * Only the browser's half of each ceremony is faked, at `navigator.credentials`:
 * the ceremonies themselves run against the fixture server, so what is
 * asserted is what was SENT — the token, the name, the credential, the touch.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorityRequest, OwnerKey, OwnerSession, OwnerView } from '@/data/owner';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a press came to is a toast, and the tray is the shell's: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { ApiError } from '@/data/http';
import { OwnerKeysGroup, keyNeeds } from './owner-keys';

/** The clock every case reads: a touch at 09:59 is fresh until 10:04. */
const NOW = '2026-10-08T10:00:00.000Z';

const bytes = (text: string): ArrayBuffer => Uint8Array.from(text, (char) => char.charCodeAt(0)).buffer;
const b64url = (text: string): string =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The authenticator, as `navigator.credentials` answers: a passkey made, and a passkey touched. */
const authenticator = {
  create: vi.fn(async () => ({
    id: 'made-1',
    rawId: bytes('made-1'),
    type: 'public-key',
    response: {
      clientDataJSON: bytes('{"type":"webauthn.create"}'),
      attestationObject: bytes('attestation'),
    },
  })),
  get: vi.fn(async () => ({
    id: 'made-1',
    rawId: bytes('made-1'),
    type: 'public-key',
    response: {
      clientDataJSON: bytes('{"type":"webauthn.get"}'),
      authenticatorData: bytes('authenticator'),
      signature: bytes('signature'),
      userHandle: bytes('owner'),
    },
  })),
};

/** What the server is sent for each — every buffer as base64url. */
const MADE = {
  id: 'made-1',
  rawId: b64url('made-1'),
  type: 'public-key',
  response: {
    clientDataJSON: b64url('{"type":"webauthn.create"}'),
    attestationObject: b64url('attestation'),
  },
};
const TOUCHED = {
  id: 'made-1',
  rawId: b64url('made-1'),
  type: 'public-key',
  response: {
    clientDataJSON: b64url('{"type":"webauthn.get"}'),
    authenticatorData: b64url('authenticator'),
    signature: b64url('signature'),
    userHandle: b64url('owner'),
  },
};

/** The server's half of each ceremony's start: its options, named by the ceremony the finish returns. */
const CREATION = {
  ceremony: 'enrol-1',
  publicKey: {
    challenge: b64url('enrol-challenge'),
    rp: { id: 'localhost', name: 'Phase Console' },
    user: { id: b64url('owner'), name: 'owner', displayName: 'The owner' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    attestation: 'none',
    timeout: 60_000,
    excludeCredentials: [{ type: 'public-key', id: b64url('k1') }],
  },
};
const ASSERTION = {
  ceremony: 'assert-1',
  publicKey: {
    challenge: b64url('assert-challenge'),
    rpId: 'localhost',
    userVerification: 'required',
    timeout: 60_000,
    allowCredentials: [{ type: 'public-key', id: b64url('k1') }],
  },
};

const KEY: OwnerKey = {
  id: 'k1',
  alg: 'ES256',
  label: 'MacBook',
  origin: 'http://localhost:4130',
  rpId: 'localhost',
  createdAt: '2026-10-07T09:00:00.000Z',
  lastUsedAt: '2026-10-08T08:00:00.000Z',
  counter: 3,
  backedUp: true,
};

/** A key that lives on one device, made an hour ago and never used. */
const PHONE: OwnerKey = {
  ...KEY,
  id: 'k2',
  alg: 'EdDSA',
  label: 'Phone',
  createdAt: '2026-10-08T09:00:00.000Z',
  lastUsedAt: null,
  counter: 0,
  backedUp: false,
};

/** An owner session touched a minute ago — fresh for four more. */
const SESSION: OwnerSession = {
  id: 'o1',
  keyId: 'k1',
  label: 'MacBook',
  origin: 'http://localhost:4130',
  startedAt: '2026-10-08T08:00:00.000Z',
  lastSeenAt: '2026-10-08T09:59:00.000Z',
  assertedAt: '2026-10-08T09:59:00.000Z',
  idleEndsAt: '2026-10-08T21:59:00.000Z',
  freshUntil: '2026-10-08T10:04:00.000Z',
  fresh: true,
};

/** A grant a paired phone asked the owner for. */
const ASKED: AuthorityRequest = {
  id: 'q1',
  at: '2026-10-08T09:50:00.000Z',
  state: 'open',
  door: 'device',
  label: 'iPhone',
  press: 'grant',
  authority: 'grant',
  risk: 'high',
  method: 'POST',
  path: '/api/human-steps/hs-1/grant',
  body: { scope: 'plan' },
  summary: 'grant Bash(npm publish:*) for this plan',
  item: { kind: 'human-step', id: 'hs-1' },
  repeats: 0,
  ask: 'asked by iPhone through device — grant Bash(npm publish:*) for this plan — confirm?',
};

const view = (over: Partial<OwnerView> = {}): OwnerView => ({
  state: 'unenrolled',
  mode: 'unenrolled',
  keys: [],
  session: null,
  requests: [],
  relyingParty: { id: 'localhost', origin: 'http://localhost:4130' },
  ...over,
});

const unlocked = (over: Partial<OwnerView> = {}) =>
  view({ state: 'unlocked', mode: 'enrolled', keys: [KEY], session: SESSION, ...over });

/** Every request but the reads, in the order it was made. */
const pressed = () =>
  server.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);

/** Press a button once it can be pressed — a press in flight disables the group's others. */
async function press(name: string) {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  server.calls = [];
  server.reads = {
    '/api/owner': view(),
    'POST /api/owner/enroll/begin': CREATION,
    'POST /api/owner/enroll/finish': (body: unknown) => ({
      key: { ...KEY, id: 'k9', label: (body as { label: string }).label },
      session: SESSION,
    }),
    'POST /api/owner/assert/begin': ASSERTION,
    'POST /api/owner/assert/finish': { session: SESSION, fresh: true },
  };
  toast.mockClear();
  authenticator.create.mockClear();
  authenticator.get.mockClear();
  // A browser that can make and use a passkey.
  Object.defineProperty(window, 'PublicKeyCredential', {
    value: function PublicKeyCredential() {},
    configurable: true,
  });
  Object.defineProperty(navigator, 'credentials', { value: authenticator, configurable: true });
  window.location.hash = '#/settings/permissions';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('with no key yet', () => {
  it('says the console works as it always has, and that the first key is enrolled at the machine', async () => {
    renderWithClient(<OwnerKeysGroup />);
    expect(await screen.findByTestId('owner-state')).toHaveTextContent(
      'No owner key. The console works as it always has: a press from this machine does what it says, and a high-risk grant takes the rule typed back.',
    );
    const first = screen.getByTestId('owner-first');
    expect(first).toHaveTextContent(
      'The first key is enrolled at the machine. Run this there, and open the link it prints:',
    );
    expect(first).toHaveTextContent('phase-console owner enroll');
    expect(within(first).getByRole('button', { name: 'Copy the command' })).toBeInTheDocument();
    // Nothing to name, sign in with or lock: the console holds no key.
    expect(screen.queryByLabelText('Name this key')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign in|Touch|Lock|Make a link/ })).toBeNull();
    expect(pressed()).toEqual([]);
  });
});

describe('enrolling a key', () => {
  it('enrols the first key through the machine’s link, under the name given, and the link is good once', async () => {
    window.location.hash = '#/settings/permissions?enrol=tok-123';
    let enrolled = false;
    const laptop = { ...KEY, label: 'Work laptop' };
    server.reads['/api/owner'] = () =>
      enrolled ? unlocked({ keys: [laptop], session: { ...SESSION, label: 'Work laptop' } }) : view();
    server.reads['POST /api/owner/enroll/finish'] = (body: unknown) => {
      enrolled = true;
      return { key: { ...laptop, label: (body as { label: string }).label }, session: SESSION };
    };
    renderWithClient(<OwnerKeysGroup />);
    // The link is what enrols the first key, so the machine's command is not offered beside it.
    const name = await screen.findByLabelText('Name this key');
    expect(screen.queryByTestId('owner-first')).toBeNull();
    fireEvent.change(name, { target: { value: '  Work laptop ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enrol a passkey' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Enrolled “Work laptop” — this browser holds an owner key now.',
        'ok',
      ),
    );
    expect(sent(server, 'POST', '/api/owner/enroll/begin')).toEqual([
      { token: 'tok-123', label: 'Work laptop' },
    ]);
    expect(sent(server, 'POST', '/api/owner/enroll/finish')).toEqual([
      { ceremony: 'enrol-1', label: 'Work laptop', credential: MADE },
    ]);
    expect(authenticator.create).toHaveBeenCalledTimes(1);

    // Read again, the door says this browser is the owner's now.
    await waitFor(() =>
      expect(screen.getByTestId('owner-state')).toHaveTextContent(
        'Signed in with “Work laptop”. Touched just now — a high-risk press may go.',
      ),
    );
    // The link was spent: the next key is the session's, and a key given no name is this browser.
    await press('Add a passkey in this browser');
    await waitFor(() => expect(sent(server, 'POST', '/api/owner/enroll/begin')).toHaveLength(2));
    expect(sent(server, 'POST', '/api/owner/enroll/begin')[1]).toEqual({ label: 'This browser' });
  });

  it('enrols on a device with no session through a link the owner made, and then offers signing in', async () => {
    window.location.hash = '#/settings/permissions?enrol=tok-456';
    let made = false;
    server.reads['/api/owner'] = () =>
      view({ state: 'enrolled', mode: 'enrolled', keys: made ? [KEY, PHONE] : [KEY] });
    server.reads['POST /api/owner/enroll/finish'] = () => {
      made = true;
      return { key: PHONE, session: null };
    };
    renderWithClient(<OwnerKeysGroup />);
    fireEvent.change(await screen.findByLabelText('Name this key'), { target: { value: 'Phone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enrol a passkey' }));

    await waitFor(() =>
      expect(sent(server, 'POST', '/api/owner/enroll/finish')).toEqual([
        { ceremony: 'enrol-1', label: 'Phone', credential: MADE },
      ]),
    );
    expect(sent(server, 'POST', '/api/owner/enroll/begin')).toEqual([{ token: 'tok-456', label: 'Phone' }]);
    // No session comes with a key made through a link: the form goes with the link.
    await waitFor(() => expect(screen.getAllByTestId('owner-key')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByLabelText('Name this key')).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in with the owner key' })).toBeEnabled(),
    );
  });
});

describe('the keys', () => {
  it('lists each key — its name, where and when it was made, when last used — and removes one, asked once', async () => {
    server.reads['/api/owner'] = unlocked({ keys: [KEY, PHONE] });
    server.reads['DELETE /api/owner/keys/k1'] = { removed: KEY, state: 'enrolled' };
    renderWithClient(<OwnerKeysGroup />);
    const [mac, phone] = await screen.findAllByTestId('owner-key');
    for (const words of ['MacBook', 'http://localhost:4130', 'ES256', 'a synced passkey']) {
      expect(mac).toHaveTextContent(words);
    }
    expect(mac).toHaveTextContent('made 1 day ago');
    expect(mac).toHaveTextContent('last used 2 hours ago');
    expect(phone).toHaveTextContent('EdDSA');
    expect(phone).toHaveTextContent('on this device only');
    expect(phone).toHaveTextContent('made 1 hour ago');
    expect(phone).toHaveTextContent('not used yet');

    fireEvent.click(within(mac!).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the key “MacBook”?' });
    expect(dialog).toHaveTextContent('Its sessions end at once.');
    // Asked, not done: nothing goes until the question is answered.
    expect(pressed()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Removed “MacBook”.', 'ok'));
    expect(pressed()).toEqual(['DELETE /api/owner/keys/k1']);
  });

  it('a session whose touch is stale says so, touches the key once, then removes', async () => {
    server.reads['/api/owner'] = unlocked({ session: { ...SESSION, fresh: false } });
    let refused = false;
    server.reads['DELETE /api/owner/keys/k1'] = () => {
      if (refused) return { removed: KEY, state: 'unenrolled' };
      refused = true;
      throw new ApiError('Touch the owner key again.', 401, '/api/owner/keys/k1', { reassert: true });
    };
    renderWithClient(<OwnerKeysGroup />);
    expect(await screen.findByTestId('owner-state')).toHaveTextContent(
      'Signed in with “MacBook”. Touch the key again before a high-risk press. The session ends after twelve idle hours, or when you lock it.',
    );
    expect(screen.getByRole('button', { name: 'Touch the key again' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('owner-key')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Removed “MacBook”.', 'ok'));
    // Refused for a stale touch: the key is touched, and the press goes ONCE more.
    expect(pressed()).toEqual([
      'DELETE /api/owner/keys/k1',
      'POST /api/owner/assert/begin',
      'POST /api/owner/assert/finish',
      'DELETE /api/owner/keys/k1',
    ]);
    expect(sent(server, 'POST', '/api/owner/assert/finish')).toEqual([
      { ceremony: 'assert-1', credential: TOUCHED },
    ]);
    expect(authenticator.get).toHaveBeenCalledTimes(1);
  });
});

describe('the owner session', () => {
  it('offers signing in where a key is enrolled and this browser holds no session, and points at the requests waiting', async () => {
    server.reads['/api/owner'] = view({
      state: 'enrolled',
      mode: 'enrolled',
      keys: [KEY],
      requests: [ASKED, { ...ASKED, id: 'q2', state: 'confirmed' }],
    });
    renderWithClient(<OwnerKeysGroup />);
    expect(await screen.findByTestId('owner-state')).toHaveTextContent(
      'An owner key is enrolled, and this browser is not signed in with it: a risky press from here is asked of the owner.',
    );
    // A later key is enrolled inside an owner session, never from a browser outside one.
    expect(screen.queryByLabelText('Name this key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock this browser' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Lock every session' })).toBeInTheDocument();
    const waiting = screen.getByTestId('owner-requests');
    expect(waiting).toHaveTextContent('1 request waits for the owner on Your turn.');
    expect(within(waiting).getByRole('link', { name: 'Your turn' })).toHaveAttribute('href', '#/turn');

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with the owner key' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Signed in as the owner.', 'ok'));
    expect(pressed()).toEqual(['POST /api/owner/assert/begin', 'POST /api/owner/assert/finish']);
    expect(sent(server, 'POST', '/api/owner/assert/finish')).toEqual([
      { ceremony: 'assert-1', credential: TOUCHED },
    ]);
  });

  it('a signed-in owner makes a link for another device, enrols another browser, and locks', async () => {
    let locked = false;
    server.reads['/api/owner'] = () =>
      locked ? view({ state: 'enrolled', mode: 'enrolled', keys: [KEY] }) : unlocked();
    server.reads['POST /api/owner/enroll/link'] = {
      link: 'http://localhost:4130/#/settings/permissions?enrol=t2',
      links: ['https://mac.tailnet.ts.net/#/settings/permissions?enrol=t2'],
      expiresAt: '2026-10-08T10:10:00.000Z',
      first: false,
    };
    server.reads['POST /api/owner/lock'] = (body: unknown) => {
      locked = true;
      return { ended: (body as { all?: boolean }).all ? 2 : 1, state: 'enrolled' };
    };
    renderWithClient(<OwnerKeysGroup />);
    expect(await screen.findByTestId('owner-state')).toHaveTextContent(
      'Signed in with “MacBook”. Touched just now — a high-risk press may go. The session ends after twelve idle hours, or when you lock it.',
    );

    await press('Make a link for another device');
    const links = await screen.findByTestId('owner-links');
    expect(links).toHaveTextContent(
      'Open one of these on the other device within ten minutes — each is good once:',
    );
    expect(links).toHaveTextContent('http://localhost:4130/#/settings/permissions?enrol=t2');
    expect(links).toHaveTextContent('https://mac.tailnet.ts.net/#/settings/permissions?enrol=t2');
    expect(within(links).getAllByRole('button', { name: 'Copy the link' })).toHaveLength(2);
    expect(sent(server, 'POST', '/api/owner/enroll/link')).toEqual([undefined]);

    fireEvent.change(screen.getByLabelText('Name this key'), { target: { value: 'Studio' } });
    await press('Add a passkey in this browser');
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Enrolled “Studio” — this browser holds an owner key now.', 'ok'),
    );
    // Inside a session the key is the session's: no token goes with it.
    expect(sent(server, 'POST', '/api/owner/enroll/begin')).toEqual([{ label: 'Studio' }]);

    await press('Lock this browser');
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Locked — this browser is no longer the owner’s.', 'ok'),
    );
    // Read again, the door is shut to this browser: signing in is offered, and every session can still be locked.
    expect(await screen.findByRole('button', { name: 'Sign in with the owner key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make a link for another device' })).toBeNull();
    await press('Lock every session');
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Every owner session is locked.', 'ok'));
    expect(sent(server, 'POST', '/api/owner/lock')).toEqual([{}, { all: true }]);
  });

  it('offers no ceremony in a browser that cannot make a passkey, and says so', async () => {
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
    window.location.hash = '#/settings/permissions?enrol=tok-123';
    server.reads['/api/owner'] = view({ state: 'enrolled', mode: 'enrolled', keys: [KEY] });
    renderWithClient(<OwnerKeysGroup />);
    expect(await screen.findByTestId('owner-unsupported')).toHaveTextContent(
      'This browser cannot make or use a passkey.',
    );
    expect(screen.queryByLabelText('Name this key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in with the owner key' })).toBeNull();
  });
});

describe('which presses need the key', () => {
  it('is read from the door table: the high presses need a touch, the rest the owner, a decline any door', () => {
    expect(keyNeeds()).toEqual({
      touch:
        'a raise of a run’s permission profile, a capability flag turned on, adding or removing an owner key and trusting an agent with your authority',
      owner:
        'a grant, an answer to a card or a decision, I’ve done this, taken on your word, Accept anyway, a policy rule that widens what runs may do, a gate’s approval and a plan’s approval',
      device: 'a grant, an answer to a card or a decision, a gate’s approval and a plan’s approval',
      free: 'Deny and I can’t',
    });
  });

  it('is said under the keys, before a key is enrolled as after', async () => {
    renderWithClient(<OwnerKeysGroup />);
    const needs = await screen.findByTestId('owner-needs');
    const { touch, owner, device, free } = keyNeeds();
    expect(needs).toHaveTextContent('What needs the key, once one is enrolled');
    expect(needs).toHaveTextContent(`A touch in the last five minutes: ${touch}, and any high-risk grant.`);
    expect(needs).toHaveTextContent(
      `The owner, signed in — from any other door these are asked of the owner: ${owner}. A paired phone may press the low and medium ones of ${device} itself.`,
    );
    expect(needs).toHaveTextContent(`Any door, no key: ${free}, and Revoke on a grant.`);
  });
});

describe('an address a passkey cannot be bound to', () => {
  it('offers the same page at localhost', async () => {
    server.reads['/api/owner'] = view({
      relyingParty: { refused: 'open this console at http://localhost:4130' },
    });
    renderWithClient(<OwnerKeysGroup />);
    const hint = await screen.findByTestId('owner-localhost');
    const port = window.location.port ? `:${window.location.port}` : '';
    const address = `http://localhost${port}/#/settings/permissions`;
    expect(hint).toHaveTextContent(
      `A passkey is bound to a name, never an address — open this page at ${address}`,
    );
    expect(within(hint).getByRole('link', { name: address })).toHaveAttribute('href', address);
  });
});
