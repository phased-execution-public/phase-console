/**
 * Settings ▸ Notifications ▸ Webhooks (quiet-console phase 22; the 6.x
 * Webhooks card's cases): where else the console speaks, and what it refuses
 * to show or do.
 *
 * Pinned: no URL is ever on screen — a row is its origin and the tail the
 * server masked, drawn exactly as the server cut it, and a pasted URL leaves
 * the page once the server took it; without `--allow-webhooks` the rows are
 * still listed, every press is off and the group says why, with no form to add
 * one; Add webhook posts the URL and the name, trimmed, and a refusal is said
 * in the server's words with the URL kept to correct; a failing webhook reads
 * as backing off rather than lost, and "last reached" is a relative time, so
 * both run on a fixed clock; Send a test, Remove behind its confirm and the
 * kinds under *What it receives* each post their one route, and the page reads
 * the register back; one press runs at a time; a server with no such endpoint
 * draws nothing.
 */

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationCategory, WebhookRow, WebhooksState } from '@/data/api';
import { ApiError } from '@/data/http';
import { keys } from '@/data/keys';
import { Toaster, dismissToast, useToasts } from '@/ui';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { WebhooksGroup, failureLine } from './webhooks';

/** The kinds as the server's catalogue serves them, in its order. */
const CATEGORIES: NotificationCategory[] = [
  { id: 'halted', label: 'Run halted', detail: 'A run stopped.', byDefault: true, urgent: true },
  { id: 'phase', label: 'Phase finished or failed', detail: 'Each phase.', byDefault: true, urgent: false },
  { id: 'digest', label: 'Hourly digest', detail: 'A summary.', byDefault: false, urgent: false },
];

/** The fixed clock the time-dependent words are read against. */
const NOW = Date.parse('2026-10-11T12:00:00.000Z');

/** A row as the server serves it: the origin and the tail `maskUrl` cut, never the URL. */
function row(over: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id: 'w1',
    label: '#builds',
    origin: 'https://hooks.slack.com',
    tail: '…xxxxxx',
    categories: { halted: true, phase: true, digest: false },
    createdAt: '2026-10-01T00:00:00.000Z',
    lastOkAt: null,
    failures: 0,
    secretHint: '…1a2b',
    queued: 0,
    ...over,
  };
}

/** A second webhook, on another host. */
const OPS = (over: Partial<WebhookRow> = {}) =>
  row({ id: 'w2', label: '#ops', origin: 'https://discord.com', tail: '…a1b2c3', ...over });

/** The register the fixture server holds. GET answers it as it stands, so a write that changes it is read back. */
let register: WebhooksState;

function serve(over: Partial<WebhooksState> = {}) {
  register = { allowWebhooks: true, hooks: [row()], categories: CATEGORIES, ...over };
  server.reads['/api/webhooks'] = () => register;
}

/** The group, and the toast tray in a container of its own, so the group's container holds the group alone. */
function mount() {
  render(<Toaster />);
  return renderWithClient(<WebhooksGroup />);
}

