/**
 * The wire of repo — the read-only git surfaces under `GET /api/repo/…`
 * (targets, graph, branches, checkouts, diff, settles, and in Pro the
 * landscape) that the Repo destination renders (measured-console phase 32).
 *
 * Two shapes are written deliberately rather than simplified, because both
 * were P8 QA findings and both change what the UI renders:
 *
 * - **`CheckoutAttribution` is a discriminated union on `via`, not a bag of
 *   optionals.** `runId`/`status`/`live` come from a run RECORD; a
 *   `via:'branch'` row is a guess from a branch NAME an operator could have
 *   picked themselves, and has none of them — so the compiler must ask `via`
 *   before anything reads `runId`.
 * - **`via` names two different vocabularies.** On a checkout it is
 *   `record | branch` — written evidence versus a guess. On a settle event it
 *   is `record | journal` — which of two sources carried the row, both real.
 */

/**
 * A repository this console will answer about: the root, a linked worktree, or a mirror mount.
 * @typedef {'root' | 'submodule' | 'linked' | 'mount'} RepoTargetKind
 */

/* ---------------- targets ---------------- */

/**
 * @typedef {object} RepoTarget
 * @property {string} key - `root`, or a path relative to the root; the ONLY way to name a target
 * @property {string} dir
 * @property {string} label
 * @property {RepoTargetKind} kind
 */

/**
 * @typedef {object} RepoTargets
 * @property {RepoTarget[]} targets
 */

/* ---------------- graph ---------------- */

/**
 * @typedef {object} RepoCommit
 * @property {string} sha
 * @property {string} short
 * @property {string[]} parents
 * @property {string[]} refs - decorations git printed for this commit: branch names, tags
 * @property {string} subject
 * @property {string} author
 * @property {string} at
 */

/**
 * @typedef {object} RepoGraph
 * @property {RepoCommit[]} commits
 * @property {string[]} tips - the refs this walk covered
 * @property {string} [trunk]
 * @property {boolean} tipsTruncated - this walk does not cover every branch it should — independent of `truncated` ("more commits"); this means "fewer branches"
 * @property {boolean} truncated
 * @property {string} [nextCursor]
 */

/* ---------------- branches ---------------- */

/**
 * @typedef {object} RepoBranch
 * @property {string} name
 * @property {string} head
 * @property {string} short
 * @property {string} [at]
 * @property {string} [subject]
 * @property {string} [author]
 * @property {string} [upstream]
 * @property {boolean} current
 * @property {number} [ahead] - absent when there is no trunk to measure against — never `0`
 * @property {number} [behind]
 * @property {boolean} trunk
 * @property {{ slug: string; phase?: number }} [run] - parsed from the NAME (`pe/<slug>` / `pe/<slug>-p<N>`), so it is a guess
 * @property {string[]} [heldBy] - working trees standing on this branch, from the registry — written evidence
 */

/**
 * @typedef {object} RepoBranches
 * @property {RepoBranch[]} branches
 * @property {string} [trunk]
 * @property {boolean} truncated
 * @property {boolean} divergenceTruncated - the ahead/behind pass was capped — some rows have no divergence, not zero
 */

/* ---------------- checkouts ---------------- */

/**
 * How this console knows whose tree that is — three arms, and there is no fourth.
 *
 * `record` is the run record: it carries the run id, its status and whether it is
 * still live. `branch` is the branch name alone, which an operator can write by
 * hand — the arm with no run id, and the reason a reclaim surface must show it.
 * @typedef {{ via: 'record'; run: { slug: string; phase?: number; runId: string; status?: string; live: boolean } }
 *   | { via: 'branch'; run: { slug: string; phase?: number } }
 *   | { via?: undefined; run?: undefined }} CheckoutAttribution
 */

/**
 * @typedef {object} RepoCheckoutTree
 * @property {string} dir
 * @property {string} repo - the repository this tree belongs to — a target key: `root`, or a submodule's path
 * @property {string} [branch]
 * @property {boolean} root - the main working tree, as opposed to a linked one
 * @property {boolean} managed - under the console's own state directory — something it created
 * @property {boolean} prunable - git still lists it and the directory is gone
 * @property {import('../worktree-model.js').CheckoutRole} role
 * @property {string} [detached] - `detached@<sha>` — a tree standing on no branch names where it stands
 */

/** @typedef {RepoCheckoutTree & CheckoutAttribution} RepoCheckout */

/**
 * @typedef {object} RepoCheckouts
 * @property {RepoCheckout[]} checkouts
 * @property {boolean} truncated - always `false`, and honestly so: this reader applies no cap
 */

/* ---------------- diff ---------------- */

/**
 * @typedef {object} RepoDiffFile
 * @property {string} path
 * @property {string} [oldPath]
 * @property {number} additions
 * @property {number} deletions
 * @property {boolean} binary
 */

/**
 * @typedef {object} RepoPatch
 * @property {string} text
 * @property {boolean} truncated
 * @property {boolean} failed - git could not answer; `text` is empty and means NOTHING
 * @property {string} path
 */

/**
 * @typedef {object} RepoDiff
 * @property {string} [base]
 * @property {string} [tip]
 * @property {RepoDiffFile[]} files
 * @property {boolean} filesTruncated
 * @property {number} fileCount
 * @property {RepoPatch} [patch]
 */

/* ---------------- settles ---------------- */

/**
 * @typedef {object} RepoSettleEvent
 * @property {string} slug
 * @property {string} runId
 * @property {string} at
 * @property {import('../worktree-model.js').SettleKind} kind
 * @property {string} [branch]
 * @property {string} [strategy]
 * @property {number} [phase]
 * @property {string} [detail]
 * @property {'record' | 'journal'} via - WHICH SOURCE carried the row — not the checkout vocabulary; both are real
 */

/**
 * @typedef {object} RepoSettles
 * @property {RepoSettleEvent[]} events
 * @property {boolean} truncated
 * @property {{ runs: number; entriesPerRun: number }} scanned - the window this history was read through — a TAIL, not the whole journal; rendered, not logged
 */


/**
 * Every route this family owns → the typedef its response is.
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/repo/targets': { response: 'RepoTargets' },
  'GET /api/repo/graph': { response: 'RepoGraph' },
  'GET /api/repo/branches': { response: 'RepoBranches' },
  'GET /api/repo/checkouts': { response: 'RepoCheckouts' },
  'GET /api/repo/diff': { response: 'RepoDiff' },
  'GET /api/repo/settles': { response: 'RepoSettles' },
});
