/**
 * One RUN, redacted, as a tar.gz — everything somebody needs to answer "what
 * happened here" without being on the machine.
 *
 * The v1 bundle (`debug/index.ts`) is a snapshot of the CONSOLE: every plan,
 * the health rows, the metrics, and the newest few hundred log lines across all
 * of them. It is the right artefact for "is this console well". It is the wrong
 * one for "why did phase 7 park at 03:14 on Tuesday", which is the question
 * anybody actually asks — and for that question the v1 bundle held the journal
 * of no run, the transcript of no session, no task ledger, no outcome, no
 * ruling, no lock, no git trace, and a log slice chosen by recency rather than
 * by relevance. So this is a second bundle rather than a bigger first one: a
 * different question, a different scope, a different shape.
 *
 * **Collect → Redact → Analyze**, in that order and separately, because the
 * middle step is the one with a consequence. This file is exported to be
 * SHARED — pasted into an issue, attached to a model — and every collector
 * reads a file the console wrote for itself, with no expectation of an
 * audience. So nothing reaches a member without passing `scrubText`
 * (`redact` + home masking + the entropy backstop), and the manifest says in
 * words that the redaction is best-effort, because a bundle that claims to be
 * clean and is not read before sharing is the failure this whole feature could
 * cause rather than prevent.
 *
 * **An absent artefact is named, never thrown.** Half the files here are
 * optional by construction: a run with no messages has no message ledger, a
 * plan with no rulings has no ruling file, a phase that never locked has no
 * lock. Failing the export because one is absent would mean the bundles that
 * are hardest to get are exactly the ones that cannot be built — a run that
 * died early is both the least complete and the most interesting.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { tarGz, type TarMember } from './tar.ts';
import { scrubText, scrubValue } from './sources.ts';

export const RUN_BUNDLE_SCHEMA = 'phase-console/run-bundle';
export const RUN_BUNDLE_VERSION = 2;

/**
 * The sentence the manifest carries, and the reason it is a sentence rather
 * than a boolean: `redacted: true` is a claim a reader will believe, and this
 * redaction is regexes, a home-directory mask and an entropy heuristic. It
 * catches the shapes we know and the ones random enough to guess at. It does
 * not catch a password that looks like a word.
 */
export const RUN_BUNDLE_NOTES: readonly string[] = [
  'Redaction is best-effort (regex + home masking + entropy). Inspect before sharing.',
];

/**
 * Environment variables worth carrying, by exact name or by prefix.
 *
 * An allow-list rather than a deny-list, because the deny-list version of this
 * question has been lost by every project that has tried it: the variable that
 * leaks is always the one nobody listed. `PATH` leads because E7 — the Xcode
 * licence shim shadowing `git` under launchd's `PATH` — is a PATH bug, and was
 * unanswerable from a bundle that did not carry it.
 */
const ENV_ALLOW: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'TMPDIR',
  'NODE_ENV',
  'NODE_OPTIONS',
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'CLAUDE_CONFIG_DIR',
];
const ENV_ALLOW_PREFIX: readonly string[] = ['PHASE_CONSOLE_', 'PE_'];

/**
 * …and the second gate, applied to an already-allowed name. `PHASE_CONSOLE_`
 * is a prefix this console adds variables to; the day one of them holds a token
 * the allow-list alone would carry it.
 */
const ENV_SECRET_NAME = /TOKEN|SECRET|KEY|PASS|AUTH/i;

/**
 * `?since=` — a duration back from now (`30m`, `2h`, `7d`), or an instant.
 *
 * The duration spelling exists because the useful ask is almost always "the
 * last half hour", and an operator computing an ISO timestamp for that is an
 * operator who gets the timezone wrong. An instant is still accepted, in ISO or
 * epoch milliseconds, because a second bundle of the SAME window is how two
 * runs get compared.
 */
