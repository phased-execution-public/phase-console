/**
 * Sessions — the shell half: the list, the strip, the pane, the composer.
 *
 * (`sessions.test.tsx` is the agent half of the same page — the launcher, the
 * mode chip, the wizard. They were two files when this was two pages, and
 * splitting them by SUBJECT rather than by page is what let the merge happen
 * without rewriting either suite to agree with it.)
 *
 * xterm is mocked out wholesale. It measures a real font in a real layout
 * engine, which jsdom does not have — and none of what is worth asserting here
 * is xterm's behaviour anyway. What is worth asserting is the part that is
 * *ours* and invisible until it is wrong:
 *
 * - **Both ways the terminal can be absent say which one it is.** "Restart with
 *   `--allow-terminal`" and "`node-pty` did not load" are different problems
 *   with different fixes, and a page that showed one message for both would
 *   send someone to the wrong one.
 * - **No shell opens as a side effect of navigating.** Under StrictMode a mount
 *   that spawned a pty would spawn two.
 * - **The strip is a tab list**, and the composer sends a line with its Enter
 *   (the key bar has its own file: `keybar.test.tsx`).
 * - **The nav entry is gated but the route is not** — a deep link from a phone
 *   must explain itself, not resolve to the dashboard.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { Route } from '@/app/router';
import type { ConsoleState, ForeignSession, TerminalState } from '@/lib/api';
import { Composer } from './composer';

/* ------------------------------------------------------------------ *
 * Mocks
 * ------------------------------------------------------------------ */

// `vi.hoisted`: a `vi.mock` factory runs above every top-level `const` in the
// file, so anything it closes over has to be created here or it is in its
// temporal dead zone when the factory fires.
const { state, terminal, terminalTicket, terminalClose, agentTicket, sessionRegistry, pane } = vi.hoisted(
  () => ({
    state: vi.fn(),
    terminal: vi.fn(),
    terminalTicket: vi.fn(),
    terminalClose: vi.fn(),
    agentTicket: vi.fn(),
    sessionRegistry: vi.fn(),
    pane: vi.fn(),
  }),
);

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      terminal,
      terminalTicket,
      terminalClose,
      agentTicket,
      // Since Phase 8 the page resolves an address against the presence
      // registry before it will say a session is gone — an id that is not a
      // pty may still be a conversation it can offer to resume.
      sessionRegistry,
      plans: vi.fn(async () => []),
      approvals: vi.fn(async () => []),
    },
  };
});

// The pane owns xterm and a live WebSocket. Both are the wrong thing to build
// in jsdom, and neither is what this file is about.
//
// ONLY the emulator is stubbed, and after Phase 10 that is all this mock has to
// say: `pane.tsx` re-exports nothing, so the ended/gone panels, the vitals, the
// controls and the strip reach the page from their own modules and are under
// test for real. `default` is what `lazy()` resolves — the page reaches the
// pane through a dynamic import so the emulator stays out of the precached
// `sessions-*` chunk, and a mock without it renders an empty Suspense forever.
vi.mock('./pane', () => {
  const Stub = (props: { sessionId: string }) => {
    pane(props.sessionId);
    return <div data-testid="pane">{props.sessionId}</div>;
  };
  return { TerminalPane: Stub, default: Stub };
});

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: false,
  allowWrites: false,
  allowTerminal: true,
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  recentRoots: [],
  unread: 0,
};

const SESSION = {
  id: 'abc123',
  label: 'Terminal 1',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 100,
  rows: 30,
  pid: 900,
  clients: 1,
  createdAt: 0,
};

const TERMINALS: TerminalState = { allowed: true, available: 'yes', limit: 8, sessions: [SESSION] };

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/**
 * `#/sessions?new=shell` — where a bare `#/terminal` now lands.
 *
 * Bare `#/sessions` is the LIST, not a pane, so the shell-shaped tests name the
 * launch intent the old address carried. `?new=shell` deliberately does NOT
 * mint on arrival: a pty opened as a page-load side effect is spawned twice
 * under StrictMode, which is the rule the very first test here holds.
 */
const NEW_SHELL = { segments: ['sessions'], query: { new: 'shell' }, path: 'sessions' };

async function openPage(route: Route = NEW_SHELL) {
  const { default: SessionsView } = await import('./index');
  return mount(<SessionsView route={route} />);
}

