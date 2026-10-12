/**
 * The permission card (7.0, quiet-console phase 8; control-tower phase 138,
 * #215; exit criterion 3).
 *
 *   PC-1 the card offers EXACTLY the scopes the item's wall allows, as one control —
 *        each saying what it covers and when it ends — and says why it was raised;
 *   PC-2 a low or a medium grant is one press, at the scope chosen, through `data/press.ts`;
 *   PC-3 a high grant waits for the rule typed back; on a console with no owner key the
 *        card says so and the typed rule alone grants it;
 *   PC-4 on a keyed console a high grant also waits for a touch of the owner key inside
 *        the last five minutes — signing in or touching again is offered;
 *   PC-5 a never item draws no Grant at all: why it is never, and the manual path;
 *   PC-6 the server's own answer wins: a 400 `{rule, blast}` shows its blast radius and
 *        asks for its rule; a 202 `{requested}` is said to wait for the owner;
 *   PC-7 a request another door made shows WHO asked, through WHICH door, and EXACTLY
 *        what the owner's Confirm replays — the method, the path, the body — never a
 *        label the page composed (#277);
 *   PC-8 a grant that went through does not take the item off the page: the card holds,
 *        says so, and tells the page (#270);
 *   GA-1 *Grant every low-risk ask* grants every open low-risk item at `call` or `phase`
 *        scope in one press, and nothing else.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { owner, post, touch } = vi.hoisted(() => ({ owner: vi.fn(), post: vi.fn(), touch: vi.fn() }));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) =>
      path.startsWith('/api/owner')
        ? owner()
        : Promise.reject(new actual.ApiError(`unmocked ${path}`, 500, path)),
    post: (path: string, body?: unknown) => post(path, body),
  };
});
vi.mock('@/data/owner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/owner')>();
  return { ...actual, signInAsOwner: () => touch() };
});

import { ApiError } from '@/data/http';
import type { InboxAction, PermissionRecord, TurnItem } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import type { OwnerView } from '@/data/owner';
import { MemoryRouterProvider } from '@/shell/router';
import { GrantEveryLowRisk, lowRiskGrants } from './grants';
import { PermissionCard } from './permission-card';

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
  const client = new QueryClient({ ...queryClientConfig, defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const perform = vi.fn();
const onSettled = vi.fn();
function card(it: TurnItem) {
  const row = {
    id: it.rows[0]!,
    actions: it.actions,
  } as unknown as Parameters<typeof PermissionCard>[0]['row'];
  return wrap(
    <PermissionCard
      item={it}
      permission={it.permission!}
      row={row}
      perform={perform}
      onSettled={onSettled}
    />,
  );
}

const granted = (scope: string) => ({
  ok: true,
  granted: { id: 'g-1', rule: 'Bash(npm test:*)', scope, state: 'live' },
  resumes: [],
});

beforeEach(() => {
  owner.mockReset();
  post.mockReset();
  touch.mockReset();
  perform.mockReset();
  onSettled.mockReset();
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
    expect(choices[0]!.getAttribute('data-state')).toBe('checked');
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

describe('PC-2 a low or a medium grant is one press, through the owner door', () => {
  it('grants at the narrowest scope in one press', async () => {
    post.mockResolvedValue(granted('call'));
    card(item());
    const primary = screen.getByTestId('turn-primary');
    expect(primary.textContent).toMatch(/^Grant/);
    expect((primary as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(primary);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(at('s1', 'grant'), { scope: 'call' });
  });

  it('a medium scope is one press too, and its risk is shown', async () => {
    post.mockResolvedValue(granted('plan'));
    card(item());
    fireEvent.click(screen.getByRole('radio', { name: /this plan/i }));
    expect(screen.getByTestId('grant-risk').textContent).toMatch(/medium risk/i);
    fireEvent.click(screen.getByTestId('turn-primary'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(at('s1', 'grant'), { scope: 'plan' }));
  });
});

describe('PC-3 a high grant asks for the rule typed', () => {
  it('stays disabled until the rule is typed exactly; with no key enrolled the card says so', async () => {
    post.mockResolvedValue(granted('phase'));
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
      expect(post).toHaveBeenCalledWith(at('s1', 'grant'), { scope: 'call', rule: 'Bash(npm publish:*)' }),
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
    post.mockResolvedValue({
      requested: true,
      request: {
        id: 'q1',
        at: '2026-10-08T09:00:00.000Z',
        state: 'open',
        door: 'device',
        label: 'the phone',
        press: 'grant-step',
        authority: 'grant',
        risk: 'low',
        method: 'POST',
        path: at('s1', 'grant'),
        body: { scope: 'call' },
        summary: 'grant Bash(npm test:*) for this one call',
        item: { kind: 'human-step', id: 's1' },
        repeats: 0,
        ask: 'asked by the phone through device — grant Bash(npm test:*) for this one call — confirm?',
      },
      error: 'asked',
    });
    card(item());
    await waitFor(() => expect(screen.getByTestId('grant-owner').textContent).toMatch(/asked of the owner/i));
    fireEvent.click(screen.getByTestId('turn-primary'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(at('s1', 'grant'), { scope: 'call' }));
    // Written down, not done: the card holds and says so — and the page is told (#270).
    expect((await screen.findByTestId('grant-settling')).textContent).toMatch(/asked of the owner/i);
    expect(onSettled).toHaveBeenCalledWith(expect.stringMatching(/asked of the owner/i));
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

  it('on a keyed console it still offers nothing to sign in for', async () => {
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
    post.mockRejectedValue(
      new ApiError('type the rule exactly', 400, at('s1', 'grant'), {
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
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe('PC-7 a request another door made is the owner’s to confirm (#277)', () => {
  const REQUEST = {
    id: 'q1',
    at: '2026-10-08T09:00:00.000Z',
    state: 'open' as const,
    door: 'supervisor',
    label: 'the supervisor',
    press: 'grant-step',
    authority: 'grant',
    risk: 'low',
    method: 'POST',
    path: at('s1', 'grant'),
    body: { scope: 'phase', reason: 'the suite is the gate' },
    // The server's gloss — which once misstated the press (#277): the prompt
    // shows the replay, never a summary.
    summary: 'grant Bash(npm test:*) for this one call',
    item: { kind: 'human-step', id: 's1' },
    repeats: 0,
    ask: 'asked by the supervisor through the supervisor door — grant Bash(npm test:*) for this one call — confirm?',
  };

  it('shows who asked, through which door, and exactly what Confirm replays: the method, the path, the body', async () => {
    post.mockResolvedValue({ request: null, result: { status: 200, answer: {} } });
    card(item({ requests: [REQUEST] }));
    const request = screen.getByTestId('turn-owner-request');
    expect(request.textContent).toContain('the supervisor');
    expect(request.textContent).toContain('through the supervisor door');
    expect(within(request).getByTestId('turn-owner-replay').textContent).toBe(`POST ${at('s1', 'grant')}`);
    const body = within(request).getByTestId('turn-owner-body').textContent ?? '';
    expect(body).toContain('"scope": "phase"');
    expect(body).toContain('"reason": "the suite is the gate"');
    // Never the gloss: the body says `phase`, and "this one call" is nowhere.
    expect(request.textContent).not.toContain('this one call');
    fireEvent.click(within(request).getByTestId('turn-owner-confirm'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/owner/requests/q1/confirm', undefined));
    expect(within(request).getByTestId('turn-owner-refuse')).toBeTruthy();
  });

  it('a local script that calls itself the owner is drawn as a script, its claim quoted — never as the owner asking', () => {
    card(
      item({
        requests: [
          { ...REQUEST, door: 'local', label: 'script', claims: 'the owner', ask: 'asked by script…' },
        ],
      }),
    );
    const request = screen.getByTestId('turn-owner-request');
    const words = request.textContent ?? '';
    expect(words).toContain('script (which calls itself “the owner”) asked through the local door');
    expect(within(request).getByTestId('turn-owner-claims').textContent).toBe('“the owner”');
    expect(words).not.toMatch(/the owner asked/);
  });

  it('a settled request is one quiet line', () => {
    card(item({ requests: [{ ...REQUEST, state: 'refused', settledAt: '2026-10-08T09:05:00.000Z' }] }));
    const request = screen.getByTestId('turn-owner-request');
    expect(request.textContent).toContain('refused');
    expect(within(request).queryByTestId('turn-owner-confirm')).toBeNull();
  });
});

describe('PC-8 a grant that went through is held on the page, not taken off it (#270)', () => {
  it('the card says the item is waiting on the console, offers no second Grant, and tells the page', async () => {
    post.mockResolvedValue(granted('call'));
    card(item());
    fireEvent.click(screen.getByTestId('turn-primary'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const held = await screen.findByTestId('grant-settling');
    expect(held.textContent).toContain('Granted for this one call');
    expect(held.textContent).toContain('leaves this list once the console confirms');
    expect(screen.queryByTestId('turn-primary')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(onSettled).toHaveBeenCalledWith(expect.stringContaining('Granted for this one call'));
    // Still on the page: the facts of the item stand.
    expect(screen.getByTestId('turn-permission').textContent).toContain('npm test --workspace viewer');
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

  it('grants them all in one press, and holds each on the page', async () => {
    post.mockResolvedValue(granted('call'));
    wrap(<GrantEveryLowRisk items={[low, lowPhase, high, never]} onSettled={onSettled} />);
    const button = screen.getByRole('button', { name: /grant every low-risk ask/i });
    expect(button.textContent).toContain('2');
    fireEvent.click(button);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenCalledWith(at('a1', 'grant'), { scope: 'call' });
    expect(post).toHaveBeenCalledWith(at('a2', 'grant'), { scope: 'phase' });
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
  });

  it('draws nothing when no low-risk ask is open', () => {
    const { container } = wrap(<GrantEveryLowRisk items={[high, never]} />);
    expect(container.textContent).toBe('');
  });
});