export function parseSince(value: string | null | undefined, now: number): number | undefined {
  const text = (value ?? '').trim();
  if (!text) return undefined;
  const duration = /^(\d+)\s*(s|m|h|d)$/i.exec(text);
  if (duration) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2].toLowerCase() as 's'];
    return now - Number(duration[1]) * unit;
  }
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

export type BundleRequest = {
  slug: string;
  runId: string;
  /** Milliseconds since the epoch; time-stamped members are narrowed to it. */
  since?: number;
};

export type BundleDeps = {
  /** `runDir(root, slug)` — every run artefact lives here. */
  runDir: string;
  /** `INSTANCE_STATE_DIR` — the console log and the sessions directory. */
  instanceDir: string;
  /** The plan's `.locks` directory in the docs root, when there is one. */
  locksDir?: string | null;
  /** This run's derived trace id, for the console-log slice. */
  traceId?: string;
  console?: () => unknown;
  worktrees?: () => unknown;
  versions?: () => unknown;
  diagnosis?: (phase: number) => Promise<unknown> | unknown;
  env?: Record<string, string | undefined>;
  now?: () => number;
};

export type BundleFile = { name: string; bytes: number };

export type RunBundleManifest = {
  schema: string;
  version: number;
  generatedAt: string;
  slug: string;
  runId: string;
  since?: string;
  files: BundleFile[];
  /** Named rather than thrown — see the header. */
  missing: string[];
  notes: string[];
};

export type RunBundle = {
  manifest: RunBundleManifest;
  body: Buffer;
  filename: string;
};

/* ------------------------------------------------------------------ *
 * Collect
 * ------------------------------------------------------------------ */

