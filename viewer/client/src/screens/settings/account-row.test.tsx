/**
 * A run’s account (quiet-console phase 22; the 6.x switch control’s cases) —
 * which account a run spends, the choice of another, what a switch would do,
 * the switch itself and what it did.
 *
 * Pinned: the picker lists every account with the run’s own marked, the
 * roomiest first, and shows where the run IS until a choice is made; a choice
 * asks the server’s own preview (`dry: true`) and says it — never guessed from
 * the lanes on the page — and a refused preview says the server’s reason;
 * Switch posts the choice and its moment, and what it did is the verb’s own
 * fields in a sentence; a refused switch keeps the choice and says why. The
 * console’s `--allow-accounts` reaches the row through `GET /api/accounts`:
 * with one account it decides between nothing and the way to add another;
 * with two, moving a run is a run verb and needs no registration flag.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a switch did is a toast, and the tray is the shell’s: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import type { AccountView } from '@/data/api';
import { ApiError } from '@/data/http';
import { keys } from '@/data/keys';
import {
  ACCOUNT_RECOVERY_PARTS,
  RunAccountRow,
  accountChoiceWords,
  switchPreviewWords,
  switchedWords,
} from './account-row';

/** The one route both the preview and the switch post to; `dry: true` is the preview. */
const SWITCH = '/api/run/demo/switch-account';

interface SwitchBody {
  accountId: string;
  when?: string;
  dry?: boolean;
}

const MACHINE: AccountView = {
  id: 'default',
  kind: 'default',
  builtIn: true,
  name: 'machine login',
  email: 'me@example.com',
};
const WORK: AccountView = {
  id: 'acct-work',
  kind: 'token',
  builtIn: false,
  name: 'work',
  email: 'work@example.com',
  plan: 'Max',
  usage: { buckets: { five_hour: { utilization: 41.6, resetsAt: '2026-10-11T20:00:00.000Z' } } },
};

/** What the server says when the account cannot pay: the switch’s refusal, and the preview’s. */
const RETIRED =
  'work is retired. Clear it under Settings ▸ Accounts once the organisation allows it again. ' +
  'The run stays on default; nothing was checkpointed.';
const refused = () => new ApiError(RETIRED, 409, SWITCH, { ok: false, reason: RETIRED, error: RETIRED });

/**
 * A live run of `demo` with phase 3 still working and phase 7 closing out —
 * the preview says what each moment would do to them, and the switch answers
 * with the verb’s own fields.
 */
function answer(body: SwitchBody) {
  const boundary = body.when === 'boundary';
  if (body.dry)
    return boundary
      ? { ok: true, dry: true, to: body.accountId, wouldCheckpoint: [], deferred: [3, 7] }
      : { ok: true, dry: true, to: body.accountId, wouldCheckpoint: [3], deferred: [7] };
  return boundary
    ? { ok: true, run: null, checkpointed: 0, deferred: [3, 7], rekeyed: 2 }
    : { ok: true, run: null, checkpointed: 1, deferred: [7], rekeyed: 2 };
}

function serve({ accounts = [MACHINE, WORK], allowAccounts = true } = {}) {
  server.reads['/api/accounts'] = { accounts, allowAccounts };
  server.reads[`POST ${SWITCH}`] = answer;
}

function mount(run: { accountId?: string } | null = { accountId: 'default' }, disabled = false) {
  return renderWithClient(<RunAccountRow slug="demo" run={run} disabled={disabled} />);
}

const picker = () => screen.findByRole('combobox', { name: 'Account for this run' });
const moment = () => screen.getByRole('combobox', { name: 'When to switch' });
const switchButton = () => screen.getByRole('button', { name: 'Switch account' });
/** The row’s head: "Account" and the name of the account the run is on. */
const head = () => document.querySelector('[data-run-account] span');
/** A picker’s options as a person reads them, and as the server is sent them. */
const optionWords = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((one) => one.textContent);
const optionValues = (select: HTMLElement) =>
  within(select)
    .getAllByRole<HTMLOptionElement>('option')
    .map((one) => one.value);

beforeEach(() => {
  server.calls = [];
  server.reads = {};
  toast.mockClear();
});

