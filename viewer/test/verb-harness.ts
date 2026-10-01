/**
 * One harness for the control-tower phase 98 suites (the verb table, triggers,
 * the boundary re-board, the long poll, the bounded runs list): a scratch plan
 * library, a `Service` over it, and a request through the REAL `handleApi` —
 * as a browser sends it, or as `phase-console run` does.
 *
 * Import it AFTER `./state-sandbox.ts`, like everything that reaches `server/`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** Three phases, none depending on another — any of them may board next. */
export const PLAN = `---
slug: alpha
created: 2026-09-27
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | — | — | app | it still works |
| 3 | checkout | — | — | app | it all works |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

/** A plan library with `alpha` (and any other plans named) in it. */
export function scratch(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-verbs-'));
  trash.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  for (const [slug, text] of Object.entries(extra)) {
    mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), text, 'utf8');
  }
  return root;
}

export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pc-${label}-`));
  trash.push(dir);
  return dir;
}

/** A Service over `root`, writes and runs allowed, announcing nothing. */
export async function service(root: string) {
  const { SKILL_DIR } = await import('../server/config.ts');
  const { Service } = await import('../server/service.ts');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

export type Captured = { status: number; body: any; bytes: number };

/** The User-Agents the two clients send — a browser, and `phase-console run`. */
export const BROWSER_UA = 'Mozilla/5.0';
export const CLI_UA = 'phase-console/6.0.0 run';

/** One request through the real `handleApi`. */
export async function call(
  svc: unknown, method: 'GET' | 'POST', path: string, body?: unknown, opts: { ua?: string } = {},
): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {}, bytes: 0 };
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    url: path,
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': opts.ua ?? BROWSER_UA },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { if (payload) yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      out.bytes = Buffer.byteLength(text);
      try { out.body = JSON.parse(text); } catch { out.body = { text }; }
    },
    setHeader() { return this; },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

/** A run's journal, parsed. */
export function journalOf(file: string): { event: string; phase?: number; data?: Record<string, any> }[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
