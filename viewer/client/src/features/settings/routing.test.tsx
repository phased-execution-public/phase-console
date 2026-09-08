/**
 * The routing matrix — the console-wide switches, and where each kind lands.
 *
 * Six of these properties came from the card this replaced and are unchanged,
 * because they are the ones the old per-device card could not hold: it renders
 * and works with **no push device subscribed** (the console that had nowhere to
 * store a preference at all), it shows what the *server* holds rather than a
 * local copy, it falls back to a catalogue default, it sends a delta rather
 * than the whole map (so two tabs cannot overwrite each other), and it says
 * something when the operator silences a kind that work stops dead behind.
 *
 * The rest are new and are the point of the redesign: the routing line has to
 * be READ off the three registers rather than guessed, and it has to answer
 * with what `announce()` would do rather than with what is registered.
 *
 * **The registers are complete by construction.** `sanitiseCategories()` fills
 * every key from `defaultCategories()` on subscribe, on update *and on load*,
 * for both the device register and the webhook one, so an absent key is not a
 * shape the server can serve. If one ever were absent the honest reading is
 * that kind's CATALOGUE default — which is `false` for the three kinds that
 * ship off — and never "on", because both send gates are fail-closed on the
 * same record. So the fixtures below are whole registers, as the server serves
 * them, and the absent key is tested for the default resolution it would get
 * rather than pinned to a shape that cannot occur.
 *
 * The three ways the line can lie about a webhook, all tested here: a console
 * without `--allow-webhooks` (which is the shipping default) POSTs nothing at
 * all, a row inside its failure backoff is skipped and its announcement
 * dropped, and a console with no browser subscribed has no device row at all —
 * a different fact from "subscribed and narrowed out".
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, push, savePrefs, webhooks, currentEndpoint } = vi.hoisted(() => ({
  state: vi.fn(),
  push: vi.fn(),
  savePrefs: vi.fn(),
  webhooks: vi.fn(),
  currentEndpoint: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, push, savePrefs, webhooks } };
});

// The endpoint is the only thing that says which push row is this browser, and
// it comes from the service worker — which jsdom does not have.
vi.mock('@/lib/push', () => ({ currentEndpoint }));

/** The two load-bearing kinds, plus the firehose. */
const CATEGORIES = [
  {
    id: 'approval',
    label: 'Permission needed',
    detail: 'blocked on a decision',
    byDefault: true,
    urgent: true,
  },
  { id: 'halted', label: 'Run halted', detail: 'stopped on something', byDefault: true, urgent: true },
  { id: 'changed', label: 'Plans changed on disk', detail: 'a firehose', byDefault: false, urgent: false },
];

/**
 * A register as the server serves one — `sanitiseCategories()`'s own output.
 *
 * Every key present, defaults filled in, the named ones overridden. Writing a
 * fixture by hand as `{}` or `{ approval: false }` is writing a shape the
 * server cannot produce, and a test that pins the client to it pins it to a
 * rule the server does not implement.
 */
const register = (overrides: Record<string, boolean> = {}): Record<string, boolean> =>
  Object.fromEntries(CATEGORIES.map((c) => [c.id, overrides[c.id] ?? c.byDefault]));

function mount(notify: Record<string, boolean> = {}) {
  state.mockResolvedValue({ prefs: { notify } });
  const client = new QueryClient(queryClientConfig);
  return import('./routing').then(({ RoutingCard }) =>
    render(
      <QueryClientProvider client={client}>
        <RoutingCard />
      </QueryClientProvider>,
    ),
  );
}

/** The routing sentence under one kind. */
const lineFor = (label: string) =>
  screen.getByRole('checkbox', { name: label }).parentElement!.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  // The case the card exists for: nothing subscribed, nowhere for a per-device
  // preference to live.
  push.mockResolvedValue({ publicKey: '', devices: [], categories: CATEGORIES });
  savePrefs.mockResolvedValue({});
  webhooks.mockResolvedValue({ allowWebhooks: false, hooks: [], categories: CATEGORIES });
  currentEndpoint.mockResolvedValue(null);
});

