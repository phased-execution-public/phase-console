/**
 * The owner's moves (control-tower phase 133, #210) — one harness for
 * `turn-moves`, `turn-road-back` and `turn-evidence`: a real Service over a
 * scratch root, a run whose phase is parked on a freshly raised item (the
 * shape every park door leaves), the real router, and a press that records
 * the resumes it was asked for instead of spawning anything.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Service } = await import('../server/service.ts');
const { SKILL_DIR, INSTANCE_STATE_DIR } = await import('../server/config.ts');
const { journalFile, loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { HUMAN_STEPS_FILE, parkOnStep } = await import('../server/human-steps.ts');
const { handleApi } = await import('../server/api/routes.ts');
type RunState = import('../server/runner/state.ts').RunState;
type HumanStep = import('../server/human-steps.ts').HumanStep;

export { INSTANCE_STATE_DIR, loadRun, saveRun };
export type { HumanStep, RunState };

export const SLUG = 'alpha';

export type Resume = { slug: string; phase: number; mode: string; instruction?: string };

export type Harness = {
  svc: InstanceType<typeof Service>;
  root: string;
  /** Every resume a press asked for — the own session's (`recoverPhase`) or a fresh board's (`startRun`). */
  resumed: Resume[];
  pushes: unknown[];
  cleanup: () => void;
};

/** A plan the engine can read — `### Phase N` sections, so `decisions.sh --phase N` knows the phase. */
function writePlan(root: string): void {
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${SLUG}.md`), [
    '# Alpha', '', '## Phase graph', '', '| Phase | Depends on | Repos |', '|---|---|---|',
    '| 1 | — | root |', '| 3 | — | root |', '| 4 | — | root |', '| 5 | — | root |', '',
    '### Phase 1 — one', '- **Verification:** `true`', '',
    '### Phase 3 — three', '- **Verification:** `true`', '',
    '### Phase 4 — four', '- **Verification:** `true`', '',
    '### Phase 5 — five', '- **Verification:** `true`', '',
  ].join('\n'));
}

export function harness(over: Record<string, unknown> = {}): Harness {
  // Each test starts from an empty ledger: the sandbox's state directory is one
  // per FILE, and an item an earlier test left open would take a later one's
  // declaration as another waiter (G7 — one item per kind and link).
  rmSync(join(INSTANCE_STATE_DIR, HUMAN_STEPS_FILE), { force: true });
  // …and from an empty grant ledger (control-tower phase 149), for the same reason.
  rmSync(join(INSTANCE_STATE_DIR, 'grants.ndjson'), { force: true });
  // …and from an empty handled log (control-tower phase 136).
  rmSync(join(INSTANCE_STATE_DIR, 'handled.ndjson'), { force: true });
  rmSync(join(INSTANCE_STATE_DIR, 'handled-sessions.ndjson'), { force: true });
  const root = mkdtempSync(join(tmpdir(), 'pc-turn-moves-'));
  writePlan(root);
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null, remoteHosts: [], remoteUsers: [], ...over,
  } as never);
  const pushes: unknown[] = [];
  svc.push.announce = ((...args: unknown[]) => { pushes.push(args); return null; }) as never;
  assert.equal(svc.open(root).ok, true);
  const resumed: Resume[] = [];
  const bag = svc as unknown as Record<string, unknown>;
  bag.recoverPhase = async (slug: string, phase: number, mode: string, opts?: { instruction?: string }) => {
    resumed.push({ slug, phase, mode, ...(opts?.instruction ? { instruction: opts.instruction } : {}) });
    return null;
  };
  bag.startRun = async (slug: string, options: { reboard?: { phase: number; instruction?: string }[] }) => {
    resumed.push({ slug, phase: options.reboard?.[0]?.phase ?? 0, mode: 'fresh', instruction: options.reboard?.[0]?.instruction });
    return null;
  };
  bag.continueAfterPress = () => {};
  bag.retryPhase = async () => null;
  return {
    svc, root, resumed, pushes,
    cleanup: () => { svc.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

/** A run whose phase is parked on a freshly raised item — its own session ended, worth resuming. */
export function parked(
  h: Harness, step: Record<string, unknown>, phase = 3, opts: { runId?: string; state?: RunState } = {},
): { state: RunState; step: HumanStep } {
  const state = opts.state ?? newRun({ slug: SLUG, root: h.root, onlyPhases: [phase] } as never);
  const record = phaseRecord(state, phase);
  const at = new Date().toISOString();
  record.status = 'parked';
  record.sessionId = `sess-${phase}`;
  record.endedAt = at;
  record.declared = { status: 'needs-human', reason: 'a person must decide', needs: 'human-acts', at } as never;
  const declared = h.svc.recordHumanStep({
    slug: SLUG, phase, birth: 'session', step, runId: state.id, sessionId: `sess-${phase}`,
  });
  assert.ok(declared && !('refused' in declared), `the step is recorded: ${JSON.stringify(declared)}`);
  parkOnStep(record, declared as HumanStep, 'session', at);
  state.status = 'parked' as never;
  saveRun(state);
  return { state, step: declared as HumanStep };
}

export type Captured = { status: number; body: Record<string, unknown> };

/** One request through the real router. */
export async function call(
  svc: unknown, method: string, path: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {},
): Promise<Captured> {
  const out: Captured = { status: 0, body: {} };
  const req = {
    method,
    url: path,
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    setHeader() {},
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1:4130${path}`));
  return out;
}

