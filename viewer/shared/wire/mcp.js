/**
 * The wire of mcp — `/api/mcp`: the instance's MCP registry (never a secret,
 * never a path), the catalog, the probes and the guided sign-in (measured-console phase 32).
 */

/**
 * As the CLI spells them in `.mcp.json`. `streamable-http` is normalised to `http`.
 * @typedef {(typeof import('../ops-vocab.js').MCP_TRANSPORTS)[number]} McpTransport
 */

/**
 * What the CLI's own `system/init` reports for a server, plus our "never asked".
 * @typedef {(typeof import('../ops-vocab.js').MCP_STATUSES)[number]} McpStatus
 */

/**
 * A guided sign-in's step (`MCP_LOGIN_STEPS`).
 * @typedef {(typeof import('../ops-vocab.js').MCP_LOGIN_STEPS)[number]} McpLoginStep
 */

/**
 * One registered server (`server/mcp/index.ts` `McpServerView`). Carries no
 * secret and no path — the facade sees to that.
 * @typedef {object} McpServerView
 * @property {string} id
 * @property {string} label
 * @property {McpTransport} transport
 * @property {string} [url]
 * @property {string} [command]
 * @property {boolean} enabled
 * @property {{ kind: 'none' | 'oauth' | 'header' | 'env'; secrets: { ref: string; held: boolean }[] }} auth - which values it needs, and whether the console holds each; never the values
 * @property {McpStatus} status
 * @property {string} [checkedAt] - when that status was taken, so the UI can age it honestly
 * @property {string} [issue]
 * @property {number} [toolCount]
 * @property {{ min: string; held: boolean }} [pin] - the catalog's lowest version for this id, and whether the registered command holds it (phase 27)
 * @property {boolean} [untrustedOutput] - what it returns is third-party text a model reads — the catalog marks it (Context7)
 * @property {string[]} [interactiveTools] - tools an unattended run could never approve (`requiresUserInteraction`)
 * @property {{ added: string[]; removed: string[]; seenAt: string }} [toolsChanged] - the advertised tools changed since we last looked — the rug-pull flag
 * @property {string[]} [needsConfig] - `${VAR}`s its command refers to and nothing supplies: a registration nobody finished, never silently attached
 * @property {string} [source]
 * @property {string} [lastUsed]
 */

/**
 * `GET /api/mcp`: the registry with its health, the flag, and what one attached server costs.
 * @typedef {object} McpState
 * @property {McpServerView[]} servers
 * @property {boolean} allowMcp
 * @property {number} [contextTokens] - what one attached server costs every turn, in tokens — `scripts/mcp.env` `MCP_SURCHARGE`
 */

/**
 * One suggestion, from our curated list or from the official registry (`server/mcp/catalog.ts` `CatalogEntry`).
 * @typedef {object} McpCatalogEntry
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {McpTransport} transport
 * @property {string} [url]
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {'none' | 'oauth' | 'header' | 'env'} auth
 * @property {{ kind: 'header' | 'env' | 'var'; name: string; template?: string }[]} [secretRefs]
 * @property {string} [authNote]
 * @property {string} category
 * @property {string} [registryName]
 * @property {'curated' | 'registry'} source
 * @property {string} [homepage]
 * @property {{ package: string; min: string }} [pin] - the lowest version the entry runs, pinned in its command (phase 27)
 * @property {boolean} [untrustedOutput] - its output is third-party text, to be weighed and never obeyed
 */

/**
 * Where the cached copy of the official registry stands (#363).
 * @typedef {object} McpRegistryState
 * @property {'fresh' | 'stale' | 'refreshing' | 'unavailable'} state - `refreshing` — no copy yet, the first read runs; `stale` — searched as it is, read again behind
 * @property {string} [fetchedAt]
 * @property {number} count
 * @property {string} [error]
 */

/**
 * `GET /api/mcp/catalog?q=`: the entries a search found.
 * @typedef {object} McpCatalogResult
 * @property {McpCatalogEntry[]} entries
 * @property {McpRegistryState} [registry] - the registry copy this answer searched
 * @property {string} [registryError] - set when there is no registry copy to search — curated only
 */