/** One webhook's row. */
function item(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-webhook="${id}"]`);
  expect(found, `webhook ${id} is drawn`).not.toBeNull();
  return found!;
}

const pressesSent = () => server.calls.filter((call) => call.method !== 'GET');

beforeEach(() => {
  server.calls = [];
  server.reads = {};
});

afterEach(() => {
  vi.useRealTimers();
  // The tray's store is the module's own and outlives a render.
  const { result, unmount } = renderHook(() => useToasts());
  act(() => {
    for (const one of result.current) dismissToast(one.id);
  });
  unmount();
});

describe('what a webhook row shows', () => {
  it('never puts a URL on screen: a row is its origin and the tail the server masked, cut where the server cut it', async () => {
    serve({
      hooks: [
        row(),
        // A path of six characters or fewer is not cut: the server sends it whole, and no ellipsis is drawn.
        row({ id: 'w2', label: 'relay', origin: 'https://relay.example.com', tail: '/hook' }),
      ],
    });
    mount();
    await screen.findByText('#builds');
    expect(within(item('w1')).getByText('https://hooks.slack.com…xxxxxx')).toBeInTheDocument();
    expect(within(item('w2')).getByText('https://relay.example.com/hook')).toBeInTheDocument();
    // Nor is there a field holding one to copy out: the form starts empty.
    expect(screen.getByLabelText('Webhook URL')).toHaveValue('');
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('says how many kinds each webhook takes and when it was last reached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve({
      hooks: [
        row({ lastOkAt: '2026-10-11T09:00:00.000Z' }),
        OPS({ categories: { halted: true, phase: false, digest: false } }),
      ],
    });
    mount();
    await screen.findByText('#builds');
    expect(within(item('w1')).getByText('2 kinds')).toBeInTheDocument();
    expect(within(item('w1')).getByText(/^last reached/)).toHaveTextContent(/^last reached 3 hours ago$/);
    expect(within(item('w1')).getByText('3 hours ago')).toHaveAttribute(
      'datetime',
      '2026-10-11T09:00:00.000Z',
    );
    expect(within(item('w2')).getByText('1 kind')).toBeInTheDocument();
    expect(within(item('w2')).getByText('never reached')).toBeInTheDocument();
    expect(screen.getByText('2 webhooks')).toBeInTheDocument();
  });

  it('reads a failing webhook as backing off rather than lost, until its backoff has run out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve({
      hooks: [
        row({
          failures: 3,
          lastFailure: { at: '2026-10-11T11:59:00.000Z', status: 500, reason: null },
          quietUntil: NOW + 60_000,
        }),
        OPS({
          failures: 1,
          lastFailure: { at: '2026-10-11T10:00:00.000Z', status: 0, reason: 'timed out' },
          quietUntil: NOW - 1,
        }),
        row({ id: 'w3', label: '#quiet', origin: 'https://relay.example.com', tail: '/hook' }),
      ],
    });
    mount();
    await screen.findByText('#builds');
    expect(within(item('w1')).getByTestId('webhook-failing').textContent).toBe(
      '3 failures in a row: 500. Backing off; it tries again by itself.',
    );
    expect(within(item('w2')).getByTestId('webhook-failing').textContent).toBe(
      '1 failure in a row: no answer timed out.',
    );
    expect(within(item('w3')).queryByTestId('webhook-failing')).toBeNull();
  });

  it('words a failure from the row and the clock alone', () => {
    expect(failureLine(row(), NOW)).toBeNull();
    const failing = row({
      failures: 2,
      lastFailure: { at: '2026-10-11T11:00:00.000Z', status: 502, reason: null },
    });
    expect(failureLine({ ...failing, quietUntil: NOW + 1 }, NOW)).toBe(
      '2 failures in a row: 502. Backing off; it tries again by itself.',
    );
    // The backoff ends AT its clock, exactly where the server starts sending to it again.
    expect(failureLine({ ...failing, quietUntil: NOW }, NOW)).toBe('2 failures in a row: 502.');
    expect(
      failureLine(
        row({
          failures: 1,
          lastFailure: { at: '2026-10-11T11:00:00.000Z', status: 0, reason: 'unreachable' },
        }),
        NOW,
      ),
    ).toBe('1 failure in a row: no answer unreachable.');
    expect(failureLine(row({ failures: 4 }), NOW)).toBe('4 failures in a row.');
  });

  it('with no webhook yet, says where the first one will go', async () => {
    serve({ hooks: [] });
    mount();
    expect(await screen.findByTestId('webhooks-empty')).toHaveTextContent(
      'No webhook yet — the announcements this console already makes go to the first one you add.',
    );
    expect(screen.getByText('0 webhooks')).toBeInTheDocument();
    expect(screen.queryByTestId('webhooks')).toBeNull();
  });

  it('points at the webhooks guide — a link, because a packaged copy ships no docs directory', async () => {
    serve();
    mount();
    const guide = await screen.findByRole('link', { name: 'the webhooks guide' });
    expect(guide).toHaveAttribute(
      'href',
      'https://github.com/phased-execution-public/phase-console/blob/main/docs/webhooks.md',
    );
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide).toHaveAttribute('rel', 'noreferrer');
    expect(guide.closest('p')).toHaveTextContent(
      'Slack and Telegram show the payload’s text; Discord shows its content.',
    );
  });

  it('draws nothing at all against a server that has no such endpoint', async () => {
    // Nothing is fixtured for GET /api/webhooks, so the kit answers 404, as a server that predates webhooks does.
    const view = mount();
    // While it reads, the group is drawn — so an empty container afterwards is the failure hiding it.
    expect(screen.getByRole('heading', { name: 'Webhooks' })).toBeInTheDocument();
    await waitFor(() => expect(view.client.getQueryState(keys.webhooks())?.status).toBe('error'));
    // Counting ELEMENTS, not text: the skeleton is an element with no text, so an empty text proves nothing.
    expect(view.container.children).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Webhooks' })).toBeNull();
    expect(sent(server, 'GET', '/api/webhooks')).toHaveLength(1);
  });
});

describe('without --allow-webhooks', () => {
  it('still lists every webhook, says why nothing can be pressed, and offers no form to add one', async () => {
    serve({ allowWebhooks: false });
    mount();
    expect(await screen.findByTestId('webhooks-off')).toHaveTextContent(
      'Outbound webhooks are off. Restart the console with --allow-webhooks to add one; until then it sends nothing — to the webhooks below included.',
    );
    // Listed: hiding a row is how a URL on file goes unnoticed.
    expect(within(item('w1')).getByText('#builds')).toBeInTheDocument();
    const test = screen.getByRole('button', { name: 'Send a test' });
    expect(test).toBeDisabled();
    expect(test).toHaveAttribute('title', 'Start the console with --allow-webhooks to change a webhook.');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    // No way to add one: the form is absent, not merely off — and so is the line inviting the first.
    expect(screen.queryByTestId('webhook-add')).toBeNull();
    expect(screen.queryByLabelText('Webhook URL')).toBeNull();
    expect(screen.queryByTestId('webhooks-empty')).toBeNull();
    // Reading what a webhook receives is not a press: the fold opens, and its boxes are off.
    fireEvent.click(screen.getByTestId('webhook-open-w1'));
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(CATEGORIES.length);
    for (const box of boxes) expect(box).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Run halted, to #builds' }));
    fireEvent.click(test);
    expect(pressesSent()).toEqual([]);
  });
});

describe('adding a webhook', () => {
  /** What a person pastes: a credential, whose path is what authorises. */
  const PASTED = 'https://hooks.example.com/services/T0000/B0000/abcdefabcdefabcdefabcdef';

  it("shows the new row's signing secret ONCE, with the header it signs, and only its hint after (measured-console phase 17)", async () => {
    const SECRET = `whsec_${'9f'.repeat(24)}`;
    serve({ hooks: [row({ queued: 3 })] });
    server.reads['POST /api/webhooks/add'] = (body: { url: string; label: string }) => {
      const hook = row({
        id: 'w2',
        label: body.label,
        origin: 'https://hooks.example.com',
        tail: '…abcdef',
        secretHint: '…9f9f',
      });
      register = { ...register, hooks: [...register.hooks, hook] };
      return { hook: { ...hook, secret: SECRET }, state: register };
    };
    mount();
    expect(await screen.findByText('signed with …1a2b')).toBeInTheDocument();
    expect(within(item('w1')).getByTestId('webhook-queued')).toHaveTextContent('3 announcements waiting');
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: PASTED } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '#deploys' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }));
    const shown = await screen.findByTestId('webhook-secret');
    expect(shown).toHaveTextContent(SECRET);
    expect(shown).toHaveTextContent('X-Phase-Console-Signature: sha256=…');
    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('webhook-secret')).toBeNull();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(await screen.findByText('signed with …9f9f')).toBeInTheDocument();
  });

  it('posts the URL and the name, trimmed, then empties both and draws the new row as the server masked it', async () => {
    serve();
    server.reads['POST /api/webhooks/add'] = (body: { url: string; label: string }) => {
      const hook = row({ id: 'w2', label: body.label, origin: 'https://hooks.example.com', tail: '…abcdef' });
      register = { ...register, hooks: [...register.hooks, hook] };
      return { hook, state: register };
    };
    mount();
    const url = await screen.findByLabelText('Webhook URL');
    const name = screen.getByLabelText('Name');
    const add = screen.getByRole('button', { name: 'Add webhook' });
    // Nothing to add yet — and a URL of spaces is not one.
    expect(add).toBeDisabled();
    fireEvent.change(url, { target: { value: '   ' } });
    expect(add).toBeDisabled();
    fireEvent.change(url, { target: { value: `  ${PASTED}  ` } });
    fireEvent.change(name, { target: { value: ' #deploys ' } });
    fireEvent.click(add);
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/webhooks/add')).toEqual([{ url: PASTED, label: '#deploys' }]),
    );
    expect(
      await screen.findByText(
        'Added. Nothing is sent until a matching announcement — send a test to prove it now.',
      ),
    ).toBeInTheDocument();
    // The register is read back: the new row is its origin and tail, and the URL is gone from the page.
    expect(await screen.findByText('https://hooks.example.com…abcdef')).toBeInTheDocument();
    expect(within(item('w2')).getByText('#deploys')).toBeInTheDocument();
    expect(url).toHaveValue('');
    expect(name).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('abcdefabcdefabcdefabcdef');
  });

  it.each([
    {
      shape: 'a 400, as the server refuses',
      answer: () =>
        new ApiError('URL must be https', 400, '/api/webhooks/add', { error: 'URL must be https' }),
    },
    { shape: 'an answer that carries an error', answer: () => ({ error: 'URL must be https' }) },
  ])(
    'says a refusal ($shape) in the server’s words and keeps the pasted URL to correct',
    async ({ answer }) => {
      serve();
      server.reads['POST /api/webhooks/add'] = answer();
      mount();
      const url = await screen.findByLabelText('Webhook URL');
      fireEvent.change(url, { target: { value: 'http://hooks.example.com/x' } });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: '#builds' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }));
      await waitFor(() =>
        expect(sent(server, 'POST', '/api/webhooks/add')).toEqual([
          { url: 'http://hooks.example.com/x', label: '#builds' },
        ]),
      );
      expect(await screen.findByText('URL must be https')).toBeInTheDocument();
      expect(url).toHaveValue('http://hooks.example.com/x');
      expect(screen.getByLabelText('Name')).toHaveValue('#builds');
      expect(screen.queryByText(/^Added\./)).toBeNull();
    },
  );
});

describe('each webhook’s presses', () => {
  it('Send a test posts the webhook’s id and says what the far end answered', async () => {
    serve({ hooks: [row(), OPS()] });
    server.reads['POST /api/webhooks/test'] = ({ id }: { id: string }) =>
      id === 'w1'
        ? { ok: true, detail: 'accepted by https://hooks.slack.com (204)' }
        : { ok: false, detail: 'https://discord.com answered 404' };
    mount();
    await screen.findByText('#builds');
    fireEvent.click(within(item('w1')).getByRole('button', { name: 'Send a test' }));
    expect(
      await screen.findByText('Delivered: accepted by https://hooks.slack.com (204)'),
    ).toBeInTheDocument();
    const second = within(item('w2')).getByRole('button', { name: 'Send a test' });
    await waitFor(() => expect(second).toBeEnabled());
    fireEvent.click(second);
    expect(await screen.findByText('Not delivered: https://discord.com answered 404')).toBeInTheDocument();
    expect(sent(server, 'POST', '/api/webhooks/test')).toEqual([{ id: 'w1' }, { id: 'w2' }]);
  });

  it('Remove asks first: Cancel sends nothing, and the confirm posts the id and the row goes', async () => {
    serve();
    server.reads['POST /api/webhooks/remove'] = ({ id }: { id: string }) => {
      register = { ...register, hooks: register.hooks.filter((hook) => hook.id !== id) };
      return { removed: true, state: register };
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    let ask = await screen.findByRole('alertdialog', { name: 'Remove the webhook #builds?' });
    expect(ask).toHaveTextContent('Its URL is kept nowhere else: to send there again, paste the URL anew.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent(server, 'POST', '/api/webhooks/remove')).toEqual([]);
    expect(within(item('w1')).getByText('#builds')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    ask = await screen.findByRole('alertdialog', { name: 'Remove the webhook #builds?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/webhooks/remove')).toEqual([{ id: 'w1' }]));
    expect(await screen.findByText('Removed #builds.')).toBeInTheDocument();
    // The register is read back without it.
    await waitFor(() => expect(screen.queryByTestId('webhooks')).toBeNull());
    expect(screen.getByTestId('webhooks-empty')).toBeInTheDocument();
  });

  it('What it receives opens per webhook, and a kind ticked or cleared posts that webhook’s whole set', async () => {
    serve({ hooks: [row(), OPS({ categories: { halted: true, phase: false, digest: false } })] });
    server.reads['POST /api/webhooks/categories'] = (body: {
      id: string;
      categories: Record<string, boolean>;
    }) => {
      register = {
        ...register,
        hooks: register.hooks.map((hook) =>
          hook.id === body.id ? { ...hook, categories: body.categories } : hook,
        ),
      };
      return { hook: register.hooks.find((hook) => hook.id === body.id), state: register };
    };
    mount();
    await screen.findByText('#builds');
    // Folded, none of it is drawn.
    expect(screen.queryByRole('checkbox')).toBeNull();
    const fold = screen.getByTestId('webhook-open-w1');
    expect(fold).toHaveTextContent('What it receives');
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(fold).toHaveTextContent('Done');
    const kinds = screen.getByRole('group', {
      name: 'What it receives — a narrowing of what the console announces.',
    });
    // This webhook's alone: one box per kind of the catalogue, each named for the webhook it narrows.
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual([
      'Run halted, to #builds',
      'Phase finished or failed, to #builds',
      'Hourly digest, to #builds',
    ]);
    expect(within(kinds).getByText('Urgent').closest('label')).toHaveTextContent('Run halted');
    const halted = within(kinds).getByRole('checkbox', { name: 'Run halted, to #builds' });
    expect(halted).toHaveAttribute('aria-checked', 'true');
    const digest = within(kinds).getByRole('checkbox', { name: 'Hourly digest, to #builds' });
    expect(digest).toHaveAttribute('aria-checked', 'false');

    // Cleared: the webhook's whole set goes, with the one kind changed.
    fireEvent.click(halted);
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/webhooks/categories')).toEqual([
        { id: 'w1', categories: { halted: false, phase: true, digest: false } },
      ]),
    );
    // The register is read back, and the box stands where the server put it.
    await waitFor(() => expect(halted).toHaveAttribute('aria-checked', 'false'));
    expect(within(item('w1')).getByText('1 kind')).toBeInTheDocument();

    // Ticked: the set as the server now holds it, plus the one kind.
    await waitFor(() => expect(digest).toBeEnabled());
    fireEvent.click(digest);
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/webhooks/categories')).toEqual([
        { id: 'w1', categories: { halted: false, phase: true, digest: false } },
        { id: 'w1', categories: { halted: false, phase: true, digest: true } },
      ]),
    );
    await waitFor(() => expect(digest).toHaveAttribute('aria-checked', 'true'));
    expect(within(item('w1')).getByText('2 kinds')).toBeInTheDocument();

    fireEvent.click(fold);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('makes one press at a time: while a test is out it reads Sending…, and every other press waits', async () => {
    serve();
    let answer!: (value: { ok: boolean; detail: string }) => void;
    server.reads['POST /api/webhooks/test'] = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    mount();
    fireEvent.change(await screen.findByLabelText('Webhook URL'), {
      target: { value: 'https://hooks.example.com/x' },
    });
    const add = screen.getByRole('button', { name: 'Add webhook' });
    expect(add).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(add).toBeDisabled();
    await act(async () => answer({ ok: true, detail: 'accepted by https://hooks.slack.com (204)' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send a test' })).toBeEnabled());
    expect(add).toBeEnabled();
    expect(sent(server, 'POST', '/api/webhooks/test')).toEqual([{ id: 'w1' }]);
  });
});
