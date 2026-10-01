/**
 * What a tour leaves running, and the teardown that leaves nothing (#90).
 *
 * Every process the sandbox console starts names the sandbox's temp directory
 * on its command line — the console its root, a lane the stub `claude` under
 * `<dir>/bin` and its `--settings` under `<dir>/state`. A lane is spawned
 * detached, into a process group of its own, and by design (#21) outlives a
 * console that dies before its shutdown ladder runs; so a tour whose console
 * was SIGKILLed left stubs at PPID 1, in a directory `cleanup()` then deleted.
 * `reap` ends each such process's GROUP before the directory goes, and
 * `leftovers` is the check `npm run test:e2e` fails on.
 */
import { execFileSync } from 'node:child_process';

export type Leftover = { pid: number; pgid: number; command: string };

/** Every process whose command line names `dir`, other than this one. */
export function leftovers(dir: string): Leftover[] {
  let table: string;
  try {
    table = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const found: Leftover[] = [];
  for (const line of table.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!row) continue;
    const pid = Number(row[1]);
    if (pid === process.pid || !row[3].includes(dir)) continue;
    found.push({ pid, pgid: Number(row[2]), command: row[3] });
  }
  return found;
}

/** This process's own group — never signalled as a group, since the runner that started us is in it. */
function ownGroup(): number {
  try {
    return Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim(),
    );
  } catch {
    return -1;
  }
}

function signal(left: Leftover, sig: NodeJS.Signals, own: number): void {
  try {
    // A lane leads its own group: the group takes its bash and its children too.
    if (left.pgid > 1 && left.pgid !== own) process.kill(-left.pgid, sig);
    else process.kill(left.pid, sig);
  } catch {
    /* already gone */
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * End every process naming `dir`: SIGTERM to each one's group, up to
 * `graceMs` for them to leave, then SIGKILL. Resolves to what was still there
 * after that — nothing, unless something ignores even SIGKILL.
 */
export async function reap(dir: string, graceMs = 3_000): Promise<Leftover[]> {
  const first = leftovers(dir);
  if (!first.length) return [];
  const own = ownGroup();
  for (const left of first) signal(left, 'SIGTERM', own);
  for (let waited = 0; waited < graceMs && leftovers(dir).length; waited += 100) await pause(100);
  for (const left of leftovers(dir)) signal(left, 'SIGKILL', own);
  await pause(200);
  return leftovers(dir);
}
