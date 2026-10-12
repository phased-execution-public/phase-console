/**
 * Settings ▸ Permissions ▸ Grants (quiet-console phase 22; control-tower phase
 * 138, #215, over phase 149's engine): every grant this console made, and
 * taking each one back.
 *
 * Each grant is drawn in the server's order, newest first — what it allowed,
 * how far it reaches, who gave it through which door and when, until when, the
 * item that asked, and exactly what it changed — its state and its risk
 * through the typed family. A live grant ends with Revoke and every live one
 * with Revoke all, each asked once with an optional reason that goes with the
 * press and stays on the row, because "why was this taken back" is the
 * question the row is read for a week later; a reason left blank sends none.
 * A revoke the owner door only wrote down is said in the server's words and
 * never as done. The `granted` push opens the list AT its grant
 * (`?grant=<id>`), and with no grant the group says where one is made.
 *
 * The wire is what is asserted: what each revoke route was sent.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantRecord } from '@/data/permissions';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a press came to is a toast, and the tray is the shell's: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));
// jsdom has no layout, so nothing scrolls: the call is what is asserted.
const scrolled = vi.hoisted(() => vi.fn());
vi.mock('@/lib/scroll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scroll')>()),
  scrollIntoScroller: scrolled,
}));

import { GrantsGroup, grantChangeWords, grantEndWords, grantMinute } from './grants';

/** The clock every case reads — "3 hours ago" is a fact about it. */
const NOW = '2026-10-08T12:00:00.000Z';

/** A low grant for one phase, given with the owner key from Your turn's item — live until tomorrow. */
const LIVE: GrantRecord = {
  id: 'g-1',
  at: '2026-10-08T09:00:00.000Z',
  by: 'mobin',
  door: 'owner',
  item: 'hs-1',
  wall: 'ask',
  tool: 'Bash',
  rule: 'Bash(npm test:*)',
  command: 'npm test',
  family: 'any',
  risk: 'low',
  scope: 'phase',
  slug: 'alpha',
  phase: 3,
  runId: 'r-1',
  until: '2026-10-09T09:00:00.000Z',
  changed: [{ kind: 'hook', rule: 'Bash(npm test:*)', runId: 'r-1', phase: 3, command: 'npm test' }],
  state: 'live',
};

/** A high grant for the plan, struck from the deny wall at this machine — revoked since, with its reason. */
const REVOKED: GrantRecord = {
  ...LIVE,
  id: 'g-2',
  at: '2026-10-08T08:00:00.000Z',
  door: 'local',
  item: 'hs-2',
  wall: 'deny',
  rule: 'Bash(npm publish:*)',
  command: 'npm publish',
  risk: 'high',
  scope: 'plan',
  until: null,
  changed: [
    {
      kind: 'policy',
      layer: 'plan',
      file: 'alpha.json',
      slug: 'alpha',
      op: 'strike',
      list: 'deny',
      rule: 'Bash(npm publish:*)',
    },
  ],
  state: 'revoked',
  endedAt: '2026-10-08T10:00:00.000Z',
  endedBy: 'mobin',
  endReason: 'published by hand',
};

/** A high grant pressed on an approval card from a paired device, on a console with no owner key — spent on its call. */
const SPENT: GrantRecord = {
  ...LIVE,
  id: 'g-3',
  at: '2026-10-08T11:30:00.000Z',
  door: 'device',
  item: null,
  card: 'card-7',
  rule: 'Bash(gh release create:*)',
  command: 'gh release create v1.2.0',
  risk: 'high',
  scope: 'call',
  slug: null,
  phase: null,
  runId: null,
  until: null,
  reason: 'the release needs its tag',
  unkeyed: true,
  changed: [],
  state: 'spent',
  endedAt: '2026-10-08T11:31:00.000Z',
  endedBy: 'console',
};

/** A second live grant — what Revoke all ends beside the first. */
const ALSO_LIVE: GrantRecord = {
  ...LIVE,
  id: 'g-4',
  at: '2026-10-08T09:30:00.000Z',
  rule: 'Bash(npm run lint:*)',
  command: 'npm run lint',
  changed: [{ kind: 'settings', runId: 'r-1', list: 'allow', rule: 'Bash(npm run lint:*)' }],
};

/**
 * A console holding `grants`, newest first, whose revoke routes end them as the
 * server would: revoked now, by mobin, with the reason sent — and none when
 * none was.
 */