describe('the words', () => {
  it('words a preview from the server’s own fields: what is cut now, what finishes first, or that nothing is live', () => {
    expect(switchPreviewWords('now', { wouldCheckpoint: [], deferred: [] })).toBe(
      'No session is live — the next one starts on the new account.',
    );
    expect(switchPreviewWords('boundary', {})).toBe(
      'No session is live — the next one starts on the new account.',
    );
    expect(switchPreviewWords('now', { wouldCheckpoint: [3], deferred: [7] })).toBe(
      'Checkpoints phase 3 now (the session id is kept); phase 7 finishes on the old account first.',
    );
    expect(switchPreviewWords('now', { wouldCheckpoint: [2, 4, 6] })).toBe(
      'Checkpoints phases 2, 4 and 6 now (the session id is kept).',
    );
    expect(switchPreviewWords('boundary', { wouldCheckpoint: [], deferred: [3, 7] })).toBe(
      'At the next boundary: Checkpoints nothing; phases 3 and 7 finish on the old account first.',
    );
  });

  it('words what a switch did from the verb’s own fields', () => {
    expect(switchedWords({ checkpointed: 1, deferred: [], rekeyed: 0 })).toBe(
      'Switched — 1 live session checkpointed. The next session runs under the other account.',
    );
    expect(switchedWords({})).toBe('Switched. The next session runs under the other account.');
    expect(switchedWords({ checkpointed: 2, deferred: [7], rekeyed: 1 })).toBe(
      'Switched — 2 live sessions checkpointed — phase 7 finishes first — 1 queued phase moved with it. ' +
        'The next session runs under the other account.',
    );
    expect(switchedWords({ checkpointed: 0, deferred: [3, 7], rekeyed: 2 })).toBe(
      'Switched — phases 3 and 7 finish first — 2 queued phases moved with it. ' +
        'The next session runs under the other account.',
    );
  });

  it('words an account in the picker: its name, the email when the name is not it, its plan, its 5-hour window, and the run’s own marked now', () => {
    // The machine login says which Claude account it is: the picker decides who pays.
    expect(accountChoiceWords(MACHINE, 'default')).toBe('machine login (me@example.com), now');
    expect(accountChoiceWords(WORK, 'default')).toBe('work (work@example.com), Max, 5-hour 42 %');
    // A name that is the email says it once; an empty window is a reading too.
    expect(
      accountChoiceWords(
        { id: 'acct-solo', kind: 'profile', builtIn: false, email: 'solo@example.com' },
        'acct-solo',
      ),
    ).toBe('solo@example.com, now');
    expect(
      accountChoiceWords(
        {
          ...WORK,
          usage: { buckets: { five_hour: { utilization: 0, resetsAt: '2026-10-11T20:00:00.000Z' } } },
        },
        'default',
      ),
    ).toBe('work (work@example.com), Max, 5-hour 0 %');
    // Nothing to go by: the machine login is still named, and any other account by its id.
    expect(accountChoiceWords({ id: 'default', kind: 'default', builtIn: true }, 'acct-work')).toBe(
      'This machine’s login',
    );
    expect(accountChoiceWords({ id: 'acct-bare', kind: 'token', builtIn: false }, 'default')).toBe(
      'acct-bare',
    );
  });
});

describe('the choice', () => {
  it('lists every account with the run’s own marked, the roomiest first, and holds Switch until another is chosen', async () => {
    serve();
    // A run that names no account is on the machine login.
    mount({});
    const select = await picker();
    expect(optionWords(select)).toEqual([
      'The roomiest account',
      'machine login (me@example.com), now',
      'work (work@example.com), Max, 5-hour 42 %',
    ]);
    expect(optionValues(select)).toEqual(['auto', 'default', 'acct-work']);
    expect(select).toHaveValue('default');
    expect(head()).toHaveTextContent(/^Account machine login$/);
    expect(optionWords(moment())).toEqual(['now', 'at the next boundary']);
    expect(optionValues(moment())).toEqual(['now', 'boundary']);
    expect(moment()).toHaveValue('now');
    expect(switchButton()).toBeDisabled();
    expect(switchButton()).toHaveAttribute(
      'title',
      'The run is already on this account — pick another, or the roomiest.',
    );

    fireEvent.change(select, { target: { value: 'acct-work' } });
    expect(switchButton()).toBeEnabled();
    expect(switchButton()).toHaveAttribute(
      'title',
      'A live session is checkpointed (its session id kept) and tried again under the chosen account right away.',
    );
  });

  it('reads the account the run is on, marked now, whichever it is', async () => {
    serve();
    mount({ accountId: 'acct-work' });
    const select = await picker();
    expect(select).toHaveValue('acct-work');
    expect(head()).toHaveTextContent(/^Account work$/);
    expect(optionWords(select)).toEqual([
      'The roomiest account',
      'machine login (me@example.com)',
      'work (work@example.com), Max, 5-hour 42 %, now',
    ]);
  });
});

