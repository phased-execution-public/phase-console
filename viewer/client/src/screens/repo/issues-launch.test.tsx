/**
 * The plan-from-issues launch — the payload, the parity that keeps it whole,
 * and the dialog's one press (7.0, quiet-console phase 18).
 *
 * Three questions, and the second is the one the plan asked for in as many
 * words:
 *
 *  1. **What does one press actually send?** The builder is pure, so it is
 *     pinned field by field including the omissions — a key that stops being
 *     sent degrades silently to the server's own default, and the session looks
 *     healthy and is not the session that was asked for.
 *  2. **Can this dialog reach every option the server accepts?** Every member of
 *     `AGENT_TICKET_FIELDS` must be either in a payload this surface can send or
 *     in `TICKET_FIELD_GAPS` with a written reason — the same rule the launch
 *     form lives under (`screens/launch/model/schema-parity.test.ts`).
 *  3. **What does the dialog do with the answer?** A ticket lands on its
 *     session; a refusal stays beside Launch, in the server's words, until the
 *     next press.
 *
 * The launch form stands in as its contract with the door (`LaunchForm`): a
 * Launch that hands over a launch body, and the line beside it. Its own fields
 * are its own suite's.
 */

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TICKET_FIELDS } from '@shared/run-settings.js';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { EMPTY } from '@/screens/launch/model/schema';
import { MODES, buildLaunch, shows } from '@/screens/launch/model/modes';
import { MemoryRouterProvider } from '@/shell/router';
import {
  IssuesLaunchDialog,
  issuesTicket,
  launchBlockedReason,
  briefBytes,
  TICKET_FIELD_GAPS,
  BRIEF_MAX,
  BRIEF_MAX_BYTES,
} from './issues-launch';
import { SELECTION_MAX } from './issues';

const { agentTicket } = vi.hoisted(() => ({ agentTicket: vi.fn() }));
vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, agentTicket } };
});

vi.mock('@/screens/launch/door', () => ({
  LaunchForm: (props: {
    mode: string;
    onLaunch?: (body: Record<string, unknown>) => void;
    footerNote?: ReactNode;
    blocked?: boolean;
    blockedReason?: string;
    cancel?: ReactNode;
  }) => (
    <div data-testid="launch-form" data-mode={props.mode}>
      <button
        type="button"
        disabled={props.blocked}
        onClick={() =>
          props.onLaunch?.(
            // What each mode's form hands over: `plan` offers no permission
            // field and no first message; `fix` offers the mode, and a prompt
            // typed by mistake must not travel.
            props.mode === 'fix'
              ? { model: 'claude-opus-5', permissionMode: '', prompt: 'typed' }
              : { model: 'claude-opus-5', effort: 'high' },
          )
        }
      >
        Launch
      </button>
      <div data-testid="footer-note">{props.blocked ? props.blockedReason : props.footerNote}</div>
      {props.cancel}
    </div>
  ),
}));

/** Every choice turned ON, so a conditionally-sent field is visible to the walk. */
const LOUD = {
  ...EMPTY,
  model: 'claude-opus-5',
  effort: 'high',
  accountId: 'work',
  ultracode: true,
  attachDefaultSkills: true,
  skills: ['design-system'],
};

const TICKET = (over: Partial<Parameters<typeof issuesTicket>[1]> = {}) =>
  issuesTicket(buildLaunch(LOUD, 'plan', ['phased-execution']), {
    brief: 'close these three',
    issues: ['acme/one#7', 'acme/two#3'],
    size: { cols: 120, rows: 40 },
    ...over,
  });

const MINTED = (id: string) => ({
  ok: true,
  sessionId: id,
  token: 't',
  expiresAt: 0,
  path: '/ws/terminal',
  session: { id, label: 'Claude 1', kind: 'claude' },
});

let landed: string[] = [];

beforeEach(() => {
  landed = [];
  agentTicket.mockReset();
});