/**
 * The same page, but reading the route from the hash the way `App` does.
 *
 * `openPage` hands the view a frozen `route` prop, which is fine for the states
 * that do not navigate — but useless for asserting what the page does *after*
 * it changes the URL, because the prop never follows.
 */
async function openLive(hash: string) {
  window.location.hash = hash;
  const { default: SessionsView } = await import('./index');
  const { useRoute } = await import('@/app/router');
  const Harness = () => <SessionsView route={useRoute()} />;
  return mount(<Harness />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  state.mockResolvedValue(BASE_STATE);
  terminal.mockResolvedValue(TERMINALS);
  terminalTicket.mockResolvedValue({
    ok: true,
    sessionId: 'new1',
    token: 't',
    expiresAt: 0,
    path: '/ws/terminal',
    session: { ...SESSION, id: 'new1', label: 'Terminal 2' },
  });
  terminalClose.mockResolvedValue({ closed: true, state: { ...TERMINALS, sessions: [] } });
  sessionRegistry.mockResolvedValue({ sessions: [] });
  agentTicket.mockResolvedValue({
    ok: true,
    sessionId: 'resumed1',
    token: 't',
    expiresAt: 0,
    path: '/ws/terminal',
    session: { ...SESSION, id: 'resumed1', kind: 'claude', label: 'Resumed: demo · P3' },
  });
});

/* ------------------------------------------------------------------ *
 * The two ways there is no terminal
 * ------------------------------------------------------------------ */

