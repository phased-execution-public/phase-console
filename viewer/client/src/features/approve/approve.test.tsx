/**
 * `#/approve` — the phone surface, and the dictation on it.
 *
 * Two promises this page makes that Now does not:
 *
 *  - **everything on it can be pressed.** An item whose only remedies are
 *    gated, or that has no remedy at all, is counted at the foot and never
 *    drawn as a row of dead buttons — a phone screen of things you cannot do
 *    is what teaches people to stop opening the link;
 *  - **the operator's words reach the field the SERVER named.** A gate's
 *    evidence goes in `note`, a permission card's reason in `reason`, and this
 *    page knows neither — it reads `action.says.field`.
 *
 * The mic is feature-detected at mount, so both branches are testable by
 * installing (or not installing) the global before rendering.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { InboxItem, InboxView } from '@/lib/api';
import ApprovePage, { actionable, pressable } from './index';

const { inbox, inboxAct, toast } = vi.hoisted(() => ({
  inbox: vi.fn(),
  inboxAct: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return { ...actual, toast };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, inbox, inboxAct } };
});

const gate = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    id: 'gate:demo:4:',
    kind: 'gate',
    severity: 'needs-you',
    slug: 'demo',
    phase: 4,
    title: 'demo phase 4 — gate needs a person',
    need: 'The gate on phase 4 is not clear (manual).',
    how: 'Do what the gate asks, then approve it.',
    since: new Date(Date.now() - 5 * 60_000).toISOString(),
    href: '#/plan/demo/phase/4',
    actions: [
      {
        verb: 'approve',
        label: 'Approve the gate',
        endpoint: '/api/plans/demo/gate/4',
        method: 'POST',
        body: { approve: true, continueRun: true },
        says: { field: 'note', label: 'Evidence (optional)', placeholder: 'what you checked' },
      },
    ],
    ...over,
  }) as InboxItem;

function mount(items: InboxItem[]) {
  inbox.mockResolvedValue({ items, generatedAt: new Date().toISOString() } as InboxView);
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/approve" onNavigate={vi.fn()}>
        <ApprovePage />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  inboxAct.mockResolvedValue({ ok: true });
  delete (globalThis as Record<string, unknown>).SpeechRecognition;
  delete (globalThis as Record<string, unknown>).webkitSpeechRecognition;
});

/* ------------------------------------------------------------------ *
 * what belongs on a phone
 * ------------------------------------------------------------------ */

describe('the list is only what this console can answer', () => {
  it('keeps an item with a pressable remedy', () => {
    expect(actionable([gate()]).map((i) => i.id)).toEqual(['gate:demo:4:']);
  });

  it('drops one whose every remedy is gated by a capability this console lacks', () => {
    // `flag` is present ONLY when the capability is off, so its presence is
    // the whole test — the card would render a button that cannot be pressed.
    const walled = gate({
      actions: [{ ...gate().actions[0], flag: 'writes' }],
    });
    expect(pressable(walled)).toEqual([]);
    expect(actionable([walled])).toEqual([]);
  });

  it('drops one with no remedy at all', () => {
    // `session-ask` is the real case: a Claude session stopped at its own
    // terminal prompt, which the console genuinely cannot answer for.
    expect(actionable([gate({ kind: 'session-ask', actions: [] })])).toEqual([]);
  });

  it('drops the merely informative and the already-seen', () => {
    expect(actionable([gate({ severity: 'fyi' })])).toEqual([]);
    expect(actionable([gate({ ack: { at: new Date().toISOString() } })])).toEqual([]);
  });

  it('says how many it is NOT showing rather than hiding them silently', async () => {
    mount([
      gate(),
      gate({ id: 'gate:other:1:', slug: 'other', actions: [{ ...gate().actions[0], flag: 'writes' }] }),
    ]);
    expect(await screen.findByText(/1 more need a person/)).toBeTruthy();
  });

  it('has an empty state that distinguishes "nothing" from "nothing you can do here"', async () => {
    mount([gate({ actions: [{ ...gate().actions[0], flag: 'writes' }] })]);
    expect(await screen.findByText(/none can be answered from here/)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * answering
 * ------------------------------------------------------------------ */

describe('answering', () => {
  it("presses the server's own action, verbatim", async () => {
    mount([gate()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve the gate' }));
    await waitFor(() => expect(inboxAct).toHaveBeenCalled());
    const [action, says] = inboxAct.mock.calls[0];
    expect(action.endpoint).toBe('/api/plans/demo/gate/4');
    expect(action.method).toBe('POST');
    expect(says).toBe('');
  });

  it("sends the operator's words in the key the ACTION named", async () => {
    mount([gate()]);
    const field = await screen.findByLabelText('Evidence (optional)');
    fireEvent.change(field, { target: { value: 'ran the migration on a copy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve the gate' }));
    await waitFor(() => expect(inboxAct).toHaveBeenCalled());
    expect(inboxAct.mock.calls[0][1]).toBe('ran the migration on a copy');
  });

  it('offers no box on an action that takes no words', async () => {
    mount([gate({ actions: [{ ...gate().actions[0], says: undefined }] })]);
    await screen.findByRole('button', { name: 'Approve the gate' });
    expect(screen.queryByLabelText(/Evidence/)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * dictation
 * ------------------------------------------------------------------ */

describe('the mic', () => {
  it('is absent on a browser with no SpeechRecognition', async () => {
    // Firefox. A button that does nothing teaches the operator the feature is
    // broken rather than absent — so there is no button.
    mount([gate()]);
    await screen.findByLabelText('Evidence (optional)');
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
  });

  it('fills the field with what was heard, and never submits it', async () => {
    const started: FakeRecognition[] = [];
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 0;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        started.push(this);
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    (globalThis as Record<string, unknown>).SpeechRecognition = FakeRecognition;

    mount([gate()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }));
    await waitFor(() => expect(started.length).toBe(1));

    started[0].onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'checked the backup' }], { isFinal: true })],
    });

    await waitFor(() =>
      expect((screen.getByLabelText('Evidence (optional)') as HTMLInputElement).value).toBe(
        'checked the backup',
      ),
    );
    // The whole rule: a microphone may fill a box, it may never press a button.
    expect(inboxAct).not.toHaveBeenCalled();
  });
});
