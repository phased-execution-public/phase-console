import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

// The fixture's stub `claude` ends the way a real one does when its console
// goes: on stdin's end, not only on a signal. A lane is spawned detached, so
// after an unclean console death its closed stdin is the only thing that still
// reaches it — the stubs that ignored it lived on at PPID 1 (#90).
const STUB = fileURLToPath(new URL('./fixture/stub-claude.mjs', import.meta.url));

test('the stub lane exits when its stdin ends', async () => {
  const child = spawn(process.execPath, [STUB, '-p', '--output-format', 'stream-json'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const first = await new Promise<string>((resolve) =>
    child.stdout.once('data', (chunk: Buffer) => resolve(String(chunk))),
  );
  expect(first).toContain('"subtype":"init"');
  child.stdin.end();
  const code = await Promise.race([
    exited,
    new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 5_000)),
  ]);
  if (code === 'alive') child.kill('SIGKILL');
  expect(code).toBe(0);
});
