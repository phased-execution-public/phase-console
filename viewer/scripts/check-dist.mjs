#!/usr/bin/env node
/**
 * The build gate: `npm run build && node scripts/check-dist.mjs`.
 *
 * `web-imports.test.ts` policed the legacy client until it retired; the built
 * client's equivalent risks live in the build output, so this checks the output
 * itself — every assertion below is something that actually went wrong once, or
 * something two live devices depend on:
 *
 *   • doctype + `<html lang>` — the legacy document spent its whole life in
 *     quirks mode because nothing held the one line that prevents it.
 *   • the manifest link + file — iOS silently ignores a missing or mistyped
 *     manifest, and "silently not installable" looks exactly like working.
 *   • `sw.js` AT THE ROOT, still push-capable, still what the entry registers —
 *     the two live push subscriptions are bound to `('/sw.js', scope '/')`;
 *     moving or renaming the worker unsubscribes every device silently. Do not
 *     weaken these three.
 *   • precache sanity — `index.html` and the destination chunks precached
 *     (the offline shell), the EMULATOR chunk not (89 KB of xterm is no use to
 *     someone who cannot open a shell, and Sessions is a destination: the page
 *     belongs in the precache, the terminal inside it does not).
 *   • the entry stays under the ~300 KB gzipped budget, and the terminal stays
 *     a lazy chunk the entry document never references — in the precache OR
 *     as a `modulepreload`, which is the second way a lazy chunk stops being
 *     lazy and the one nothing checked until Phase 7.
 *   • first paint (entry + every modulepreload) is GATED at 200 KB — of SERVED
 *     bytes, the `.br`/`.gz` sibling the server actually sends. It was advisory
 *     for four phases, drifted 211 → 220 KB, and nobody read the printed line;
 *     the cause turned out to be a one-line barrel import, not a dependency
 *     bump. It then spent its whole gated life measuring a compression the
 *     server never applied — 192.7 KB here, 641.1 KB on the wire. See the note
 *     above the constant.
 *   • `dist/.build-rev` exists — proves the stamp stayed wired into
 *     `npm run build`, which is what `npm start`'s staleness warning reads.
 *
 * Exits non-zero on the first summary with any ✗. Read the lines; each names
 * the file and the promise it holds.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const VIEWER = dirname(dirname(fileURLToPath(import.meta.url)));
// Which build to read: `client/dist` (what the server serves) unless
// `PC_DIST_DIR` names another — `npm run verify:dist` builds into a scratch
// directory so the live console is never touched. Same variable, same
// resolution as vite.config.ts: relative to `client/`, or absolute.
const DIST = resolve(join(VIEWER, 'client'), process.env.PC_DIST_DIR || 'dist');

/** The plan's bundle budget: ~300 KB gzipped for the entry's JS. */
const BUDGET_GZ = 300 * 1024;

if (!existsSync(join(DIST, 'index.html'))) {
  process.stderr.write(
    `check-dist: no ${DIST.replace(VIEWER + '/', '')}/index.html — run \`npm run build\` first.\n`,
  );
  process.exit(1);
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, condition, detail });
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');

check(
  'index.html starts with <!doctype html> (standards mode)',
  /^<!doctype html>/i.test(html.trimStart().slice(0, 40)),
);
check('<html> declares lang', /<html[^>]+lang=/.test(html));
check('index.html links the manifest', /<link[^>]+rel="manifest"/.test(html));
check('manifest.webmanifest is in dist', existsSync(join(DIST, 'manifest.webmanifest')));

/*
 * The CSP's side of the bargain.
 *
 * `server/index.ts` serves `script-src 'self'` with no hash and no nonce, so
 * the BUILT document must carry no inline script and no `<base>`. Today it
 * carries neither — Vite emits external module scripts and a stylesheet link,
 * and the one inline thing in the source (`<link rel="icon" href="data:...">`)
 * is an image, covered by `img-src data:`. A plugin, or a bump to
 * `build.assetsInlineLimit`, that starts inlining a bootstrap would be refused
 * by the browser at first paint and pass every other check in this file.
 */
const inlineScripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(
  (match) => match[1].trim() !== '',
);
check(
  'index.html carries no inline <script> (the served CSP has no script hash or nonce)',
  inlineScripts.length === 0,
  "server/index.ts serves `script-src 'self'`; an inline bootstrap is refused by the browser. Either stop " +
    'inlining it (a Vite plugin or build.assetsInlineLimit is the usual cause) or widen the policy ' +
    'deliberately — a hash means the header and the build have to move together forever.',
);
check("index.html declares no <base> (the served CSP sends base-uri 'none')", !/<base[\s>]/i.test(html));

/* The worker — the three checks two live devices depend on. */
const swPath = join(DIST, 'sw.js');
check('sw.js is at the ROOT of dist (subscriptions are bound to /sw.js)', existsSync(swPath));

const sw = existsSync(swPath) ? readFileSync(swPath, 'utf8') : '';
check(
  'the worker still handles push',
  /addEventListener\((["'`])push\1/.test(sw),
  'a worker without a push listener silently ends notifications for every subscribed device',
);
check('the precache includes index.html (the offline shell)', sw.includes('index.html'));
check(
  'the precache does NOT include the pane chunk (where xterm lives)',
  !sw.includes('pane-'),
  'the emulator chunk `features/sessions/session-page.tsx` lazy-loads — 89 KB no reader of a route map needs',
);
check(
  'the precache DOES include the Sessions destination chunk',
  /\bsessions-[^"'`\s]*\.js/.test(sw),
  'Sessions is one of the eight destinations; its chunk belongs in the offline shell like the rest. ' +
    'If this fails while the emulator check passes, the destination chunk was excluded by name — the thing ' +
    'to exclude is the pane, never the page.',
);
/*
 * The other two destinations Phase 11 built, by the same rule.
 *
 * A destination is precached; the expensive thing INSIDE it is not. Settings
 * is eight sections and only two of them are heavy (the MCP catalog with its
 * search and add dialog; the permissions rule editor), so both are `lazy()`
 * inside the section chunk — the same shape as Sessions and its pane, for the
 * same reason: nobody who opened Settings to flip a theme should download a
 * rule grammar.
 */
check('the precache DOES include the Settings destination chunk', /\bsettings-[^"'`\s]*\.js/.test(sw));
check('the precache DOES include the Insights destination chunk', /\binsights-[^"'`\s]*\.js/.test(sw));

/*
 * The two Phase 4 added, by the same rule — and this gate is the reason they
 * are here. P4's handoff claimed "two guards will tell you if you miss one"
 * when a destination is added; there are THREE, and this was the silent one:
 * a new destination whose chunk never reaches the precache is a page that is
 * simply missing from the offline shell, on the surface (a phone, at 2am, over
 * whatever signal is there) where that matters most.
 */
check('the precache DOES include the Repo destination chunk', /\brepo-[^"'`\s]*\.js/.test(sw));
check('the precache DOES include the Debug destination chunk', /\bdebug-[^"'`\s]*\.js/.test(sw));

/* The entry — parsed from the document, not guessed from filenames. */
const entryMatch = /<script[^>]+type="module"[^>]+src="\/assets\/(index-[^"]+\.js)"/.exec(html);
check('index.html references exactly one module entry under /assets/', Boolean(entryMatch));

if (entryMatch) {
  const entry = readFileSync(join(DIST, 'assets', entryMatch[1]), 'utf8');
  const gz = gzipSync(entry).length;
  check(
    `entry ${entryMatch[1]} is under the budget (${(gz / 1024).toFixed(1)} KB gz of ${BUDGET_GZ / 1024} KB)`,
    gz <= BUDGET_GZ,
  );
  check(
    'the entry registers the worker at /sw.js',
    /["'`]\/sw\.js["'`]/.test(entry),
    'the registration URL is the contract the two live subscriptions depend on',
  );
}

const assets = existsSync(join(DIST, 'assets')) ? readdirSync(join(DIST, 'assets')) : [];
check(
  'the Sessions destination is its own lazy chunk',
  assets.some((name) => /^sessions-.*\.js$/.test(name)),
);
check(
  'xterm rides in one lazy pane-* chunk (the name the globIgnores exclude)',
  assets.some((name) => /^pane-.*\.js$/.test(name)),
  'if the bundler renamed the emulator chunk, update vite.config.ts globIgnores AND this check together',
);
check(
  'index.html never references the pane chunk',
  !html.includes('pane-'),
  'referenced from the document, it would load for every reader of a route map',
);
check(
  "Settings' two heavy sections are chunks of their own",
  assets.some((name) => /^mcp-.*\.js$/.test(name)) &&
    assets.some((name) => /^permissions-.*\.js$/.test(name)),
  'features/settings/index.tsx reaches the MCP catalog and the permissions editor through `lazy()`. ' +
    'A static import folds both into the precached Settings chunk — which every visitor downloads ' +
    'on install, including one who only ever changes the theme.',
);

/*
 * The same promise as the three precache checks above, asserted against the
 * BUILD rather than against three chunk names.
 *
 * Every check above pins a name, and a name is exactly what a bundler is free
 * to change: adding one module that both terminal routes import made it a
 * second facade of the shared chunk and renamed it `pane-*` → `ended-*`, which
 * matched no `globIgnores` entry and put 346 KB of xterm in the precache. The
 * named checks caught it here, but only because one of them happened to assert
 * the old name still existed — update the name in `vite.config.ts` alone and
 * every check would pass while the regression shipped.
 *
 * So: find whichever asset actually contains the emulator, and assert the
 * worker does not precache that one. Rename-proof by construction.
 */
const xtermChunks = assets.filter(
  (name) => name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes('xterm'),
);
check('the terminal emulator is in a chunk at all (nothing to check otherwise)', xtermChunks.length > 0);
const precachedXterm = xtermChunks.filter((name) => sw.includes(name));
check(
  `the precache excludes the emulator, whatever the chunk is called (${xtermChunks.join(', ') || 'none'})`,
  precachedXterm.length === 0,
  `precached: ${precachedXterm.join(', ')} — add it to globIgnores in vite.config.ts. ` +
    'A renamed emulator chunk is the usual cause; see the note in features/sessions/pane.tsx.',
);

/*
 * The modulepreload twin of the check above.
 *
 * The precache is one of TWO ways a lazy chunk stops being lazy. The other is
 * `<link rel="modulepreload">` in the document: a preloaded chunk is fetched
 * by every visitor on first paint, on the same connection as the entry, and
 * nothing about it looks lazy from the network tab's point of view — it is
 * simply there before anything asked.
 *
 * The named check above (`index.html never references the pane or agent
 * chunks`) is the version of this that a rename defeats, for exactly the
 * reason the note above gives. This one asks the build the same question the
 * emulator-precache check asks: whichever chunk actually contains xterm, is
 * the document pulling it in?
 */
/*
 * The Phase-10 failure mode, named.
 *
 * Sessions is a DESTINATION, so unlike the two pages it replaced its chunk is
 * precached as part of the offline shell. That makes one ordinary-looking edit
 * expensive: turning `lazy(() => import('./pane'))` in `session-page.tsx` back
 * into a static import would fold the emulator into `sessions-*` — and the
 * rename-proof precache check below would catch it, but only as "some chunk
 * you have never heard of is precached". This says which edit did it.
 */
const sessionChunks = assets.filter((name) => /^sessions-.*\.js$/.test(name));
const emulatorInSessions = sessionChunks.filter((name) =>
  readFileSync(join(DIST, 'assets', name), 'utf8').includes('xterm'),
);
check(
  'the Sessions destination chunk carries no emulator',
  emulatorInSessions.length === 0,
  `${emulatorInSessions.join(', ')} contains xterm — the pane must stay behind ` +
    "`lazy(() => import('./pane'))` in features/sessions/session-page.tsx; a static import puts 89 KB gz " +
    'of emulator into a chunk every visitor precaches.',
);

/*
 * What the PLAN route actually downloads.
 *
 * A route's cost is not its own chunk, it is the transitive closure of that
 * chunk's STATIC imports — and nothing about reading a plan tells you what is
 * in there. Two things had crept into it and neither was visible from the
 * source of any file anyone would think to open:
 *
 *   - `groupRows`, a ten-line helper, was exported from the 888-line run table,
 *     so importing the helper imported the table (now `features/runs/phase-groups`).
 *   - `LaunchDialog` — the whole run-setup surface, 77.6 KB of skill picker,
 *     MCP picker, per-phase table and zod schema — was a static import in two
 *     components the plan page mounts, both of which render it as
 *     `{open && <LaunchDialog/>}`. Rendered on a press; downloaded by everyone
 *     (now `features/run-setup/lazy-launch-dialog`).
 *
 * So this walks the graph rather than trusting a name. `import("./x.js")` and
 * its backticked twin are deliberately NOT followed: a dynamic import is the
 * whole point, and counting one would make every `lazy()` look like a
 * regression.
 */
function staticImportsOf(chunk) {
  const file = join(DIST, 'assets', chunk);
  if (!existsSync(file)) return [];
  const source = readFileSync(file, 'utf8');
  // `from "./x.js"` and the bare side-effect `import "./x.js"`, with or without
  // the whitespace a minifier removes. The dynamic forms — `import("./x.js")`
  // and its backticked twin — cannot match either branch: both put a `(`
  // between the keyword and the quote, and `(` is neither whitespace nor a
  // quote. That distinction is the whole point of the check, so it is asserted
  // both ways in `test/check-dist.test.ts`.
  return [...source.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)].map((match) => match[1]);
}

function chunkClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const chunk = queue.shift();
    if (!chunk || seen.has(chunk)) continue;
    seen.add(chunk);
    queue.push(...staticImportsOf(chunk));
  }
  return seen;
}

const planChunk = assets.find((name) => /^detail-.*\.js$/.test(name));
check(
  'the plan route is its own chunk (nothing to walk otherwise)',
  Boolean(planChunk),
  'features/plans/detail.tsx is `page(() => import(...))` in app/router.tsx; if it stopped being its ' +
    'own chunk it was folded into the entry, which is a bigger problem than this check.',
);
if (planChunk) {
  const planGraph = chunkClosure(planChunk);
  const runSetup = [...planGraph].filter((name) => /^run-setup-.*\.js$/.test(name));
  check(
    `the plan route never statically pulls run-setup (${planGraph.size} chunks in its graph)`,
    runSetup.length === 0,
    `${runSetup.join(', ')} is reachable from ${planChunk} by static imports. The launch dialog must be ` +
      "reached through `features/run-setup/lazy-launch-dialog`, and the run table's grouping helpers " +
      'through `features/runs/phase-groups` — never `phase-table` or `launch-dialog` directly from ' +
      'anything the plan page mounts.',
  );
}

/*
 * The same rule, for the second route that grew a launch.
 *
 * Phase 16 put a plan-from-issues dialog on the Repo destination, and a direct
 * import of it took the run-setup chunk with it — measured: the repo chunk's
 * static closure went from 11 chunks to 12, so everyone who opened `#/repo` to
 * read a commit graph downloaded 71 KB of skill picker. That is the plan
 * route's own regression, on a different page, which is exactly why the check
 * is a rule rather than a fact about one chunk.
 */
const repoChunk = assets.find((name) => /^repo-.*\.js$/.test(name));
check(
  'the repo route is its own chunk (nothing to walk otherwise)',
  Boolean(repoChunk),
  'features/repo/index.tsx is `page(() => import(...))` in app/router.tsx; if it stopped being its ' +
    'own chunk it was folded into the entry, which is a bigger problem than this check.',
);
if (repoChunk) {
  const repoGraph = chunkClosure(repoChunk);
  const runSetup = [...repoGraph].filter((name) => /^run-setup-.*\.js$/.test(name));
  check(
    `the repo route never statically pulls run-setup (${repoGraph.size} chunks in its graph)`,
    runSetup.length === 0,
    `${runSetup.join(', ')} is reachable from ${repoChunk} by static imports. The issues board's ` +
      'launch must be reached through `features/repo/lazy-issues-launch` — never `issues-launch` ' +
      'directly from anything the Repo destination mounts.',
  );
}

/*
 * The Repo destination's one heavy section, by the emulator's three rules.
 *
 * The Landscape section (many-plans-one-repo phase 14) draws the repository
 * map on React Flow with a d3-dag layout — ~97 KiB gzipped by the phase-1
 * spike (`test/fixtures/spikes/react-flow-bundle.md`), behind a section most
 * readers of `#/repo` never open. `features/repo/index.tsx` reaches it through
 * `features/repo/pro/lazy-landscape`, so the library rides in a chunk of its
 * own: not in the repo chunk's static graph, not in the precache, not
 * preloaded. Each is found by CONTENT — whichever chunk carries React Flow's
 * own class prefix — for the reason the pane check gives: a name is exactly
 * what a bundler is free to change. In the free tree nothing imports the
 * library and no chunk carries it, so the three read as vacuously true there;
 * the Pro block below is what asserts the chunk exists at all.
 */
const REACT_FLOW_MARK = 'react-flow__';
const reactFlowChunks = assets.filter(
  (name) =>
    name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes(REACT_FLOW_MARK),
);
if (repoChunk) {
  const repoGraph = chunkClosure(repoChunk);
  const pulled = [...repoGraph].filter((name) => reactFlowChunks.includes(name));
  check(
    `the repo route's static graph carries no React Flow (${repoGraph.size} chunks walked)`,
    pulled.length === 0,
    `${pulled.join(', ')} is reachable from ${repoChunk} by static imports. The Landscape section must be ` +
      'reached through `features/repo/pro/lazy-landscape` — never `landscape-section` or `repo-map` ' +
      'directly from anything the Repo destination mounts.',
  );
}
const precachedReactFlow = reactFlowChunks.filter((name) => sw.includes(name));
check(
  `the precache excludes React Flow, whatever the chunk is called (${reactFlowChunks.join(', ') || 'none'})`,
  precachedReactFlow.length === 0,
  `precached: ${precachedReactFlow.join(', ')} — add it to globIgnores in vite.config.ts. A renamed landscape ` +
    'chunk is the usual cause; see the note in features/repo/pro/lazy-landscape.tsx.',
);

const preloaded = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/assets\/([^"]+)"/g)].map(
  (match) => match[1],
);
const preloadedReactFlow = reactFlowChunks.filter((name) => preloaded.includes(name));
check(
  'the document never modulepreloads React Flow, whatever the chunk is called',
  preloadedReactFlow.length === 0,
  `modulepreloaded: ${preloadedReactFlow.join(', ')} — a preloaded chunk is fetched by every visitor on ` +
    'first paint. Usually a static import that should be a `lazy()`; see features/repo/pro/lazy-landscape.tsx.',
);
/*
 * The same rule for the fleet app's one heavy piece.
 *
 * The pairing QR (many-plans-one-repo phase 23) is drawn by the `qrcode`
 * encoder, which nobody opening the fleet app to read an inbox needs.
 * `features/fleet/reach.tsx` reaches it through `features/fleet/lazy-qr`, so
 * the encoder rides in a chunk of its own: not in the Fleet chunk's static
 * graph, not in the precache, not preloaded. Found by CONTENT — the encoder's
 * own error sentence — for the reason the two checks above give. In the free
 * tree nothing imports it and no chunk carries it, so the three read as
 * vacuously true there; the Pro block asserts the chunk exists at all.
 */
const QR_MARK = 'too big to be stored in a QR Code';
const qrChunks = assets.filter(
  (name) => name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes(QR_MARK),
);
const fleetChunk = assets.find((name) => /^fleet-.*\.js$/.test(name));
if (fleetChunk) {
  const fleetGraph = chunkClosure(fleetChunk);
  const pulled = [...fleetGraph].filter((name) => qrChunks.includes(name));
  check(
    `the fleet chunk's static graph carries no QR encoder (${fleetGraph.size} chunks walked)`,
    pulled.length === 0,
    `${pulled.join(', ')} is reachable from ${fleetChunk} by static imports. The pairing QR must be ` +
      'reached through `features/fleet/lazy-qr` — never `qr-code` directly from anything the fleet app mounts.',
  );
}
const precachedQr = qrChunks.filter((name) => sw.includes(name));
check(
  `the precache excludes the QR encoder, whatever the chunk is called (${qrChunks.join(', ') || 'none'})`,
  precachedQr.length === 0,
  `precached: ${precachedQr.join(', ')} — add it to globIgnores in vite.config.ts. A renamed qr-code chunk ` +
    'is the usual cause; see the note in features/fleet/lazy-qr.tsx.',
);
const preloadedQr = qrChunks.filter((name) => preloaded.includes(name));
check(
  'the document never modulepreloads the QR encoder, whatever the chunk is called',
  preloadedQr.length === 0,
  `modulepreloaded: ${preloadedQr.join(', ')} — a preloaded chunk is fetched by every visitor on first paint. ` +
    'Usually a static import that should be a `lazy()`; see features/fleet/lazy-qr.tsx.',
);
const preloadedXterm = xtermChunks.filter((name) => preloaded.includes(name));
check(
  `the document never modulepreloads the emulator, whatever the chunk is called (${preloaded.length} preloaded)`,
  preloadedXterm.length === 0,
  `modulepreloaded: ${preloadedXterm.join(', ')} — a preloaded chunk is fetched by every visitor on ` +
    'first paint. Usually a static import that should be a `lazy()`; see the note in vite.config.ts.',
);

/*
 * First paint, as a number rather than as a name.
 *
 * The entry budget above (~300 KB gz) only counts the entry. What a visitor
 * actually downloads before the first frame is the entry PLUS everything the
 * document preloads, and a chunk that migrates out of the entry into a
 * preload costs exactly as much while making the entry check greener. This
 * counts the real total.
 *
 * HARD since 3.0. It was advisory for four phases on the reasoning that a
 * figure moving with every dependency bump becomes a gate people raise rather
 * than read — and in those four phases it drifted 211 → 220 KB and nobody
 * acted on a single printed line.
 *
 * What it was hiding was not a dependency bump. The help sheet is mounted in
 * the composition root, so it is on every page, and it imported its section
 * panel STATICALLY — which put the guide's eleven `?raw` markdown bodies and
 * `marked` in the entry chunk for every visitor, including one who never opens
 * the guide. One `lazy()` took first paint from 220.5 to 172.8 KB.
 *
 * That is the argument for the gate rather than against it, and the entry
 * budget above is why: with the panel static the ENTRY check reads a
 * comfortable 128.6 of 300 KB and says nothing is wrong. Only the total says
 * so. Raise this deliberately if a real dependency needs the room — with the
 * reason, here.
 */
const FIRST_PAINT_SERVED = 200 * 1024;

/*
 * SERVED bytes, not `gzipSync` of the source.
 *
 * For four phases this line called `gzipSync` on each file and reported the
 * result as the budget — and `server/index.ts` compressed nothing, so the
 * browser received 641.1 KB against a gate that read 192.7 and passed. The
 * measurement was not wrong; it was measuring a transformation nobody applied.
 *
 * So this asks the question the server answers: which bytes leave the process?
 * `server/http/static.ts` serves `<file>.br` to a client that accepts brotli,
 * else `<file>.gz`, else the file — preferring the smaller. Those siblings are
 * written by `scripts/precompress.mjs`, the last step of `npm run build`. Drop
 * that step and this check reads the identity size and FAILS, which is the
 * whole point: the gap can no longer open silently.
 */
function servedBytes(file) {
  if (!existsSync(file)) return 0;
  const identity = readFileSync(file).length;
  let best = identity;
  for (const suffix of ['.br', '.gz']) {
    if (!existsSync(file + suffix)) continue;
    best = Math.min(best, readFileSync(file + suffix).length);
  }
  return best;
}

const firstPaintServed =
  (entryMatch ? servedBytes(join(DIST, 'assets', entryMatch[1])) : 0) +
  preloaded.reduce((sum, name) => sum + servedBytes(join(DIST, 'assets', name)), 0);
check(
  `first paint is ${(firstPaintServed / 1024).toFixed(1)} KB served (entry + ${preloaded.length} ` +
    `modulepreload${preloaded.length === 1 ? '' : 's'}) of ${FIRST_PAINT_SERVED / 1024} KB`,
  firstPaintServed <= FIRST_PAINT_SERVED,
  'the entry PLUS everything index.html preloads, in the form the server would send it. A chunk ' +
    'that migrates from the entry into a preload costs exactly as much while making the entry ' +
    'check greener — usually a static import that should be a `lazy()`, or a barrel re-export ' +
    'pulling a parser in behind a helper. If this jumped by ~3x, `scripts/precompress.mjs` did ' +
    'not run and the browser is being sent the uncompressed build.',
);

check('dist/.build-rev exists (npm run build stamps what it built)', existsSync(join(DIST, '.build-rev')));

/* ------------------------------------------------------------------ */

let failed = 0;
for (const { name, condition, detail } of results) {
  process.stdout.write(`${condition ? '✓' : '✗'} ${name}\n`);
  if (!condition) {
    failed += 1;
    if (detail) process.stdout.write(`  ${detail}\n`);
  }
}
process.stdout.write(
  failed === 0
    ? `check-dist: all ${results.length} checks passed.\n`
    : `check-dist: ${failed} of ${results.length} checks FAILED.\n`,
);
process.exit(failed === 0 ? 0 : 1);
