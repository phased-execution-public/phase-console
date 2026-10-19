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
 *   • first paint (entry + every modulepreload) is GATED at 170 KB (see the
 *     note above the constant) — of SERVED
 *     bytes, the `.br`/`.gz` sibling the server actually sends. It was advisory
 *     for four phases, drifted 211 → 220 KB, and nobody read the printed line;
 *     the cause turned out to be a one-line barrel import, not a dependency
 *     bump. It then spent its whole gated life measuring a compression the
 *     server never applied — 192.7 KB here, 641.1 KB on the wire. See the note
 *     above the constant.
 *   • the TABLE ENGINE (TanStack Table, behind the grid's filters, groups and
 *     picks — control-tower phase 18) is a lazy chunk of its own that no chunk
 *     imports statically and the document never preloads.
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
  'the emulator chunk `screens/sessions/session-page.tsx` lazy-loads — 89 KB no reader of a route map needs',
);
check(
  'the precache DOES include the Sessions destination chunk',
  /\bsessions-[^"'`\s]*\.js/.test(sw),
  'Sessions is one of the seven destinations; its chunk belongs in the offline shell like the rest. ' +
    'If this fails while the emulator check passes, the destination chunk was excluded by name — the thing ' +
    'to exclude is the pane, never the page.',
);
/*
 * The other two destinations Phase 11 built, by the same rule.
 *
 * A destination is precached; the expensive thing INSIDE it is not. Settings
 * is nine sections (Pro adds two) and only two of them are heavy (the MCP catalog with its
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
/*
 * Debug became Logs in 7.0 (quiet-console phase 3), and since phase 20 the
 * place is `screens/logs/index.tsx`, so its chunk is `logs-*` — the 6.x name
 * no longer satisfies the check. Below, once the assets are listed, the place's
 * own chunk is found by content, because `data/logs.ts` is a `logs-*` too.
 */
check('the precache DOES include the Logs destination chunk', /\blogs-[^"'`\s]*\.js/.test(sw));
/*
 * The seven destinations, all of them: Runs and Plans are offline too. Each
 * also names a `data/` chunk, so these two say only that nothing excluded the
 * name — the glob takes every chunk the list above does not ignore.
 */
check('the precache DOES include the Runs destination chunk', /\bruns-[^"'`\s]*\.js/.test(sw));
check('the precache DOES include the Plans destination chunk', /\bplans-[^"'`\s]*\.js/.test(sw));

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
  'screens/settings/index.tsx reaches the MCP section and the permissions editor through `lazy()` (its BODIES). ' +
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
// Exactly ONE (control-tower phase 42): the sessions page and a human step's
// terminal sheet both reach the emulator through the same lazy door
// (`import('./pane')`), so they share its chunk. A second chunk carrying it is
// a second door — somebody imported xterm, or the pane, statically.
check(
  `the terminal emulator is in exactly one lazy chunk (${xtermChunks.join(', ') || 'none'})`,
  xtermChunks.length === 1,
);
const precachedXterm = xtermChunks.filter((name) => sw.includes(name));
check(
  `the precache excludes the emulator, whatever the chunk is called (${xtermChunks.join(', ') || 'none'})`,
  precachedXterm.length === 0,
  `precached: ${precachedXterm.join(', ')} — add it to globIgnores in vite.config.ts. ` +
    'A renamed emulator chunk is the usual cause; see the note in screens/sessions/pane.tsx.',
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
    "`lazy(() => import('./pane'))` in screens/sessions/session-page.tsx; a static import puts 89 KB gz " +
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
 *     so importing the helper imported the table (the helper now lives apart from it).
 *   - `LaunchDialog` — the whole run-setup surface, 77.6 KB of skill picker,
 *     MCP picker, per-phase table and zod schema — was a static import in two
 *     components the plan page mounts, both of which render it as
 *     `{open && <LaunchDialog/>}`. Rendered on a press; downloaded by everyone
 *     (now `screens/launch/door`, the one door every launch opens through).
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

// `plan-vocab-*` (shared/plan-vocab.js) shares the prefix; the page's chunk is `plan-<hash>`.
const planChunk = assets.find((name) => /^plan-(?!vocab-)[\w-]+\.js$/.test(name));
check(
  'the plan route is its own chunk (nothing to walk otherwise)',
  Boolean(planChunk),
  'screens/plan/index.tsx is `page(() => import(...))` in shell/router.tsx; if it stopped being its ' +
    'own chunk it was folded into the entry, which is a bigger problem than this check.',
);
if (planChunk) {
  const planGraph = chunkClosure(planChunk);
  const runSetup = [...planGraph].filter((name) => /^run-setup-.*\.js$/.test(name));
  check(
    `the plan route never statically pulls run-setup (${planGraph.size} chunks in its graph)`,
    runSetup.length === 0,
    `${runSetup.join(', ')} is reachable from ${planChunk} by static imports. The launch dialog must be ` +
      'reached through `LaunchDoor` (`screens/launch/door.tsx`) — never `launch-dialog` or `run-setup` directly ' +
      'from anything the plan page mounts.',
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
 *
 * The route's chunk is found by CONTENT, as the turn chunk is below: since 7.0
 * two chunks are named `repo-*` — the place (`screens/repo/index.tsx`) and its
 * data hooks (`data/repo.ts`) — and which of them sorts first is the hashes'
 * business. Taken by name, the walk below could read the hooks' four imports
 * and call the route clean (quiet-console phase 17). The place is the one that
 * names its section nav.
 */
const REPO_MARK = 'Repo sections';
const repoChunk = assets.find(
  (name) =>
    /^repo-.*\.js$/.test(name) && readFileSync(join(DIST, 'assets', name), 'utf8').includes(REPO_MARK),
);
check(
  'the repo route is its own chunk (nothing to walk otherwise)',
  Boolean(repoChunk),
  'screens/repo/index.tsx is `page(() => import(...))` in shell/router.tsx, and its chunk is the `repo-*` one ' +
    `that names its section nav ("${REPO_MARK}"). If none does, the place was folded into the entry — a bigger ` +
    'problem than this check — or the nav was renamed, and this mark goes with it.',
);
if (repoChunk) {
  check(`the precache includes the Repo place's own chunk (${repoChunk})`, sw.includes(repoChunk));
}

/*
 * The Logs place's own chunk, by the Repo rule: two chunks are named `logs-*`
 * since 7.0 — the place (`screens/logs/index.tsx`) and its data hooks
 * (`data/logs.ts`) — and the place is the one that names its section nav. The
 * offline shell must carry the PLACE: a phone that opens Logs with no network
 * is exactly the reader who needs it.
 */
const LOGS_MARK = 'Logs sections';
const logsChunk = assets.find(
  (name) =>
    /^logs-.*\.js$/.test(name) && readFileSync(join(DIST, 'assets', name), 'utf8').includes(LOGS_MARK),
);
check(
  'the logs route is its own chunk',
  Boolean(logsChunk),
  'screens/logs/index.tsx is `page(() => import(...))` in shell/router.tsx, and its chunk is the `logs-*` one ' +
    `that names its section nav ("${LOGS_MARK}"). If none does, the place was folded into the entry or the nav ` +
    'was renamed, and this mark goes with it.',
);
if (logsChunk) {
  check(`the precache includes the Logs place's own chunk (${logsChunk})`, sw.includes(logsChunk));
}
if (repoChunk) {
  const repoGraph = chunkClosure(repoChunk);
  const runSetup = [...repoGraph].filter((name) => /^run-setup-.*\.js$/.test(name));
  check(
    `the repo route never statically pulls run-setup (${repoGraph.size} chunks in its graph)`,
    runSetup.length === 0,
    `${runSetup.join(', ')} is reachable from ${repoChunk} by static imports. The Issues desk is ` +
      '`lazy()` in screens/repo/index.tsx, its plan-from-issues dialog `lazy()` in the desk, and every ' +
      'launch on it goes through `screens/launch/door` — never `run-setup` or `launch-dialog` directly ' +
      'from anything the Repo destination mounts.',
  );
}

/*
 * The Repo destination's one heavy section, by the emulator's three rules.
 *
 * The Landscape section (many-plans-one-repo phase 14) draws the repository
 * map on React Flow with a d3-dag layout — ~97 KiB gzipped by the phase-1
 * spike (`test/fixtures/spikes/react-flow-bundle.md`), behind a section most
 * readers of `#/repo` never open. `screens/repo/index.tsx` reaches
 * `screens/repo/pro/landscape-section` through `lazy()`, so the library rides in a chunk of its
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
      'reached through the `lazy()` in screens/repo/index.tsx — never `landscape-section` or `repo-map` ' +
      'statically from anything the Repo destination mounts.',
  );
}
/*
 * And the plan route, in both trees (control-tower phase 30). The route map is
 * hand-rolled — `screens/plan/map/dag.tsx`, kept over React Flow by the phase's
 * spike, which measured React Flow's pane taking a phone's vertical swipe — so
 * no map library may reach the plan chunk's static graph. Found by content, as
 * above; in the free tree nothing carries the library and the walk is short.
 */
if (planChunk) {
  const planGraph = chunkClosure(planChunk);
  const pulled = [...planGraph].filter((name) => reactFlowChunks.includes(name));
  check(
    `the plan route's static graph carries no map library (${planGraph.size} chunks walked)`,
    pulled.length === 0,
    `${pulled.join(', ')} is reachable from ${planChunk} by static imports. The plan route draws its map ` +
      'with screens/plan/map/dag.tsx; a map library there would ride into every plan page, and into the free ' +
      "tree — control-tower phase 30's handoff records why it was not adopted.",
  );
}
/*
 * The route map is the console's largest drawing and most visits to a plan read
 * the grid, so the map rides a chunk of its own (`screens/plan/map/map-view.tsx`,
 * `lazy()` in the Phases view) — quiet-console phase 10.
 */
const mapChunk = assets.find((name) => /^map-view-.*\.js$/.test(name));
check(
  'the route map is its own chunk',
  Boolean(mapChunk),
  'screens/plan/phases/view.tsx loads `../map/map-view` with `lazy()`; a static import folds the map into the plan chunk.',
);
if (planChunk && mapChunk) {
  const planGraph = chunkClosure(planChunk);
  check(
    `the plan route's static graph leaves the route map to its own chunk (${planGraph.size} chunks walked)`,
    !planGraph.has(mapChunk),
    `${mapChunk} is reachable from ${planChunk} by static imports. Only the Phases view's map reading draws it; ` +
      'reach it through `lazy()`, never a static import of `screens/plan/map/*`.',
  );
}
const precachedReactFlow = reactFlowChunks.filter((name) => sw.includes(name));
check(
  `the precache excludes React Flow, whatever the chunk is called (${reactFlowChunks.join(', ') || 'none'})`,
  precachedReactFlow.length === 0,
  `precached: ${precachedReactFlow.join(', ')} — add it to globIgnores in vite.config.ts. A renamed landscape ` +
    'chunk is the usual cause; see the Landscape note in screens/repo/index.tsx.',
);

const preloaded = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/assets\/([^"]+)"/g)].map(
  (match) => match[1],
);
const preloadedReactFlow = reactFlowChunks.filter((name) => preloaded.includes(name));
check(
  'the document never modulepreloads React Flow, whatever the chunk is called',
  preloadedReactFlow.length === 0,
  `modulepreloaded: ${preloadedReactFlow.join(', ')} — a preloaded chunk is fetched by every visitor on ` +
    'first paint. Usually a static import that should be a `lazy()`; see the Landscape note in screens/repo/index.tsx.',
);
/*
 * The same rule for the fleet app's one heavy piece.
 *
 * The pairing QR (many-plans-one-repo phase 23) is drawn by the `qrcode`
 * encoder, which nobody opening the fleet app to read an inbox needs.
 * `screens/fleet/reach.tsx` reaches it through `screens/fleet/lazy-qr`, so
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
/*
 * The Fleet place's own chunk, by the Repo rule (quiet-console phase 24): two
 * chunks are named `fleet-*` since 7.0 — the place (`screens/fleet/index.tsx`)
 * and its data door (`data/fleet.ts`) — and which sorts first is the hashes'
 * business. The place is the one that names its page (`fleet-page`); its
 * sections ride in a chunk it shares with the supervisor's own app, so the
 * offline shell must carry everything the place imports statically, not only
 * the place. In the free tree no chunk names it, and the walks below are skipped.
 */
const FLEET_MARK = 'fleet-page';
const fleetChunk = assets.find(
  (name) =>
    /^fleet-.*\.js$/.test(name) && readFileSync(join(DIST, 'assets', name), 'utf8').includes(FLEET_MARK),
);
if (fleetChunk) {
  const fleetGraph = chunkClosure(fleetChunk);
  const pulled = [...fleetGraph].filter((name) => qrChunks.includes(name));
  check(
    `the fleet chunk's static graph carries no QR encoder (${fleetGraph.size} chunks walked)`,
    pulled.length === 0,
    `${pulled.join(', ')} is reachable from ${fleetChunk} by static imports. The pairing QR must be ` +
      'reached through `screens/fleet/lazy-qr` — never `qr-code` directly from anything the fleet app mounts.',
  );
}
const precachedQr = qrChunks.filter((name) => sw.includes(name));
check(
  `the precache excludes the QR encoder, whatever the chunk is called (${qrChunks.join(', ') || 'none'})`,
  precachedQr.length === 0,
  `precached: ${precachedQr.join(', ')} — add it to globIgnores in vite.config.ts. A renamed qr-code chunk ` +
    'is the usual cause; see the note in screens/fleet/lazy-qr.tsx.',
);
const preloadedQr = qrChunks.filter((name) => preloaded.includes(name));
check(
  'the document never modulepreloads the QR encoder, whatever the chunk is called',
  preloadedQr.length === 0,
  `modulepreloaded: ${preloadedQr.join(', ')} — a preloaded chunk is fetched by every visitor on first paint. ` +
    'Usually a static import that should be a `lazy()`; see screens/fleet/lazy-qr.tsx.',
);
/*
 * The table engine, by the same three rules — and one stricter.
 *
 * `ui/grid/engine.ts` is the ONE file that imports TanStack Table, and the
 * engine is reached only through `import()` (ESLint holds both in the source),
 * by `ui/grid/grid.tsx` alone, only when a table asks for a filter, a group, a
 * pick or a window. A table with none of those — most of them — never
 * downloads it. The chunk is `engine-*`, by the file's name. Found by CONTENT: an
 * option name only the library itself spells (the client never writes it), for
 * the reason the pane check gives — a chunk name is exactly what a bundler is
 * free to change.
 *
 * Stricter than the landscape's rule, which walks named route chunks: NO chunk
 * may import the engine statically, because the grid is on almost every
 * destination and a static edge from any of them is that page carrying it.
 * It is NOT kept out of the precache: the tables it serves are on precached
 * destinations, and an offline grid that could not load its engine would draw
 * its rows unfiltered with no way to narrow them.
 */
const TABLE_ENGINE_MARK = 'maxLeafRowFilterDepth';
const engineChunks = assets.filter(
  (name) =>
    name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes(TABLE_ENGINE_MARK),
);
check(
  `the table engine is its own lazy chunk (engine-*: ${engineChunks.join(', ') || 'none'})`,
  engineChunks.some((name) => /^engine-.*\.js$/.test(name)),
  "ui/grid/grid.tsx reaches the engine through `import('./engine')`; if no engine-* chunk " +
    'carries it, it was folded into its importer — every page with a table would download it.',
);
const staticEngineImporters = assets.filter(
  (name) =>
    name.endsWith('.js') &&
    !engineChunks.includes(name) &&
    staticImportsOf(name).some((imported) => engineChunks.includes(imported)),
);
check(
  `no chunk imports the table engine statically (${staticEngineImporters.join(', ') || 'none do'})`,
  staticEngineImporters.length === 0,
  `${staticEngineImporters.join(', ')} import the engine by a static import. Only ` +
    'ui/grid/engine.ts may import @tanstack/react-table, and the grid reaches it only through `import()`.',
);
const preloadedEngine = engineChunks.filter((name) => preloaded.includes(name));
check(
  'the document never modulepreloads the table engine, whatever the chunk is called',
  preloadedEngine.length === 0,
  `modulepreloaded: ${preloadedEngine.join(', ')} — a preloaded chunk is fetched by every visitor on first paint.`,
);

/*
 * The figures, by the table engine's three rules (control-tower phase 29).
 *
 * The four figures' drawings and the run's cost strip draw with visx, in
 * `ui/figures/bars.tsx` and `ui/figures/run-chart.tsx`, behind ONE door that
 * reaches each only through `import()`: `ui/figures/lazy.tsx`.
 * The door is imported by every page that draws a figure and the Gantt sits
 * on every plan's Run view, so a static edge from either — or from anything —
 * to a drawing is visx in first paint. Found by CONTENT: the `data-figure`
 * attribute every drawing spells and nothing else in the client does. Not
 * kept out of the precache, for the engine's reason: the figures are on
 * precached destinations, and an offline Insights page that could not draw
 * would show only its tables.
 */
const FIGURES_MARK = 'data-figure';
const figureChunks = assets.filter(
  (name) => name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes(FIGURES_MARK),
);
check(
  `the figures are lazy chunks of their own (bars-*, run-chart-*: ${figureChunks.join(', ') || 'none'})`,
  figureChunks.some((name) => /^bars-.*\.js$/.test(name)) &&
    figureChunks.some((name) => /^run-chart-.*\.js$/.test(name)),
  "ui/figures/lazy.tsx reaches the bars through `import('./bars')` and the cost strip through " +
    "`import('./run-chart')`; if either chunk is gone it was folded into an importer — and the page that " +
    'imports it carries visx.',
);
const staticFigureImporters = assets.filter(
  (name) =>
    name.endsWith('.js') &&
    !figureChunks.includes(name) &&
    staticImportsOf(name).some((imported) => figureChunks.includes(imported)),
);
check(
  `no chunk imports a figure drawing statically (${staticFigureImporters.join(', ') || 'none do'})`,
  staticFigureImporters.length === 0,
  `${staticFigureImporters.join(', ')} import a figure drawing by a static import. Only ` +
    'ui/figures/lazy.tsx may reach bars.tsx and run-chart.tsx, each only through `import()`.',
);
const preloadedFigures = figureChunks.filter((name) => preloaded.includes(name));
check(
  'the document never modulepreloads a figure drawing, whatever the chunk is called',
  preloadedFigures.length === 0,
  `modulepreloaded: ${preloadedFigures.join(', ')} — a preloaded chunk is fetched by every visitor on first paint.`,
);


/*
 * Settings ▸ Accounts (one-pool phase 9): the desk is a section body the
 * Settings chunk reaches through `lazy()` (`screens/settings/index.tsx` BODIES),
 * so it is never folded into the precached Settings chunk or the entry. Found by
 * CONTENT, the test id only the section writes.
 */
const DESK_MARK = 'settings-accounts';
const deskChunks = assets.filter(
  (name) => name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes(DESK_MARK),
);
check(
  `the accounts desk is in a chunk of its own (${deskChunks.join(', ') || 'none'})`,
  deskChunks.length > 0 &&
    entryMatch !== null &&
    !deskChunks.includes(entryMatch[1]) &&
    !deskChunks.some((name) => /^settings-/.test(name)),
  'screens/settings/index.tsx reaches the Accounts section through `lazy()`; if no chunk carries settings-accounts, ' +
    'or the entry or the Settings chunk does, the desk was folded into what every visitor downloads.',
);



/*
 * Your turn (control-tower phase 137, #214): the page, its item card and its
 * guide are one lazy chunk, found by CONTENT — `data-turn-page`, the attribute
 * only the page writes. First paint sat at 189.1 of its 190 KB when the page
 * was built, and the card brings the human-step model's tables, the guide's
 * grammar and the decision card with it: in the entry, or reachable from it by
 * a static import, or modulepreloaded, every visitor would download all of it.
 */
{
  const turnChunks = assets.filter(
    (name) =>
      name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes('data-turn-page'),
  );
  check(
    `Your turn is in a chunk of its own (${turnChunks.join(', ') || 'none'})`,
    turnChunks.length > 0 && entryMatch !== null && !turnChunks.includes(entryMatch[1]),
    "Your turn is reached through the router's `page()` (a dynamic import); if no chunk carries " +
      'data-turn-page, or the entry does, it was folded into what every visitor downloads.',
  );
  if (entryMatch) {
    const firstPaint = chunkClosure(entryMatch[1]);
    const pulled = [...firstPaint].filter((name) => turnChunks.includes(name));
    check(
      `first paint's static graph carries no Your turn (${firstPaint.size} chunks walked)`,
      pulled.length === 0,
      `${pulled.join(', ')} is reachable from the entry by static imports — import screens/turn lazily.`,
    );
  }
  const preloadedTurn = turnChunks.filter((name) => preloaded.includes(name));
  check(
    'the document never modulepreloads Your turn',
    preloadedTurn.length === 0,
    `modulepreloaded: ${preloadedTurn.join(', ')} — a preloaded chunk is fetched by every visitor on first paint.`,
  );
}

/*
 * The owner key's ceremony (`data/owner.ts`, control-tower phase 148): the
 * passkey's begin and finish, and the press that asks for it again
 * (`data/press.ts`, quiet-console phase 2) reaches it through a dynamic
 * import. Found by CONTENT — the one route only the ceremony asks — so a press
 * or a card that imported it statically would put it in what every visitor
 * downloads, and a console with no key never needs a byte of it.
 */
{
  const ownerChunks = assets.filter(
    (name) =>
      name.endsWith('.js') &&
      readFileSync(join(DIST, 'assets', name), 'utf8').includes('/api/owner/assert/begin'),
  );
  check(
    `the owner key's ceremony is built (${ownerChunks.join(', ') || 'none'})`,
    ownerChunks.length > 0 && entryMatch !== null && !ownerChunks.includes(entryMatch[1]),
    'no chunk asks /api/owner/assert/begin, or the entry does — data/owner.ts was folded into first paint or lost.',
  );
  if (entryMatch) {
    const firstPaint = chunkClosure(entryMatch[1]);
    const pulled = [...firstPaint].filter((name) => ownerChunks.includes(name));
    check(
      `first paint's static graph carries no owner key ceremony (${firstPaint.size} chunks walked)`,
      pulled.length === 0,
      `${pulled.join(', ')} is reachable from the entry by static imports — reach data/owner lazily.`,
    );
  }
  const preloadedOwner = ownerChunks.filter((name) => preloaded.includes(name));
  check(
    'the document never modulepreloads the owner key ceremony',
    preloadedOwner.length === 0,
    `modulepreloaded: ${preloadedOwner.join(', ')} — a preloaded chunk is fetched by every visitor on first paint.`,
  );
}

/*
 * First paint carries no command palette (quiet-console phase 3).
 *
 * The palette is `shell/palette/palette.tsx`, on cmdk, and `App.tsx` reaches
 * it only through `lazy(() => import('@/shell/palette/palette'))`: what first
 * paint holds is the chord that opens it (`shell/palette/shortcut.ts`), never
 * the dialog. In 6.x the library rode in the kit's modulepreloaded barrel
 * chunk, so every visitor downloaded the palette's engine before the first
 * frame whether or not they ever pressed ⌘K. Found by
 * CONTENT — `cmdk-root`, the attribute cmdk renders on its root and nothing in
 * the client spells — because a chunk's name is the bundler's to change, and
 * so the combobox that shares the library is held to the same rule: built,
 * absent from first paint's static graph, never modulepreloaded.
 */
{
  const CMDK_MARK = 'cmdk-root';
  const cmdkChunks = assets.filter(
    (name) => name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes(CMDK_MARK),
  );
  check(
    `the command palette is built (${cmdkChunks.join(', ') || 'no chunk spells it'})`,
    cmdkChunks.length > 0 && entryMatch !== null && !cmdkChunks.includes(entryMatch[1]),
    `no chunk spells \`${CMDK_MARK}\`, or the entry does — shell/palette/palette.tsx was lost or folded into ` +
      'first paint. If cmdk renamed the attribute, move CMDK_MARK to another word only the library spells.',
  );
  if (entryMatch) {
    const firstPaint = chunkClosure(entryMatch[1]);
    const pulled = [...firstPaint].filter((name) => cmdkChunks.includes(name));
    check(
      `first paint carries no command palette (${firstPaint.size} chunks walked)`,
      pulled.length === 0,
      `${pulled.join(', ')} is reachable from the entry by static imports. App.tsx reaches the palette through ` +
        "`lazy(() => import('@/shell/palette/palette'))` and the shell imports only `shell/palette/shortcut`; a " +
        'first-paint import of `ui/command`, `ui/combobox` or a barrel that re-exports them carries cmdk.',
    );
  }
  const preloadedCmdk = cmdkChunks.filter((name) => preloaded.includes(name));
  check(
    'the document never modulepreloads the command palette',
    preloadedCmdk.length === 0,
    `modulepreloaded: ${preloadedCmdk.join(', ')} — a preloaded chunk is fetched by every visitor on first paint.`,
  );
}

/*
 * The status model's word tables and its icon map stay out of first paint
 * (control-tower phase 16).
 *
 * The shell's toast and banner (`ui/toast.tsx`, `ui/banner.tsx`) are on first
 * paint and draw four note severities. The typed status family (`ui/status/`)
 * draws every word of two dozen vocabularies with 98 lucide icons, and only
 * pages import it. Tree-shaking works per MODULE, not per chunk: a module that one
 * first-paint file and one page both import is placed whole in a chunk first
 * paint loads. So the notes live in modules of their own
 * (`shared/status-notes.js`, `ui/status/note-icons.ts`) — and while they did
 * not, first paint carried the whole model and all 98 icons, 8 KB served.
 * Found by CONTENT: `thermometer-snowflake`, the icon of a cooling
 * entitlement, is spelled by the word table and by that lucide icon, and by
 * nothing first paint draws.
 */
const STATUS_TABLE_MARK = 'thermometer-snowflake';
const statusTableChunks = assets.filter(
  (name) =>
    name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes(STATUS_TABLE_MARK),
);
check(
  `the status word tables are built (${statusTableChunks.join(', ') || 'no chunk spells them'})`,
  statusTableChunks.length > 0,
  `no chunk spells \`${STATUS_TABLE_MARK}\`, so the check below could not find the tables it guards. ` +
    'If the icon was renamed, move STATUS_TABLE_MARK to another word only the tables spell.',
);
const statusTablesInFirstPaint = statusTableChunks.filter(
  (name) => name === entryMatch?.[1] || preloaded.includes(name),
);
check(
  `first paint carries none of the status word tables (${statusTablesInFirstPaint.join(', ') || 'none does'})`,
  statusTablesInFirstPaint.length === 0,
  `${statusTablesInFirstPaint.join(', ')} spell \`${STATUS_TABLE_MARK}\`: a first-paint file imports ` +
    '`shared/status-model.js` or `ui/status/status-icons.ts` (or the `ui/status` barrel), and the whole ' +
    'module came along. First paint takes the notes from `shared/status-notes.js` and ' +
    '`ui/status/note-icons.ts` only.',
);

/*
 * The hover card stays out of first paint (control-tower phase 19).
 *
 * `@radix-ui/react-hover-card` came in with the 6.2 run strip's peek and left
 * with it in 7.0, uninstalled, so no chunk spells it and this check passes by
 * having nothing to find. It stays as the rule for the next one: a hover card
 * brought back through a first-paint file — the one-line barrel re-export
 * that once cost first paint 8 KB — would put it in every visitor's first
 * load. Found by
 * CONTENT: the trigger's display name, which the library spells and nothing
 * else in the client does.
 */
const PEEK_MARK = 'HoverCardTrigger';
const peekChunks = assets.filter(
  (name) => name.endsWith('.js') && readFileSync(join(DIST, 'assets', name), 'utf8').includes(PEEK_MARK),
);
const peekInFirstPaint = peekChunks.filter((name) => name === entryMatch?.[1] || preloaded.includes(name));
check(
  `first paint carries no hover card (${peekInFirstPaint.join(', ') || 'none does'})`,
  peekInFirstPaint.length === 0,
  `${peekInFirstPaint.join(', ')} spell \`${PEEK_MARK}\`: a first-paint file imports ` +
    'the hover card (or a barrel re-exports it). A hover card is for pages, reached through their routes.',
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
 *
 * 170 since 7.0 (quiet-console phase 29). The 7.0 shell imports nothing of the
 * 6.x kit on its static path — the preloaded barrel that was 37 % of the old
 * figure is gone with the old client — and first paint measured about 131 KB
 * at the release. The gate keeps the room the redesign bought and makes
 * spending it a decision, stated here.
 */
const FIRST_PAINT_SERVED = 170 * 1024;

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
 *
 * The gate was 200, then 190 (control-tower phase 18 took the grid and the
 * long list out of the 6.x kit's preloaded barrel), and is 170 since 7.0 —
 * each time set from a measured figure, never raised to make a build pass.
 * Raise it with the reason, at the constant above.
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
