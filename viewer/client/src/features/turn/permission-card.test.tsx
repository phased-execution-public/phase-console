/**
 * The permission card (control-tower phase 138, #215, exit criteria 1 and 2).
 *
 *   PC-1 the card offers EXACTLY the scopes the item's wall allows, as one control —
 *        each saying what it covers and when it ends — and says why it was raised;
 *   PC-2 a low or a medium grant is one press, at the scope chosen;
 *   PC-3 a high grant waits for the rule typed back; on a console with no owner key the
 *        card says so and the typed rule alone grants it;
 *   PC-4 on a keyed console a high grant also waits for a touch of the owner key inside
 *        the last five minutes — signing in or touching again is offered;
 *   PC-5 a never item draws no Grant at all: why it is never, and the manual path;
 *   PC-6 the server's own answer wins: a 400 `{rule, blast}` shows its blast radius and
 *        asks for its rule; a 202 `{requested}` is said to wait for the owner;
 *   PC-7 a request another door made on the item reads "asked by … — confirm?", and
 *        Confirm and Refuse are the owner's;
 *   GA-1 *Grant every low-risk ask* grants every open low-risk item at `call` or `phase`
 *        scope in one press, and nothing else.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRouterProvider } from '@/app/router';
import { ApiError } from '@/lib/api/client';
import type { InboxAction, TurnItem } from '@/lib/api';
import type { PermissionRecord } from '@/lib/api/human-steps';
import type { OwnerView } from '@/lib/api/owner';
import { queryClientConfig } from '@/lib/queries';

const grant = vi.fn();
vi.mock('@/lib/api/permissions', () => ({
  GRANTS_QUERY_KEY: ['permissions', 'grants'],
  permissionsApi: {
    grant: (...args: unknown[]) => grant(...args),
    grants: vi.fn(),
    revoke: vi.fn(),
    revokeAll: vi.fn(),
  },
}));

const owner = vi.fn();
const confirm = vi.fn();
const refuse = vi.fn();
const touch = vi.fn();
vi.mock('@/lib/api/owner', () => ({
  ownerApi: {
    owner: () => owner(),
    ownerConfirm: (id: string) => confirm(id),
    ownerRefuse: (id: string) => refuse(id),
  },
  signInAsOwner: () => touch(),
  enrolOwnerKey: vi.fn(),
}));

import { GrantEveryLowRisk, PermissionCard, lowRiskGrants } from './permission-card';

const at = (id: string, verb: string): string => `/api/human-steps/${id}/${verb}`;
const actions = (id: string, scope?: string): InboxAction[] => [
  ...(scope
    ? [
        {
          verb: 'grant',
          label: `Grant — ${scope}`,
          endpoint: at(id, 'grant'),
          method: 'POST' as const,
          body: { scope },
        },
      ]
    : []),
  { verb: 'deny', label: 'Deny', endpoint: at(id, 'deny'), method: 'POST' },
  { verb: 'convert', label: "I'll do it myself", endpoint: at(id, 'convert'), method: 'POST' },
];

const ASK = {
  wall: 'ask',
  tool: 'Bash',
  rule: 'Bash(npm test:*)',
  command: 'npm test --workspace viewer',
  need: 'The phase runs its own suite before it hands off.',
  family: 'any',
  risk: 'low',
  scopes: ['call', 'phase', 'plan', 'repository', 'always'],
} satisfies PermissionRecord;

function item(over: Partial<TurnItem> = {}, id = 's1'): TurnItem {
  const permission: PermissionRecord = over.permission ?? ASK;
  return {
    item: id,
    record: 'ledger',
    source: 'declared',
    kind: 'permission',
    why: 'permission',
    proofType: 'grant',
    group: 'now',
    rows: [`human-step:alpha:3:${id}`],
    title: 'Run the test suite',
    need: '',
    how: '',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    runId: 'r-1',
    since: '2026-10-07T10:00:00.000Z',
    href: '/plan/alpha/phase/3',
    actions: actions(id, permission.never ? undefined : (permission.scopes?.[0] ?? 'call')),
    permission,
    ...over,
  } as TurnItem;
}

const DENY_WALL = {
  wall: 'deny',
  tool: 'Bash',
  rule: 'Bash(npm publish:*)',
  command: 'npm publish',
  need: 'The phase publishes the package.',
  family: 'any',
  risk: 'high',
  scopes: ['call', 'phase', 'plan', 'repository', 'always'],
} satisfies PermissionRecord;

const NEVER = {
  wall: 'deny',
  tool: 'Bash',
  rule: 'Bash(git push --force:*)',
  command: 'git push --force origin main',
  family: 'force-push',
  risk: 'never',
  scopes: [],
  never: {
    why: 'a forced or deleting push rewrites or removes what a remote already holds',
    manual: 'Push it yourself from a terminal if you mean it.',
  },
} satisfies PermissionRecord;

const view = (over: Partial<OwnerView> = {}): OwnerView => ({
  state: 'unenrolled',
  mode: 'unenrolled',
  keys: [],
  session: null,
  requests: [],
  relyingParty: { id: 'localhost', origin: 'http://localhost:4130' },
  ...over,
});

const FRESH = {
  id: 'o1',
  keyId: 'k1',
  label: 'This Mac',
  origin: 'http://localhost:4130',
  startedAt: '2026-10-08T09:00:00.000Z',
  lastSeenAt: '2026-10-08T09:00:00.000Z',
  assertedAt: new Date(Date.now() - 60_000).toISOString(),
  idleEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
  freshUntil: new Date(Date.now() + 240_000).toISOString(),
  fresh: true,
};

function wrap(node: ReactNode) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const perform = vi.fn();
function card(it: TurnItem) {
  const row = {
    id: it.rows[0]!,
    actions: it.actions,
  } as unknown as Parameters<typeof PermissionCard>[0]['row'];
  return wrap(<PermissionCard item={it} permission={it.permission!} row={row} perform={perform} />);
}

const granted = (scope: string) => ({
  ok: true,
  granted: { id: 'g-1', rule: 'Bash(npm test:*)', scope, state: 'live' },
  resumes: [],
});

beforeEach(() => {
  grant.mockReset();
  owner.mockReset();
  confirm.mockReset();
  refuse.mockReset();
  touch.mockReset();
  perform.mockReset();
  owner.mockResolvedValue(view());
});

describe('PC-1 the scopes the wall allows, as one control', () => {
  it('draws one choice per offered scope, narrowest first, each with what it covers and when it ends', () => {
    card(item());
    const group = screen.getByRole('radiogroup', { name: /how far/i });
    const choices = within(group).getAllByRole('radio');
    expect(choices.map((choice) => choice.getAttribute('value'))).toEqual(ASK.scopes);
    const labels = within(group).getAllByTestId('grant-scope');
    expect(labels.map((label) => label.querySelector('[data-part="name"]')!.textContent)).toEqual([
      'This call',
      'This phase',
      'This plan',
      'This repository',
      'Always',
    ]);
    for (const label of labels) {
      expect(label.querySelector('[data-part="covers"]')!.textContent).toBeTruthy();
      expect(label.querySelector('[data-part="ends"]')!.textContent).toBeTruthy();
    }
    expect(labels[0]!.querySelector('[data-part="ends"]')!.textContent).toMatch(/used|24 hours/i);
    expect(labels[1]!.querySelector('[data-part="ends"]')!.textContent).toMatch(/phase settles/i);
    expect(labels[4]!.querySelector('[data-part="ends"]')!.textContent).toMatch(/revoke/i);
    // The narrowest is chosen until a person picks another.
    expect((choices[0] as HTMLInputElement).checked).toBe(true);
  });

  it('offers only what the wall allows — an MCP tool is never held to a lane', () => {
    card(
      item({
        permission: {
          ...ASK,
          wall: 'mcp',
          tool: 'mcp__linear__create_issue',
          rule: 'mcp__linear',
          scopes: ['plan', 'repository', 'always'],
        },
      }),
    );
    const values = within(screen.getByRole('radiogroup')).getAllByRole('radio');
    expect(values.map((choice) => choice.getAttribute('value'))).toEqual(['plan', 'repository', 'always']);
  });

  it('says why it was raised: the command, why the phase needs it, the wall and the rule', () => {
    card(item());
    const facts = screen.getByTestId('turn-permission');
    expect(facts.textContent).toContain('Raised because the AI lacks permission to run');
    expect(facts.textContent).toContain('npm test --workspace viewer');
    expect(facts.textContent).toContain('The phase runs its own suite before it hands off.');
    expect(facts.textContent).toContain('Bash(npm test:*)');
    expect(screen.getByTestId('grant-risk').textContent).toMatch(/low risk/i);
  });
});

describe('PC-2 a low or a medium grant is one press', () => {
  it('grants at the narrowest scope in one press', async () => {
    grant.mockResolvedValue(granted('call'));
    card(item());
    const primary = screen.getByTestId('turn-primary');
    expect(primary.textContent).toMatch(/^Grant/);
    expect((primary as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(primary);
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
    expect(grant).toHaveBeenCalledWith('s1', { scope: 'call' });
  });

  it('a medium scope is one press too, and its risk is shown', async () => {
    grant.mockResolvedValue(granted('plan'));
    card(item());
    fireEvent.click(screen.getByRole('radio', { name: /this plan/i }));
    expect(screen.getByTestId('grant-risk').textContent).toMatch(/medium risk/i);
    fireEvent.click(screen.getByTestId('turn-primary'));
    await waitFor(() => expect(grant).toHaveBeenCalledWith('s1', { scope: 'plan' }));
  });
});

describe('PC-3 a high grant asks for the rule typed', () => {
  it('stays disabled until the rule is typed exactly; with no key enrolled the card says so', async () => {
    grant.mockResolvedValue(granted('phase'));
    card(item({ permission: DENY_WALL, actions: actions('s1', 'call') }));
    expect(screen.getByTestId('grant-risk').textContent).toMatch(/high risk/i);
    expect(screen.getByTestId('grant-blast').textContent).toContain('phase 3 of alpha');
    await waitFor(() => expect(screen.getByTestId('grant-owner').textContent).toMatch(/no owner key/i));
    const primary = screen.getByTestId('turn-primary') as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    const typed = screen.getByLabelText(/type the rule/i);
    fireEvent.change(typed, { target: { value: 'Bash(npm publish' } });
    expect(primary.disabled).toBe(true);
    fireEvent.change(typed, { target: { value: 'Bash(npm publish:*)' } });
    expect(primary.disabled).toBe(false);
    fireEvent.click(primary);
    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith('s1', { scope: 'call', rule: 'Bash(npm publish:*)' }),
    );
  });

  it('Always is high on any wall, and asks for the rule', () => {
    card(item());
    fireEvent.click(screen.getByRole('radio', { name: /always/i }));
    expect(screen.getByTestId('grant-risk').textContent).toMatch(/high risk/i);
    expect(screen.getByLabelText(/type the rule/i)).toBeTruthy();
    expect((screen.getByTestId('turn-primary') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PC-4 on a keyed console a high grant needs a fresh touch of the owner key', () => {
  it('stays disabled with the rule typed until the key is touched, and offers the sign-in', async () => {
    owner.mockResolvedValue(view({ state: 'enrolled', mode: 'enrolled' }));
    touch.mockResolvedValue({ session: FRESH, fresh: true });
    card(item({ permission: DENY_WALL }));
    await waitFor(() => expect(screen.getByTestId('grant-owner').textContent).toMatch(/sign in/i));
    fireEvent.change(screen.getByLabelText(/type the rule/i), { target: { value: 'Bash(npm publish:*)' } });
    expect((screen.getByTestId('turn-primary') as HTMLButtonElement).disabled).toBe(true);
    owner.mockResolvedValue(view({ state: 'unlocked', mode: 'enrolled', session: FRESH }));
    fireEvent.click(within(screen.getByTestId('grant-owner')).getByRole('button', { name: /owner key/i }));
    await waitFor(() => expect(touch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByTestId('turn-primary') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('a session whose touch is older than five minutes must touch again', async () => {
    owner.mockResolvedValue(
      view({
        state: 'unlocked',
        mode: 'enrolled',
        session: { ...FRESH, fresh: false, freshUntil: new Date(Date.now() - 1000).toISOString() },
      }),
    );
    card(item({ permission: DENY_WALL }));
    await waitFor(() => expect(screen.getByTestId('grant-owner').textContent).toMatch(/touch/i));
    fireEvent.change(screen.getByLabelText(/type the rule/i), { target: { value: 'Bash(npm publish:*)' } });
    expect((screen.getByTestId('turn-primary') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a low grant on a keyed console is still one press — and says it is asked of the owner without a session', async () => {
    owner.mockResolvedValue(view({ state: 'enrolled', mode: 'enrolled' }));
    grant.mockResolvedValue({ requested: true, request: { id: 'q1' }, error: 'asked' });
    card(item());
    await waitFor(() => expect(screen.getByTestId('grant-owner').textContent).toMatch(/asked of the owner/i));
    fireEvent.click(screen.getByTestId('turn-primary'));
    await waitFor(() => expect(grant).toHaveBeenCalledWith('s1', { scope: 'call' }));
  });
});

describe('PC-5 a never item offers no grant through any door', () => {
  it('draws no Grant — why it is never, and the manual path', () => {
    card(item({ permission: NEVER, actions: actions('s1') }));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: /^grant/i })).toBeNull();
    expect(screen.getByTestId('grant-risk').textContent).toMatch(/never/i);
    const never = screen.getByTestId('turn-permission-never');
    expect(never.textContent).toContain('rewrites or removes what a remote already holds');
    const manual = within(never).getByRole('list');
    expect(manual.textContent).toContain('Push it yourself from a terminal');
    expect(manual.textContent).toContain('git push --force origin main');
    expect(screen.getByTestId('turn-primary').textContent).toBe("I'll do it myself");
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });
});

describe('PC-5b on a keyed console a never item still offers nothing to sign in for', () => {
  it('draws no owner line and no Grant', async () => {
    owner.mockResolvedValue(view({ state: 'enrolled', mode: 'enrolled' }));
    card(item({ permission: NEVER, actions: actions('s1') }));
    await waitFor(() => expect(owner).toHaveBeenCalled());
    expect(screen.queryByTestId('grant-owner')).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
  });
});

describe('PC-4b a failed read of the owner door keeps a high grant shut', () => {
  it('says the state could not be read, and Grant stays disabled with the rule typed', async () => {
    owner.mockRejectedValue(new ApiError('down', 503, '/api/owner'));
    card(item({ permission: DENY_WALL }));
    await waitFor(() => expect(screen.getByTestId('grant-owner').textContent).toMatch(/could not be read/i), {
      timeout: 4000,
    });
    fireEvent.change(screen.getByLabelText(/type the rule/i), { target: { value: 'Bash(npm publish:*)' } });
    expect((screen.getByTestId('turn-primary') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PC-6 the server has the last word', () => {
  it('a 400 {rule, blast} shows the server’s blast radius and asks for its rule', async () => {
    grant.mockRejectedValue(
      new ApiError('type the rule exactly', 400, '/api/human-steps/s1/grant', {
        rule: 'Bash(npm publish --tag next:*)',
        blast: { sentence: 'reaches run r-1 of alpha, phase 3 only, until 10:00Z at the latest.' },
      }),
    );
    card(item({ permission: DENY_WALL }));
    // A high press waits for the owner door's answer — here, no key.
    await screen.findByTestId('grant-owner');
    const typed = screen.getByLabelText(/type the rule/i);
    fireEvent.change(typed, { target: { value: 'Bash(npm publish:*)' } });
    fireEvent.click(screen.getByTestId('turn-primary'));
    await waitFor(() =>
      expect(screen.getByTestId('grant-blast').textContent).toContain('reaches run r-1 of alpha'),
    );
    expect(screen.getByTestId('grant-rule').textContent).toBe('Bash(npm publish --tag next:*)');
    expect((screen.getByTestId('turn-primary') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PC-7 a request another door made is the owner’s to confirm', () => {
  it('reads "asked by … — confirm?" with Confirm and Refuse', async () => {
    confirm.mockResolvedValue({ request: null, result: { status: 200, answer: {} } });
    card(
      item({
        requests: [
          {
            id: 'q1',
            at: '2026-10-08T09:00:00.000Z',
            state: 'open',
            door: 'supervisor',
            label: 'the supervisor',
            press: 'grant-step',
            authority: 'grant',
            risk: 'low',
            method: 'POST',
            path: '/api/human-steps/s1/grant',
            body: { scope: 'call' },
            summary: 'grant Bash(npm test:*) for this one call',
            item: { kind: 'human-step', id: 's1' },
            repeats: 0,
            ask: 'asked by the supervisor through the supervisor door — grant Bash(npm test:*) for this one call — confirm?',
          },
        ],
      }),
    );
    const request = screen.getByTestId('turn-owner-request');
    expect(request.textContent).toContain('asked by the supervisor');
    expect(request.textContent).toContain('confirm?');
    fireEvent.click(within(request).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('q1'));
    expect(within(request).getByRole('button', { name: 'Refuse' })).toBeTruthy();
  });
});

describe('GA-1 Grant every low-risk ask', () => {
  const low = item({}, 'a1');
  const lowPhase = item({ permission: { ...ASK, scopes: ['phase', 'plan', 'repository', 'always'] } }, 'a2');
  const high = item({ permission: DENY_WALL }, 'a3');
  const never = item({ permission: NEVER, actions: actions('a4') }, 'a4');
  const settled = item({ humanStep: { state: 'proven' } as TurnItem['humanStep'] }, 'a5');
  const projected = item({ record: 'projected' }, 'a6');

  it('picks every open low-risk ledger item at call or phase scope, and nothing else', () => {
    expect(lowRiskGrants([low, lowPhase, high, never, settled, projected])).toEqual([
      { item: 'a1', scope: 'call' },
      { item: 'a2', scope: 'phase' },
    ]);
  });

  it('grants them all in one press', async () => {
    grant.mockResolvedValue(granted('call'));
    wrap(<GrantEveryLowRisk items={[low, lowPhase, high, never]} />);
    const button = screen.getByRole('button', { name: /grant every low-risk ask/i });
    expect(button.textContent).toContain('2');
    fireEvent.click(button);
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(2));
    expect(grant).toHaveBeenCalledWith('a1', { scope: 'call' });
    expect(grant).toHaveBeenCalledWith('a2', { scope: 'phase' });
  });

  it('draws nothing when no low-risk ask is open', () => {
    const { container } = wrap(<GrantEveryLowRisk items={[high, never]} />);
    expect(container.textContent).toBe('');
  });
});
