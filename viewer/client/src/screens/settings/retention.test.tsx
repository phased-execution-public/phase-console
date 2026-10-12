/**
 * Settings ▸ This instance ▸ Logs and retention (quiet-console phase 23): what
 * this console keeps and for how long, every member of the policy a key a page
 * writes.
 *
 * What it holds. Every `retention.*` row of the settings schema reaches ONE
 * control here, the first group open and each other fold saying how many keys
 * it holds. Each key saves through the one settings door as exactly its own
 * member of the map, `{retention: {<member>: <value>}}`, a size typed in MB and
 * sent in bytes, an age or a count as typed. Each is held on the page to the
 * floor the server holds it to (`server/retention-policy.ts` `retentionPatch`):
 * above zero, except the runs kept per plan, where zero keeps none past its
 * age; and a trim's tail below the size that triggers it. A value past either
 * is refused in a sentence and nothing is sent. Above the keys sits the
 * report: what the next sweep would act on, each sink that holds files, in the
 * policy words the SCHEMA's numbers make, so a save moves them. A report that
 * could not be read is said in a sentence, never left as a skeleton.
 *
 * The keys are the server's, walked from the schema rather than listed here:
 * a member added to the table is a member this test demands a control for.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetentionReport } from '@/data/api';
import type { PrefSchemaRow } from '@/data/console';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { ApiError } from '@/data/http';
import { keys } from '@/data/keys';
import { RetentionGroup, bytesWords } from './retention';

const MB = 1024 * 1024;

/** Every `retention.*` row of the schema the server serves: the keys, walked, never listed. */
const ROWS = schemaAnswer().rows.filter((row) => row.key.startsWith('retention.'));
const KEYS = ROWS.map((row) => row.key);
const memberOf = (key: string) => key.slice('retention.'.length);

/** The server's floor (`retentionPatch`): above zero, except runs kept per plan, where zero is a real answer. */
/**
 * Each key's floor on the page: zero for the runs kept per plan, the size above
 * the kept tail for the trim (the tail is 2 MB below, so 3), else one.
 */
const floorOf = (key: string): number =>
  memberOf(key) === 'runRetainMin'
    ? 0
    : memberOf(key) === 'supervisorLogMaxBytes'
      ? Math.floor(TABLE.supervisorLogKeepBytes! / MB) + 1
      : 1;
/** A size is typed in MB and stored in bytes; an age or a count is stored as typed. */
const scaleOf = (row: PrefSchemaRow) => (row.unit === 'bytes' ? MB : 1);
/** The word after a field, by the schema's unit: a count needs none. */
const UNIT_WORD: Record<string, string | null> = { bytes: 'MB', days: 'days', hours: 'hours', count: null };

/** A stored number per unit (the shipped table's shape), then the figures the words below name. */
const BY_UNIT: Record<string, number> = { bytes: 16 * MB, days: 30, hours: 24, count: 20 };
const TABLE: Record<string, number> = {
  ...Object.fromEntries(ROWS.map((row) => [memberOf(row.key), BY_UNIT[row.unit ?? '']!])),
  // A trim's tail under the size that triggers it, as the loader keeps it.
  supervisorLogMaxBytes: 32 * MB,
  supervisorLogKeepBytes: 2 * MB,
  runsMaxBytes: 2048 * MB,
  gitTraceDirMaxBytes: 64 * MB,
};

/**
 * The report as the server sends it. Its own `policy` disagrees with the
 * schema on purpose: the page's words are the schema's numbers, which a save
 * moves, never the report's copy, which it does not.
 */
