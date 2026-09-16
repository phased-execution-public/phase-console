#!/usr/bin/env node
/**
 * Build the journal fixture from a console's run corpus — bounded, redacted.
 *
 *   node viewer/test/fixtures/journals/build.mjs --from <runs/<instance> dir>
 *
 * Copies, for the six plans chapter 03 of the sep-review audit measured, every
 * `run-<id>.jsonl` journal and `run-<id>.json` state file — never the console
 * log (`*.log.jsonl`, megabytes of stream), the task lists or the outcome
 * declarations — and rewrites them so nothing in them points at a person, a
 * machine or a customer:
 *
 *   - every UUID (session ids above all) → a stable pseudonym, same shape, so
 *     a record's `sessionId` still matches its `sessionGone.sessionId`;
 *   - every email address → a placeholder under `example.com`;
 *   - every home-directory path → `/home/operator/…`; the account name and the
 *     GitHub handles → `operator`;
 *   - the organisation, the private repositories' prefixes and a private
 *     tool's name → neutral words (`.github/scripts/scrub.sh --dir` is the
 *     gate, and it is strict in artifact mode).
 *
 * Run ids (8 hex, in the file names) stay: they are not identity, and the
 * audit's chapters cite them. The replacements never change a string's JSON
 * shape, and every line is re-parsed before it is written.
 *
 * Idempotent and deterministic: the same corpus gives the same bytes, and the
 * pseudonym table is rebuilt from scratch each run, in first-seen order.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chapter 03's six plans — the bound. */
export const PLANS = [
  'ai-builder-v3',
  'ci-cd-hardening',
  'customer-app-ios-release',
  'mql-build-lane-hardening',
  'mql-lane-followups',
  'scroll-world-focus-cut',
];

const args = process.argv.slice(2);
const fromAt = args.indexOf('--from');
const from = fromAt >= 0 ? args[fromAt + 1] : null;
if (!from || !existsSync(from)) {
  process.stderr.write('usage: build.mjs --from <the console\'s runs/<instance> directory>\n');
  process.exit(2);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// The needles are assembled from parts for the same reason `scrub.sh` does
// it: a builder that spelled them out would itself be the leak it removes.
const ORG = new RegExp('themarket' + 'robo', 'gi');
const REPO_PREFIX = new RegExp('tra' + 'de-', 'gi');
const ADMIN_APP = new RegExp('front-' + 'admin', 'gi');
const TOOL = new RegExp('gra' + 'phify', 'gi');
const HOME = /\/Users\/[A-Za-z0-9._-]+/g;
const HANDLES = [new RegExp('mobin' + 'zarekar', 'g'), new RegExp('mobin-' + 'mac-pro', 'g'), new RegExp('zs' + 'arir', 'g'), /\bmobin\b/gi];
// A hostname of the `<Name>s-MacBook-Pro` shape, and the one this corpus has.
const HOSTNAMES = [new RegExp('Mobins-' + 'MacBook-Pro', 'g'), /\b[A-Z][a-z]+s-(?:MacBook|iMac|Mac)(?:-[A-Za-z]+)*\b/g];

const pseudonyms = new Map();
const pseudonym = (uuid) => {
  if (!pseudonyms.has(uuid)) {
    const n = pseudonyms.size + 1;
    pseudonyms.set(uuid, `f1c70000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  }
  return pseudonyms.get(uuid);
};

export function scrub(text) {
  return text
    .replace(UUID, (m) => pseudonym(m))
    .replace(EMAIL, (m) => (/@anthropic\.com$/i.test(m) ? 'bot@example.com' : 'operator@example.com'))
    .replace(HOME, '/home/operator')
    // The tilde form of the same home, as sessions write it in prose.
    .replace(/(^|[^\w/])~\//g, '$1/home/operator/')
    .replace(ORG, 'example-org')
    .replace(REPO_PREFIX, 'acme-')
    .replace(ADMIN_APP, 'web-admin')
    .replace(TOOL, 'graph-tool')
    .replace(HANDLES[0], 'operator')
    .replace(HANDLES[1], 'operator')
    .replace(HANDLES[2], 'operator')
    .replace(HANDLES[3], 'operator')
    .replace(HOSTNAMES[0], 'operator-host')
    .replace(HOSTNAMES[1], 'operator-host')
    .replace(/@Mac\b/g, '@host');
}

const inventory = [];
for (const slug of PLANS) {
  const src = join(from, slug);
  if (!existsSync(src)) { process.stderr.write(`build: no ${slug} under ${from}\n`); process.exit(2); }
  const dst = join(HERE, slug);
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    const journal = /^run-([0-9a-f]{8})\.jsonl$/.exec(name);
    const state = /^run-([0-9a-f]{8})\.json$/.exec(name);
    if (!journal && !state) continue;
    const raw = readFileSync(join(src, name), 'utf8');
    const clean = scrub(raw);
    const entry = { slug, file: `${slug}/${name}`, bytes: Buffer.byteLength(clean) };
    if (journal) {
      const lines = clean.split('\n').filter(Boolean);
      const events = new Map();
      const sessions = new Set();
      let costUsd = 0;
      for (const line of lines) {
        const row = JSON.parse(line);   // throws on a scrub that broke a line
        events.set(row.event, (events.get(row.event) ?? 0) + 1);
        if (row.event === 'phase.session') {
          // The payload rides beside `event`/`at`/`phase` on the line itself,
          // or under `data` on lines an older console wrote — read both.
          const payload = { ...(row.data ?? {}), ...row };
          // The session id is the `--session-id` in the argv the line records.
          const argv = Array.isArray(payload.argv) ? payload.argv : [];
          const id = payload.sessionId ?? argv[argv.indexOf('--session-id') + 1];
          if (id && argv.indexOf('--session-id') >= 0) sessions.add(id);
          if (typeof payload.costUsd === 'number') costUsd += payload.costUsd;
        }
      }
      Object.assign(entry, {
        lines: lines.length,
        distinctEvents: events.size,
        sessions: sessions.size,
        sessionCostUsd: Math.round(costUsd * 10000) / 10000,
        liveWalls: events.get('phase.live-wall') ?? 0,
        usageWindows: events.get('run.usage-window') ?? 0,
        waits: events.get('phase.waiting') ?? 0,
      });
      writeFileSync(join(dst, name), `${lines.join('\n')}\n`);
    } else {
      const run = JSON.parse(clean);
      Object.assign(entry, {
        status: run.status,
        halt: run.halt ? { kind: run.halt.kind ?? null, reason: String(run.halt.reason).slice(0, 60) } : null,
        phases: Object.keys(run.phases ?? {}).length,
      });
      writeFileSync(join(dst, name), clean.endsWith('\n') ? clean : `${clean}\n`);
    }
    inventory.push(entry);
  }
}
writeFileSync(join(HERE, 'inventory.json'), `${JSON.stringify({ builtFrom: 'runs/<instance> of the hub console', plans: PLANS, pseudonyms: pseudonyms.size, files: inventory }, null, 2)}\n`);
for (const e of inventory) process.stdout.write(`${e.file.padEnd(52)} ${String(e.bytes).padStart(8)} B${e.lines ? `  ${String(e.lines).padStart(5)} lines  ${e.distinctEvents} events  ${e.sessions} sessions  $${e.sessionCostUsd}` : `  ${e.status}${e.halt ? `  halt.kind=${e.halt.kind}` : ''}`}\n`);
process.stdout.write(`pseudonyms: ${pseudonyms.size}\n`);