function serve(grants: GrantRecord[]) {
  const held = grants.map((grant) => ({ ...grant }));
  const end = (grant: GrantRecord, body: unknown) => {
    const { reason } = (body ?? {}) as { reason?: string };
    return Object.assign(grant, {
      state: 'revoked' as const,
      endedAt: NOW,
      endedBy: 'mobin',
      ...(reason ? { endReason: reason } : {}),
    });
  };
  server.reads['/api/permissions/grants'] = () => ({
    grants: held.map((grant) => ({ ...grant })),
    live: held.filter((grant) => grant.state === 'live').length,
  });
  for (const grant of held) {
    server.reads[`POST /api/permissions/grants/${grant.id}/revoke`] = (body: unknown) => ({
      ok: true,
      grant: end(grant, body),
    });
  }
  server.reads['POST /api/permissions/grants/revoke-all'] = (body: unknown) => {
    const live = held.filter((grant) => grant.state === 'live');
    for (const grant of live) end(grant, body);
    return { ok: true, revoked: live.length, grants: held };
  };
}

/** A grant's row, by its id. */
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-grant="${id}"]`)!;
/** The word a row draws for one vocabulary of the typed family. */
const statusIn = (row: HTMLElement, vocab: 'grant' | 'risk') => row.querySelector(`[data-vocab="${vocab}"]`);
const revokesOf = (id: string) => sent(server, 'POST', `/api/permissions/grants/${id}/revoke`);
const revokeAlls = () => sent(server, 'POST', '/api/permissions/grants/revoke-all');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  server.calls = [];
  server.reads = {};
  toast.mockClear();
  scrolled.mockClear();
  window.location.hash = '#/settings/permissions';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('every grant, with its cause', () => {
  it('draws what each allowed, how far, who gave it through which door and when, until when, the item that asked and what it changed', async () => {
    serve([SPENT, LIVE, REVOKED]);
    renderWithClient(<GrantsGroup />);
    const rows = await screen.findAllByTestId('grant-row');
    // The server's order, newest first — the page never sorts its own.
    expect(rows.map((row) => row.dataset.grant)).toEqual(['g-3', 'g-1', 'g-2']);
    expect(screen.getByText('1 live')).toBeInTheDocument();

    const live = rowOf('g-1');
    expect(statusIn(live, 'grant')).toHaveTextContent('Live');
    expect(statusIn(live, 'risk')).toHaveTextContent('Low risk');
    expect(live).toHaveTextContent('Bash(npm test:*)');
    expect(live).toHaveTextContent('For this phase. Granted by mobin with the owner key, 3 hours ago.');
    expect(within(live).getByTestId('grant-end')).toHaveTextContent('Until 2026-10-09 09:00Z at the latest');
    expect(live).toHaveTextContent('alpha phase 3, run r-1');
    expect(within(live).getByRole('link', { name: 'The item that asked' })).toHaveAttribute(
      'href',
      '#/turn/hs-1',
    );
    expect(live).toHaveTextContent('Changed: the hook lets it through for run r-1 phase 3 (npm test).');
    expect(within(live).getByRole('button', { name: 'Revoke' })).toBeEnabled();

    const revoked = rowOf('g-2');
    expect(statusIn(revoked, 'grant')).toHaveTextContent('Revoked');
    expect(statusIn(revoked, 'risk')).toHaveTextContent('High risk');
    expect(revoked).toHaveTextContent('For this plan. Granted by mobin from this machine, 4 hours ago.');
    expect(within(revoked).getByTestId('grant-end')).toHaveTextContent(
      'Revoked 2026-10-08 10:00Z by mobin: published by hand',
    );
    expect(revoked).toHaveTextContent('Changed: the plan policy file: strike deny Bash(npm publish:*).');

    const spent = rowOf('g-3');
    expect(statusIn(spent, 'grant')).toHaveTextContent('Spent');
    expect(spent).toHaveTextContent(
      'For this one call. Granted by mobin from a paired device, 30 minutes ago, on the typed rule alone (no owner key).',
    );
    expect(within(spent).getByTestId('grant-end')).toHaveTextContent('Used 2026-10-08 11:31Z by console');
    expect(spent).toHaveTextContent('From an approval card');
    expect(within(spent).queryByRole('link')).toBeNull();
    expect(spent).toHaveTextContent('Why it was granted: the release needs its tag');
    expect(spent).toHaveTextContent('Changed: nothing — it was already so.');

    // An ended grant has nothing left to take back.
    for (const ended of [revoked, spent]) {
      expect(within(ended).queryByRole('button', { name: 'Revoke' })).toBeNull();
    }
  });
});

describe('Revoke ends one grant', () => {
  it('is asked once, with an optional reason that is sent with the press and kept on the row', async () => {
    serve([LIVE, REVOKED]);
    renderWithClient(<GrantsGroup />);
    await screen.findAllByTestId('grant-row');
    fireEvent.click(within(rowOf('g-1')).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke Bash(npm test:*)?' });
    expect(dialog).toHaveTextContent(
      'What this grant changed is undone, and nothing another live grant still holds. A session that relied on it meets its wall again.',
    );
    expect(dialog).toHaveTextContent('Why — kept on the grant’s row and in the journal');
    // Asked, not done: nothing goes until the question is answered.
    expect(revokesOf('g-1')).toEqual([]);
    const why = within(dialog).getByRole('textbox', { name: 'Why Bash(npm test:*) is revoked' });
    expect(why).toHaveAttribute('placeholder', 'optional');
    fireEvent.change(why, { target: { value: '  the suite runs in CI now  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(revokesOf('g-1')).toEqual([{ reason: 'the suite runs in CI now' }]));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Revoked Bash(npm test:*) — what it changed is undone.', 'ok'),
    );
    // The list is read again: the row says how it ended and why, and offers nothing more.
    await waitFor(() =>
      expect(within(rowOf('g-1')).getByTestId('grant-end')).toHaveTextContent(
        'Revoked 2026-10-08 12:00Z by mobin: the suite runs in CI now',
      ),
    );
    expect(within(rowOf('g-1')).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(screen.getByText('0 live')).toBeInTheDocument();
    expect(revokeAlls()).toEqual([]);
  });

  it('sends no reason when the field is left blank', async () => {
    serve([LIVE]);
    renderWithClient(<GrantsGroup />);
    await screen.findAllByTestId('grant-row');
    fireEvent.click(within(rowOf('g-1')).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revokesOf('g-1')).toEqual([{}]));
    await waitFor(() =>
      expect(within(rowOf('g-1')).getByTestId('grant-end')).toHaveTextContent(
        /^Revoked 2026-10-08 12:00Z by mobin$/,
      ),
    );
  });

  it('says a revoke the owner door only wrote down in the server’s words, and the grant stays live', async () => {
    serve([LIVE]);
    server.reads['POST /api/permissions/grants/g-1/revoke'] = {
      requested: true,
      request: { id: 'q-1', ask: 'asked by a session through the session door — revoke Bash(npm test:*)' },
      error: 'Asked of the owner: confirm it on Your turn.',
    };
    renderWithClient(<GrantsGroup />);
    await screen.findAllByTestId('grant-row');
    fireEvent.click(within(rowOf('g-1')).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Asked of the owner: confirm it on Your turn.', 'info', 6000),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(revokesOf('g-1')).toEqual([{}]);
    expect(rowOf('g-1')).toHaveAttribute('data-state', 'live');
    await waitFor(() => expect(within(rowOf('g-1')).getByRole('button', { name: 'Revoke' })).toBeEnabled());
  });
});

describe('Revoke all', () => {
  it('is asked once, with one reason for every live grant, and ends them all in one press', async () => {
    serve([ALSO_LIVE, LIVE, REVOKED]);
    renderWithClient(<GrantsGroup />);
    await screen.findAllByTestId('grant-row');
    expect(screen.getByText('2 live')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke all 2 live grants?' });
    expect(dialog).toHaveTextContent('Each grant’s changes are undone');
    expect(revokeAlls()).toEqual([]);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Why every live grant is revoked' }), {
      target: { value: 'handing the machine over' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke all' }));

    await waitFor(() => expect(revokeAlls()).toEqual([{ reason: 'handing the machine over' }]));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Revoked every live grant — what each changed is undone.', 'ok'),
    );
    await waitFor(() => expect(screen.getByText('0 live')).toBeInTheDocument());
    for (const id of ['g-4', 'g-1']) {
      expect(within(rowOf(id)).getByTestId('grant-end')).toHaveTextContent(
        'Revoked 2026-10-08 12:00Z by mobin: handing the machine over',
      );
    }
    // One press, one route: no grant was revoked one by one.
    expect([...revokesOf('g-4'), ...revokesOf('g-1')]).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Revoke all' })).toBeNull();
  });

  it('sends no reason when the field holds nothing but spaces', async () => {
    serve([LIVE]);
    renderWithClient(<GrantsGroup />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke all' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke all 1 live grant?' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Why every live grant is revoked' }), {
      target: { value: '   ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke all' }));
    await waitFor(() => expect(revokeAlls()).toEqual([{}]));
  });

  it('is absent when nothing is live', async () => {
    serve([REVOKED]);
    renderWithClient(<GrantsGroup />);
    await screen.findAllByTestId('grant-row');
    expect(screen.getByText('0 live')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke all' })).toBeNull();
  });
});

describe('the granted push opens the list at its grant', () => {
  it('marks the grant the address names as current, and scrolls it into view', async () => {
    window.location.hash = '#/settings/permissions?grant=g-2';
    serve([LIVE, REVOKED]);
    renderWithClient(<GrantsGroup />);
    await screen.findAllByTestId('grant-row');
    expect(rowOf('g-2')).toHaveAttribute('aria-current', 'true');
    expect(rowOf('g-1')).not.toHaveAttribute('aria-current');
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith(rowOf('g-2'), 'center'));
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it('marks nothing and scrolls nowhere when the grant it names is not on the list', async () => {
    window.location.hash = '#/settings/permissions?grant=g-9';
    serve([LIVE, REVOKED]);
    renderWithClient(<GrantsGroup />);
    for (const row of await screen.findAllByTestId('grant-row')) {
      expect(row).not.toHaveAttribute('aria-current');
    }
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('with no grant yet', () => {
  it('says where a grant is made, and offers nothing to revoke', async () => {
    serve([]);
    renderWithClient(<GrantsGroup />);
    expect(await screen.findByTestId('grants-empty')).toHaveTextContent(
      'No grant yet. A grant is made on Your turn, from a permission item — one press, at the scope you choose.',
    );
    expect(screen.getByText('0 live')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
  });
});

describe('the words', () => {
  it('says an instant to the minute, in UTC', () => {
    expect(grantMinute('2026-10-09T09:00:00.000Z')).toBe('2026-10-09 09:00Z');
  });

  it('says each change a grant made — what a revoke undoes', () => {
    expect(grantChangeWords({ kind: 'hook', rule: 'Bash(npm test:*)', runId: 'r-1', phase: 3 })).toBe(
      'the hook lets it through for run r-1 phase 3',
    );
    expect(
      grantChangeWords({
        kind: 'hook',
        rule: 'Bash(npm test:*)',
        runId: 'r-1',
        phase: 3,
        command: 'npm test',
      }),
    ).toBe('the hook lets it through for run r-1 phase 3 (npm test)');
    expect(
      grantChangeWords({ kind: 'settings', runId: 'r-1', list: 'allow', rule: 'Bash(npm run lint:*)' }),
    ).toBe('run r-1’s settings: allow Bash(npm run lint:*)');
    expect(
      grantChangeWords({
        kind: 'policy',
        layer: 'machine',
        file: 'policy.json',
        op: 'remove',
        list: 'deny',
        rule: 'WebFetch',
      }),
    ).toBe('the machine policy file: remove deny WebFetch');
    expect(
      grantChangeWords({
        kind: 'capability',
        flag: '--allow-webhooks',
        unit: 'com.phase-console',
        restart: 'when-idle',
      }),
    ).toBe('--allow-webhooks in com.phase-console, restarted when idle');
  });

  it('says until when a live grant holds, or how an ended one ended, by whom and why', () => {
    expect(grantEndWords(LIVE)).toBe('Until 2026-10-09 09:00Z at the latest');
    expect(grantEndWords({ ...LIVE, until: null })).toBe('Until you revoke it');
    expect(grantEndWords(SPENT)).toBe('Used 2026-10-08 11:31Z by console');
    expect(grantEndWords({ ...LIVE, state: 'expired', endedAt: '2026-10-09T09:00:00.000Z' })).toBe(
      'Expired 2026-10-09 09:00Z',
    );
    expect(grantEndWords(REVOKED)).toBe('Revoked 2026-10-08 10:00Z by mobin: published by hand');
    expect(grantEndWords({ ...LIVE, state: 'revoked' })).toBe('Revoked');
  });
});