describe('the preview', () => {
  it('asks the server what switching now would cut, for the chosen account, and says it — switching nothing', async () => {
    serve();
    mount();
    const select = await picker();
    // Nothing is asked while the picker reads where the run is.
    expect(sent(server, 'POST', SWITCH)).toEqual([]);

    fireEvent.change(select, { target: { value: 'acct-work' } });
    expect(await screen.findByTestId('switch-preview')).toHaveTextContent(
      'Checkpoints phase 3 now (the session id is kept); phase 7 finishes on the old account first.',
    );
    expect(sent(server, 'POST', SWITCH)).toEqual([{ accountId: 'acct-work', dry: true, when: 'now' }]);
    expect(toast).not.toHaveBeenCalled();

    // Back on the run’s own account, there is nothing to preview and nothing more is asked.
    fireEvent.change(select, { target: { value: 'default' } });
    expect(screen.queryByTestId('switch-preview')).toBeNull();
    expect(sent(server, 'POST', SWITCH)).toHaveLength(1);
  });

  it('says the server’s reason when it would refuse the switch', async () => {
    serve();
    // A refusal is a 409 with the reason, which the transport throws — the same refusals as the switch.
    server.reads[`POST ${SWITCH}`] = () => {
      throw refused();
    };
    mount();
    fireEvent.change(await picker(), { target: { value: 'acct-work' } });
    expect(await screen.findByTestId('switch-preview')).toHaveTextContent(RETIRED);
    expect(sent(server, 'POST', SWITCH)).toEqual([{ accountId: 'acct-work', dry: true, when: 'now' }]);
  });
});

describe('the switch', () => {
  it('offers the next boundary, previews that nothing is cut, and says what the switch did', async () => {
    serve();
    mount();
    const select = await picker();
    fireEvent.change(select, { target: { value: 'acct-work' } });
    await screen.findByTestId('switch-preview');
    fireEvent.change(moment(), { target: { value: 'boundary' } });
    await waitFor(() =>
      expect(screen.getByTestId('switch-preview')).toHaveTextContent(
        'At the next boundary: Checkpoints nothing; phases 3 and 7 finish on the old account first.',
      ),
    );
    expect(switchButton()).toHaveAttribute(
      'title',
      'No live session is cut: each finishes on the account it started on, and everything after runs on the new one.',
    );

    fireEvent.click(switchButton());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Switched — phases 3 and 7 finish first — 2 queued phases moved with it. ' +
          'The next session runs under the other account.',
        'ok',
      ),
    );
    expect(sent(server, 'POST', SWITCH)).toEqual([
      { accountId: 'acct-work', dry: true, when: 'now' },
      { accountId: 'acct-work', dry: true, when: 'boundary' },
      { accountId: 'acct-work', when: 'boundary' },
    ]);
    // The choice is spent: the picker reads where the run is again, and the preview goes with it.
    await waitFor(() => expect(select).toHaveValue('default'));
    expect(screen.queryByTestId('switch-preview')).toBeNull();
  });

  it('holds the controls and says so while the switch is in flight', async () => {
    serve();
    let settle!: (outcome: unknown) => void;
    server.reads[`POST ${SWITCH}`] = (body: SwitchBody) =>
      body.dry
        ? answer(body)
        : new Promise((done) => {
            settle = done;
          });
    mount();
    const select = await picker();
    fireEvent.change(select, { target: { value: 'acct-work' } });
    await screen.findByTestId('switch-preview');

    fireEvent.click(switchButton());
    expect(await screen.findByRole('button', { name: 'Switching…' })).toBeDisabled();
    expect(select).toBeDisabled();
    expect(moment()).toBeDisabled();

    settle({ ok: true, run: null, checkpointed: 1, deferred: [7], rekeyed: 0 });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Switched — 1 live session checkpointed — phase 7 finishes first. The next session runs under the other account.',
        'ok',
      ),
    );
    await waitFor(() => expect(select).toBeEnabled());
    expect(sent(server, 'POST', SWITCH).at(-1)).toEqual({ accountId: 'acct-work', when: 'now' });
  });

  it('keeps the choice and says the server’s reason when the switch is refused', async () => {
    serve();
    server.reads[`POST ${SWITCH}`] = (body: SwitchBody) => {
      if (body.dry) return answer(body);
      throw refused();
    };
    mount();
    const select = await picker();
    fireEvent.change(select, { target: { value: 'acct-work' } });
    await screen.findByTestId('switch-preview');

    fireEvent.click(switchButton());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(RETIRED, 'error'));
    await waitFor(() => expect(switchButton()).toBeEnabled());
    expect(select).toHaveValue('acct-work');
  });

  it('asks about the roomiest account as auto and switches to it as auto — the server picks', async () => {
    serve();
    mount();
    fireEvent.change(await picker(), { target: { value: 'auto' } });
    await screen.findByTestId('switch-preview');
    fireEvent.click(switchButton());
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(sent(server, 'POST', SWITCH)).toEqual([
      { accountId: 'auto', dry: true, when: 'now' },
      { accountId: 'auto', when: 'now' },
    ]);
  });
});

