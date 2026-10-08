/**
 * The human-step card: ONE card for a person's turn (control-tower phase 42).
 *
 * What is pinned, criterion by criterion:
 *   1. every kind renders with its own primary action — table-driven over
 *      `HUMAN_STEP_KINDS` — and `KIND_META` is the only place a kind's icon
 *      and label are read: the card draws them from it, and no other client
 *      source spells a kind's label out;
 *   2. *Open again* stands in every open state a person can act in (all but
 *      `upcoming`, which is not due yet), counts its opens, and never
 *      navigates away from the card;
 *   and the rules the card carries beside them: a device code is large,
 *   selectable and copyable; a secret leaves the page the moment it is sent;
 *   a check that did not land says what the proof read; a folded card leads
 *   with its row's own verb.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  humanSteps: vi.fn(),
  humanStepOpen: vi.fn(),
  humanStepCheck: vi.fn(),
  humanStepSnooze: vi.fn(),
  humanStepCannot: vi.fn(),
}));
vi.mock('@/lib/api/human-steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/human-steps')>();
  return { ...actual, humanStepsApi: { ...actual.humanStepsApi, ...api } };
});

import {
  HUMAN_STEP_KINDS,
  HUMAN_STEP_OPEN_STATES,
  HUMAN_STEP_STATES,
  KIND_META,
  humanStepView,
  type HumanStepKind,
} from '@shared/human-step-model.js';
import { HUMAN_STEP_CATEGORY, HALT_CATEGORIES } from '@shared/halt-categories.js';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import type { InboxItem } from '@/lib/api';
import {
  HumanStepCard,
  PRIMARY_ACT,
  WHERE_LABEL,
  kindIcon,
  primaryActOf,
  primaryLabel,
} from './human-step-card';

function stepItem(kind: HumanStepKind, over: Parameters<typeof humanStepView>[0] | object = {}): InboxItem {
  const act = PRIMARY_ACT[kind];
  const view = humanStepView({
    kind,
    title: `Do the ${kind} thing`,
    stepId: `s-${kind}`,
    check: true,
    ...(act === 'open' ? { openUrl: 'https://example.com/login' } : {}),
    ...(act === 'terminal' || act === 'machine' ? { openCommand: 'gh auth login' } : {}),
    ...(kind === 'device-code' ? { code: 'ABCD-1234' } : {}),
    ...over,
  });
  return {
    id: `human-step:alpha:3:s-${kind}`,
    kind: 'human-step',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    runId: 'r1',
    title: `Your turn — ${KIND_META[kind].label.toLowerCase()} for alpha phase 3`,
    need: view.title,
    how: '',
    since: '2026-09-30T09:00:00.000Z',
    actions: [],
    href: '/plan/alpha/phase/3',
    humanStep: view,
  };
}

function mount(item: InboxItem, props: Record<string, unknown> = {}) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <HumanStepCard item={item} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.humanSteps.mockResolvedValue({
    steps: [],
    reminders: { series: [], quiet: null },
    can: { openHost: false, terminal: true, resume: true },
  });
});

describe('every kind leads with its own action (criterion 1)', () => {
  it('the tables are total over the kinds', () => {
    expect(Object.keys(PRIMARY_ACT).sort()).toEqual([...HUMAN_STEP_KINDS].sort());
    expect(Object.keys(HUMAN_STEP_CATEGORY).sort()).toEqual([...HUMAN_STEP_KINDS].sort());
    for (const family of Object.values(HUMAN_STEP_CATEGORY))
      expect(HALT_CATEGORIES as readonly string[]).toContain(family);
  });

  it.each([...HUMAN_STEP_KINDS])('%s', (kind) => {
    const item = stepItem(kind);
    mount(item);
    const card = screen.getByTestId('human-step-card');
    const primary = within(card).getByTestId('step-primary');
    expect(primary.getAttribute('data-act')).toBe(PRIMARY_ACT[kind]);
    expect(primary.textContent).toBe(primaryLabel(PRIMARY_ACT[kind], kind));
    // The icon and the label are KIND_META's, drawn by name.
    const mark = within(card).getByTestId('step-kind');
    expect(mark.textContent).toBe(KIND_META[kind].label);
    expect(mark.getAttribute('data-icon')).toBe(KIND_META[kind].icon);
    expect(kindIcon(KIND_META[kind].icon)).toBeTruthy();
    expect(within(card).getByTestId('step-where').textContent).toBe(WHERE_LABEL[item.humanStep!.where]);
  });

  it('the five acts say what they do', () => {
    const labels = new Set(HUMAN_STEP_KINDS.map((kind) => primaryLabel(PRIMARY_ACT[kind], kind)));
    for (const label of [
      'Open sign-in',
      'Open in terminal',
      'Enter it at the machine',
      'Approve',
      "I've done this — check",
    ])
      expect(labels).toContain(label);
  });

  it('a step without what its act needs leads with the other opener, else the check', () => {
    expect(primaryActOf({ kind: 'browser-login', openCommand: 'gh auth login' })).toBe('terminal');
    expect(primaryActOf({ kind: 'browser-login' })).toBe('check');
    expect(primaryActOf({ kind: 'interactive-prompt', openUrl: 'https://x.test' })).toBe('open');
    expect(primaryActOf({ kind: 'one-time-code' })).toBe('check');
  });

  it('no client source but KIND_META spells a kind’s label out', () => {
    // Through a helper: Vite rewrites an inline `new URL('<literal>', import.meta.url)` as an asset.
    const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
    const SRC = here('../');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    const offences: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const kind of HUMAN_STEP_KINDS) {
        const label = KIND_META[kind].label;
        if (text.includes(`'${label}'`) || text.includes(`"${label}"`) || text.includes(`>${label}<`))
          offences.push(`${relative(SRC, file)}: ${label}`);
      }
    }
    expect(offences).toEqual([]);
  });
});

describe('Open again (criterion 2)', () => {
  it.each([...HUMAN_STEP_STATES])('in state %s', (state) => {
    mount(stepItem('browser-login', { state }));
    const again = screen.queryByTestId('step-open-again');
    // `upcoming` is open but not due (control-tower phase 121): the ledger
    // refuses an open until its due-when ref lands, so the card offers none.
    if ((HUMAN_STEP_OPEN_STATES as readonly string[]).includes(state) && state !== 'upcoming')
      expect(again).toBeTruthy();
    else expect(again).toBeNull();
  });

  it('counts every open, in a new tab, and the card stays where it is', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    let n = 0;
    api.humanStepOpen.mockImplementation(async () => ({
      ok: true,
      opened: { n: ++n, where: 'here', what: 'url', url: 'https://example.com/login' },
    }));
    const before = window.location.href;
    mount(stepItem('browser-login'));
    fireEvent.click(screen.getByTestId('step-open-again'));
    await waitFor(() => expect(screen.getByTestId('step-status').textContent).toContain('opened 1×'));
    fireEvent.click(screen.getByTestId('step-open-again'));
    await waitFor(() => expect(screen.getByTestId('step-status').textContent).toContain('opened 2×'));
    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenCalledWith('https://example.com/login', '_blank', 'noopener,noreferrer');
    expect(api.humanStepOpen).toHaveBeenCalledWith('s-browser-login', { where: 'here', what: 'url' });
    expect(window.location.href).toBe(before);
    expect(screen.getByTestId('human-step-card')).toBeTruthy();
    opened.mockRestore();
  });

  it('a command opens the terminal sheet, with the command prefilled in words', async () => {
    api.humanStepOpen.mockResolvedValue({
      ok: true,
      opened: {
        n: 1,
        where: 'terminal',
        what: 'command',
        command: 'gh auth login',
        terminal: { sessionId: 't-1', token: 'tok', expiresAt: Date.now() + 60_000 },
      },
    });
    mount(stepItem('interactive-prompt'));
    fireEvent.click(screen.getByTestId('step-primary'));
    expect(await screen.findByTestId('step-terminal')).toBeTruthy();
    expect(screen.getByTestId('step-terminal-command').textContent).toBe('gh auth login');
    expect(api.humanStepOpen).toHaveBeenCalledWith('s-interactive-prompt', {
      where: 'here',
      what: 'command',
    });
  });
});

describe('the rest of the card’s rules', () => {
  it('a device code is large, mono, selectable and copyable', () => {
    mount(stepItem('device-code'));
    const code = screen.getByTestId('step-code');
    expect(code.textContent).toBe('ABCD-1234');
    expect(code.className).toMatch(/select-all/);
    expect(code.className).toMatch(/font-mono/);
    expect(screen.getByRole('button', { name: /Copy code/ })).toBeTruthy();
  });

  it('a secret-entry card has no field for the value: it says where it goes, and the check sends nothing', async () => {
    api.humanStepCheck.mockResolvedValue({ ok: true, check: { landed: true, read: 'landed — held' } });
    mount(stepItem('secret-entry'));
    expect(screen.queryByTestId('step-secret')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByTestId('step-secret-where').textContent).toMatch(/never takes the value/);
    fireEvent.click(screen.getByTestId('step-primary'));
    await waitFor(() => expect(api.humanStepCheck).toHaveBeenCalledTimes(1));
    expect(api.humanStepCheck).toHaveBeenCalledWith('s-secret-entry');
  });

  it('a check that did not land says what the proof read', async () => {
    api.humanStepCheck.mockResolvedValue({
      ok: true,
      check: { landed: false, read: 'pending — gh: not signed in', ref: 'cmd:"gh auth status"' },
    });
    mount(stepItem('browser-login'));
    fireEvent.click(screen.getByTestId('step-check'));
    expect((await screen.findByTestId('step-read')).textContent).toContain('pending — gh: not signed in');
  });

  it('I can’t do this asks why, and sends the words', async () => {
    api.humanStepCannot.mockResolvedValue({ ok: true });
    mount(stepItem('physical'));
    fireEvent.click(screen.getByTestId('step-cannot'));
    fireEvent.change(screen.getByTestId('step-cannot-reason'), { target: { value: 'the cable is at home' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand it back' }));
    await waitFor(() =>
      expect(api.humanStepCannot).toHaveBeenCalledWith('s-physical', 'the cable is at home'),
    );
  });

  it('a folded card leads with its row’s own verb, performed as the server spelled it', () => {
    const perform = vi.fn();
    const approve = {
      verb: 'approve',
      label: 'Approve',
      endpoint: '/api/gates/alpha/3',
      method: 'POST' as const,
    };
    const item: InboxItem = {
      ...stepItem('decision'),
      id: 'gate:alpha:3',
      kind: 'gate',
      actions: [approve],
      humanStep: humanStepView({ kind: 'decision', title: 'Approve the gate', fold: 'gate' }),
    };
    mount(item, { perform });
    const primary = screen.getByTestId('step-primary');
    expect(primary.getAttribute('data-verb')).toBe('approve');
    fireEvent.click(primary);
    expect(perform).toHaveBeenCalledWith(item, approve);
    // A folded card has no ledger step: nothing to open again, snooze or check.
    expect(screen.queryByTestId('step-open-again')).toBeNull();
    expect(screen.queryByTestId('step-snooze')).toBeNull();
  });

  it('the row folds the card to a line and expands it in place', () => {
    mount(stepItem('device-code'), { variant: 'row' });
    const row = screen.getByTestId('human-step-row');
    expect(within(row).getByTestId('step-kind').textContent).toBe(KIND_META['device-code'].label);
    expect(within(row).getByTestId('step-primary').textContent).toBe('Open sign-in');
    expect(screen.queryByTestId('human-step-card')).toBeNull();
    fireEvent.click(within(row).getByTestId('step-expand'));
    expect(screen.getByTestId('human-step-card')).toBeTruthy();
  });
});