function readText(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The timestamp of one NDJSON line, whichever of the four spellings it uses.
 *
 * `null` means "this line carries no time I can read", and an undated line is
 * always KEPT. "I could not date it" and "it is old" are different facts, and
 * conflating them silently drops exactly the malformed lines a post-mortem is
 * looking for.
 */
function lineTime(raw: string): number | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const key of ['time', 'at', 'appliedAt', 'writtenAt']) {
    const value = parsed[key];
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** Keep the lines at or after `since`, plus every line with no readable time. */
function narrow(text: string, since: number | undefined): string {
  if (since === undefined) return text;
  const kept = text
    .split('\n')
    .filter((line) => line.trim())
    .filter((line) => {
      const at = lineTime(line);
      return at === null || at >= since;
    });
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

/**
 * The console log, cut to this run.
 *
 * Three reasons a line belongs, and the third is the one that matters: a
 * warning or an error inside the run's window is evidence about the run even
 * when it carries no trace of it, because the thing that went wrong is often
 * precisely the thing that failed to be traced.
 */
function consoleSlice(
  text: string,
  opts: { traceId?: string; runId: string; from: number | null; to: number | null; since?: number },
): string {
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof entry.time === 'string' ? Date.parse(entry.time) : NaN;
    if (opts.since !== undefined && Number.isFinite(at) && at < opts.since) continue;

    if (opts.traceId && entry.traceId === opts.traceId) {
      kept.push(line);
      continue;
    }
    if (line.includes(opts.runId)) {
      kept.push(line);
      continue;
    }
    const level = String(entry.level ?? '');
    if (level !== 'warn' && level !== 'error') continue;
    if (!Number.isFinite(at)) continue;
    if (opts.from !== null && at < opts.from) continue;
    if (opts.to !== null && at > opts.to) continue;
    kept.push(line);
  }
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

/* ------------------------------------------------------------------ *
 * Redact
 * ------------------------------------------------------------------ */

/** Every member goes through this. There is no path into the archive that does not. */
function member(name: string, text: string): TarMember {
  return { name, body: Buffer.from(scrubText(text), 'utf8') };
}

function jsonMember(name: string, value: unknown): TarMember {
  return member(name, `${JSON.stringify(scrubValue(value), null, 2)}\n`);
}

function envBlock(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const allowed = ENV_ALLOW.includes(name) || ENV_ALLOW_PREFIX.some((prefix) => name.startsWith(prefix));
    if (!allowed) continue;
    // Dropped WHOLE rather than masked: the name of a secret is itself a hint,
    // and a masked row invites somebody to wonder what it was.
    if (ENV_SECRET_NAME.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Analyze
 * ------------------------------------------------------------------ */

type Summary = {
  slug: string;
  runId: string;
  status: string | null;
  phases: number[];
  counts: Record<string, number>;
  /** Journal events that read as a failure, newest last. */
  errors: string[];
  /** `phase.suspect` lines — what was noticed and deliberately not acted on. */
  suspects: string[];
  /** The ten slowest `git.command` lines in the run's own log slice. */
  slowGit: string[];
  /** A §Verification command whose result moved between two attempts. */
  flips: string[];
};

/** How many of the slow git commands the analysis names. */
const SLOW_GIT_SHOWN = 10;

function summarise(
  run: Record<string, unknown> | null,
  journal: string,
  counts: Record<string, number>,
  consoleLog = '',
): Summary {
  const phases = Object.keys((run?.phases ?? {}) as Record<string, unknown>)
    .map((key) => Number(key))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const errors: string[] = [];
  for (const line of journal.split('\n')) {
    if (!line.trim()) continue;
    if (!/(fail|halt|error|refus|denied|park)/i.test(line)) continue;
    try {
      const entry = JSON.parse(line) as { event?: string; time?: string };
      if (entry.event) errors.push(`${entry.time ?? ''} ${entry.event}`.trim());
    } catch {
      /* a half-written line is not a finding */
    }
  }
  const suspects: string[] = [];
  const flips: string[] = [];
  const verdicts = new Map<string, { attempt: number; ok: boolean }>();
  for (const line of journal.split('\n')) {
    if (!line.trim()) continue;
    let entry: { event?: string; time?: string; phase?: number; data?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.event === 'phase.suspect') {
      const evidence = (entry.data?.evidence ?? {}) as Record<string, unknown>;
      suspects.push(
        `${entry.time ?? ''} phase ${entry.phase ?? '?'}: ${String(entry.data?.detail ?? 'loop')}`
        + (evidence.count ? ` (×${String(evidence.count)})` : ''),
      );
      continue;
    }
    if (entry.event !== 'phase.verify') continue;
    // By COMMAND, not by index: a §Verification that gained or lost a line
    // between attempts would otherwise pair `npm test` against `npm run lint`
    // and report both as flipped — `compareAttempts`' own rule.
    const attempt = Number(entry.data?.attempt ?? 0);
    for (const row of (Array.isArray(entry.data?.ran) ? entry.data.ran : []) as Record<string, unknown>[]) {
      const command = String(row.command ?? '');
      if (!command) continue;
      const ok = Number(row.code) === 0;
      const key = `${entry.phase ?? 0}\u0000${command}`;
      const held = verdicts.get(key);
      if (held && held.ok !== ok) {
        flips.push(
          `phase ${entry.phase ?? '?'}: \`${command}\` went ${held.ok ? 'pass → fail' : 'fail → pass'}`
          + ` between attempt ${held.attempt} and ${attempt}`,
        );
      }
      verdicts.set(key, { attempt, ok });
    }
  }

  const slowGit: string[] = [];
  for (const line of consoleLog.split('\n')) {
    if (!line.includes('git.command')) continue;
    try {
      const entry = JSON.parse(line) as { time?: string; data?: Record<string, unknown> };
      const ms = Number(entry.data?.ms);
      const argv = Array.isArray(entry.data?.argv) ? entry.data.argv.map(String) : [];
      if (!Number.isFinite(ms) || !argv.length) continue;
      slowGit.push(`${ms} ms · \`${argv.join(' ')}\`${entry.time ? ` · ${entry.time}` : ''}`);
    } catch {
      /* a half-written line is not a finding */
    }
  }
  slowGit.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));

  return {
    suspects,
    flips,
    slowGit: slowGit.slice(0, SLOW_GIT_SHOWN),
    slug: String(run?.slug ?? ''),
    runId: String(run?.id ?? ''),
    status: typeof run?.status === 'string' ? run.status : null,
    phases,
    counts,
    errors: errors.slice(-40),
  };
}


/* ------------------------------------------------------------------ *
 * The bundle
 * ------------------------------------------------------------------ */

/** A run id and a plan slug both reach a filename, so both are held to a shape. */
const SAFE = /[^A-Za-z0-9._-]+/g;

export async function runBundle(request: BundleRequest, deps: BundleDeps): Promise<RunBundle> {
  const { slug, runId, since } = request;
  const now = deps.now?.() ?? Date.now();
  const dir = deps.runDir;

  const recordText = readText(join(dir, `run-${runId}.json`));
  if (recordText === null) {
    throw new Error(`no record of run ${runId} in ${slug} — nothing to export`);
  }
  let record: Record<string, unknown> | null = null;
  try {
    record = JSON.parse(recordText) as Record<string, unknown>;
  } catch {
    // Unreadable is still worth exporting: it is the evidence.
  }

  const members: TarMember[] = [];
  const missing: string[] = [];

  /** Add a text member, or record that it was not there. */
  const addText = (name: string, path: string, opts: { narrow?: boolean } = {}): string => {
    const text = readText(path);
    if (text === null) {
      missing.push(name);
      return '';
    }
    const body = opts.narrow ? narrow(text, since) : text;
    members.push(member(name, body));
    return body;
  };

  // `record.json`, not `run.json`: `docs-parity` scans every `'run.…'` string
  // literal under `viewer/server/` as an EVENT name, and a member called
  // `run.json` fails it as an undocumented event. It is also the better name —
  // the file is the run RECORD, and the archive is already of one run.
  members.push(member('record.json', recordText));
  const journal = addText('journal.ndjson', join(dir, `run-${runId}.jsonl`), { narrow: true });
  addText('transcript.ndjson', join(dir, `run-${runId}.log.jsonl`), { narrow: true });
  addText('git-trace.ndjson', join(dir, `run-${runId}.git.ndjson`), { narrow: true });
  addText('rulings.ndjson', join(dir, 'rulings.ndjson'), { narrow: true });
  addText('messages.ndjson', join(dir, 'messages.ndjson'), { narrow: true });

  // This run's own per-phase ledgers, and the plan's inbox copies beside them.
  // Both, because they are written by different processes and a disagreement
  // between them is itself a finding.
  for (const name of safeList(dir)) {
    const own = new RegExp(`^run-${runId}-p(\\d+)-(tasks\\.ndjson|outcome\\.json)$`).exec(name);
    if (!own) continue;
    const kind = own[2] === 'outcome.json' ? 'outcomes' : 'tasks';
    const leaf = own[2] === 'outcome.json' ? `run-p${own[1]}.json` : `run-p${own[1]}.ndjson`;
    addText(`${kind}/${leaf}`, join(dir, name));
  }
  for (const name of safeList(join(dir, 'tasks'))) {
    addText(`tasks/inbox-${name}`, join(dir, 'tasks', name));
  }
  for (const name of safeList(join(dir, 'outcomes'))) {
    const path = join(dir, 'outcomes', name);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    addText(`outcomes/inbox-${name}`, path);
  }

  // Session event logs — every session this run's journal names, which is how a
  // presence question gets an answer rather than a shrug.
  const sessionsDir = join(deps.instanceDir, 'sessions');
  for (const name of safeList(sessionsDir)) {
    if (!name.endsWith('.events.ndjson')) continue;
    const id = name.slice(0, -'.events.ndjson'.length);
    if (!journal.includes(id) && !recordText.includes(id)) continue;
    addText(`sessions/${name}`, join(sessionsDir, name), { narrow: true });
  }
  // A run whose journal names no session still gets every log in the directory
  // rather than none: an empty `sessions/` is the least useful possible answer
  // to "which session was this", and these files are small and already capped.
  if (!members.some((one) => one.name.startsWith('sessions/'))) {
    for (const name of safeList(sessionsDir)) {
      if (name.endsWith('.events.ndjson')) addText(`sessions/${name}`, join(sessionsDir, name), { narrow: true });
    }
  }

  for (const name of safeList(deps.locksDir ?? null)) {
    if (!name.endsWith('.lock')) continue;
    addText(`locks/${basename(name)}`, join(deps.locksDir as string, name));
  }

  // The console log, cut to this run.
  const logText = readText(join(deps.instanceDir, 'console.log')) ?? '';
  const window = runWindow(record);
  // Kept rather than only pushed: the analysis reads the same slice for the
  // slow-git table, and slicing twice would let the member and the summary
  // disagree about which lines belong to this run.
  const consoleText = consoleSlice(
    logText, { traceId: deps.traceId, runId, from: window.from, to: window.to, since },
  );
  members.push(member('console/console.log.slice.ndjson', consoleText));

  members.push(jsonMember('worktrees.json', deps.worktrees?.() ?? []));
  members.push(jsonMember('env.json', envBlock(deps.env ?? {})));
  members.push(
    jsonMember('versions.json', deps.versions?.() ?? { console: deps.console?.() ?? null, node: process.version }),
  );

  for (const phase of Object.keys((record?.phases ?? {}) as Record<string, unknown>)) {
    const n = Number(phase);
    if (!Number.isFinite(n)) continue;
    try {
      const diagnosis = await deps.diagnosis?.(n);
      if (diagnosis !== undefined && diagnosis !== null) {
        members.push(jsonMember(`diagnosis/phase-${String(n).padStart(2, '0')}.json`, diagnosis));
      }
    } catch {
      // A diagnosis that will not compute must not cost the whole bundle: it is
      // itself derived from the files already in here.
    }
  }

  const counts: Record<string, number> = {};
  for (const one of members) counts[one.name] = one.body.length;
  const summary = summarise(record, journal, counts, consoleText);
  members.push(jsonMember('SUMMARY.json', summary));

  const manifest: RunBundleManifest = {
    schema: RUN_BUNDLE_SCHEMA,
    version: RUN_BUNDLE_VERSION,
    generatedAt: new Date(now).toISOString(),
    slug,
    runId,
    ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
    files: [],
    missing,
    notes: [...RUN_BUNDLE_NOTES],
  };


  manifest.files = named([...members, { name: 'MANIFEST.json', body: Buffer.alloc(0) }]);
  const manifestMember = member('MANIFEST.json', `${JSON.stringify(manifest, null, 2)}\n`);
  // The manifest's own size is its last unknown, so it is listed at whatever it
  // turned out to be rather than at zero: a reader comparing `files` against
  // `tar -tvf` must not find one row wrong.
  manifest.files = manifest.files.map((file) =>
    (file.name === 'MANIFEST.json' ? { name: file.name, bytes: manifestMember.body.length } : file));

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return {
    manifest,
    body: tarGz([manifestMember, ...members]),
    filename: `phase-console-run-${slug.replace(SAFE, '-')}-${runId.replace(SAFE, '-')}-${stamp}.tar.gz`,
  };
}

function named(members: readonly TarMember[]): BundleFile[] {
  return [...members]
    .map((one) => ({ name: one.name, bytes: one.body.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function safeList(dir: string | null): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The run's own window, for the warn/error slice. Both ends may be unknown. */
function runWindow(record: Record<string, unknown> | null): { from: number | null; to: number | null } {
  const at = (key: string): number | null => {
    const value = record?.[key];
    if (typeof value !== 'string') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  };
  return { from: at('createdAt') ?? at('startedAt'), to: at('updatedAt') ?? at('finishedAt') };
}