function mount(node: React.ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/repo/issues" onNavigate={(path) => landed.push(path)}>
        {node}
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('one press sends exactly what was chosen', () => {
  it('carries the issues as REFS, the brief, and every option the form offered', () => {
    expect(TICKET()).toEqual({
      intent: 'plan',
      brief: 'close these three',
      issues: ['acme/one#7', 'acme/two#3'],
      model: 'claude-opus-5',
      effort: 'high',
      accountId: 'work',
      ultracode: true,
      // The plan's default skills are UNIONED by the caller, not the server: a
      // ticket has no attach flag for the server to union with.
      skills: ['phased-execution', 'design-system'],
      cols: 120,
      rows: 40,
    });
  });

  it('sends REFS and never issue TEXT', () => {
    // The server resolves each ref against its own cache and composes the
    // section itself, applying its own sanitiser. A client that pasted issue
    // text would walk around all of it.
    const body = TICKET();
    expect(body.issues).toEqual(['acme/one#7', 'acme/two#3']);
    expect(JSON.stringify(body)).not.toContain('the lock never releases');
  });

  it('omits an empty brief and an empty selection rather than sending empty values', () => {
    // The BUILDER's rule: a ticket that sends `issues: []` and one that sends
    // nothing must not be two different things to a server whose absent state
    // IS "no issues".
    //
    // ⚠️ This is not a claim that such a ticket is legal. It is not — the server
    // answers `400 a plan session needs a brief.` — and the dialog is what must
    // never compose one. That is `launchBlockedReason`, below.
    const bare = issuesTicket({}, { brief: '   ', issues: [] });
    expect(bare).toEqual({ intent: 'plan' });
    expect('brief' in bare).toBe(false);
    expect('issues' in bare).toBe(false);
    // …and the dialog would never have got here.
    expect(
      launchBlockedReason({ allowAgent: true, rootOpen: true, issues: [], brief: '   ', pending: false }),
    ).toBeTruthy();
  });

  describe('the launch refuses everything the server would refuse', () => {
    const ok = { allowAgent: true, rootOpen: true, issues: ['acme/one#7'], brief: 'do it', pending: false };

    it('opens only when every condition holds', () => {
      expect(launchBlockedReason(ok)).toBeUndefined();
    });

    it('refuses an empty brief — `agent.ts` answers 400 on one', () => {
      expect(launchBlockedReason({ ...ok, brief: '' })).toMatch(/brief/i);
      expect(launchBlockedReason({ ...ok, brief: '   \n  ' })).toMatch(/brief/i);
    });

    it('refuses an empty selection, the missing flag, a closed source and the cap', () => {
      expect(launchBlockedReason({ ...ok, issues: [] })).toMatch(/at least one issue/i);
      expect(launchBlockedReason({ ...ok, allowAgent: false })).toMatch(/--allow-agent/);
      expect(launchBlockedReason({ ...ok, rootOpen: false })).toMatch(/source directory/i);
      expect(
        launchBlockedReason({
          ...ok,
          issues: Array.from({ length: SELECTION_MAX + 1 }, (_, i) => `a/b#${i}`),
        }),
      ).toMatch(new RegExp(String(SELECTION_MAX)));
    });

    it('refuses a brief the SERVER would refuse — bytes, not characters', () => {
      // `maxLength` counts UTF-16 code units and `agent.ts` counts bytes, so
      // ~4 100 Persian characters clear the textarea and are refused by the
      // server. The dialog refuses them before the press.
      const persian = 'ی'.repeat(4200);
      expect(persian.length).toBeLessThan(BRIEF_MAX);
      expect(briefBytes(persian)).toBeGreaterThan(BRIEF_MAX_BYTES);
      expect(launchBlockedReason({ ...ok, brief: persian })).toMatch(/bytes/i);
      // …and an ASCII brief of the same character count is fine, which is what
      // makes this a UNIT question rather than a smaller cap.
      expect(launchBlockedReason({ ...ok, brief: 'a'.repeat(4200) })).toBeUndefined();
    });

    it('says it is starting rather than any other reason, once it is', () => {
      expect(launchBlockedReason({ ...ok, brief: '', pending: true })).toMatch(/starting/i);
    });
  });

  it('never carries a permission mode — the omission IS the choice', () => {
    // A plan-authoring session always starts in plan mode, so it presents the
    // graph for approval before writing. A mode chosen here could write a plan
    // nobody approved.
    const body = TICKET();
    expect('permissionMode' in body).toBe(false);
    expect('permissionProfile' in body).toBe(false);
    expect(shows('plan', 'permissionProfile')).toBe(false);
  });

  it('`default` account is still an omission, and `auto` still travels', () => {
    expect('accountId' in buildLaunch({ ...LOUD, accountId: 'default' }, 'plan', [])).toBe(false);
    expect(buildLaunch({ ...LOUD, accountId: 'auto' }, 'plan', []).accountId).toBe('auto');
  });

  it('ultracode is off unless it was ticked', () => {
    expect('ultracode' in buildLaunch({ ...LOUD, ultracode: false }, 'plan', [])).toBe(false);
  });

  it('the two ceilings are the server’s, mirrored where they are enforced', () => {
    // `TICKET_ISSUES_MAX` is a count and mirrors exactly. `MAX_BRIEF_BYTES` is
    // BYTES and this is CHARACTERS — the textarea's cap, same as the wizard's.
    expect(SELECTION_MAX).toBe(20);
    expect(BRIEF_MAX).toBe(8000);
  });
});

describe('every ticket field is reachable, or its absence is written down', () => {
  /** What this surface can actually put on the wire, with everything turned on. */
  const sendable = new Set(Object.keys(TICKET()));

  it('names every AGENT_TICKET_FIELDS member exactly once, in one place or the other', () => {
    const unreachable: string[] = [];
    for (const field of AGENT_TICKET_FIELDS) {
      if (sendable.has(field)) continue;
      if (field in TICKET_FIELD_GAPS) continue;
      unreachable.push(field);
    }
    expect(
      unreachable,
      'add the control to `plan` mode, or record why this ticket cannot carry it in TICKET_FIELD_GAPS',
    ).toEqual([]);
  });

  it('records no reason for a field it DOES send', () => {
    // A gap entry beside a field the payload carries is a stale explanation,
    // which is worse than none: it describes a decision nobody made.
    const contradictions = Object.keys(TICKET_FIELD_GAPS).filter((field) => sendable.has(field));
    expect(contradictions).toEqual([]);
  });

  it('records no reason for a field the server does not have', () => {
    const ghosts = Object.keys(TICKET_FIELD_GAPS).filter(
      (field) => !(AGENT_TICKET_FIELDS as readonly string[]).includes(field),
    );
    expect(ghosts, 'a gap for a field no door reads is a reason nobody needs').toEqual([]);
  });

  it('every recorded gap gives an actual reason, not a shrug', () => {
    for (const [field, reason] of Object.entries(TICKET_FIELD_GAPS)) {
      expect(reason.length, `"${field}" needs a reason worth reading`).toBeGreaterThan(40);
    }
  });

  it('sends nothing the ticket door would not read', () => {
    const accepted = new Set<string>(AGENT_TICKET_FIELDS);
    // `kind` is added by the API client itself, not by this builder.
    for (const field of sendable) {
      expect(accepted.has(field), `this dialog would send "${field}", which no ticket door reads`).toBe(true);
    }
  });

  it('is the WIZARD’s field set plus the two things a wizard cannot know', () => {
    // One launcher, extended: `issues` and `brief` are the ticket's own, and
    // every choice comes from `MODES.plan`.
    expect([...MODES.plan.fields]).toEqual([
      'model',
      'effort',
      'accountId',
      'attachDefaultSkills',
      'skills',
      'ultracode',
    ]);
    expect(MODES.plan.door).toBe('launch');
  });
});

describe('the dialog — the refs, the brief, and the one press', () => {
  const open = (over: Partial<React.ComponentProps<typeof IssuesLaunchDialog>> = {}) => {
    const onClose = vi.fn();
    mount(
      <IssuesLaunchDialog
        issues={['acme/one#7', 'acme/two#3']}
        allowAgent
        rootOpen
        onClose={onClose}
        {...over}
      />,
    );
    return onClose;
  };

  it('lists the selected refs, opens the form in plan mode, and holds the press until there is a brief', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Author a plan from 2 issues' });
    const selection = within(dialog).getByTestId('launch-selection');
    expect(
      within(selection)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['acme/one#7', 'acme/two#3']);
    expect(within(dialog).getByTestId('launch-form').getAttribute('data-mode')).toBe('plan');
    // Fixed, and said where a select would be — not a control.
    expect(within(dialog).getByText('plan mode — fixed for authoring')).toBeTruthy();

    expect(within(dialog).getByRole('button', { name: 'Launch' })).toBeDisabled();
    expect(within(dialog).getByTestId('footer-note').textContent).toMatch(/Write the brief first/);
    fireEvent.change(within(dialog).getByLabelText('The brief'), { target: { value: 'close them' } });
    expect(within(dialog).getByRole('button', { name: 'Launch' })).toBeEnabled();
  });

  it('posts the plan ticket — the refs, the brief, the size, no permission mode — and lands on the session', async () => {
    agentTicket.mockResolvedValue(MINTED('a1'));
    const onClose = open();
    fireEvent.change(screen.getByPlaceholderText(/what should this plan achieve/i), {
      target: { value: '  close them, and keep the lease honest  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    await waitFor(() => expect(agentTicket).toHaveBeenCalledTimes(1));
    const [body] = agentTicket.mock.calls[0]!;
    expect(body).toMatchObject({
      intent: 'plan',
      issues: ['acme/one#7', 'acme/two#3'],
      brief: 'close them, and keep the lease honest',
      model: 'claude-opus-5',
      effort: 'high',
    });
    expect(body).not.toHaveProperty('permissionMode');
    expect(typeof body.cols).toBe('number');
    expect(typeof body.rows).toBe('number');
    await waitFor(() => expect(landed).toEqual(['#/sessions/a1']));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the server’s refusal beside Launch, as an alert, and stays open with the brief', async () => {
    const said = 'the session limit is reached (8 of 8) — end one first.';
    agentTicket.mockRejectedValue(new ApiError(said, 409, '/api/terminal', { error: said }));
    const onClose = open();
    fireEvent.change(screen.getByLabelText('The brief'), { target: { value: 'close them' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    const refusal = await screen.findByTestId('launch-refused');
    expect(refusal).toHaveAttribute('role', 'alert');
    expect(refusal.textContent).toBe(said);
    expect(within(screen.getByTestId('footer-note')).getByTestId('launch-refused')).toBe(refusal);
    expect(screen.getByLabelText('The brief')).toHaveValue('close them');
    expect(onClose).not.toHaveBeenCalled();
    expect(landed).toEqual([]);
    // …and the next press is a fresh question.
    agentTicket.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(screen.queryByTestId('launch-refused')).toBeNull());
  });

  it('says why it cannot start: the missing flag, a closed source, and the ticket’s ceiling', () => {
    open({ allowAgent: false, rootOpen: false });
    expect(screen.getByTestId('launch-no-flag').textContent).toMatch(/--allow-agent/);
    expect(screen.getByText(/Open a source directory first/, { selector: 'p' })).toBeTruthy();
    expect(screen.getByTestId('footer-note').textContent).toMatch(/--allow-agent/);
  });

  it('over the ceiling, says by how much — and the launch stays shut', () => {
    open({ issues: Array.from({ length: SELECTION_MAX + 2 }, (_, i) => `acme/one#${i + 1}`) });
    fireEvent.change(screen.getByLabelText('The brief'), { target: { value: 'all of them' } });
    expect(screen.getByTestId('launch-over-cap').textContent).toMatch(/Deselect 2 and the launch opens/);
    expect(screen.getByRole('button', { name: 'Launch' })).toBeDisabled();
    expect(screen.getByTestId('footer-note').textContent).toMatch(`At most ${SELECTION_MAX} issues`);
  });
});