describe('when there is no terminal', () => {
  it('says the flags are off, and names them', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowTerminal: false });
    await openPage();

    expect(await screen.findByText(/starts no sessions of its own/i)).toBeInTheDocument();
    expect(screen.getByText('--allow-terminal')).toBeInTheDocument();
    // Nothing is asked of a server that has said no.
    expect(terminal).not.toHaveBeenCalled();
    expect(terminalTicket).not.toHaveBeenCalled();
  });

  it('distinguishes "node-pty did not load" from "the flag is off"', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, available: 'no', sessions: [] });
    await openPage();

    // "terminal", not "shell": node-pty is the layer BOTH kinds need, and on
    // one page a message that named only shells would leave someone whose
    // agent session failed reading about a feature they were not using.
    expect(await screen.findByText(/no terminal available/i)).toBeInTheDocument();
    expect(screen.getByText('node-pty')).toBeInTheDocument();
    // The distinction is the point: the same words for both would send someone
    // to restart with a flag they already have.
    expect(screen.queryByText(/starts no sessions of its own/i)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

describe('sessions', () => {
  it('does not open a shell just because the page was visited', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [] });
    await openPage();

    expect(await screen.findByText(/no shell open/i)).toBeInTheDocument();
    // Under StrictMode a mount that spawned a pty would spawn two — and this
    // route asked for a shell by name (`?new=shell`), which is the strongest
    // form of the temptation.
    expect(terminalTicket).not.toHaveBeenCalled();
  });

  it('bare #/sessions is the LIST, and it opens nothing either', async () => {
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [] });
    await openPage({ segments: ['sessions'], query: {}, path: 'sessions' });

    expect(await screen.findByText(/nothing is running/i)).toBeInTheDocument();
    expect(terminalTicket).not.toHaveBeenCalled();
  });

  it('opens one when asked, and stays on it', async () => {
    // A stateful stand-in for the server: creating a session has to show up in
    // the next listing, or this test cannot see the bug it exists for.
    const opened = { ...SESSION, id: 'new1', label: 'Terminal 2' };
    let live: (typeof SESSION)[] = [];
    terminal.mockImplementation(async () => ({ ...TERMINALS, sessions: live }));
    terminalTicket.mockImplementation(async () => {
      live = [...live, opened];
      return { ok: true, sessionId: 'new1', token: 't', expiresAt: 0, path: '/ws/terminal', session: opened };
    });

    await openLive('#/sessions?new=shell');
    fireEvent.click(await screen.findByRole('button', { name: /open a shell/i }));

    // The URL is what makes a reload — or a phone killing the tab — come back
    // to the same shell rather than a new one.
    await waitFor(() => expect(window.location.hash).toBe('#/sessions/new1'));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('new1'));

    // ⚠️ The regression this guards: the click invalidates the very list the
    // fallback reads, so a fallback that ran mid-refetch decided the new
    // session did not exist and navigated straight back off it. The symptom
    // was a tab that appeared and a terminal that never did.
    await waitFor(() => expect(terminal).toHaveBeenCalledTimes(2));
    expect(window.location.hash).toBe('#/sessions/new1');
    expect(screen.getByTestId('pane')).toHaveTextContent('new1');
  });

  it('attaches to the session the route names', async () => {
    await openPage({ segments: ['sessions', 'abc123'], query: {}, path: 'sessions/abc123' });
    expect(await screen.findByTestId('pane')).toHaveTextContent('abc123');
    expect(pane).toHaveBeenCalledWith('abc123');
  });

  it('says a session is gone instead of bouncing off its own URL', async () => {
    await openPage({ segments: ['sessions', 'long-gone'], query: {}, path: 'sessions/long-gone' });
    // This used to navigate away silently, which was defensible while sessions
    // timed out on their own. They do not any more: a URL naming nothing means
    // the record was dismissed or retired, and on a phone a redirect reads as a
    // tap that did nothing.
    expect(await screen.findByText(/not here any more/i)).toBeInTheDocument();
    // The harness renders a route object without touching the URL, so a stray
    // `navigate()` would show up here as a hash. Staying empty is the assertion.
    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('keeps an ended shell open, with its scrollback and a way to clear it', async () => {
    const ended = { ...SESSION, exited: { code: 130 }, exitedAt: Date.now() - 5_000 };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [ended], live: 0 });
    await openPage({ segments: ['sessions', 'abc123'], query: {}, path: 'sessions/abc123' });

    // The record outlives the process, so the page reports the exit rather than
    // sending you somewhere else.
    expect(await screen.findByText(/exited with code 130/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
    // …and its slot is free, so New is still offered.
    expect(screen.getByRole('button', { name: /new/i })).not.toBeDisabled();
  });

  it('refuses to go past the session cap', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...SESSION, id: `s${i}`, label: `Terminal ${i}` }));
    terminal.mockResolvedValue({ ...TERMINALS, sessions: many });
    await openPage({ segments: ['sessions', 's0'], query: {}, path: 'sessions/s0' });

    const button = await screen.findByRole('button', { name: /new/i });
    expect(button).toBeDisabled();
  });

  it('shows both kinds in ONE strip — there is no other page for them now', async () => {
    const claude = {
      ...SESSION,
      id: 'c1',
      label: 'Claude: hello',
      kind: 'claude' as const,
      shell: 'claude',
    };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [SESSION, claude] });
    await openPage({ segments: ['sessions', 'abc123'], query: {}, path: 'sessions/abc123' });

    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    expect(screen.getByText('Claude: hello')).toBeInTheDocument();
  });

  it('counts the cap across BOTH kinds, which is now what the strip shows', async () => {
    // Seven claude sessions and one shell. The cap was always the unfiltered
    // total; before Phase 10 a page could disable New because of seven tabs
    // the reader could not see.
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...SESSION,
      id: `c${i}`,
      label: `Claude ${i}`,
      kind: 'claude' as const,
    }));
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [SESSION, ...many] });
    await openPage({ segments: ['sessions', 'abc123'], query: {}, path: 'sessions/abc123' });

    expect(await screen.findByRole('button', { name: /new/i })).toBeDisabled();
  });

  it('closes a session and moves off it', async () => {
    await openPage({ segments: ['sessions', 'abc123'], query: {}, path: 'sessions/abc123' });
    fireEvent.click(await screen.findByRole('button', { name: /close terminal 1/i }));
    await waitFor(() => expect(terminalClose).toHaveBeenCalledWith('abc123'));
    await waitFor(() => expect(window.location.hash).toBe('#/sessions'));
  });
});

/* ------------------------------------------------------------------ *
 * The strip and the composer
 * ------------------------------------------------------------------ */