/** The run's journal lines. */
export function journal(root: string, state: RunState): { event: string; data: Record<string, unknown> }[] {
  return readFileSync(journalFile(root, SLUG, state.id), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
}

/** The ledger file's raw text. */
export const ledgerText = (): string => readFileSync(join(INSTANCE_STATE_DIR, HUMAN_STEPS_FILE), 'utf8');

/** A decision item with two options, one recommended. */
export const DECISION = {
  kind: 'decision', title: 'Which database does the cache use?', proof_type: 'answer',
  options: [
    { id: 'o1', label: 'Use Postgres', consequence: 'one more table on the box' },
    { id: 'o2', label: 'Use Redis', consequence: 'a new service to run' },
  ],
  recommended: 'o1',
};

/* ------------------------------------------------------------------ *
 * The check (control-tower phase 134, #211) — a scripted checking session
 * ------------------------------------------------------------------ */

type SpawnRequest = import('../server/runner/spawn.ts').SpawnRequest;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;

/** What a checking session writes when it answers: prose, then the ONE fenced verdict block. */
export const verdictText = (verdict: Record<string, unknown>, prose = 'I read what was sent against the proof.'): string =>
  `${prose}\n\n\`\`\`verdict\n${JSON.stringify(verdict)}\n\`\`\``;

/**
 * A scripted checking session in place of `spawnClaude`: each spawn answers the
 * next text (the last one again once they run out) and is recorded, so a test
 * reads exactly what the console asked for. Spends nothing.
 */
export function scriptedChecker(
  h: Harness, texts: string[], over: Partial<SpawnOutcome> = {},
): SpawnRequest[] {
  const calls: SpawnRequest[] = [];
  (h.svc as unknown as { checkerSpawn: (request: SpawnRequest) => Promise<SpawnOutcome> }).checkerSpawn = async (request) => {
    calls.push(request);
    return {
      signal: {}, costUsd: 0.15, turns: 4, resultText: texts[Math.min(calls.length - 1, texts.length - 1)] ?? '',
      durationMs: 900, argv: [], injected: 0, ...over,
    } as SpawnOutcome;
  };
  return calls;
}

/** Wait for an item's running judgement to land its verdict. */
export async function judged(h: Harness, id: string): Promise<Record<string, unknown> | undefined> {
  return (h.svc as unknown as { checksInFlight: Map<string, Promise<Record<string, unknown>>> }).checksInFlight.get(id);
}

/** A judgement item: words, never a command, prove it. */
export const JUDGED = {
  kind: 'operator-act', title: 'Turn Learning on in the dashboard', proof_type: 'judgement',
  proof_words: 'the Learning summary reads learning_enabled: true', open_url: 'https://example.com/learning',
};
