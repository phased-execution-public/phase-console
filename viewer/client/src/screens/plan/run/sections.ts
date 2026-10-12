/**
 * The Run view's folds (7.0, quiet-console phase 11; design.md principle 3).
 *
 * The view opens on a glance — the run's row, the halt card when it is
 * stopped, the one recommended move, the lanes with their clocks — and folds
 * everything else under a row that NAMES what opening it shows and, folded,
 * how much is in it. A fold a person opened stays open for them
 * (`prefs.runSectionsOpen`, the 6.2 key kept: browsers hold it), and the
 * page's Everything opens them all.
 *
 * The words live here, beside the ids, so the view, its datum ledger and the
 * e2e tour name a fold the same way.
 */

import { useCallback } from 'react';
import { usePrefs } from '@/lib/prefs';

/** Every fold, in page order — the ids the preference stores. */
export const RUN_FOLDS = [
  'phases',
  'sessions',
  'journal',
  'rungs',
  'verification',
  'triggers',
  'time',
  'ledger',
  'notes',
  'messages',
  'git',
  'landing',
  'ways',
  'raw',
] as const;

export type RunFoldId = (typeof RUN_FOLDS)[number];

/** What each fold shows, named — and what its count counts, for the row's title. */
export const RUN_FOLD_WORDS: Readonly<Record<RunFoldId, { name: string; counts: string }>> = Object.freeze({
  phases: { name: 'Phases', counts: 'Every phase of the plan, with this run’s record of each' },
  sessions: { name: 'Sessions and their consoles', counts: 'Sessions in flight or queued' },
  journal: { name: 'Journal', counts: 'The run’s latest journal lines, up to 500' },
  rungs: { name: 'What the ladder tried', counts: 'Rungs the ladder settled for this run' },
  verification: {
    name: 'Verification',
    counts: 'Runs of a §Verification line the console has on file for this plan, verdicts and baselines',
  },
  triggers: { name: 'Triggers', counts: 'Stored triggers of this plan, armed or ended' },
  time: { name: 'Where the time went', counts: 'Phases this run has a record of' },
  ledger: { name: 'Why it started and what it cost', counts: 'Sessions this run has ended' },
  notes: { name: 'Notes', counts: 'Notes people left on this run' },
  messages: { name: 'Messages', counts: 'Threads in the plan’s mailbox' },
  git: { name: 'Checkout', counts: 'Checkouts this run’s work stands in' },
  landing: { name: 'Landing', counts: 'Phases that carry a landing' },
  ways: { name: 'Ways forward', counts: 'Stopped phases, each with the action that moves it' },
  raw: { name: 'Raw record', counts: 'The record as the machine holds it' },
});

/** Is this fold open for this person, and the setter that remembers it. */
export function useRunFold(id: RunFoldId): [boolean, (next: boolean) => void] {
  const [prefs, setPrefs] = usePrefs();
  const open = prefs.runSectionsOpen.includes(id);
  const setOpen = useCallback(
    (next: boolean) => {
      const others = prefs.runSectionsOpen.filter((section) => section !== id);
      setPrefs({ runSectionsOpen: next ? [...others, id] : others });
    },
    [id, prefs.runSectionsOpen, setPrefs],
  );
  return [open, setOpen];
}