describe('the console-wide switches', () => {
  it('renders every kind with no device subscribed', async () => {
    await mount({ approval: true, halted: true, changed: false });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(screen.getByRole('checkbox', { name: 'Run halted' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Plans changed on disk' })).toBeTruthy();
  });

  it('shows what the server holds, not a local copy', async () => {
    await mount({ approval: true, halted: true, changed: false });
    const firehose = await screen.findByRole('checkbox', { name: 'Plans changed on disk' });
    // `aria-checked`, not `.checked`: the box is the ui Checkbox, which is a
    // Radix `<button role="checkbox">` — `.checked` on one is `undefined`, and
    // `undefined === false` would have made this pass either way.
    expect(firehose).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('checkbox', { name: 'Run halted' })).toHaveAttribute('aria-checked', 'true');
  });

  it('falls back to a kind default the stored config has never seen', async () => {
    // `halted` absent from the map entirely — an older config, a new kind.
    await mount({ approval: true });
    const halted = await screen.findByRole('checkbox', { name: 'Run halted' });
    expect(halted).toHaveAttribute('aria-checked', 'true');
    // …and the firehose stays off by its own default rather than reading as on.
    expect(screen.getByRole('checkbox', { name: 'Plans changed on disk' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('sends only the kind that changed, so two tabs cannot overwrite each other', async () => {
    await mount({ approval: true, halted: true, changed: false });
    const firehose = await screen.findByRole('checkbox', { name: 'Plans changed on disk' });
    fireEvent.click(firehose);
    // `mutate()` hands the call to react-query rather than making it inline.
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ notify: { changed: true } }));
  });

  it('warns when a kind that stops work dead is silenced', async () => {
    await mount({ approval: false, halted: true, changed: false });
    expect(await screen.findByText(/Permission needed is off/)).toBeTruthy();
  });

  it('says nothing alarming when only the firehose is off, and counts the silence', async () => {
    await mount({ approval: true, halted: true, changed: false });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(screen.queryByText(/is off\./)).toBeNull();
    expect(screen.getByText(/3 kinds · 1 silenced/)).toBeTruthy();
  });

  it('counts a silence the config never wrote — an off-by-default kind is silenced too', async () => {
    // The header used to read the stored map alone, which called an untouched
    // console "all on" while `changed` and `ready` were off by catalogue.
    await mount({});
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(screen.getByText(/3 kinds · 1 silenced/)).toBeTruthy();
  });
});

describe('where each kind lands', () => {
  it('says nothing about destinations for a kind that is silenced', async () => {
    // Listing where it *would* have gone is the sentence that makes an
    // operator think it still goes there.
    await mount({ approval: false });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(lineFor('Permission needed')).toMatch(/Silenced/);
    expect(lineFor('Permission needed')).not.toMatch(/Goes to/);
  });

  it('tells "no browser here is subscribed" apart from "subscribed and narrowed out"', async () => {
    await mount({ approval: true });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    // No device at all — a different fact, and a different verb.
    expect(lineFor('Permission needed')).toMatch(/no device here/);
  });

  it('reads an untouched device as reachable, not as off', async () => {
    // A device that has never been edited is stored with every key at its
    // catalogue default — `sanitiseCategories` fills them on subscribe — so a
    // kind that ships on reaches it. Reading the register as "narrowed" would
    // paint every kind unreachable on a brand-new subscription.
    push.mockResolvedValue({
      publicKey: '',
      devices: [{ id: 'd1', label: 'phone', service: 'https://push.example', categories: register() }],
      categories: CATEGORIES,
    });
    currentEndpoint.mockResolvedValue('https://push.example/abc');
    await mount({ approval: true });
    await waitFor(() => expect(lineFor('Permission needed')).toMatch(/this device/));
    expect(lineFor('Permission needed')).not.toMatch(/not this device/);
  });

  it('says so when this device has narrowed a kind out', async () => {
    push.mockResolvedValue({
      publicKey: '',
      devices: [
        {
          id: 'd1',
          label: 'phone',
          service: 'https://push.example',
          categories: register({ approval: false }),
        },
      ],
      categories: CATEGORIES,
    });
    currentEndpoint.mockResolvedValue('https://push.example/abc');
    await mount({ approval: true });
    await waitFor(() => expect(lineFor('Permission needed')).toMatch(/not this device/));
  });

  it('resolves a key no register holds to that kind’s catalogue default, on both legs', async () => {
    // The shape the server cannot serve, tested for what the server WOULD do
    // with it rather than assumed reachable. `changed` ships off, so an absent
    // key means off — reading absence as "not narrowed" is the inverted rule,
    // and it invents a destination for the one kind most likely to be a
    // firehose.
    push.mockResolvedValue({
      publicKey: '',
      devices: [{ id: 'd1', label: 'phone', service: 'https://push.example', categories: {} }],
      categories: CATEGORIES,
    });
    currentEndpoint.mockResolvedValue('https://push.example/abc');
    webhooks.mockResolvedValue({
      allowWebhooks: true,
      hooks: [{ id: 'h1', categories: {} }],
      categories: CATEGORIES,
    });
    // Switched on console-wide, so the row renders its destinations at all.
    await mount({ changed: true, approval: true });
    await waitFor(() => expect(lineFor('Permission needed')).toMatch(/this device/));
    // `approval` ships on: absent resolves to on, on both legs.
    expect(lineFor('Permission needed')).toMatch(/this device · 1 channel/);
    // `changed` ships off: absent resolves to off, on both legs.
    expect(lineFor('Plans changed on disk')).toMatch(/not this device/);
    expect(lineFor('Plans changed on disk')).toMatch(/0 of 1 channels/);
  });

  it('counts only the destinations that take this kind, and says "all" when they all do', async () => {
    webhooks.mockResolvedValue({
      allowWebhooks: true,
      hooks: [
        { id: 'h1', categories: register() },
        { id: 'h2', categories: register({ approval: false }) },
      ],
      categories: CATEGORIES,
    });
    await mount({ approval: true, halted: true });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    // h1 takes everything its defaults allow, h2 has struck `approval`.
    expect(lineFor('Permission needed')).toMatch(/1 of 2 channels/);
    // Nothing narrows `halted`, so the count is not worth spelling.
    expect(lineFor('Run halted')).toMatch(/2 channels/);
    expect(lineFor('Run halted')).not.toMatch(/of 2/);
  });

  it('says there are no channels rather than "0 of 0"', async () => {
    await mount({ approval: true });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(lineFor('Permission needed')).toMatch(/no channels/);
  });

  it('never reports a bare count when this console may not POST at all', async () => {
    // `--allow-webhooks` is off by default and registered rows survive a
    // restart without it: `announce()` returns before the first `fetch`, so
    // every row on disk is registered AND unreachable. A count here is the
    // card's own failure mode — a confident answer that is wrong.
    webhooks.mockResolvedValue({
      allowWebhooks: false,
      hooks: [
        { id: 'h1', categories: register() },
        { id: 'h2', categories: register() },
      ],
      categories: CATEGORIES,
    });
    await mount({ approval: true });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(lineFor('Permission needed')).toMatch(/2 channels, none reachable/);
    // …and the reason is said once, on the card, not sixteen times in the list.
    expect(screen.getByText(/started without/).textContent).toMatch(/--allow-webhooks/);
  });

  it('does not count a destination that is backing off after a failure', async () => {
    // `announce()` filters `!(quietUntil && quietUntil > now)` and the
    // announcement it skips is dropped, never retried — so a row in backoff is
    // a destination this kind does not reach right now.
    webhooks.mockResolvedValue({
      allowWebhooks: true,
      hooks: [
        { id: 'h1', categories: register() },
        { id: 'h2', categories: register(), quietUntil: Date.now() + 3_600_000 },
      ],
      categories: CATEGORIES,
    });
    await mount({ approval: true });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(lineFor('Permission needed')).toMatch(/1 of 2 channels/);
    expect(lineFor('Permission needed')).toMatch(/1 channel takes it but is backing off/);
  });

  it('counts a destination whose backoff has already expired', async () => {
    // The boundary in the other direction: a `quietUntil` in the past is a
    // row that has served its penalty, and dropping it would understate.
    webhooks.mockResolvedValue({
      allowWebhooks: true,
      hooks: [{ id: 'h1', categories: register(), quietUntil: Date.now() - 1_000 }],
      categories: CATEGORIES,
    });
    await mount({ approval: true });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(lineFor('Permission needed')).toMatch(/1 channel\./);
    expect(lineFor('Permission needed')).not.toMatch(/backing off/);
  });

  it('toggles the kind when its name is clicked, not only its 16px box', async () => {
    // The row IS the label, as it was in the card this replaced. A checkbox
    // whose only hit area is the drawn box is the one target size that fails
    // on the device most likely to be reading a settings page.
    await mount({ approval: true });
    const name = await screen.findByText('Permission needed');
    expect(name.closest('label')).not.toBeNull();
    fireEvent.click(name);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ notify: { approval: false } }));
  });

  it('marks the urgent kinds and the ones that ship off', async () => {
    await mount({});
    const row = (await screen.findByRole('checkbox', { name: 'Permission needed' })).parentElement!;
    expect(within(row).getByText('urgent')).toBeTruthy();
    const firehose = screen.getByRole('checkbox', { name: 'Plans changed on disk' }).parentElement!;
    expect(within(firehose).getByText('off by default')).toBeTruthy();
  });
});
