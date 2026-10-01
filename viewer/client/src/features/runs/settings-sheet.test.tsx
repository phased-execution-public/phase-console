/**
 * The run's settings sheet (control-tower phase 13, #31).
 *
 * It was shut in the one state it was most needed — a lane still working over
 * a run whose status said otherwise — it printed "applies from the next phase"
 * over a form where that was untrue of half the fields, it could tune a QA
 * reviewer it could not switch on, and it omitted the account in silence. Now:
 * it opens under `stillWorking` as a patch, it asks before a patch turns the
 * QA gate on (the patch writes `test-status.md`), it reports a field the
 * server refused BY NAME beside the rest being applied, and it links to where
 * the account is moved.
 */

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_LANE_LOCKED_FIELDS,
  QA_CONFIRM,
  SETTING_EFFECT_LABELS,
  SETTING_EFFECT_WORDS,
  SETTING_VERBS,
} from '@shared/run-settings.js';
import { queryClientConfig } from '@/lib/queries';
import { ApiError } from '@/lib/api/client';
import type { PhaseView, RunState } from '@/lib/api';
import { TooltipProvider } from '@/components/ui';

const { state, skills, runSettings, runPrelude, toastMock } = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runSettings: vi.fn(),
  runPrelude: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, skills, runSettings, runPrelude } };
});

vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return { ...actual, toast: toastMock };
});

import { SettingsSheet } from './settings-sheet';

const HALTED = {
  id: 'run-1',
  slug: 'alpha',
  status: 'halted',
  model: 'sonnet',
  effort: 'high',
  autonomy: 'keep-going',
  phases: {},
} as unknown as RunState;

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({ prefs: {}, defaultSkills: [], allowAccounts: true });
  skills.mockResolvedValue([]);
});

function client() {
  return new QueryClient(queryClientConfig);
}

