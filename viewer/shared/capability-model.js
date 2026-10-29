/**
 * The capability flags — each unlocks one act, and every one defaults off.
 *
 * ONE list (quiet-console phase 2). The server builds `CAPABILITY_FLAGS` from
 * it (`server/config.ts` — the wide-bind refusal names the first one on), the
 * launch unit's writer reads it (`server/pro/unit-args.ts`), and the page
 * reads it to say which flag a disabled verb is waiting on: a row of the
 * surface registry (`client/src/data/surface.ts`) names its flag here, and
 * `/api/state` reports each flag on by the row's `field`.
 *
 * Order is the blast radius, worst first — the order a refusal names them in.
 * The session-spawning flags lead. `--allow-publish` sits right under them: it
 * is the one flag that puts this repository's WORK where other people build on
 * it, a wider act than an announcement and a narrower one than a session that
 * edits for hours. Webhooks sit below that and above writes: a webhook cannot
 * run anything, but unlike a write it leaves the machine, and on a wide bind it
 * turns an open port into somebody else's outbound request generator.
 *
 * Each row's words name its own flag and no other: the docs and skill tests
 * read this block as text, and the first flag a row names is the one it counts.
 *
 * Dependency-free ESM, like every module in `shared/`: the node suite imports
 * it directly, the server through a relative path, the client through the
 * `@shared/` alias.
 */

/**
 * A flag as the command line spells it, the field `/api/state` and the
 * server's flags report it on, and what it lets the console do. The two names
 * are strings rather than unions: the free tree's copy of this file must not
 * name the Pro flag, and a union outside the region below would.
 * @typedef {{ flag: string, field: string, act: string }} CapabilityWord
 */

/**
 * @param {string} flag
 * @param {string} field
 * @param {string} act what turning it on lets the console do
 * @returns {Readonly<CapabilityWord>}
 */
const word = (flag, field, act) => Object.freeze({ flag, field, act });

/** Every capability flag, worst blast radius first. @type {readonly Readonly<CapabilityWord>[]} */
export const CAPABILITY_WORDS = Object.freeze([
  word('--allow-run', 'allowRun', 'start unattended sessions that edit a repo for hours; switch accounts'),
  word('--allow-terminal', 'allowTerminal', 'open a real shell in the browser'),
  word('--allow-agent', 'allowAgent', 'open interactive sessions and the plan wizard'),
  word('--allow-publish', 'allowPublish', "push a finished phase's branch where the plan allows it"),
  // Picking is this flag's; a switch mid-run is a run act, `--allow-run`'s
  // (one-pool phase 7, #323; #411).
  word('--allow-accounts', 'allowAccounts', 'register Claude accounts and pick one per run'),
  word('--allow-mcp', 'allowMcp', 'register MCP servers and attach them to plans and phases'),
  word('--allow-webhooks', 'allowWebhooks', 'post every announcement to the addresses you register'),
  word('--allow-writes', 'allowWrites', 'scaffold plans and handoffs, record QA and take locks'),
]);

/** The flags alone, in the same order. @type {readonly string[]} */
export const CAPABILITY_FLAG_NAMES = Object.freeze(CAPABILITY_WORDS.map((row) => row.flag));