/**
 * One guided sign-in, as `GET /api/mcp/:id/login` answers it (#372; `server/mcp/login.ts`).
 * @typedef {object} McpLoginFlow
 * @property {string} server
 * @property {'embedded' | 'external' | 'command'} mode
 * @property {boolean} remote - the person is not at the machine: the flow takes the browser's address pasted back
 * @property {McpLoginStep} step
 * @property {string} startedAt
 * @property {string} deadline - when the CLI gives up — five minutes after the start
 * @property {string} [authUrl] - the sign-in page, once the CLI printed it
 * @property {string} [sessionId]
 * @property {string} command
 * @property {boolean} [bridged] - this console wrote the definition the sign-in resolves, and owes it back (the server sends it; no page reads it)
 * @property {string[]} [commands]
 * @property {string} [configDir]
 * @property {string} [accountLabel]
 * @property {string} [detail] - why it failed or timed out, naming the step
 * @property {number} [exitCode]
 * @property {string} [pastedAt]
 * @property {string} [endedAt]
 */

/**
 * `POST /api/mcp/:id/login`: the multi-modal outcome of starting `claude mcp login` — as accounts do it.
 * @typedef {object} McpLoginStart
 * @property {string} id
 * @property {string} command
 * @property {'embedded' | 'external' | 'command'} mode
 * @property {{ sessionId: string; token: string; expiresAt: number }} [terminal]
 * @property {string} [detail]
 * @property {string} [configDir] - the `CLAUDE_CONFIG_DIR` the token lands in — shown rather than assumed (issue #8)
 * @property {string} [accountLabel]
 * @property {string[]} [commands] - set ONLY when no flow could start: the commands that would work run by hand
 * @property {McpLoginFlow} [flow] - the guided flow the sheet walks (#372); this server answers one on every start, a server before #372 none
 */

/**
 * `POST /api/mcp`'s body: a registration — the catalog entry's fields or a hand-written one, validated by the server.
 * @typedef {Record<string, unknown>} McpAddBody
 */

/**
 * `PATCH /api/mcp/:id`'s body: switched on or off, renamed, a secret stored under the ref it names.
 * @typedef {object} McpPatchBody
 * @property {boolean} [enabled]
 * @property {string} [label]
 * @property {{ kind: string; name: string }} [secretRef]
 * @property {string} [secret]
 * @property {Record<string, string>} [vars] - a value for each `${VAR}` the registration writes and nothing supplies (#363)
 */

/**
 * `POST /api/mcp/:id/login`'s body: the PROFILE account whose config dir the token lands in; absent, this console's own.
 * @typedef {object} McpLoginBody
 * @property {string} [accountId]
 */

/**
 * `POST /api/mcp/:id/login/paste`'s body: the address the browser landed on.
 * @typedef {object} McpLoginPasteBody
 * @property {string} url
 */

/**
 * `POST /api/mcp` and `PATCH /api/mcp/:id`: the server as it now is.
 * @typedef {{ server: McpServerView }} McpServerAnswer
 */

/**
 * `POST /api/mcp/refresh`: every server, re-probed.
 * @typedef {{ servers: McpServerView[] }} McpServersAnswer
 */

/**
 * `DELETE /api/mcp/:id`: whether a registration went.
 * @typedef {{ removed: boolean }} McpRemoveAnswer
 */

/**
 * `GET /api/mcp/:id/login` and `POST /api/mcp/:id/login/paste`: the guided sign-in as it stands.
 * @typedef {{ flow: McpLoginFlow }} McpFlowAnswer
 */

/**
 * `POST /api/mcp/:id/acknowledge`: whether there was a rug-pull flag to clear.
 * @typedef {{ acknowledged: boolean }} McpAcknowledgeAnswer
 */

/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/mcp': { response: 'McpState' },
  'GET /api/mcp/catalog': { response: 'McpCatalogResult' },
  'POST /api/mcp/refresh': { response: 'McpServersAnswer' },
  'POST /api/mcp': { response: 'McpServerAnswer', body: 'McpAddBody' },
  'DELETE /api/mcp/:id': { response: 'McpRemoveAnswer' },
  'PATCH /api/mcp/:id': { response: 'McpServerAnswer', body: 'McpPatchBody' },
  'POST /api/mcp/:id/login': { response: 'McpLoginStart', body: 'McpLoginBody' },
  'GET /api/mcp/:id/login': { response: 'McpFlowAnswer' },
  'POST /api/mcp/:id/login/paste': { response: 'McpFlowAnswer', body: 'McpLoginPasteBody' },
  'POST /api/mcp/:id/acknowledge': { response: 'McpAcknowledgeAnswer' },
});