describe('the strip', () => {
  it('is a tab list — Radix owns the roving focus, ui/tabs the scroll-into-view', async () => {
    const second = { ...SESSION, id: 'def456', label: 'Terminal 2' };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [SESSION, second] });
    await openPage({ segments: ['sessions', 'abc123'], query: {}, path: 'sessions/abc123' });

    const list = await screen.findByRole('tablist');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(tabs[0]).toHaveAttribute('data-state', 'active');
    // Every tab is thumb-sized, and the strip is the ui/tabs strip (hidden
    // scrollbar, fade) — not a hand-rolled overflow row.
    for (const tab of tabs) expect(tab.className).toMatch(/min-h-\(--tap-min\)/);
    expect(list.className).toMatch(/scrollbar-width:none/);
  });

  it('switching tabs navigates to the session', async () => {
    const second = { ...SESSION, id: 'def456', label: 'Terminal 2' };
    terminal.mockResolvedValue({ ...TERMINALS, sessions: [SESSION, second] });
    await openLive('#/sessions/abc123');
    await screen.findByRole('tablist');
    // Radix activates on mousedown (automatic activation), then click follows.
    const tab = screen.getByRole('tab', { name: 'Terminal 2' });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(window.location.hash).toBe('#/sessions/def456'));
  });
});

describe('the composer', () => {
  it('sends the line WITH its Enter — text + \\r — and clears for the next one', () => {
    const sent: string[] = [];
    render(<Composer onSend={(data) => sent.push(data)} />);
    const input = screen.getByRole('textbox', { name: /message/i });
    // A command line, not prose: nothing may rewrite it on the way in.
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('enterkeyhint', 'send');

    const send = screen.getByRole('button', { name: /send/i });
    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: 'run the tests' } });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(sent).toEqual(['run the tests\r']);
    expect(input).toHaveValue('');
  });

  it('Enter in the field submits, and a blank line sends nothing', () => {
    const sent: string[] = [];
    render(<Composer onSend={(data) => sent.push(data)} />);
    const input = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(sent).toEqual([]);
    fireEvent.change(input, { target: { value: 'y' } });
    fireEvent.submit(input.closest('form')!);
    expect(sent).toEqual(['y\r']);
  });
});

/* ------------------------------------------------------------------ *
 * A session this console does NOT own (Phase 8)
 * ------------------------------------------------------------------ */

/**
 * The presence hook reports every `claude` on this machine. Until Phase 8 the
 * Sessions list could only say one EXISTS: the row built no id, so
 * `#/sessions/<conversation>` resolved to nothing and the page said "gone".
 *
 * What it can honestly do is resume the CONVERSATION — a new process on the
 * same transcript, in a pty this console owns. Nothing attaches to a terminal
 * someone else is typing in; there is no multiplexer in this tree. So the two
 * verbs differ by presence, and the difference is the point: over an `ended`
 * session Resume is plain and safe, and over a LIVE one the same click starts a
 * second process on one conversation and has to say so first.
 */
const FOREIGN: ForeignSession = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  kind: 'foreign',
  cwd: '/repo/sub',
  owner: 'sam',
  startedAt: new Date(0).toISOString(),
  lastSeen: new Date(0).toISOString(),
  turns: 4,
  presence: 'ended',
};

const AT_FOREIGN: Route = {
  segments: ['sessions', FOREIGN.sessionId],
  query: {},
  path: `sessions/${FOREIGN.sessionId}`,
};

function withForeign(over: Partial<ForeignSession> = {}) {
  sessionRegistry.mockResolvedValue({ sessions: [{ ...FOREIGN, ...over }] });
}