describe('the sheet opens while a lane is still working', () => {
  it('as a settings PATCH, saying what a live lane holds and linking to where the account is moved', async () => {
    render(
      <QueryClientProvider client={client()}>
        <TooltipProvider>
          <SettingsSheet
            slug="alpha"
            run={HALTED}
            live={false}
            stillWorking
            allowRun
            allowWrites
            qaMode="off"
            planPhases={[] as PhaseView[]}
            planSkills={[]}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    // The trigger is open, not "Something is still running" and greyed.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getAllByText('Run settings').length).toBeGreaterThan(0);
    expect(within(sheet).getByText(/refused by\s+name, and everything else is applied/)).toBeTruthy();
    // Who pays is named, never omitted in silence — with the verb and the way there.
    expect(within(sheet).getByText(SETTING_VERBS.accountId)).toBeTruthy();
    const link = within(sheet).getByRole('link', { name: /Settings ▸ Accounts/ });
    expect(link.getAttribute('href')).toBe('#/settings/accounts');
    // A patch, not a Continue: the submit applies, it does not launch.
    expect(within(sheet).queryByRole('button', { name: /Continue/ })).toBeNull();
  });
});

async function mountLive(qaMode: string) {
  runPrelude.mockResolvedValue({ prelude: null });
  const { RunSetup } = await import('@/features/run-setup/run-setup');
  const Setup = RunSetup as unknown as (props: Record<string, unknown>) => ReactElement;
  return render(
    <QueryClientProvider client={client()}>
      <Setup mode="live" context={{ slug: 'alpha', run: HALTED }} qaMode={qaMode} allowWrites />
    </QueryClientProvider>,
  );
}

describe('the QA gate on a live run', () => {
  it("raises its creates-test-status confirmation BEFORE posting, then posts with the server's word", async () => {
    runSettings.mockResolvedValue({ run: HALTED });
    await mountLive('off');
    fireEvent.click(await screen.findByRole('checkbox', { name: /The QA gate for this plan/ }));
    fireEvent.click(screen.getByRole('button', { name: /Apply changes/ }));

    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByText(/creates test-status\.md/)).toBeTruthy();
    expect(runSettings).not.toHaveBeenCalled();

    fireEvent.click(within(ask).getByRole('button', { name: 'Turn QA on' }));
    await waitFor(() => expect(runSettings).toHaveBeenCalledTimes(1));
    const patch = runSettings.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.qa).toBe(true);
    expect(patch.confirm).toBe(QA_CONFIRM);
  });

  it("turns it off with no confirmation — off writes the plan's line, and nothing is created", async () => {
    runSettings.mockResolvedValue({ run: HALTED });
    await mountLive('on (plan directive)');
    const gate = await screen.findByRole('checkbox', { name: /The QA gate for this plan/ });
    expect(gate).toBeChecked();
    fireEvent.click(gate);
    fireEvent.click(screen.getByRole('button', { name: /Apply changes/ }));
    await waitFor(() => expect(runSettings).toHaveBeenCalledTimes(1));
    expect((runSettings.mock.calls[0]![1] as Record<string, unknown>).qa).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('a field the server refused', () => {
  it('is named, beside the rest being applied — a partial success, not an error', async () => {
    runSettings.mockRejectedValue(
      new ApiError('gitMode was not applied', 409, '/api/run/alpha/settings', {
        error: 'gitMode was not applied',
        refused: [{ field: 'gitMode', why: 'phase 2 has a live session committing in the run’s checkout' }],
      }),
    );
    await mountLive('off');
    fireEvent.click(await screen.findByRole('button', { name: /Apply changes/ }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.stringMatching(/^gitMode was not applied — phase 2/),
        'warn',
      ),
    );
    expect(toastMock).toHaveBeenCalledWith('Applied everything else in the patch.', 'ok');
  });
});

describe('each field says when a change lands (control-tower phase 24, #31)', () => {
  const RUNNING = { ...HALTED, status: 'running' } as unknown as RunState;

  async function openSheet(run: RunState, props: { live: boolean; stillWorking?: boolean }) {
    render(
      <QueryClientProvider client={client()}>
        <TooltipProvider>
          <SettingsSheet
            slug="alpha"
            run={run}
            live={props.live}
            stillWorking={props.stillWorking ?? false}
            allowRun
            allowWrites
            qaMode="off"
            planPhases={[] as PhaseView[]}
            planSkills={[]}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    return screen.findByRole('dialog');
  }

  /**
   * Every effect note on the sheet: the one screen's tiles expand in place
   * (phase 22), so each tile is opened in turn and what it shows is read.
   */
  function effectNotes(dialog: HTMLElement): { word: string; text: string; refused: boolean }[] {
    const read: { word: string; text: string; refused: boolean }[] = [];
    const opened = new Set<string>();
    for (;;) {
      const next = within(dialog)
        .queryAllByRole('button', { name: /^(Edit|Answer) / })
        .find((button) => !opened.has(button.getAttribute('aria-label') ?? ''));
      if (!next) break;
      opened.add(next.getAttribute('aria-label') ?? '');
      fireEvent.click(next);
      for (const note of dialog.querySelectorAll('[data-effect]')) {
        read.push({
          word: note.getAttribute('data-effect') ?? '',
          text: note.textContent ?? '',
          refused: note.hasAttribute('data-refused'),
        });
      }
    }
    return read;
  }

  it('marks every field with its SETTING_EFFECTS word, in SETTING_EFFECT_LABELS’ words', async () => {
    const dialog = await openSheet(RUNNING, { live: true });
    const notes = effectNotes(dialog);
    expect(notes.length).toBeGreaterThan(15);
    const seen = new Set<string>();
    for (const note of notes) {
      const word = note.word as (typeof SETTING_EFFECT_WORDS)[number];
      expect(SETTING_EFFECT_WORDS).toContain(word);
      expect(note.text).toBe(SETTING_EFFECT_LABELS[word]);
      seen.add(word);
    }
    // Half the form lands at once and half with the next phase — one sentence
    // over the whole sheet was untrue of one half or the other.
    for (const word of ['now', 'next-phase', 'next-finish']) expect(seen).toContain(word);
    // A run with no lane in flight refuses nothing.
    expect(notes.filter((note) => note.refused)).toEqual([]);
  });

  it('names the fields a working lane holds as refused, beside their controls, before the press', async () => {
    const dialog = await openSheet(HALTED, { live: false, stillWorking: true });
    const notes = effectNotes(dialog);
    const refused = notes.filter((note) => note.refused);
    expect(refused.length).toBeGreaterThan(0);
    expect(new Set(refused.map((note) => note.word)).size).toBeLessThanOrEqual(
      LIVE_LANE_LOCKED_FIELDS.length,
    );
    for (const note of refused) expect(note.text).toMatch(/^Refused while a lane is working/);
    // Everything else still says when it lands.
    expect(notes.filter((note) => !note.refused).length).toBeGreaterThan(15);
    expect(runSettings).not.toHaveBeenCalled();
  });

  it('marks nothing on a launch — nothing is running for a change to land on', async () => {
    const dialog = await openSheet({ ...HALTED, status: 'finished' } as unknown as RunState, { live: false });
    expect(effectNotes(dialog)).toEqual([]);
  });
});