const REPORT: RetentionReport = {
  at: '2026-10-11T12:00:00.000Z',
  policy: { runRetainDays: 99, runRetainMin: 99, runsMaxBytes: 1, gitTraceLeftoverHours: 99 },
  sinks: [
    { sink: 'run-records', files: 42, bytes: 12 * MB, due: 3 },
    { sink: 'rulings', files: 2, bytes: 4096, due: 0 },
    { sink: 'git-trace', files: 5, bytes: 3 * MB, due: 0 },
    { sink: 'fleet-log', files: 0, bytes: 0, due: 0 },
    { sink: 'next-sink', files: 1, bytes: 512, due: 0 },
  ],
  bytes: 15 * MB + 4096 + 512,
  actions: ['run-a', 'run-b', 'run-c'].map((run) => ({
    kind: 'delete' as const,
    sink: 'run-records',
    path: `/home/x/.local/state/phase-console/runs/alpha/${run}.json`,
    bytes: 4096,
    why: 'older than 30 days',
  })),
};

/**
 * A console holding `table`. Its schema answers each member's value, the shipped
 * one beside it and where it came from; a write merges the members it names and
 * takes a dotted key back to its shipped number, as the settings door does, so
 * a save moves the page the way the server's answer would. `still` serves one
 * unmoving schema instead, for a walk whose every save must meet the same page.
 */
function serve({
  table = TABLE,
  report = REPORT,
  still = false,
}: { table?: Record<string, number>; report?: unknown; still?: boolean } = {}) {
  const held = { ...table };
  const setHere = new Set<string>();
  const answer = () =>
    schemaAnswer(
      Object.fromEntries(
        ROWS.map((row) => {
          const member = memberOf(row.key);
          const source: PrefSchemaRow['source'] = setHere.has(member) ? 'instance' : 'default';
          return [row.key, { value: held[member], default: table[member], source }];
        }),
      ),
    );
  const fixed = answer();
  server.reads['/api/prefs/schema'] = still ? fixed : answer;
  server.reads['POST /api/prefs'] = (body: unknown) => {
    const patch = (body ?? {}) as Record<string, unknown> & { retention?: Record<string, number> };
    for (const [member, value] of Object.entries(patch.retention ?? {})) {
      held[member] = value;
      setHere.add(member);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== null || !key.startsWith('retention.')) continue;
      held[memberOf(key)] = table[memberOf(key)]!;
      setHere.delete(memberOf(key));
    }
    return {};
  };
  server.reads['/api/debug/retention'] = report;
}

/** The group, once the schema has answered. */
async function mount() {
  const view = renderWithClient(<RetentionGroup />);
  await waitFor(() => expect(view.client.getQueryState(keys.prefsSchema())?.status).toBe('success'));
  return view;
}

/** The group with the report answered and the settings schema refused — the report's words drawn. */
async function mountWithoutSchema() {
  serve();
  server.reads['/api/prefs/schema'] = new ApiError('Request failed (500)', 500, '/api/prefs/schema');
  const view = renderWithClient(<RetentionGroup />);
  await waitFor(() => expect(view.client.getQueryState(keys.prefsSchema())?.status).toBe('error'));
  await screen.findByRole('list', { name: 'What this console keeps' });
  return view;
}

const group = () => document.querySelector<HTMLElement>('[data-settings-group="retention"]')!;
function rowOf(key: string): HTMLElement {
  const found = document.querySelectorAll<HTMLElement>(`[data-pref="${key}"]`);
  expect(found, `${key} has exactly one control`).toHaveLength(1);
  return found[0]!;
}
const fieldOf = (key: string) => within(rowOf(key)).getByRole('spinbutton') as HTMLInputElement;
function enter(key: string, typed: string) {
  fireEvent.change(fieldOf(key), { target: { value: typed } });
  fireEvent.blur(fieldOf(key));
}
const saves = () => sent(server, 'POST', '/api/prefs');
/** Every fold of the group, opened: a folded group's keys are not mounted at all. */
function unfold() {
  for (const toggle of group().querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')) {
    fireEvent.click(toggle);
  }
}
const sink = (id: string) => document.querySelector<HTMLElement>(`[data-sink="${id}"]`);

beforeEach(() => {
  server.calls = [];
  server.reads = {};
});