describe('without --allow-accounts', () => {
  it('draws nothing for a run on the only account when the console cannot register another', async () => {
    serve({ accounts: [MACHINE], allowAccounts: false });
    const view = mount();
    await waitFor(() => expect(view.client.getQueryState(keys.accounts())?.status).toBe('success'));
    expect(view.container).toBeEmptyDOMElement();
    expect(sent(server, 'POST', SWITCH)).toEqual([]);
  });

  it('with the flag, names the one account and points at Settings ▸ Accounts to add another', async () => {
    serve({ accounts: [MACHINE], allowAccounts: true });
    mount();
    const link = await screen.findByRole('link', { name: 'Add another account to switch mid-run' });
    expect(link).toHaveAttribute('href', '#/settings/accounts');
    expect(head()).toHaveTextContent(/^Account machine login$/);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('with two accounts, still offers the switch: moving a run is a run verb, not a registration', async () => {
    serve({ allowAccounts: false });
    mount();
    const select = await picker();
    expect(select).toBeEnabled();
    expect(screen.queryByRole('link', { name: 'Add another account to switch mid-run' })).toBeNull();
    fireEvent.change(select, { target: { value: 'acct-work' } });
    expect(switchButton()).toBeEnabled();
  });
});

describe('where the row is drawn', () => {
  it('holds every control while the run’s settings sheet cannot act', async () => {
    serve();
    mount({ accountId: 'default' }, true);
    expect(await picker()).toBeDisabled();
    expect(moment()).toBeDisabled();
    expect(switchButton()).toBeDisabled();
  });

  it('lends a recovery the same row, never held — and nothing without a run, on either surface', async () => {
    expect(Object.isFrozen(ACCOUNT_RECOVERY_PARTS)).toBe(true);
    const AccountRow = ACCOUNT_RECOVERY_PARTS.AccountRow!;
    serve();
    // A recovery lends the row its narrow slice of a stopped run.
    const recovery = renderWithClient(
      <AccountRow slug="demo" run={{ status: 'halted', accountId: 'acct-work' }} />,
    );
    const select = await picker();
    expect(select).toHaveValue('acct-work');
    expect(select).toBeEnabled();
    recovery.unmount();

    const none = renderWithClient(<AccountRow slug="demo" run={undefined} />);
    await waitFor(() => expect(none.client.getQueryState(keys.accounts())?.status).toBe('success'));
    expect(none.container).toBeEmptyDOMElement();
    none.unmount();

    const sheet = mount(null);
    await waitFor(() => expect(sheet.client.getQueryState(keys.accounts())?.status).toBe('success'));
    expect(sheet.container).toBeEmptyDOMElement();
  });
});
