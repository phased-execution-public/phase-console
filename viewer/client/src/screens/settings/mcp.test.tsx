/**
 * Settings ▸ MCP servers (quiet-console phase 23): what this console's
 * sessions may connect to, and the catalog to add from.
 *
 * The registry is one line per server — its status, its name and id, its
 * transport and tools, when it was last checked, and its one act, switching it
 * on or off — that opens in place to the rest: the command, an unfilled
 * variable, a changed tool list and "I have checked it", the tools no
 * unattended run can approve, the secrets it needs (typed into a dialog and
 * never shown), its name, the sign-in and whose config dir it lands in, the
 * commands to run by hand when no sign-in could start, and Remove, asked once
 * with what it costs. Above the list, a server that cannot be reached is said
 * in the words of the policy in force, a drifted one in its own words, and
 * seven switched on as the cost they are. Without `--allow-mcp` the section
 * reads the same, offers no press, and says what the flag would add.
 *
 * The catalog is its own address under the section nav (`?tab=catalog`), and
 * the policy row saves through the console's preferences. The wire is what is
 * asserted: what each press sent, and to which route.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView, McpCatalogEntry, McpLoginFlow, McpLoginStart, McpServerView } from '@/data/api';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a press came to is a toast, and the tray is the shell's: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { McpServersSection } from './mcp';
import { addCommand } from './mcp-catalog';

/* ---------------- the clock, the servers, the accounts, the catalog ---------------- */

/** The clock every case reads — "checked 4 minutes ago" is a fact about it. */
const NOW = '2026-10-12T12:00:00.000Z';
const ago = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

/** A connected http server with nothing to sign in, checked four minutes ago. */
const DOCS: McpServerView = {
  id: 'docs',
  label: 'Docs',
  transport: 'http',
  url: 'https://docs.example.com/mcp',
  enabled: true,
  auth: { kind: 'none', secrets: [] },
  status: 'connected',
  checkedAt: ago(4),
  toolCount: 2,
};

/** An sse server that signs in with OAuth and has not: it cannot be reached, and was never checked. */
const TRACKER: McpServerView = {
  id: 'tracker',
  label: 'Tracker',
  transport: 'sse',
  url: 'https://tracker.example.com/sse',
  enabled: true,
  auth: { kind: 'oauth', secrets: [] },
  status: 'needs-auth',
};

/** A stdio server that needs two values from the environment: one still unset, one held. */
const FILES: McpServerView = {
  id: 'files',
  label: 'Files',
  transport: 'stdio',
  command: 'npx -y files-mcp /home/x/notes',
  enabled: true,
  auth: {
    kind: 'env',
    secrets: [
      { ref: 'env:FILES_TOKEN', held: false },
      { ref: 'env:FILES_SIGNING_KEY', held: true },
    ],
  },
  status: 'unknown',
};

/** The machine's login, two profiles (one with no name) and a pasted token — only profiles may be signed in for. */
const ACCOUNTS: AccountView[] = [
  { id: 'default', kind: 'default', builtIn: true, name: 'This machine' },
  { id: 'acct-work', kind: 'profile', builtIn: false, name: 'Work', email: 'work@example.com' },
  { id: 'acct-spare', kind: 'profile', builtIn: false, email: 'spare@example.com' },
  { id: 'acct-ci', kind: 'token', builtIn: false, name: 'CI token' },
];

/** What the catalog offers, in two categories: one already registered, one by token, one by env, one by OAuth. */
const CATALOG: McpCatalogEntry[] = [
  {
    id: 'docs',
    label: 'Docs',
    description: 'Search the team’s documentation.',
    transport: 'http',
    url: 'https://docs.example.com/mcp',
    auth: 'none',
    category: 'Knowledge',
    source: 'curated',
    homepage: 'https://docs.example.com/',
  },
  {
    id: 'board',
    label: 'Board',
    description: 'Tickets and boards for the team.',
    transport: 'http',
    url: 'https://board.example.com/mcp',
    auth: 'header',
    secretRefs: [{ kind: 'header', name: 'Authorization' }],
    authNote: 'Make a token under the board’s own settings.',
    category: 'Work',
    source: 'curated',
  },
  {
    id: 'notes',
    label: 'Notes',
    description: 'Read and write notes on disk.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'notes-mcp', '/home/x/notes'],
    auth: 'env',
    secretRefs: [{ kind: 'env', name: 'NOTES_TOKEN' }],
    category: 'Work',
    source: 'registry',
    registryName: 'example/notes',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    description: 'Events and free time.',
    transport: 'sse',
    url: 'https://calendar.example.com/sse',
    auth: 'oauth',
    category: 'Work',
    source: 'curated',
  },
];

const copyOf = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A console holding `servers`, whose writes change them as the server would —
 * a patch switches, renames or stores, a delete removes, an acknowledgement
 * clears the drift, an add registers — so a page read again shows what the
 * press did.
 */
function serve(
  servers: McpServerView[],
  { allowMcp = true, contextTokens }: { allowMcp?: boolean; contextTokens?: number } = {},
) {
  const held = copyOf(servers);
  server.reads['/api/mcp'] = () => ({
    servers: copyOf(held),
    allowMcp,
    ...(contextTokens ? { contextTokens } : {}),
  });
  server.reads['POST /api/mcp'] = (body: unknown) => {
    const { id, label, transport } = body as Pick<McpServerView, 'id' | 'label' | 'transport'>;
    const added: McpServerView = {
      id,
      label,
      transport,
      enabled: true,
      auth: { kind: 'none', secrets: [] },
      status: 'unknown',
    };
    held.push(added);
    return { server: added };
  };
  for (const one of held) {
    server.reads[`PATCH /api/mcp/${one.id}`] = (body: unknown) => {
      const patch = body as { enabled?: boolean; label?: string; secretRef?: { kind: string; name: string } };
      if (patch.enabled !== undefined) one.enabled = patch.enabled;
      if (patch.label !== undefined) one.label = patch.label;
      if (patch.secretRef) {
        const ref = `${patch.secretRef.kind}:${patch.secretRef.name}`;
        one.auth.secrets = one.auth.secrets.map((secret) =>
          secret.ref === ref ? { ...secret, held: true } : secret,
        );
      }
      return { server: copyOf(one) };
    };
    server.reads[`DELETE /api/mcp/${one.id}`] = () => {
      held.splice(held.indexOf(one), 1);
      return { removed: true };
    };
    server.reads[`POST /api/mcp/${one.id}/acknowledge`] = () => {
      delete one.toolsChanged;
      return { acknowledged: true };
    };
  }
}

