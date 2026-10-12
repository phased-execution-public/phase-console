/**
 * The doors' own negative test (quiet-console §Architecture 4).
 *
 * `lint:client` holds the rules over the real tree, where nothing offends; a
 * guard that has never been shown an offender is a claim. So this runs the
 * repository's own ESLint config over VIRTUAL files — a path under
 * `client/src` and a few lines of source — and asserts each rule refuses what
 * it exists to refuse, everywhere in the client, and lets through exactly its
 * one door: one navigation door, one data door, one status renderer, one
 * stream, one table engine.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Through a helper, never `new URL('<literal>', import.meta.url)` inline: Vite
// rewrites that shape as an asset reference, and the path stops being a file.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const VIEWER = here('../../../');
const eslint = new ESLint({ cwd: VIEWER });

type Finding = { ruleId: string | null; message: string };

async function lint(code: string, file: string): Promise<Finding[]> {
  const [result] = await eslint.lintText(code, { filePath: join(VIEWER, file) });
  return (result?.messages ?? []).map((m) => ({ ruleId: m.ruleId, message: m.message }));
}

const addresses = (findings: Finding[]) =>
  findings.filter((f) => f.ruleId === 'no-restricted-syntax' && /navigation door/.test(f.message));
const dataDoor = (findings: Finding[]) =>
  findings.filter((f) => f.ruleId === 'no-restricted-imports' && /One data door/.test(f.message));
const renderer = (findings: Finding[]) =>
  findings.filter((f) => f.ruleId === 'no-restricted-imports' && /DotWord is its renderer/.test(f.message));
const engineLibrary = (findings: Finding[]) =>
  findings.filter((f) => f.ruleId === 'no-restricted-imports' && /imports the table engine/.test(f.message));
const engineDoor = (findings: Finding[]) =>
  findings.filter(
    (f) => f.ruleId === 'no-restricted-syntax' && /reached only through import\(\)/.test(f.message),
  );
const streams = (findings: Finding[]) =>
  findings.filter((f) => f.ruleId === 'no-restricted-syntax' && /One stream/.test(f.message));

/** One file in every top folder of the client, and the two entry files. */
const EVERYWHERE = [
  'client/src/ui/fixture.ts',
  'client/src/cards/fixture.ts',
  'client/src/shell/fixture.ts',
  'client/src/screens/runs/fixture.ts',
  'client/src/lib/fixture.ts',
  'client/src/App.tsx',
  'client/src/main.tsx',
];

describe('one navigation door', () => {
  const code = "export const a = (slug: string) => `#/plan/${slug}`;\nexport const b = '#/runs';\n";

  it('refuses a hand-written `#/` address anywhere but shell/routes.ts', async () => {
    for (const file of [...EVERYWHERE, 'client/src/data/fixture.ts']) {
      expect(addresses(await lint(code, file)), file).toHaveLength(2);
    }
    expect(addresses(await lint(code, 'client/src/shell/routes.ts'))).toEqual([]);
  });

  it('does not hold a hash that is not an address', async () => {
    expect(addresses(await lint("export const c = '#root';\n", 'client/src/screens/fixture.ts'))).toEqual([]);
  });
});

describe('one data door', () => {
  const code =
    "import { useQuery, useMutation } from '@tanstack/react-query';\nexport const y = [useQuery, useMutation];\n";

  it('refuses the query hooks outside data/', async () => {
    for (const file of EVERYWHERE) expect(dataDoor(await lint(code, file)), file).toHaveLength(2);
    expect(dataDoor(await lint(code, 'client/src/data/runs.ts'))).toEqual([]);
  });

  it('keeps the client itself — a provider, a key — reachable everywhere', async () => {
    const client =
      "import { QueryClientProvider } from '@tanstack/react-query';\nexport const y = QueryClientProvider;\n";
    expect(dataDoor(await lint(client, 'client/src/shell/fixture.tsx'))).toEqual([]);
  });
});

describe('one status renderer', () => {
  it('keeps DotWord inside its family', async () => {
    const code = "import { DotWord } from '@/ui/status/dot-word';\nexport const y = DotWord;\n";
    for (const file of EVERYWHERE) expect(renderer(await lint(code, file)), file).toHaveLength(1);
    expect(
      renderer(
        await lint(
          "import { DotWord } from './dot-word';\nexport const y = DotWord;\n",
          'client/src/ui/status/fixture.tsx',
        ),
      ),
    ).toEqual([]);
  });

  it('lets every page in through the typed members', async () => {
    expect(
      renderer(
        await lint(
          "import { RunStatus } from '@/ui/status';\nexport const y = RunStatus;\n",
          'client/src/screens/runs/fixture.tsx',
        ),
      ),
    ).toEqual([]);
  });
});

describe('one stream', () => {
  const open = "export const s = new EventSource('/events');\n";

  it('refuses a second EventSource anywhere under client/src', async () => {
    for (const file of [...EVERYWHERE, 'client/src/data/runs.ts']) {
      expect(streams(await lint(open, file)), file).toHaveLength(1);
    }
  });

  it('names exactly two doors: the console’s one stream and the Logs tail', async () => {
    expect(streams(await lint(open, 'client/src/data/live.ts'))).toEqual([]);
    expect(streams(await lint(open, 'client/src/screens/logs/tail.ts'))).toEqual([]);
    // A door is still the client: the address door holds there too.
    expect(
      addresses(await lint("export const a = '#/logs';\n", 'client/src/screens/logs/tail.ts')),
    ).toHaveLength(1);
    // Reading the global is no stream.
    expect(
      streams(
        await lint(
          "export const ok = typeof EventSource !== 'undefined';\n",
          'client/src/screens/fixture.ts',
        ),
      ),
    ).toEqual([]);
  });
});

describe('one table engine', () => {
  it('lets only ui/grid/engine.ts import TanStack Table', async () => {
    const code = "import { useTable } from '@tanstack/react-table';\nexport const y = useTable;\n";
    for (const file of [...EVERYWHERE, 'client/src/ui/grid/grid.tsx']) {
      expect(engineLibrary(await lint(code, file)), file).toHaveLength(1);
    }
    expect(engineLibrary(await lint(code, 'client/src/ui/grid/engine.ts'))).toEqual([]);
    // The engine is still the client: the data door holds there too.
    expect(
      dataDoor(
        await lint(
          "import { useQuery } from '@tanstack/react-query';\nexport const y = useQuery;\n",
          'client/src/ui/grid/engine.ts',
        ),
      ),
    ).toHaveLength(1);
  });

  it('reaches the engine through import() only — a type import is erased, a value import is refused', async () => {
    const value = "import { useRowModel } from './engine';\nexport const y = useRowModel;\n";
    expect(engineDoor(await lint(value, 'client/src/ui/grid/grid.tsx'))).toHaveLength(1);
    const byPath = "import { useRowModel } from '@/ui/grid/engine';\nexport const y = useRowModel;\n";
    expect(engineDoor(await lint(byPath, 'client/src/screens/runs/fixture.tsx'))).toHaveLength(1);
    const reexport = "export { useRowModel } from './engine';\n";
    expect(engineDoor(await lint(reexport, 'client/src/ui/grid/index.ts'))).toHaveLength(1);
    const clean = [
      "import type { RowModel } from './engine';",
      "export const load = () => import('./engine');",
      'export type M = RowModel<unknown>;',
    ].join('\n');
    expect(engineDoor(await lint(`${clean}\n`, 'client/src/ui/grid/grid.tsx'))).toEqual([]);
  });
});