describe('every key the schema serves', () => {
  it('reaches exactly one control: the first group open, each fold saying how many keys it holds', async () => {
    serve();
    await mount();
    expect(screen.getByRole('heading', { name: 'Logs and retention' })).toBeInTheDocument();
    const toggles = [...group().querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')];
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) {
      const said = Number(/\((\d+)\)/.exec(toggle.textContent ?? '')?.[1]);
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const id = toggle.dataset.testid!.replace(/^retention-/, '');
      const drawn = group().querySelectorAll(`[data-retention-keys="${id}"] [data-pref]`);
      expect(drawn.length, `the ${id} fold said ${said}`).toBe(said);
    }
    const drawn = [...group().querySelectorAll('[data-pref]')].map((el) => el.getAttribute('data-pref'));
    expect([...drawn].sort()).toEqual([...KEYS].sort());
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it('reads each stored number in its unit, with the schema’s own sentence under it', async () => {
    serve();
    await mount();
    unfold();
    for (const row of ROWS) {
      expect(Object.keys(UNIT_WORD), `${row.key} is in a unit the page knows`).toContain(row.unit);
      expect(fieldOf(row.key).value, row.key).toBe(String(TABLE[memberOf(row.key)]! / scaleOf(row)));
      expect(rowOf(row.key)).toHaveTextContent(row.description);
      const word = UNIT_WORD[row.unit!];
      if (word) expect(within(rowOf(row.key)).getByText(word)).toBeInTheDocument();
    }
    // Spot checks in a person's words: a size in MB, an age in days, a count bare.
    expect(screen.getByLabelText('Every plan’s runs together, at most')).toHaveValue(2048);
    expect(screen.getByLabelText('Keep a finished run for')).toHaveValue(30);
    expect(rowOf('retention.runRetainMin').textContent).not.toMatch(/MB|days|hours/);
  });

  it('saves each one at its floor as exactly its own member of the map, a size sent in bytes', async () => {
    serve({ still: true });
    await mount();
    unfold();
    const expected: unknown[] = [];
    for (const row of ROWS) {
      const floor = floorOf(row.key);
      enter(row.key, String(floor));
      expected.push({ retention: { [memberOf(row.key)]: floor * scaleOf(row) } });
      await waitFor(() => expect(saves(), `${row.key} at ${floor}`).toHaveLength(expected.length));
      expect(saves().at(-1)).toEqual(expected.at(-1));
    }
    // Zero is a real answer for the runs kept per plan, and only there.
    expect(expected).toContainEqual({ retention: { runRetainMin: 0 } });
    expect(saves()).toEqual(expected);
  });

  it('refuses a value under each one’s floor, or a fraction, on the page in a sentence, and sends nothing', async () => {
    serve({ still: true });
    await mount();
    unfold();
    for (const key of KEYS) {
      const floor = floorOf(key);
      enter(key, String(floor - 1));
      expect(within(rowOf(key)).getByText(`Type ${floor} or more.`), key).toBeInTheDocument();
      expect(fieldOf(key)).toHaveAttribute('aria-invalid', 'true');
    }
    enter('retention.runsMaxBytes', '1.5');
    expect(within(rowOf('retention.runsMaxBytes')).getByText('Type a whole number.')).toBeInTheDocument();
    enter('retention.runRetainDays', '');
    expect(within(rowOf('retention.runRetainDays')).getByText('Type a number.')).toBeInTheDocument();
    // Escape puts the held value back and takes the sentence away.
    fireEvent.keyDown(fieldOf('retention.runRetainDays'), { key: 'Escape' });
    expect(fieldOf('retention.runRetainDays')).toHaveValue(30);
    expect(within(rowOf('retention.runRetainDays')).queryByText('Type a number.')).toBeNull();
    // Nothing reached the wire, not even the values the server would also refuse.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saves()).toEqual([]);
  });

  it('holds a trim’s tail below the size that triggers it, and follows the trim as it moves', async () => {
    serve();
    await mount();
    unfold();
    const keep = 'retention.supervisorLogKeepBytes';
    const trim = 'retention.supervisorLogMaxBytes';
    // The trim is 32 MB: the tail may be 31 MB at most.
    expect(fieldOf(keep)).toHaveAttribute('max', '31');
    enter(keep, '32');
    expect(within(rowOf(keep)).getByText('Type 31 or less.')).toBeInTheDocument();
    expect(saves()).toEqual([]);

    // Nor may the trim drop to the tail it keeps (2 MB): it stays above it.
    expect(fieldOf(trim)).toHaveAttribute('min', '3');
    enter(trim, '2');
    expect(within(rowOf(trim)).getByText('Type 3 or more.')).toBeInTheDocument();
    expect(saves()).toEqual([]);

    // The trim moves to 4 MB, and the most the tail may keep moves with it.
    enter(trim, '4');
    await waitFor(() => expect(saves()).toEqual([{ retention: { supervisorLogMaxBytes: 4 * MB } }]));
    await waitFor(() => expect(fieldOf(keep)).toHaveAttribute('max', '3'));
    enter(keep, '4');
    expect(within(rowOf(keep)).getByText('Type 3 or less.')).toBeInTheDocument();
    enter(keep, '3');
    await waitFor(() =>
      expect(saves()).toEqual([
        { retention: { supervisorLogMaxBytes: 4 * MB } },
        { retention: { supervisorLogKeepBytes: 3 * MB } },
      ]),
    );
    expect(within(rowOf(keep)).queryByText(/or less\./)).toBeNull();
  });

  it('says a key set here once a save lands, and Reset takes it back to its shipped number', async () => {
    serve();
    await mount();
    expect(within(rowOf('retention.runRetainDays')).queryByText('Set here')).toBeNull();
    enter('retention.runRetainDays', '7');
    await waitFor(() =>
      expect(within(rowOf('retention.runRetainDays')).getByText('Set here')).toBeInTheDocument(),
    );
    expect(fieldOf('retention.runRetainDays')).toHaveValue(7);

    fireEvent.click(
      within(rowOf('retention.runRetainDays')).getByRole('button', {
        name: 'Reset retention.runRetainDays to its default',
      }),
    );
    await waitFor(() =>
      expect(saves()).toEqual([{ retention: { runRetainDays: 7 } }, { 'retention.runRetainDays': null }]),
    );
    await waitFor(() => expect(fieldOf('retention.runRetainDays')).toHaveValue(30));
    expect(within(rowOf('retention.runRetainDays')).queryByText('Set here')).toBeNull();
  });
});

describe('the report', () => {
  it('says what the next sweep would act on, each sink with files in the schema’s words, and moves with a save', async () => {
    serve();
    await mount();
    await screen.findByRole('list', { name: 'What this console keeps' });
    expect(screen.getByRole('status')).toHaveTextContent(
      '15 MB across 4 sinks. The next sweep would act on 3 files.',
    );
    // A sink with no files is a policy row about nothing: not drawn.
    expect(sink('fleet-log')).toBeNull();
    expect(screen.getAllByRole('listitem').map((item) => item.dataset.sink)).toEqual([
      'run-records',
      'rulings',
      'git-trace',
      'next-sink',
    ]);

    const runs = sink('run-records')!;
    expect(within(runs).getByText('Runs, journals and their sidecars')).toBeInTheDocument();
    expect(runs).toHaveTextContent('12 MB · 42 files · 3 due');
    // The schema's numbers, never the report's own copy of the policy.
    expect(runs).toHaveTextContent('30 days, at least 20 per plan, 2.0 GB in total');
    expect(sink('rulings')).toHaveTextContent('4.0 KB · 2 files');
    expect(sink('rulings')!.textContent).not.toMatch(/due/);
    expect(sink('rulings')).toHaveTextContent('never pruned — reported past 16 MB');
    expect(sink('git-trace')).toHaveTextContent('leftovers past 24 h, 64 MB in total');
    // A sink the page has no words for is named by its id, with nothing invented about it.
    expect(sink('next-sink')!.textContent).toBe('next-sink512 B · 1 file');

    enter('retention.runRetainDays', '7');
    await waitFor(() => expect(runs).toHaveTextContent('7 days, at least 20 per plan, 2.0 GB in total'));
    expect(saves()).toEqual([{ retention: { runRetainDays: 7 } }]);
  });

  it('says one sink and one file in the singular, and plainly when nothing is due', async () => {
    serve({
      report: {
        ...REPORT,
        sinks: [{ sink: 'rulings', files: 1, bytes: 2048, due: 0 }],
        bytes: 2048,
        actions: [],
      },
    });
    const first = await mount();
    await screen.findByRole('list', { name: 'What this console keeps' });
    expect(screen.getByRole('status')).toHaveTextContent(
      '2.0 KB across 1 sink. Nothing is due for the next sweep.',
    );
    expect(sink('rulings')).toHaveTextContent('2.0 KB · 1 file');
    first.unmount();

    serve({ report: { ...REPORT, actions: REPORT.actions.slice(0, 1) } });
    await mount();
    await screen.findByRole('list', { name: 'What this console keeps' });
    expect(screen.getByRole('status')).toHaveTextContent('The next sweep would act on 1 file.');
  });

  it('is busy while it reads, and says it could not read — no skeleton left — while the keys still save', async () => {
    serve({ report: () => new Promise(() => {}) });
    const first = await mount();
    const busy = group().querySelector('[aria-busy="true"]');
    expect(busy).toHaveAttribute('aria-label', 'Reading what this console keeps');
    first.unmount();

    serve({ report: new ApiError('Request failed (500)', 500, '/api/debug/retention') });
    await mount();
    expect(await screen.findByTestId('retention-report')).toHaveTextContent(
      'The console did not say what it keeps: Request failed (500). The keys below still save.',
    );
    expect(group().querySelector('[aria-busy]')).toBeNull();
    expect(screen.queryByRole('list', { name: 'What this console keeps' })).toBeNull();
    enter('retention.runRetainMin', '5');
    await waitFor(() => expect(saves()).toEqual([{ retention: { runRetainMin: 5 } }]));
  });

  it('leaves no skeleton behind when the settings themselves cannot be read, and the keys still save', async () => {
    await mountWithoutSchema();
    expect(group().querySelector('[aria-busy]')).toBeNull();
    expect(fieldOf('retention.runRetainDays')).toBeEnabled();
    enter('retention.runRetainDays', '7');
    await waitFor(() => expect(saves()).toEqual([{ retention: { runRetainDays: 7 } }]));
  });

  // The policy words are the schema's numbers alone, so a failed schema read
  // once worded every rule from the fallbacks — "0 days, at least 0 per plan,
  // 0 B in total" for a console that keeps 30 — and said nothing else.
  it('says the settings could not be read, and never words a policy of zeros', async () => {
    await mountWithoutSchema();
    expect(sink('run-records')).not.toHaveTextContent('0 days, at least 0 per plan, 0 B in total');
    expect(sink('run-records')).not.toHaveTextContent(/days|per plan|in total/);
    expect(screen.getByTestId('retention-unread')).toHaveTextContent(
      'The settings could not be read: Request failed (500), so how long each is kept is not said here. The keys below still save.',
    );
  });

  it('says a size as a person reads it, three figures at most', () => {
    expect(bytesWords(512)).toBe('512 B');
    expect(bytesWords(4096)).toBe('4.0 KB');
    expect(bytesWords(12 * MB)).toBe('12 MB');
    expect(bytesWords(2048 * MB)).toBe('2.0 GB');
    expect(bytesWords(1536 * 1024 * MB)).toBe('1.5 TB');
  });
});