describe('a session this console does not own', () => {
  it('decides the verb from presence, and the flag decides whether there is one', async () => {
    // The rule itself, without a DOM — the renders below prove it reaches the
    // page, this proves what it says.
    const { foreignAction } = await import('./foreign');
    expect(foreignAction({ presence: 'ended' }, true)).toMatchObject({ kind: 'resume', confirm: false });
    expect(foreignAction({ presence: 'live' }, true)).toMatchObject({ kind: 'takeover', confirm: true });
    // Nobody can vouch for `unknown`, so it is read as live — the same
    // conservative reading the registry uses everywhere else.
    expect(foreignAction({ presence: 'unknown' }, true)).toMatchObject({ kind: 'takeover', confirm: true });
    for (const presence of ['ended', 'live', 'unknown'] as const) {
      expect(foreignAction({ presence }, false)).toMatchObject({ kind: 'refused' });
    }
  });

  it('has a page — the address the list now links to resolves', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    withForeign({ plan: { slug: 'demo', phase: 3, strong: true } });
    await openPage(AT_FOREIGN);

    expect(await screen.findByRole('heading', { name: /demo · P3/ })).toBeInTheDocument();
    // The facts that decide whether resuming is the right idea, said on the
    // page — the directory twice over, because where a resume RUNS is the one
    // fact a person cannot recover after the fact.
    expect(screen.getAllByText('/repo/sub').length).toBeGreaterThan(0);
    expect(screen.getByText(FOREIGN.sessionId)).toBeInTheDocument();
    // And NOT the panel that used to answer this address.
    expect(screen.queryByText(/not here any more/i)).not.toBeInTheDocument();
  });

  it('resumes an ended one plainly, and lands on the terminal it started', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    withForeign();
    await openLive(`#/sessions/${FOREIGN.sessionId}`);

    fireEvent.click(await screen.findByRole('button', { name: /^resume$/i }));
    await waitFor(() =>
      expect(agentTicket).toHaveBeenCalledWith(expect.objectContaining({ resume: FOREIGN.sessionId })),
    );
    // The browser sends an id and nothing else about the session — no cwd, no
    // argv. The server reads the registry for the rest.
    expect(Object.keys(agentTicket.mock.calls[0][0]).sort()).toEqual(['cols', 'resume', 'rows']);
    await waitFor(() => expect(window.location.hash).toBe('#/sessions/resumed1'));
  });

  it('asks before starting anything in a directory the console does not know', async () => {
    // 🔴 The escalation this phase introduced, and the guard for it. A session
    // record is written by `POST /hooks/session`, which is deliberately exempt
    // from the console-header and Origin checks — so the cwd it names is not a
    // fact this console can vouch for, and since Phase 8 that cwd is where a
    // resume SPAWNS. A directory chooses a project's settings and hooks.
    //
    // Nothing is refused: an ENDED session (which would otherwise resume with
    // one plain click) takes the confirm, and the path is put in front of the
    // person clicking.
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    withForeign({ cwd: '/somewhere/else' });
    await openPage(AT_FOREIGN);

    fireEvent.click(await screen.findByRole('button', { name: /^resume$/i }));
    expect(agentTicket).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('/somewhere/else');
    expect(dialog).toHaveTextContent(/not the open root/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /start it there/i }));
    await waitFor(() => expect(agentTicket).toHaveBeenCalled());
  });

  it('does not ask twice for a directory it recognises — a recent root counts', async () => {
    state.mockResolvedValue({
      ...BASE_STATE,
      allowAgent: true,
      recentRoots: [{ path: '/elsewhere/repo', label: 'elsewhere' }],
    });
    withForeign({ cwd: '/elsewhere/repo/packages/ui' });
    await openPage(AT_FOREIGN);

    fireEvent.click(await screen.findByRole('button', { name: /^resume$/i }));
    await waitFor(() => expect(agentTicket).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('is not fooled by a path that only LOOKS like it is under the root', async () => {
    // 🔴 The first version of this guard was defeated by its own commit
    // message's example: `/repo/../../tmp/evil` starts with `/repo/` and read as
    // familiar, while the server's `firstDir` resolves it through `statSync` and
    // spawns in `/tmp/evil`. A record written by a shell hook carries `$PWD` and
    // never has a `..` segment, so anything denormalized is unfamiliar on that
    // fact alone.
    const { unfamiliarDirectory } = await import('./foreign');
    expect(unfamiliarDirectory('/repo/sub', ['/repo'])).toBe(false);
    expect(unfamiliarDirectory('/repo', ['/repo'])).toBe(false);
    expect(unfamiliarDirectory('/repo-evil', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/repo/../../tmp/evil', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/repo/..', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/repo/./sub', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/repo/sub/', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('relative/path', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/anywhere', [])).toBe(true);
  });

  it('takes the confirm for a traversal that resolves outside the root', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    withForeign({ cwd: '/repo/../../tmp/evil' });
    await openPage(AT_FOREIGN);

    fireEvent.click(await screen.findByRole('button', { name: /^resume$/i }));
    expect(agentTicket).not.toHaveBeenCalled();
    // The page shows the string the RECORD holds, not a tidied one — a
    // normalized path the record does not contain would hide the trick.
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('/repo/../../tmp/evil');
  });

  it('does not mistake a SIBLING that merely shares the root’s first characters', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    withForeign({ cwd: '/repo-evil' });
    await openPage(AT_FOREIGN);

    fireEvent.click(await screen.findByRole('button', { name: /^resume$/i }));
    expect(agentTicket).not.toHaveBeenCalled();
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('/repo-evil');
  });

  it('makes taking over a LIVE one an explicit answer, and says what it costs', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    withForeign({ presence: 'live' });
    await openPage(AT_FOREIGN);

    const button = await screen.findByRole('button', { name: /take over/i });
    // 🔴 The click alone must start nothing — the confirm IS the guard.
    fireEvent.click(button);
    expect(agentTicket).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/SECOND claude on the same conversation/i);
    expect(dialog).toHaveTextContent(/keeps running: this does not stop it/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /start a second session/i }));
    await waitFor(() =>
      expect(agentTicket).toHaveBeenCalledWith(expect.objectContaining({ resume: FOREIGN.sessionId })),
    );
  });

  it('treats `unknown` as live — the conservative reading, and it asks', async () => {
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    withForeign({ presence: 'unknown' });
    await openPage(AT_FOREIGN);

    expect(await screen.findByRole('button', { name: /take over/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument();
  });

  it('refuses without --allow-agent, by naming the flag, and starts nothing', async () => {
    // `--allow-terminal` alone: this console opens shells but mints no claude
    // session, so the page is READABLE (the registry needs no flag) and the
    // action is not offered at all.
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: false });
    withForeign();
    await openPage(AT_FOREIGN);

    expect(await screen.findByText(/restart with --allow-agent/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume|take over/i })).not.toBeInTheDocument();
    expect(agentTicket).not.toHaveBeenCalled();
  });

  it('is readable on a console with NO session flags at all', async () => {
    // Reading who else is in your repository is display — the same rule
    // `GET /api/sessions/registry` follows. A page about somebody else's
    // session must not answer "this console starts no sessions of its own".
    state.mockResolvedValue({ ...BASE_STATE, allowTerminal: false, allowAgent: false });
    withForeign();
    await openPage(AT_FOREIGN);

    expect(await screen.findByText(/restart with --allow-agent/i)).toBeInTheDocument();
    expect(screen.queryByText(/starts no sessions of its own/i)).not.toBeInTheDocument();
  });

  it('does not flash "gone" while the registry is still answering', async () => {
    // 🔴 The guard QA broke and nothing caught: `settled` includes the registry
    // read, because whether an id is a CONVERSATION is only knowable from it.
    // Without that term the page renders "gone" over a foreign session for as
    // long as the read takes — and then replaces it, which is the worst of both
    // (a wrong answer, briefly, on the page whose whole job is to be honest).
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    let answer: (value: { sessions: ForeignSession[] }) => void = () => {};
    sessionRegistry.mockReturnValue(
      new Promise<{ sessions: ForeignSession[] }>((resolve) => {
        answer = resolve;
      }),
    );
    await openPage(AT_FOREIGN);

    // The terminals read settles (it is mocked resolved) while the registry
    // does not, so every OTHER term of `settled` is true here. The wait is real
    // and deliberate: "gone" appearing one frame late and being replaced is the
    // failure this pins, so the assertion has to outlive the render that would
    // show it.
    await waitFor(() => expect(terminal).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.queryByText(/not here any more/i)).not.toBeInTheDocument();

    answer({ sessions: [FOREIGN] });
    expect(await screen.findByRole('heading', { name: /sam/ })).toBeInTheDocument();
    expect(screen.queryByText(/not here any more/i)).not.toBeInTheDocument();
  });

  it('once resumed, the SAME address opens the terminal instead of offering again', async () => {
    // The address of a conversation stays the address of the conversation. The
    // pty that resumed it carries `meta.claudeSessionId`, and the broker hands
    // that meta back to the console that adopts the session after a restart —
    // so this is also what makes the link survive one.
    state.mockResolvedValue({ ...BASE_STATE, allowAgent: true });
    withForeign();
    terminal.mockResolvedValue({
      ...TERMINALS,
      sessions: [{ ...SESSION, id: 'pty-9', kind: 'claude', meta: { claudeSessionId: FOREIGN.sessionId } }],
    });
    await openPage(AT_FOREIGN);

    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('pty-9'));
    expect(screen.queryByRole('button', { name: /resume|take over/i })).not.toBeInTheDocument();
  });
});
