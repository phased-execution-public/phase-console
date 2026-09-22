/**
 * The spike fixtures, held to a shape a later phase can read.
 *
 * A spike is a measurement, and a measurement nobody can date or attribute is a
 * rumour. Phases 7, 8, 10, 14 and 21 of `many-plans-one-repo` are each built on
 * a fact this repository measured once — whether a token-authenticated write
 * bypasses `crossSessionInbound: hold`, what `git merge-tree` prints when a
 * submodule has no merge base, whether the `openssl` first on the fleet unit's
 * PATH can mint a leaf node's `tls` will accept. Six months from now the only
 * thing standing between those phases and a guess is the header of the fixture
 * that recorded the answer: WHICH binary, at WHICH version, on WHICH day, with
 * WHICH argv, and what the verdict was.
 *
 * So this file pins the header rather than the prose. It asserts, for every
 * `.md` under `fixtures/spikes/`:
 *
 *   - a title, so the file says what it measured;
 *   - `date:`, so a reader knows how stale the answer is;
 *   - `verdict:`, a single lowercase token, so the answer is greppable;
 *   - at least one VERSION field (`cli:`, `git:`, `openssl:`, `node:`, `npm:`),
 *     so the verdict is attributed to a build and not to the universe.
 *
 * and, for the five fixtures this plan's phase 1 owns, that every arm it was
 * asked to measure is present as a row of an `arm`/`verdict` table — an arm
 * that was skipped cannot silently read as an arm that passed.
 *
 * WHAT THIS DOES NOT CHECK, so later phases know what stays hand-read: whether
 * a verdict is CORRECT (only that one was recorded and attributed), whether the
 * raw evidence supports it, or whether the argv in the prose is the argv that
 * was run. Those are a reader's job; this file only guarantees the reader has
 * the four facts they need to judge.
 */
// First, and before anything under `server/`: `config.ts` resolves STATE_DIR at
// module load, and it is reached transitively from most of that tree. Without
// this the suite reads the operator's real push subscriptions.
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPIKES = fileURLToPath(new URL('./fixtures/spikes/', import.meta.url));

/** Header fields that attribute a verdict to a build rather than to the universe. */
const VERSION_FIELDS = ['cli', 'git', 'openssl', 'node', 'npm'] as const;

/**
 * The arms `many-plans-one-repo` phase 1 was asked to measure, by fixture.
 *
 * Keyed by file so a fixture that exists but measured half of its arms fails
 * here rather than in phase 10, where the missing answer becomes a guess.
 */
const PHASE_1_ARMS: Record<string, string[]> = {
  'messaging-socket.md': ['S-A', 'S-B', 'S-C', 'S-D', 'S-E', 'S-F'],
  'config-dir-credentials.md': ['S-G'],
  'git-superproject-worktrees.md': ['G-1', 'G-2', 'G-3', 'G-4'],
  'react-flow-bundle.md': ['RF-1'],
  'openssl-mint.md': ['O-1', 'O-2', 'O-3'],
};

const mdFixtures = () => readdirSync(SPIKES).filter((f) => f.endsWith('.md')).sort();

/**
 * The `key: value` block between the title and the first prose, table or fence.
 *
 * Deliberately positional: a header that has drifted below the first paragraph
 * is not a header, because nobody skimming the file would read it as one.
 */
const header = (body: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const line of body.split('\n').slice(1)) {
    if (/^(#|\*\*|\||```|>|-\s)/.test(line)) break;
    const m = /^([a-z][a-z0-9_]*):[ \t]+(.+)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
};

/** Rows of the first table that has both an `arm` and a `verdict` column. */
const armVerdicts = (body: string): Record<string, string> => {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cells = (row: string) => row.split('|').slice(1, -1).map((c) => c.trim());
    if (!lines[i].trim().startsWith('|')) continue;
    const head = cells(lines[i]).map((c) => c.toLowerCase());
    const armAt = head.indexOf('arm');
    const verdictAt = head.indexOf('verdict');
    if (armAt < 0 || verdictAt < 0) continue;
    const rows: Record<string, string> = {};
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const c = cells(lines[j]);
      // `` `S-A` `` and `S-A` are the same arm; the backticks are typography.
      const arm = (c[armAt] ?? '').replace(/`/g, '').trim();
      if (arm) rows[arm] = (c[verdictAt] ?? '').replace(/`/g, '').trim();
    }
    return rows;
  }
  return {};
};

test('phase 1 leaves at least eight spike fixtures on disk', () => {
  assert.ok(
    mdFixtures().length >= 8,
    `expected >= 8 .md fixtures under fixtures/spikes/, found ${mdFixtures().length}`,
  );
});

test('every spike fixture is titled, dated, attributed to a build, and carries a verdict', () => {
  for (const file of mdFixtures()) {
    const body = readFileSync(join(SPIKES, file), 'utf8');
    const where = `fixtures/spikes/${file}`;

    assert.match(body.split('\n')[0] ?? '', /^# \S/, `${where}: first line must be a '# ' title`);

    const fields = header(body);

    assert.match(
      fields.date ?? '',
      /^\d{4}-\d{2}-\d{2}$/,
      `${where}: needs a 'date: YYYY-MM-DD' header, got ${JSON.stringify(fields.date)}`,
    );

    // One lowercase token, so `grep -l 'verdict'` and a reader agree on the answer.
    assert.match(
      fields.verdict ?? '',
      /^[a-z][a-z0-9-]*(\s|$)/,
      `${where}: needs a 'verdict: <word>' header, got ${JSON.stringify(fields.verdict)}`,
    );

    const versions = VERSION_FIELDS.filter((k) => (fields[k] ?? '').length > 0);
    assert.ok(
      versions.length > 0,
      `${where}: needs at least one version header (${VERSION_FIELDS.join(', ')}) — ` +
        `a verdict with no build behind it cannot be re-checked`,
    );
  }
});

test('every arm phase 1 was asked to measure has a row and a verdict of its own', () => {
  for (const [file, arms] of Object.entries(PHASE_1_ARMS)) {
    const where = `fixtures/spikes/${file}`;
    const body = readFileSync(join(SPIKES, file), 'utf8');
    const rows = armVerdicts(body);

    assert.ok(
      Object.keys(rows).length > 0,
      `${where}: needs a table with an 'arm' column and a 'verdict' column`,
    );

    for (const arm of arms) {
      assert.ok(arm in rows, `${where}: arm ${arm} was measured by nobody — no row for it`);
      assert.match(
        rows[arm],
        /^[a-z][a-z0-9-]*$/,
        `${where}: arm ${arm} needs a one-word verdict, got ${JSON.stringify(rows[arm])}`,
      );
    }
  }
});

test('every raw-evidence sidecar is line-delimited JSON that parses', () => {
  for (const file of readdirSync(SPIKES).filter((f) => f.endsWith('.jsonl')).sort()) {
    const body = readFileSync(join(SPIKES, file), 'utf8');
    const lines = body.split('\n').filter((l) => l.trim().length > 0);
    assert.ok(lines.length > 0, `fixtures/spikes/${file}: is empty`);
    lines.forEach((line, i) => {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `fixtures/spikes/${file}:${i + 1}: not JSON — ${line.slice(0, 120)}`,
      );
    });
  }
});
