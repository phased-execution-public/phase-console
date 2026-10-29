/**
 * The wire of the Logs destination (Debug until 7.0, and its routes keep the name) — the log
 * index and its follow stream, the bundle, the retention table, the log level, the doctor, Health
 * over time, and (Pro) a run's trace and its git commands (measured-console phase 32).
 */

/**
 * Where a row came from — the server's list, in the server's order.
 * @typedef {'console' | 'supervisor' | 'journal' | 'outcome' | 'ruling' | 'delivery' | 'health'} DebugSource
 */
/** @typedef {'info' | 'warn' | 'error'} DebugLevel */
/**
 * One row, whatever it came from. `at` is `''` when the source had no time.
 * @typedef {object} DebugEntry
 * @property {DebugSource} source
 * @property {string} at
 * @property {DebugLevel} level
 * @property {string} event
 * @property {string} text
 * @property {string} [slug]
 * @property {string} [runId]
 * @property {number} [phase]
 * @property {string} [traceId] - The correlation ids the source line carried (envelope v2). Absent on a v1 line and never invented — "this predates the ids" and "this was written outside every span" are both real answers.
 * @property {string} [spanId]
 * @property {Record<string, unknown>} [data]
 */
/**
 * Whether a source could be read, and why not.
 *
 * `available: false` with a `note` is an ANSWER — "there is no supervisor log
 * on this machine" — and the page must render it as one. An absent note on an
 * unavailable source means the reason is structural and stated elsewhere.
 * @typedef {object} DebugSourceStatus
 * @property {DebugSource} source
 * @property {boolean} available
 * @property {string} [path]
 * @property {number} count
 * @property {string} [note]
 */
/**
 * @typedef {object} DebugIndex
 * @property {DebugEntry[]} entries
 * @property {DebugSourceStatus[]} sources
 * @property {boolean} truncated - The limit cut the answer. The page says so rather than implying "all".
 * @property {string[]} slugs - The plans this answer covers — bounded when no slug was named.
 * @property {DeliveryTally} [delivery] - Present when the read included the `delivery` source. The SERVER's tally, not a client re-derivation: `undelivered` counts an announcement no device took, which is a different question from how many rows said `failed`, and two implementations of that rule would be two answers.
 */
/**
 * @typedef {object} DebugRuns
 * @property {string} slug
 * @property {string[]} runs
 */
/**
 * @typedef {object} MetricSample
 * @property {Record<string, string>} labels
 * @property {number} value
 */
/**
 * @typedef {object} MetricFamily
 * @property {string} name
 * @property {string} type
 * @property {string} help
 * @property {MetricSample[]} samples
 */
/**
 * @typedef {object} DeliveryTally
 * @property {Record<string, number>} outcomes - One count per outcome word actually seen — `sent`, `quiet`, `failed`, …
 * @property {number} undelivered - Announcements no device took. Not the same as the `failed` count.
 * @property {number} announcements
 * @property {number} devices
 */
/**
 * @typedef {object} DebugBundle
 * @property {string} schema
 * @property {number} version
 * @property {string} generatedAt
 * @property {Record<string, unknown>} console
 * @property {string | null} root
 * @property {{ slug: string; runs: string[] }[]} plans
 * @property {{ environment: { kind: string; detail: string; fix: string }[]; watches: { passes: number; asked: string[]; open: boolean } | null }} health
 * @property {MetricFamily[]} metrics
 * @property {DeliveryTally} delivery
 * @property {DebugEntry[]} entries
 * @property {DebugSourceStatus[]} sources
 * @property {string[]} notes - What was left out, and how to ask for it.
 */
/**
 * `GET /api/doctor` — the run-start prelude's probes and the machine checks,
 * the same report `phase-console doctor` prints (`server/doctor.ts`). A row
 * whose `blocking` is true fails the report; `firstFailing` is the one to fix
 * first, and the page leads with it.
 * @typedef {object} DoctorRow
 * @property {string} id
 * @property {string} label
 * @property {import('../ops-vocab.js').ProbeStatus} status
 * @property {boolean} blocking
 * @property {string} reason
 * @property {string[]} [warnings]
 */
/**
 * @typedef {object} DoctorReport
 * @property {{ id: string; name: string; root: string | null; port: number; default: boolean } | null} instance
 * @property {'console' | 'offline'} mode
 * @property {DoctorRow[]} rows
 * @property {boolean} ok
 * @property {DoctorRow | null} firstFailing
 * @property {string} cliFloor
 * @property {string} at
 */
/**
 * `GET /api/debug/level` — how loud this console's own log is, and until when.
 * An override reverts by itself at `until`; `null` means the configured level.
 * @typedef {object} DebugLevelState
 * @property {string} level
 * @property {string | null} [debug]
 * @property {'override' | 'env'} source - `override` while a person's change stands; `env` once it reverted, or never was.
 * @property {number} [until] - Epoch ms the override reverts at — present only on `override`.
 * @property {readonly string[]} levels
 */
/**
 * One sink's live size, its policy row, and how many files the next sweep would touch.
 * @typedef {{ sink: string; files: number; bytes: number; due: number }} RetentionSinkReport
 */
/**
 * @typedef {{ kind: 'delete' | 'rotate' | 'truncate' | 'oversized' | 'prune'; sink: string; path: string; bytes: number; keepBytes?: number; keepAfter?: number; why: string }} RetentionAction
 */
/**
 * @typedef {{ at: string; policy: Record<string, number>; sinks: RetentionSinkReport[]; bytes: number; actions: RetentionAction[] }} RetentionReport
 */
/**
 * One measure's points over time — Logs ▸ Health's series (measured-console phase 31, F2).
 * @typedef {{ at: string; v: number; note?: string }} HealthSeriesPointView
 */
/**
 * `GET /api/health/series`: gate seconds, load per core, persist ms and (Pro) the reconciliation's delta %.
 * @typedef {{ from: string; to: string; bounds: { maxPoints: number; days: number; sampleMs: number }; measures: Record<'gate' | 'load' | 'persist' | 'reconcile', HealthSeriesPointView[]> }} HealthSeriesView
 */
/**
 * `POST /api/debug/level` — the floor, the channels written whatever it is, and for how long; the
 * server reverts it by itself at the deadline.
 * @typedef {object} DebugLevelBody
 * @property {string} [level]
 * @property {string} [debug] - A csv of event prefixes (`git, runner`) or `*`; empty clears every channel for the change's life.
 * @property {number} [ttlMs]
 */

/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/debug/retention': { response: 'RetentionReport' },
  'GET /api/debug/level': { response: 'DebugLevelState' },
  'DELETE /api/debug/level': { response: 'DebugLevelState' },
  'POST /api/debug/level': { response: 'DebugLevelState', body: 'DebugLevelBody' },
  'GET /api/debug/index': { response: 'DebugIndex' },
  'GET /api/debug/runs': { response: 'DebugRuns' },
  'GET /api/debug/bundle': { response: 'DebugBundle' },
  'GET /api/debug/tail': { response: 'WireOpaque' },
});
