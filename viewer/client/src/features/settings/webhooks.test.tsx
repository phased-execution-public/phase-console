/**
 * The Webhooks card: what it refuses to show, and what it refuses to do.
 *
 * The two assertions that matter are both about absence — the URL is never on
 * screen, and with the flag off the verbs cannot be pressed — so they are made
 * against the rendered document rather than against a prop, which is the only
 * place "never shown" is actually true or false.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { WebhookRow, WebhooksState } from '@/lib/api';

const { listMock, addMock, removeMock, testMock, categoriesMock } = vi.hoisted(() => ({
  listMock: vi.fn<() => Promise<WebhooksState>>(),
  addMock: vi.fn(),
  removeMock: vi.fn(),
  testMock: vi.fn(),
  categoriesMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      webhooks: listMock,
      webhookAdd: addMock,
      webhookRemove: removeMock,
      webhookTest: testMock,
      webhookCategories: categoriesMock,
    },
  };
});

import { WebhooksCard } from './webhooks';

const SECRET_PATH = '/services/T0000/B0000/xxxxxxxxxxxxxxxxxxxxxxxx';

function row(patch: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id: 'w1',
    label: '#builds',
    origin: 'https://hooks.slack.com',
    tail: '…xxxxxx',
    categories: { halted: true, phase: false },
    createdAt: '2026-08-25T00:00:00.000Z',
    lastOkAt: null,
    failures: 0,
    ...patch,
  };
}

function state(patch: Partial<WebhooksState> = {}): WebhooksState {
  return {
    allowWebhooks: true,
    hooks: [row()],
    categories: [
      { id: 'halted', label: 'Run halted', detail: 'A run stopped.', byDefault: true, urgent: true },
      {
        id: 'phase',
        label: 'Phase finished or failed',
        detail: 'Each phase.',
        byDefault: true,
        urgent: false,
      },
    ] as WebhooksState['categories'],
    ...patch,
  };
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WebhooksCard />
    </QueryClientProvider>,
  );
}

describe('the Webhooks card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(state());
  });

  it('never renders a URL, only its origin and a masked tail', async () => {
    show();
    await screen.findByText('#builds');
    expect(document.body.textContent).not.toContain(SECRET_PATH);
    expect(document.body.textContent).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxx');
    expect(document.body.textContent).toContain('https://hooks.slack.com');
    // And there is no field pre-filled with one to copy out of.
    const url = screen.getByLabelText('Webhook URL') as HTMLInputElement;
    expect(url.value).toBe('');
  });

  it('with the flag off it still lists destinations, and every verb is disabled', async () => {
    listMock.mockResolvedValue(state({ allowWebhooks: false }));
    show();
    await screen.findByText('#builds');
    expect(screen.getByText(/Outbound webhooks are off/)).toBeTruthy();
    // The row is still there — hiding it is how an operator stops knowing a URL
    // is on file.
    expect(screen.getByRole('button', { name: 'Test' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveProperty('disabled', true);
    // No way to add one either: the whole form is absent, not merely disabled.
    expect(screen.queryByLabelText('Webhook URL')).toBeNull();
  });

  it('adds a destination and clears the field only on success', async () => {
    addMock.mockResolvedValue({ hook: row() });
    show();
    const url = await screen.findByLabelText('Webhook URL');
    fireEvent.change(url, { target: { value: 'https://hooks.example.com/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));
    await waitFor(() => expect(addMock).toHaveBeenCalled());
    expect(addMock.mock.calls[0][0]).toMatchObject({ url: 'https://hooks.example.com/x' });
    await waitFor(() => expect((url as HTMLInputElement).value).toBe(''));
  });

  it('a refusal is shown and the pasted URL is kept so it can be corrected', async () => {
    addMock.mockResolvedValue({ error: 'URL must be https' });
    show();
    const url = await screen.findByLabelText('Webhook URL');
    fireEvent.change(url, { target: { value: 'http://hooks.example.com/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));
    await waitFor(() => expect(addMock).toHaveBeenCalled());
    expect((url as HTMLInputElement).value).toBe('http://hooks.example.com/x');
  });

  it('shows a failing destination as backing off rather than as lost', async () => {
    listMock.mockResolvedValue(
      state({
        hooks: [
          row({
            failures: 3,
            lastFailure: { at: '2026-08-25T01:00:00.000Z', status: 500, reason: null },
            quietUntil: Date.now() + 60_000,
          }),
        ],
      }),
    );
    show();
    await screen.findByText('#builds');
    expect(screen.getByText(/3 failures in a row/)).toBeTruthy();
    expect(document.body.textContent).toContain('Backing off');
  });

  it('the category list is per destination and opens on demand', async () => {
    show();
    await screen.findByText('#builds');
    expect(screen.queryByText('Run halted')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Categories' }));
    const halted = await screen.findByRole('checkbox', { name: /Run halted/ });
    // `aria-checked`, not `.checked`: the box is the ui Checkbox now — a Radix
    // `<button role="checkbox">`, which has no `checked` property at all.
    expect(halted).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(halted);
    await waitFor(() => expect(categoriesMock).toHaveBeenCalled());
    expect(categoriesMock.mock.calls[0][1]).toMatchObject({ halted: false, phase: false });
  });

  it('renders nothing at all against a server that has no such endpoint', async () => {
    listMock.mockRejectedValue(new Error('404'));
    const { container } = show();
    // Counting ELEMENTS, not text. The loading skeleton is an empty div, so a
    // `textContent === ''` assertion passes before the query has even failed —
    // it was green with the `isError` guard deleted, which is a test that
    // proves nothing. Nothing rendered means no child node at all.
    await waitFor(() => expect(container.children.length).toBe(0));
    expect(screen.queryByText('Webhooks')).toBeNull();
  });
});
