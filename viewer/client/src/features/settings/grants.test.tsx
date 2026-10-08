/**
 * Settings ▸ Permissions ▸ Grants (control-tower phase 138, #215, exit criterion 3).
 *
 *   GR-1 every grant is listed — what, how far, which door and who, when, until when, and
 *        the item that caused it — with its state through the typed family;
 *   GR-2 a live grant ends with Revoke; an ended one says how it ended and offers none;
 *   GR-3 Revoke all is asked once, and ends every live grant; with none live it is absent;
 *   GR-4 the `granted` push's address (`?grant=<id>`) opens the list AT that grant;
 *   GR-5 with no grant, the card says where one is made.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRouterProvider } from '@/app/router';
import type { GrantRecord } from '@/lib/api/permissions';
import { queryClientConfig } from '@/lib/queries';

const grants = vi.fn();
const revoke = vi.fn();
const revokeAll = vi.fn();
vi.mock('@/lib/api/permissions', () => ({
  GRANTS_QUERY_KEY: ['permissions', 'grants'],
  permissionsApi: {
    grants: () => grants(),
    revoke: (id: string) => revoke(id),
    revokeAll: () => revokeAll(),
    grant: vi.fn(),
  },
}));

const scrolled = vi.fn();
vi.mock('@/lib/scroll', () => ({ scrollIntoScroller: (el: Element) => scrolled(el) }));

import { GrantsCard } from './grants';

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
  changed: [{ kind: 'hook', rule: 'Bash(npm test:*)', runId: 'r-1', phase: 3 }],
  state: 'live',
};

const ENDED: GrantRecord = {
  ...LIVE,
  id: 'g-2',
  rule: 'Bash(npm publish:*)',
  wall: 'deny',
  risk: 'high',
  scope: 'plan',
  until: null,
  door: 'local',
  item: 'hs-2',
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

function wrap(node: ReactNode, initial = '#/settings/permissions') {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={initial}>{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  grants.mockReset();
  revoke.mockReset();
  revokeAll.mockReset();
  grants.mockResolvedValue({ grants: [LIVE, ENDED], live: 1 });
  scrolled.mockReset();
});

describe('GR-1 every grant, with its cause', () => {
  it('lists what, how far, the door, when, until when and the item that asked', async () => {
    wrap(<GrantsCard />);
    const rows = await screen.findAllByTestId('grant-row');
    expect(rows).toHaveLength(2);
    const live = rows[0]!;
    expect(live.textContent).toContain('Bash(npm test:*)');
    expect(live.textContent).toContain('this phase');
    expect(live.textContent).toContain('mobin');
    expect(live.textContent).toMatch(/owner key/i);
    expect(live.textContent).toMatch(/until .*2026-10-09/);
    expect(live.textContent).toMatch(/Live/);
    const cause = within(live).getByRole('link', { name: /the item that asked/i });
    expect(cause.getAttribute('href')).toBe('#/turn/hs-1');
    expect(live.textContent).toContain('alpha phase 3');
    expect(live.textContent).toMatch(/changed/i);
  });
});

describe('GR-2 Revoke ends one grant', () => {
  it('a live grant revokes in one press; an ended one says how it ended', async () => {
    revoke.mockResolvedValue({ ok: true, grant: { ...LIVE, state: 'revoked' } });
    wrap(<GrantsCard />);
    const [live, ended] = await screen.findAllByTestId('grant-row');
    fireEvent.click(within(live!).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('g-1'));
    expect(within(ended!).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(ended!.textContent).toMatch(/revoked/i);
    expect(ended!.textContent).toContain('published by hand');
  });
});

describe('GR-3 Revoke all', () => {
  it('is asked once, then ends every live grant', async () => {
    revokeAll.mockResolvedValue({ ok: true, revoked: 1, grants: [] });
    wrap(<GrantsCard />);
    await screen.findAllByTestId('grant-row');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke all' }));
    await waitFor(() => expect(revokeAll).toHaveBeenCalledTimes(1));
  });

  it('is absent when nothing is live', async () => {
    grants.mockResolvedValue({ grants: [ENDED], live: 0 });
    wrap(<GrantsCard />);
    await screen.findAllByTestId('grant-row');
    expect(screen.queryByRole('button', { name: 'Revoke all' })).toBeNull();
  });
});

describe('GR-4 the granted push opens the list at its grant', () => {
  it('marks the grant the address names, and scrolls to it', async () => {
    wrap(<GrantsCard />, '#/settings/permissions?grant=g-2');
    const rows = await screen.findAllByTestId('grant-row');
    expect(rows[1]!.getAttribute('aria-current')).toBe('true');
    expect(rows[0]!.getAttribute('aria-current')).toBeNull();
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith(rows[1]));
  });
});

describe('GR-5 no grant yet', () => {
  it('says where a grant is made', async () => {
    grants.mockResolvedValue({ grants: [], live: 0 });
    wrap(<GrantsCard />);
    expect(await screen.findByTestId('grants-empty')).toBeTruthy();
    expect(screen.getByTestId('grants-empty').textContent).toMatch(/your turn/i);
  });
});