/* ---------------- reading the page ---------------- */

function mount(address = '#/settings/mcp') {
  window.location.hash = address;
  return renderWithClient(<McpServersSection />);
}

/** The element a selector names, once it is drawn. */
const drawn = (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(selector);
    expect(found).not.toBeNull();
    return found!;
  });
const rowOf = (id: string) => drawn(`[data-mcp-server="${id}"]`);
const entryOf = (id: string) => drawn(`[data-catalog-entry="${id}"]`);

/** The status word a row draws, through the typed family. */
const markOf = (row: HTMLElement) => row.querySelector('[data-vocab="mcp"]');

/** What an opened server needs, one line per value: its ref, whether it is held, and the press offered. */
const needsOf = (details: HTMLElement, label: string): string[][] =>
  within(within(details).getByRole('list', { name: `What ${label} needs` }))
    .getAllByRole('listitem')
    .map((line) => [...line.children].map((part) => part.textContent ?? ''));

/** Open a server's row in place; what opened is returned. */
async function open(id: string): Promise<HTMLElement> {
  const row = await rowOf(id);
  fireEvent.click(within(row).getByRole('button', { name: /^Show details of / }));
  return row.querySelector<HTMLElement>(`[data-mcp-details="${id}"]`)!;
}

/** Press a button once it can be pressed — a press in flight disables its neighbours. */
async function press(button: HTMLElement) {
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

/** Every request that was not a read. */
const writes = () => server.calls.filter((call) => call.method !== 'GET');

/** The paths the catalog was asked with, its search included. */
const catalogAsks = () =>
  server.calls.filter((call) => call.path.startsWith('/api/mcp/catalog')).map((call) => call.path);

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  server.calls = [];
  server.reads = {
    '/api/mcp/catalog': { entries: CATALOG },
    // The shipped answer to "a server cannot be reached" is `continue`; a case that cares sets it.
    '/api/prefs/schema': schemaAnswer({ mcpPolicy: { default: 'continue' } }),
    '/api/accounts': { allowAccounts: true, accounts: ACCOUNTS },
    'POST /api/mcp/refresh': { servers: [] },
  };
  serve([DOCS]);
  toast.mockClear();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

/* ---------------- the registry ---------------- */

describe('the registry, read', () => {
  it('draws each server as one line — its status, name and id, transport, tools and when it was checked', async () => {
    serve([DOCS, { ...TRACKER, enabled: false }]);
    mount();

    const docs = await rowOf('docs');
    expect(markOf(docs)).toHaveTextContent('Connected');
    expect(within(docs).getByText('Docs')).toBeInTheDocument();
    expect(within(docs).getByText('docs')).toBeInTheDocument();
    expect(docs).toHaveTextContent('http · 2 tools');
    expect(docs).toHaveTextContent('checked 4 minutes ago');
    expect(within(docs).getByRole('button', { name: 'Switch off' })).toBeEnabled();

    const tracker = await rowOf('tracker');
    expect(markOf(tracker)).toHaveTextContent('Needs sign-in');
    expect(tracker).toHaveTextContent('Switched off · sse');
    expect(tracker).toHaveTextContent('never checked');
    expect(within(tracker).getByRole('button', { name: 'Switch on' })).toBeEnabled();

    expect(
      screen.getByText(
        '1 of 2 switched on. Every server costs context on every turn — three to six is the range people settle at.',
      ),
    ).toBeInTheDocument();
    // A server switched off is attached to nothing, so its sign-in is no alarm.
    expect(screen.queryByText(/cannot be reached — /)).toBeNull();
    const views = screen.getByRole('navigation', { name: 'MCP server views' });
    expect(within(views).getByRole('link', { name: 'Registered (2)' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(views).getByRole('link', { name: 'Catalog' })).toHaveAttribute(
      'href',
      '#/settings/mcp?tab=catalog',
    );
    expect(writes()).toEqual([]);
  });

  it('draws what each attached server costs every turn, and the catalog’s pin and untrusted output on Context7’s line (measured-console phase 27)', async () => {
    const context7: McpServerView = {
      ...DOCS,
      id: 'context7',
      label: 'Context7',
      transport: 'stdio',
      command: 'npx -y @upstash/context7-mcp@>=2.1.3',
      pin: { min: '2.1.3', held: true },
      untrustedOutput: true,
    };
    const drifted: McpServerView = {
      ...context7,
      id: 'c7-old',
      label: 'Old C7',
      pin: { min: '2.1.3', held: false },
    };
    serve([DOCS, context7, drifted, { ...TRACKER, enabled: false }], { contextTokens: 1500 });
    mount();

    expect(await rowOf('docs')).toHaveTextContent('http · 2 tools · ~1,500 tokens a turn');
    expect(await rowOf('context7')).toHaveTextContent(
      'stdio · 2 tools · ~1,500 tokens a turn · pinned ≥ 2.1.3 · untrusted output',
    );
    expect(await rowOf('c7-old')).toHaveTextContent('not pinned — the catalog runs ≥ 2.1.3');
    // Switched off is attached to nothing, and costs nothing.
    const tracker = await rowOf('tracker');
    expect(tracker).toHaveTextContent('Switched off · sse');
    expect(tracker).not.toHaveTextContent('tokens a turn');
  });

  it('names the flag when registration is off, and offers no press — in the registry or the catalog', async () => {
    serve([DOCS, TRACKER, FILES], { allowMcp: false });
    mount();

    // The section still renders — a capability that hides when it is off looks like a bug.
    await rowOf('docs');
    expect(
      screen.getByText(
        'Start the console with --allow-mcp to register, rename or sign in a server. Reading the registry, the statuses and the catalog works without it.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Switch (on|off)$/ })).toBeNull();
    // Checking changes nothing, so it needs no flag.
    expect(screen.getByRole('button', { name: 'Re-check all' })).toBeEnabled();

    const tracker = await open('tracker');
    expect(tracker).toHaveTextContent(
      'Start the console with --allow-mcp to register, rename or sign in a server.',
    );
    expect(within(tracker).queryAllByRole('button')).toEqual([]);
    expect(within(tracker).queryByLabelText('Sign in for')).toBeNull();
    const files = await open('files');
    // What it needs is read all the same — with no Set and no Replace beside it.
    expect(needsOf(files, 'Files')).toEqual([
      ['env:FILES_TOKEN', 'Not set'],
      ['env:FILES_SIGNING_KEY', 'Held in the keychain'],
    ]);
    expect(within(files).queryAllByRole('button')).toEqual([]);

    fireEvent.click(screen.getByRole('link', { name: 'Catalog' }));
    const board = await entryOf('board');
    expect(board).toHaveTextContent('Adding needs --allow-mcp');
    expect(within(await entryOf('docs')).getByText('Registered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    // The line that does it outside the console is offered either way.
    fireEvent.click(within(board).getByRole('button', { name: 'Copy the command' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'claude mcp add --transport http --header "Authorization: <value>" board https://board.example.com/mcp',
      ),
    );
    fireEvent.click(within(await entryOf('notes')).getByRole('button', { name: 'Copy the command' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        'claude mcp add -e NOTES_TOKEN=<value> notes -- npx -y notes-mcp /home/x/notes',
      ),
    );
    expect(writes()).toEqual([]);
  });

  it('warns at the top when a server cannot be reached, in the words of the shipped policy', async () => {
    // The shipped policy is `continue`: the phase boards WITHOUT the server and
    // records an errand. Parking needs an explicit `require`.
    serve([DOCS, TRACKER]);
    mount();

    expect(
      await screen.findByText(
        'Tracker cannot be reached — a phase naming it will run without it and record an errand.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/will park at boarding/)).toBeNull();
    const mark = markOf(await rowOf('tracker'));
    expect(mark).toHaveTextContent('Needs sign-in');
    expect(mark).toHaveAttribute('data-attention', 'needs-you');
  });

  it('says "park at boarding" only when the policy in force is require, and counts only the servers switched on', async () => {
    server.reads['/api/prefs/schema'] = schemaAnswer({
      mcpPolicy: { value: 'require', default: 'continue', source: 'instance' },
    });
    serve([
      TRACKER,
      { ...DOCS, id: 'broken', label: 'Broken', status: 'failed' },
      { ...DOCS, id: 'parked', label: 'Parked', status: 'failed', enabled: false },
    ]);
    mount();

    // The banner names them (#372), and offers the sign-in of each that signs in.
    expect(
      await screen.findByText(
        'Tracker, Broken cannot be reached — a phase naming one will park at boarding.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/will run without it and record an errand/)).toBeNull();
    const banner = await drawn('[data-testid="mcp-unreachable"]');
    expect(
      within(banner)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Sign in to Tracker']);
    expect(markOf(await rowOf('broken'))).toHaveTextContent('Failed');
  });

  it('treats a server still connecting as normal, not as an alarm', async () => {
    // A remote server with a cached tool list connects on first use; flagging it would train people to ignore the flag.
    serve([{ ...DOCS, status: 'pending', checkedAt: ago(1) }]);
    mount();

    const mark = markOf(await rowOf('docs'));
    expect(mark).toHaveTextContent('Connecting');
    expect(mark).toHaveAttribute('data-attention', 'none');
    expect(document.querySelector('[data-severity]')).toBeNull();
  });

  it('says plainly that seven servers switched on are seven paid for on every turn', async () => {
    serve([
      ...Array.from({ length: 7 }, (_, i) => ({ ...DOCS, id: `s${i}`, label: `Server ${i}` })),
      { ...DOCS, id: 'off', label: 'Off', enabled: false },
    ]);
    mount();

    expect(
      await screen.findByText(
        '7 servers are switched on. Each adds tool names that can collide with another server’s; the run page shows which ones a phase actually called.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '7 of 8 switched on. Every server costs context on every turn — three to six is the range people settle at.',
      ),
    ).toBeInTheDocument();
  });

  it('explains an empty registry and points at the catalog, rather than drawing a blank page', async () => {
    serve([]);
    mount();

    expect(
      await screen.findByText(
        'No server is registered: sessions here run with this machine’s own MCP configuration.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the catalog' })).toHaveAttribute(
      'href',
      '#/settings/mcp?tab=catalog',
    );
    expect(screen.getByRole('link', { name: 'Registered (0)' })).toHaveAttribute('aria-current', 'page');
    // Nothing to re-check.
    expect(screen.queryByRole('button', { name: 'Re-check all' })).toBeNull();
  });
});

describe('a server, opened in place', () => {
  it('shows its command, what went wrong, a variable nothing supplies and when it was last used', async () => {
    serve([
      {
        ...FILES,
        command: 'npx -y files-mcp $MCP_FS_ROOT',
        status: 'failed',
        issue: 'The process exited before it answered.',
        needsConfig: ['MCP_FS_ROOT'],
        lastUsed: ago(26 * 60),
      },
      // OAuth over a transport the CLI cannot register: no sign-in is offered, and the page says why.
      {
        ...DOCS,
        id: 'socket',
        label: 'Socket',
        transport: 'ws',
        url: 'wss://socket.example.com/mcp',
        auth: { kind: 'oauth', secrets: [] },
        status: 'needs-auth',
      },
    ]);
    mount();

    const row = await rowOf('files');
    expect(row).toHaveTextContent('stdio · needs MCP_FS_ROOT');
    // An unfinished registration's one act is to finish it (#363).
    expect(row.querySelector('[data-row-act]')).toHaveTextContent('Fill it in');
    const files = await open('files');
    expect(within(files).getByText('npx -y files-mcp $MCP_FS_ROOT')).toBeInTheDocument();
    expect(files).toHaveTextContent('The process exited before it answered.');
    expect(files).toHaveTextContent(
      'Its command refers to MCP_FS_ROOT, which nothing supplies, so it cannot connect until it is filled in.',
    );
    expect(files).toHaveTextContent('Last used 1 day ago.');

    const socket = await open('socket');
    expect(within(socket).getByText('wss://socket.example.com/mcp')).toBeInTheDocument();
    expect(socket).toHaveTextContent(
      'A ws server cannot be signed in from here — the Claude CLI’s mcp add takes stdio, sse and http, and the sign-in works by registering the server with it first. Give it a header this console holds instead.',
    );
    expect(within(socket).queryByLabelText('Sign in for')).toBeNull();
    expect(within(socket).queryByRole('button', { name: /^Sign in/ })).toBeNull();
  });

  it('surfaces a tool-list change as the supply-chain event it is, and "I have checked it" clears it', async () => {
    serve([{ ...DOCS, toolsChanged: { added: ['exfiltrate'], removed: ['search'], seenAt: ago(120) } }]);
    mount();

    // Its own banner, never the unreachable one: a drifted server connects perfectly.
    expect(
      await screen.findByText(
        'Docs connects, but advertises different tools than it did when it was attached.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/cannot be reached — /)).toBeNull();
    const details = await open('docs');
    expect(details).toHaveTextContent(
      'It now advertises different tools than it did 2 hours ago. Added: exfiltrate. Removed: search. A server whose tools change under you is how a trusted integration becomes an untrusted one — check what changed before the next run attaches it.',
    );
    expect(sent(server, 'POST', '/api/mcp/docs/acknowledge')).toEqual([]);

    await press(within(details).getByRole('button', { name: 'I have checked it' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/mcp/docs/acknowledge')).toEqual([{}]));
    // Read again, the drift is gone — from the top and from the row.
    await waitFor(() => expect(screen.queryByText(/advertises different tools/)).toBeNull());
    expect(within(details).queryByRole('button', { name: 'I have checked it' })).toBeNull();
  });

  it('warns that a tool asking a person to approve every call stalls an unattended run', async () => {
    serve([
      { ...DOCS, interactiveTools: ['grant_access'] },
      { ...DOCS, id: 'pay', label: 'Pay', interactiveTools: ['approve_payment', 'refund'] },
    ]);
    mount();

    expect(await open('docs')).toHaveTextContent(
      'grant_access ask a person to approve every call, which an unattended run never can: a phase that needs that tool stalls rather than finishes.',
    );
    expect(await open('pay')).toHaveTextContent(
      'approve_payment, refund ask a person to approve every call, which an unattended run never can: a phase that needs those tools stalls rather than finishes.',
    );
  });
});

describe('the presses on a server', () => {
  it('switches a server off and on — the one act on its line — and re-checks every server switched on', async () => {
    serve([DOCS, { ...TRACKER, enabled: false }]);
    mount();

    await press(await screen.findByRole('button', { name: 'Re-check all' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/mcp/refresh')).toEqual([{}]));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Re-checked every server that is switched on.', 'ok'),
    );

    const docs = await rowOf('docs');
    await press(within(docs).getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(sent(server, 'PATCH', '/api/mcp/docs')).toStrictEqual([{ enabled: false }]));
    // Read again: the line says so, and nothing is left switched on to re-check.
    await waitFor(() => expect(within(docs).getByRole('button', { name: 'Switch on' })).toBeEnabled());
    expect(docs).toHaveTextContent('Switched off · http · 2 tools');
    expect(screen.getByText(/^0 of 2 switched on\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-check all' })).toBeDisabled();

    await press(within(await rowOf('tracker')).getByRole('button', { name: 'Switch on' }));
    await waitFor(() => expect(sent(server, 'PATCH', '/api/mcp/tracker')).toStrictEqual([{ enabled: true }]));
  });

  it('renames a server by its label alone — the id a plan names never moves — and says a refusal in the server’s words', async () => {
    serve([DOCS]);
    const accept = server.reads['PATCH /api/mcp/docs'] as (body: unknown) => unknown;
    let refused = false;
    server.reads['PATCH /api/mcp/docs'] = (body: unknown) => {
      if (refused) return accept(body);
      refused = true;
      throw new Error('no MCP server called docs');
    };
    mount();

    const row = await rowOf('docs');
    const details = await open('docs');
    const name = within(details).getByLabelText('Name');
    const rename = within(details).getByRole('button', { name: 'Rename' });
    expect(name).toHaveValue('Docs');
    expect(details).toHaveTextContent(
      'What this page and the run page call it. A plan names it by its id, which stays docs.',
    );
    // Nothing to send while the name is the one it has, or blank.
    expect(rename).toBeDisabled();
    fireEvent.change(name, { target: { value: '   ' } });
    expect(rename).toBeDisabled();

    fireEvent.change(name, { target: { value: '  Team docs ' } });
    await press(rename);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('no MCP server called docs', 'error'));
    expect(name).toHaveValue('  Team docs ');

    await press(rename);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Renamed to Team docs. Plans still name it docs.', 'ok'),
    );
    expect(sent(server, 'PATCH', '/api/mcp/docs')).toStrictEqual([
      { label: 'Team docs' },
      { label: 'Team docs' },
    ]);
    // Read again, the line wears the new name, and the field has nothing left to send.
    await waitFor(() => expect(within(row).getByText('Team docs')).toBeInTheDocument());
    expect(within(row).getByText('docs')).toBeInTheDocument();
    expect(rename).toBeDisabled();
  });

  it('stores a secret through its dialog, never on the page, and re-checks the connection', async () => {
    serve([FILES]);
    mount();

    const details = await open('files');
    expect(needsOf(details, 'Files')).toEqual([
      ['env:FILES_TOKEN', 'Not set', 'Set'],
      ['env:FILES_SIGNING_KEY', 'Held in the keychain', 'Replace'],
    ]);

    // Replace opens the same dialog for the held one; cancelled, nothing is sent.
    fireEvent.click(within(details).getByRole('button', { name: 'Replace' }));
    const replacing = await screen.findByRole('dialog', { name: 'Set env:FILES_SIGNING_KEY' });
    fireEvent.click(within(replacing).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(details).getByRole('button', { name: 'Set' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set env:FILES_TOKEN' });
    expect(dialog).toHaveTextContent(
      'Stored in this machine’s keychain, never in the registry file and never shown again.',
    );
    const store = within(dialog).getByRole('button', { name: 'Store it' });
    expect(store).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('env:FILES_TOKEN'), { target: { value: '  tok-123  ' } });
    await press(store);

    await waitFor(() =>
      expect(sent(server, 'PATCH', '/api/mcp/files')).toStrictEqual([
        { secretRef: { kind: 'env', name: 'FILES_TOKEN' }, secret: 'tok-123' },
      ]),
    );
    await waitFor(() => expect(sent(server, 'POST', '/api/mcp/refresh')).toEqual([{}]));
    expect(toast).toHaveBeenCalledWith('Stored. Re-checking the connection…', 'ok');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Read again: held now, and the value is nowhere on the page.
    await waitFor(() =>
      expect(needsOf(details, 'Files')[0]).toEqual(['env:FILES_TOKEN', 'Held in the keychain', 'Replace']),
    );
    expect(document.body).not.toHaveTextContent('tok-123');
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      'PATCH /api/mcp/files',
      'POST /api/mcp/refresh',
    ]);
  });

  it('removes a server only once the confirm is answered, after saying what removal costs', async () => {
    serve([DOCS]);
    mount();

    const details = await open('docs');
    fireEvent.click(within(details).getByRole('button', { name: 'Remove' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Remove Docs?' });
    expect(dialog).toHaveTextContent(
      'The registration and anything this console holds for it — keychain entries, stored headers — are deleted. A plan that names docs parks at boarding until it is registered again or the name is dropped from the plan.',
    );
    expect(dialog).toHaveTextContent(
      'An OAuth sign-in stays where it is: claude mcp logout docs clears that, because the CLI owns it and this console never writes to its credential store.',
    );
    // Asked, not done: Keep it sends nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes()).toEqual([]);

    fireEvent.click(within(details).getByRole('button', { name: 'Remove' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Remove Docs?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove server' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Docs removed, with anything it held.', 'ok'));
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /api/mcp/docs']);
    // Read again, the registry is empty.
    expect(await screen.findByText(/^No server is registered/)).toBeInTheDocument();
  });
});

describe('signing a server in', () => {
  const AUTH =
    'https://tracker.example.com/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A5%2Fcallback';
  /** A flow as the server answers it, five minutes from NOW. */
  const flowOf = (patch: Partial<McpLoginFlow> = {}): McpLoginFlow => ({
    server: 'tracker',
    mode: 'embedded',
    remote: false,
    step: 'starting',
    startedAt: NOW,
    deadline: new Date(Date.parse(NOW) + 5 * 60_000).toISOString(),
    command: 'claude mcp login tracker',
    sessionId: 'pty-3',
    ...patch,
  });
  /** The console's side of a flow: the start, then whatever `current` says on every read. */
  function signs(current: { flow: McpLoginFlow }) {
    server.reads['POST /api/mcp/tracker/login'] = (): McpLoginStart => ({
      id: 'tracker',
      command: current.flow.command,
      mode: 'embedded',
      terminal: { sessionId: 'pty-3', token: 't', expiresAt: Date.parse(NOW) + 600_000 },
      flow: flowOf({ remote: current.flow.remote }),
    });
    server.reads['/api/mcp/tracker/login'] = () => ({ flow: current.flow });
  }

  it('is the row’s action when a server signs in and is not connected, and the sheet walks every step here', async () => {
    serve([TRACKER]);
    const current = { flow: flowOf() };
    signs(current);
    mount();

    const row = await rowOf('tracker');
    const act = row.querySelector<HTMLElement>('[data-row-act]')!;
    expect(act).toHaveTextContent('Sign in');
    expect(within(row).queryByRole('button', { name: 'Switch off' })).toBeNull();
    current.flow = flowOf({ step: 'approve', authUrl: AUTH });
    await press(act);

    const sheet = await drawn('[data-testid="mcp-signin"]');
    await waitFor(() =>
      expect(sheet.querySelector('[data-login-step]')).toHaveAttribute('data-login-step', 'approve'),
    );
    expect(sent(server, 'POST', '/api/mcp/tracker/login')).toStrictEqual([{}]);
    const steps = [...sheet.querySelectorAll<HTMLElement>('[data-step]')].map((one) => [
      one.dataset.step,
      one.dataset.stepState,
    ]);
    expect(steps).toEqual([
      ['starting', 'done'],
      ['approve', 'now'],
      ['checking', 'later'],
    ]);
    expect(sheet).toHaveTextContent('Approve in the browser that opened on this machine');
    expect(within(sheet).getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute('href', AUTH);
    expect(within(sheet).queryByLabelText('The address the browser lands on')).toBeNull();
    expect(sheet).toHaveTextContent('5:00 left — the Claude CLI gives up five minutes after it starts.');

    current.flow = flowOf({ step: 'connected', authUrl: AUTH });
    await waitFor(
      () =>
        expect(sheet).toHaveTextContent('Tracker is connected. Runs on this console can use it from now on.'),
      { timeout: 3_000 },
    );
  });

  it('from elsewhere, asks for the address the browser lands on and hands it to the CLI', async () => {
    serve([TRACKER]);
    const current = { flow: flowOf({ remote: true, step: 'paste', authUrl: AUTH }) };
    signs(current);
    server.reads['POST /api/mcp/tracker/login/paste'] = () => ({
      flow: flowOf({ remote: true, step: 'checking', authUrl: AUTH, pastedAt: NOW }),
    });
    mount();

    await press((await rowOf('tracker')).querySelector<HTMLElement>('[data-row-act]')!);
    const sheet = await drawn('[data-testid="mcp-signin"]');
    const field = await within(sheet).findByLabelText('The address the browser lands on');
    expect(sheet).toHaveTextContent(
      'Open the sign-in page, approve, and paste back the address the browser lands on',
    );
    expect(sheet).toHaveTextContent('it may say the page cannot be reached. That is expected');
    fireEvent.change(field, { target: { value: 'http://localhost:5/callback?code=abc' } });
    await press(within(sheet).getByRole('button', { name: 'Send it to the CLI' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/mcp/tracker/login/paste')).toStrictEqual([
        { url: 'http://localhost:5/callback?code=abc' },
      ]),
    );
  });

  it('says which step a timed-out sign-in stopped on, and Try again starts another', async () => {
    serve([TRACKER]);
    const detail =
      'The sign-in gave up after five minutes, waiting for the address the browser landed on to be pasted back.';
    const current = { flow: flowOf({ remote: true, step: 'timed-out', authUrl: AUTH, detail }) };
    signs(current);
    mount();

    await press((await rowOf('tracker')).querySelector<HTMLElement>('[data-row-act]')!);
    const sheet = await drawn('[data-testid="mcp-signin"]');
    expect(await within(sheet).findByText(detail)).toBeInTheDocument();
    const paste = sheet.querySelector('[data-step="paste"]');
    expect(paste).toHaveAttribute('data-step-state', 'now');
    await press(within(sheet).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/mcp/tracker/login')).toHaveLength(2));
  });

  it('signs in for a profile account by its id, from the opened row', async () => {
    serve([{ ...TRACKER, status: 'connected', checkedAt: ago(10) }]);
    signs({ flow: flowOf() });
    mount();

    const details = await open('tracker');
    const signInFor = within(details).getByLabelText('Sign in for');
    // This console, and each profile by its name or else its email — never the machine's login or a token.
    await waitFor(() =>
      expect(
        within(signInFor)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['This console', 'Work', 'spare@example.com']),
    );
    expect(details).toHaveTextContent(
      'The token lands in that account’s own config dir, so the runs that spend it see the server signed in. This console’s own is what its health check reads.',
    );
    fireEvent.change(signInFor, { target: { value: 'acct-work' } });
    // A server that is signed in already is signed in again — and keeps Switch off as its row's act.
    expect((await rowOf('tracker')).querySelector('[data-row-act]')).toHaveTextContent('Switch off');
    await press(within(details).getByRole('button', { name: 'Sign in again' }));
    await drawn('[data-testid="mcp-signin"]');
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/mcp/tracker/login')).toStrictEqual([{ accountId: 'acct-work' }]),
    );
  });

  it('shows the commands to run by hand when no sign-in could start here', async () => {
    serve([TRACKER]);
    const commands = [
      'CLAUDE_CONFIG_DIR=/home/x/.claude-work claude mcp add --transport sse tracker https://tracker.example.com/sse',
      'CLAUDE_CONFIG_DIR=/home/x/.claude-work claude mcp login tracker',
    ];
    server.reads['POST /api/mcp/tracker/login'] = (): McpLoginStart => ({
      id: 'tracker',
      command: commands[1]!,
      mode: 'command',
      detail: 'No terminal can be opened on this machine.',
      configDir: '/home/x/.claude-work',
      commands,
    });
    mount();

    await press((await rowOf('tracker')).querySelector<HTMLElement>('[data-row-act]')!);
    const sheet = await drawn('[data-testid="mcp-signin"]');
    expect(
      await within(sheet).findByText('This console cannot run the sign-in for Tracker itself.'),
    ).toBeInTheDocument();
    expect(sheet).toHaveTextContent('No terminal can be opened on this machine.');
    expect(sheet).toHaveTextContent(
      'Run these in a terminal, then press Re-check all. The token lands in /home/x/.claude-work.',
    );
    expect(sheet.querySelector('[data-testid="mcp-signin-by-hand-block"]')).toHaveTextContent(commands[0]!);
  });
});

/* ---------------- adding by hand, and filling a variable in (#363) ---------------- */

describe('adding by hand', () => {
  it('registers any server — its fields, one secret and a value for every ${VAR} its command writes', async () => {
    serve([DOCS]);
    mount();
    await rowOf('docs');
    fireEvent.click(screen.getByRole('button', { name: 'Add by hand' }));
    const form = await drawn('[data-testid="mcp-manual-form"]');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Obs vault' } });
    fireEvent.change(within(form).getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.change(within(form).getByLabelText('Arguments, one per line'), {
      target: { value: '-y\nobs-mcp\n${OBS_ROOT}' },
    });
    fireEvent.change(within(form).getByLabelText('Environment, NAME=value per line'), {
      target: { value: 'OBS_MODE=read' },
    });
    fireEvent.change(within(form).getByLabelText('Secret variable name'), { target: { value: 'OBS_TOKEN' } });
    fireEvent.change(within(form).getByLabelText('Secret value'), { target: { value: 's3cret' } });
    fireEvent.change(await within(form).findByLabelText('OBS_ROOT'), { target: { value: '/vault' } });
    await press(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/mcp')).toStrictEqual([
        {
          label: 'Obs vault',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'obs-mcp', '${OBS_ROOT}'],
          env: { OBS_MODE: 'read' },
          secretRefs: [{ kind: 'env', name: 'OBS_TOKEN' }],
          secrets: { 'env:OBS_TOKEN': 's3cret' },
          vars: { OBS_ROOT: '/vault' },
          source: 'manual',
        },
      ]),
    );
  });

  it('says what is missing before it sends anything', async () => {
    serve([DOCS]);
    mount();
    await rowOf('docs');
    fireEvent.click(screen.getByRole('button', { name: 'Add by hand' }));
    const form = await drawn('[data-testid="mcp-manual-form"]');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Remote' } });
    fireEvent.change(within(form).getByLabelText('Transport'), { target: { value: 'http' } });
    await press(within(form).getByRole('button', { name: 'Add server' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('a remote server needs its address');
    expect(sent(server, 'POST', '/api/mcp')).toStrictEqual([]);
  });

  it('*Fill it in* sends a value for each variable the registration left unfilled', async () => {
    serve([{ ...FILES, needsConfig: ['MCP_FS_ROOT'], status: 'failed' }]);
    mount();
    await press((await rowOf('files')).querySelector<HTMLElement>('[data-row-act]')!);
    const field = await screen.findByLabelText('MCP_FS_ROOT');
    fireEvent.change(field, { target: { value: '/home/x/notes' } });
    await press(screen.getByRole('button', { name: 'Store and re-check' }));
    await waitFor(() =>
      expect(sent(server, 'PATCH', '/api/mcp/files')).toStrictEqual([
        { vars: { MCP_FS_ROOT: '/home/x/notes' } },
      ]),
    );
  });
});

/* ---------------- the catalog ---------------- */

describe('the catalog', () => {
  it('is its own address under the section nav, and lists what could be added by category', async () => {
    server.reads['/api/mcp/catalog'] = { entries: CATALOG, registryError: 'the registry answered 503' };
    mount();
    await rowOf('docs');
    expect(catalogAsks()).toEqual([]);

    const views = screen.getByRole('navigation', { name: 'MCP server views' });
    fireEvent.click(within(views).getByRole('link', { name: 'Catalog' }));
    await waitFor(() => expect(window.location.hash).toBe('#/settings/mcp?tab=catalog'));
    const catalog = await screen.findByTestId('mcp-catalog');
    expect(within(views).getByRole('link', { name: 'Catalog' })).toHaveAttribute('aria-current', 'page');
    expect(within(views).getByRole('link', { name: 'Registered (1)' })).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('region', { name: 'Registered servers' })).toBeNull();
    await waitFor(() => expect(catalogAsks()).toEqual(['/api/mcp/catalog?q=']));

    expect(
      within(catalog).getByText(
        'The official registry could not be read (the registry answered 503), so this is the curated list only. Everything below still works, and a server in neither list can be added by hand.',
      ),
    ).toBeInTheDocument();
    const knowledge = within(catalog).getByRole('region', { name: 'Knowledge' });
    expect(within(knowledge).getByRole('heading', { name: 'Knowledge', level: 3 })).toBeInTheDocument();
    const work = within(catalog).getByRole('region', { name: 'Work' });
    expect(
      [...work.querySelectorAll<HTMLElement>('[data-catalog-entry]')].map((one) => one.dataset.catalogEntry),
    ).toEqual(['board', 'notes', 'calendar']);

    // Registered already: said, and not offered again.
    const docs = await entryOf('docs');
    expect(within(docs).getByText('Registered')).toBeInTheDocument();
    expect(within(docs).queryByRole('button', { name: 'Add' })).toBeNull();
    expect(within(docs).getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      'https://docs.example.com/',
    );
    const board = await entryOf('board');
    expect(board).toHaveTextContent('http · needs a token');
    expect(board).toHaveTextContent('Tickets and boards for the team.');
    expect(board).toHaveTextContent('Make a token under the board’s own settings.');
    expect(within(board).getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(await entryOf('notes')).toHaveTextContent(
      'stdio · needs an environment variable · from the registry',
    );
    expect(await entryOf('calendar')).toHaveTextContent('sse · signs in');
    expect(writes()).toEqual([]);
  });

  it('marks a pinned entry and one whose output is untrusted (measured-console phase 27)', async () => {
    server.reads['/api/mcp/catalog'] = {
      entries: [
        {
          id: 'context7',
          label: 'Context7',
          description: 'Library docs.',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@>=2.1.3'],
          auth: 'none',
          category: 'Docs',
          source: 'curated',
          pin: { package: '@upstash/context7-mcp', min: '2.1.3' },
          untrustedOutput: true,
        },
      ],
    };
    mount();
    await rowOf('docs');
    const views = screen.getByRole('navigation', { name: 'MCP server views' });
    fireEvent.click(within(views).getByRole('link', { name: 'Catalog' }));
    expect(await entryOf('context7')).toHaveTextContent('stdio · pinned ≥ 2.1.3 · untrusted output');
  });

  it('adds an entry with the token it needs in one press, and an OAuth one to be signed in from its line', async () => {
    mount('#/settings/mcp?tab=catalog');

    const board = await entryOf('board');
    fireEvent.click(within(board).getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Board' });
    expect(dialog).toHaveTextContent(
      'It registers as board — the name a plan uses on its MCP servers line, and a permission rule as mcp__board.',
    );
    fireEvent.change(within(dialog).getByLabelText('Authorization'), { target: { value: ' tok-9 ' } });
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add server' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/mcp')).toStrictEqual([
        {
          id: 'board',
          label: 'Board',
          transport: 'http',
          url: 'https://board.example.com/mcp',
          secretRefs: [{ kind: 'header', name: 'Authorization' }],
          secrets: { 'header:Authorization': 'tok-9' },
          source: 'catalog',
        },
      ]),
    );
    expect(toast).toHaveBeenCalledWith('Board registered. Checking the connection…', 'ok');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Read again: the entry is registered now, and the count beside the registry moved.
    await waitFor(() => expect(within(board).getByText('Registered')).toBeInTheDocument());
    expect(within(board).queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Registered (2)' })).toBeInTheDocument();

    fireEvent.click(within(await entryOf('calendar')).getByRole('button', { name: 'Add' }));
    const oauth = await screen.findByRole('dialog', { name: 'Add Calendar' });
    expect(oauth).toHaveTextContent(
      'It signs in with OAuth. Register it now, then sign it in from its row — the token goes to the Claude CLI’s own store, which this console never reads or writes.',
    );
    fireEvent.click(within(oauth).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/mcp')).toHaveLength(2));
    expect(sent(server, 'POST', '/api/mcp')[1]).toStrictEqual({
      id: 'calendar',
      label: 'Calendar',
      transport: 'sse',
      url: 'https://calendar.example.com/sse',
      source: 'catalog',
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Calendar registered — sign it in from its row under Registered.',
        'ok',
      ),
    );
  });

  it('searches through the console, and says when nothing matches', async () => {
    server.reads['/api/mcp/catalog'] = () => {
      // The call being answered is the last one recorded.
      const asked = new URLSearchParams(server.calls.at(-1)!.path.split('?')[1]).get('q') ?? '';
      return { entries: CATALOG.filter((one) => one.id.includes(asked)) };
    };
    mount('#/settings/mcp?tab=catalog');
    await entryOf('calendar');

    const search = screen.getByRole('searchbox', { name: 'Search the MCP catalog' });
    fireEvent.change(search, { target: { value: 'board' } });
    await waitFor(() => expect(document.querySelector('[data-catalog-entry="calendar"]')).toBeNull());
    expect(await entryOf('board')).toBeInTheDocument();
    expect(catalogAsks()).toContain('/api/mcp/catalog?q=board');

    fireEvent.change(search, { target: { value: 'zzqx' } });
    expect(
      await screen.findByText(
        'Nothing in the catalog matches. Try a shorter search or a product name — or add the server by hand under Registered.',
      ),
    ).toBeInTheDocument();
    expect(catalogAsks()).toContain('/api/mcp/catalog?q=zzqx');
    expect(writes()).toEqual([]);
  });

  it('asks once per pause in typing, never once per keystroke (#363)', async () => {
    mount('#/settings/mcp?tab=catalog');
    await entryOf('calendar');
    const search = screen.getByRole('searchbox', { name: 'Search the MCP catalog' });
    for (const typed of ['s', 'sl', 'sla', 'slac', 'slack'])
      fireEvent.change(search, { target: { value: typed } });
    await waitFor(() => expect(catalogAsks()).toContain('/api/mcp/catalog?q=slack'));
    expect(catalogAsks().filter((path) => /q=sl?a?c?$/.test(path))).toEqual([]);
  });

  it('says the registry copy is being read the first time, and what a search searched once it is in', async () => {
    let state: 'refreshing' | 'fresh' = 'refreshing';
    server.reads['/api/mcp/catalog'] = () => ({
      entries: CATALOG,
      registry: state === 'refreshing' ? { state, count: 0 } : { state, count: 4210, fetchedAt: ago(3) },
    });
    mount('#/settings/mcp?tab=catalog');
    expect(
      await screen.findByText(/Reading the official registry for the first time — about a minute\./),
    ).toBeInTheDocument();
    state = 'fresh';
    const search = screen.getByRole('searchbox', { name: 'Search the MCP catalog' });
    fireEvent.change(search, { target: { value: 'board' } });
    expect(
      await screen.findByText(/Searched the curated list and 4,210 servers in the registry copy\./),
    ).toBeInTheDocument();
  });

  it('gives a catalog entry whose command writes a ${VAR} a field for it', async () => {
    server.reads['/api/mcp/catalog'] = {
      entries: [
        {
          ...CATALOG[2]!,
          id: 'fs',
          label: 'Filesystem',
          args: ['-y', 'fs-mcp', '${MCP_FS_ROOT}'],
          secretRefs: [],
        },
      ],
    };
    mount('#/settings/mcp?tab=catalog');
    fireEvent.click(within(await entryOf('fs')).getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Filesystem' });
    fireEvent.change(within(dialog).getByLabelText('MCP_FS_ROOT'), { target: { value: '/home/x/notes' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/mcp')).toHaveLength(1));
    expect((sent(server, 'POST', '/api/mcp')[0] as { vars?: unknown }).vars).toStrictEqual({
      MCP_FS_ROOT: '/home/x/notes',
    });
  });
});

/* ---------------- the policy ---------------- */

describe('when a server cannot be reached', () => {
  it('saves the answer through the console’s preferences, and the banner says what it costs now', async () => {
    serve([DOCS, TRACKER]);
    server.reads['POST /api/prefs'] = (body: unknown) => {
      const { mcpPolicy } = body as { mcpPolicy: string };
      server.reads['/api/prefs/schema'] = schemaAnswer({
        mcpPolicy: { value: mcpPolicy, default: 'continue', source: 'instance' },
      });
      return { ok: true };
    };
    mount();

    const group = await screen.findByRole('region', { name: 'When a server cannot be reached' });
    expect(group).toHaveTextContent(
      'Asked before a phase boards, of every server it names. A plan or a phase may say otherwise, and outranks this.',
    );
    const policy = within(group).getByLabelText('When one of a phase’s servers cannot be reached');
    await waitFor(() => expect(policy).toHaveValue('continue'));
    expect(
      within(policy)
        .getAllByRole('option')
        .map((option) => [option.getAttribute('value'), option.textContent]),
    ).toEqual([
      ['continue', 'Run without it and record an errand'],
      ['require', 'Park the phase until it is signed in'],
    ]);
    // The shipped default is silent about where it came from.
    expect(within(group).queryByText('Set here')).toBeNull();
    expect(
      screen.getByText(
        'Tracker cannot be reached — a phase naming it will run without it and record an errand.',
      ),
    ).toBeInTheDocument();

    fireEvent.change(policy, { target: { value: 'require' } });
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toStrictEqual([{ mcpPolicy: 'require' }]));
    // Read again: the word is this console's now, said where it came from — and the banner says what it costs.
    await waitFor(() => expect(within(group).getByText('Set here')).toBeInTheDocument());
    expect(policy).toHaveValue('require');
    expect(
      screen.getByText('Tracker cannot be reached — a phase naming it will park at boarding.'),
    ).toBeInTheDocument();
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/prefs']);
  });
});

describe('the line that adds one outside the console', () => {
  it('carries every secret an entry needs as a value to fill in, a header in its own shape', () => {
    expect(
      addCommand({
        id: 'board',
        label: 'Board',
        description: 'A project board.',
        transport: 'http',
        url: 'https://board.example.com/mcp',
        auth: 'header',
        secretRefs: [{ kind: 'header', name: 'Authorization', template: 'Bearer {}' }],
        category: 'Work',
        source: 'curated',
      }),
    ).toBe(
      'claude mcp add --transport http --header "Authorization: Bearer <value>" board https://board.example.com/mcp',
    );
    expect(
      addCommand({
        id: 'notes',
        label: 'Notes',
        description: 'Notes on disk.',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'notes-mcp'],
        auth: 'env',
        secretRefs: [{ kind: 'env', name: 'NOTES_TOKEN' }],
        category: 'Files',
        source: 'curated',
      }),
    ).toBe('claude mcp add -e NOTES_TOKEN=<value> notes -- npx -y notes-mcp');
  });
});
