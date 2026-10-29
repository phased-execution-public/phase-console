/**
 * Servers worth suggesting, and where to find the rest.
 *
 * Two sources, in that order of trust:
 *
 *  1. **The shipped list below.** Small, curated, and every entry's endpoint or
 *     package was verified reachable when it was added. It works offline, which
 *     matters because the console is a localhost tool and the catalog is most
 *     useful exactly when somebody is setting a machine up.
 *  2. **The official registry** at `registry.modelcontextprotocol.io`, read
 *     whole into a cached copy in the background and searched locally
 *     (`RegistryCatalog`, #363). Thousands of servers, published by anyone. Results are marked
 *     as such and never merged into the curated set, because "in the registry"
 *     is a statement about publication, not about trust.
 *
 * A network failure degrades to the curated list with a note. It is never an
 * error page: the operator's actual job — add a server I already know I want —
 * does not depend on the registry being up.
 *
 * **Keep the list SHORT.** Every attached server costs context on every turn
 * and adds a name that can collide with another server's tools; the practical
 * advice the ecosystem has converged on is three to six, not fifteen. A catalog
 * that reads like an app store invites the opposite. Entries earn their place
 * by being the ones a coding agent actually reaches for.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from '../log.ts';
import { MCP_DIR, type McpSecretRef, type McpTransport } from './store.ts';

export type CatalogEntry = {
  /** The id this would register under, and the token a plan would name. */
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  /** `oauth` needs `claude mcp login`; `header`/`env` need a value from us. */
  auth: 'none' | 'oauth' | 'header' | 'env';
  secretRefs?: McpSecretRef[];
  /** What the operator would have to fetch, when `auth` is not `none`/`oauth`. */
  authNote?: string;
  /** Grouping in the picker. Free text, not a schema. */
  category: string;
  /** The registry's own name, when this came from there rather than from us. */
  registryName?: string;
  source: 'curated' | 'registry';
  homepage?: string;
  /**
   * The lowest version this entry may run (measured-console phase 27, D8): its
   * package spec in `args` carries `>=<min>`, and a registered server whose
   * command does not is drawn as not pinned (`pinOf`).
   */
  pin?: { package: string; min: string };
  /**
   * What the server returns is third-party text a model will read — Context7's
   * library docs are written by each library's owners ("ContextCrush") — so the
   * page marks it, and a session should weigh it as a claim, never an instruction.
   */
  untrustedOutput?: boolean;
};

const BEARER: McpSecretRef = { kind: 'header', name: 'Authorization', template: 'Bearer {}' };

/**
 * The curated set. Endpoints below were each confirmed to answer an MCP
 * `initialize` (401 for the OAuth ones, 200 for the open ones) and each npm
 * package confirmed to exist, on 2026-08-09. Re-check before adding to it.
 */
export const CURATED: Omit<CatalogEntry, 'source'>[] = [
  // ---- the ones a coding agent reaches for most --------------------------
  {
    id: 'github', label: 'GitHub', category: 'Code & review',
    description: 'Read and comment on pull requests, search code across repos, triage issues, '
      + 'inspect failing CI runs.',
    transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    auth: 'header', secretRefs: [BEARER],
    authNote: 'A fine-grained personal access token scoped to the repositories Claude may touch — '
      + 'github.com/settings/personal-access-tokens.',
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'playwright', label: 'Playwright', category: 'Browser',
    description: 'Drive a real browser through the accessibility tree — navigate, click, fill, read '
      + 'the page. Turns "I made the change" into "I made the change and watched it render".',
    // `--isolated` (measured-console phase 27, D8): a fresh in-memory browser
    // profile per session, so two lanes never share one profile's cookies or
    // lock — every console lane spawns its own server.
    transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--isolated'],
    auth: 'none', homepage: 'https://playwright.dev/docs/getting-started-mcp',
  },
  {
    id: 'context7', label: 'Context7', category: 'Docs',
    description: 'Version-specific documentation for libraries and frameworks, fetched on demand '
      + 'instead of recalled from training.',
    // The package, pinned at or above 2.1.3 (measured-console phase 27, D8) —
    // the hosted endpoint carries no version a console could hold — and its
    // output marked untrusted. npm read 2026-10-28: latest 4.4.4.
    transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@>=2.1.3'],
    pin: { package: '@upstash/context7-mcp', min: '2.1.3' }, untrustedOutput: true,
    auth: 'none', homepage: 'https://context7.com',
  },
  {
    id: 'chrome-devtools', label: 'Chrome DevTools', category: 'Browser',
    description: 'Performance traces, console, network and the DOM of a running Chrome — debugging '
      + 'a page rather than merely driving it.',
    transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'],
    auth: 'none', homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
  {
    id: 'sentry', label: 'Sentry', category: 'Observability',
    description: 'The errors your application actually reported: stack traces, frequency, and which '
      + 'deployment introduced them.',
    transport: 'http', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth',
    homepage: 'https://mcp.sentry.dev',
  },
  {
    id: 'linear', label: 'Linear', category: 'Issue tracking',
    description: 'Issues, projects, comments and cycles — so a phase can start from the ticket that '
      + 'asked for it.',
    transport: 'http', url: 'https://mcp.linear.app/mcp', auth: 'oauth',
    homepage: 'https://linear.app/docs/mcp',
  },

  // ---- knowledge and search ----------------------------------------------
  {
    id: 'deepwiki', label: 'DeepWiki', category: 'Docs',
    description: 'Ask questions about any public GitHub repository and get answers grounded in its '
      + 'code — useful for a dependency you have to understand but do not own.',
    transport: 'http', url: 'https://mcp.deepwiki.com/mcp', auth: 'none',
    homepage: 'https://deepwiki.com',
  },
  {
    id: 'huggingface', label: 'Hugging Face', category: 'Docs',
    description: 'Models, datasets, papers and Spaces on the Hub.',
    transport: 'http', url: 'https://huggingface.co/mcp', auth: 'none',
    homepage: 'https://huggingface.co/settings/mcp',
  },

  // ---- product surfaces ---------------------------------------------------
  {
    id: 'notion', label: 'Notion', category: 'Docs',
    description: 'Pages, databases, comments and workspace search.',
    transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth',
    homepage: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'figma', label: 'Figma', category: 'Design',
    description: 'Files, designs and Dev Mode context — the source of truth a UI phase is supposed '
      + 'to be implementing.',
    transport: 'http', url: 'https://mcp.figma.com/mcp', auth: 'oauth',
    homepage: 'https://www.figma.com/developers/mcp',
  },
  {
    id: 'atlassian', label: 'Jira & Confluence', category: 'Issue tracking',
    description: 'Atlassian’s own endpoint for Jira issues and Confluence pages.',
    transport: 'sse', url: 'https://mcp.atlassian.com/v1/sse', auth: 'oauth',
    homepage: 'https://support.atlassian.com/atlassian-rovo-mcp-server/',
  },

  // ---- infrastructure -----------------------------------------------------
  {
    id: 'vercel', label: 'Vercel', category: 'Infrastructure',
    description: 'Deployments, build logs, runtime errors and project configuration.',
    transport: 'http', url: 'https://mcp.vercel.com', auth: 'oauth',
    homepage: 'https://vercel.com/docs/mcp/vercel-mcp',
  },
  {
    id: 'supabase', label: 'Supabase', category: 'Data',
    description: 'Projects, database schema and docs.',
    transport: 'http', url: 'https://mcp.supabase.com/mcp', auth: 'oauth',
    homepage: 'https://supabase.com/docs/guides/getting-started/mcp',
  },
  {
    id: 'cloudflare-docs', label: 'Cloudflare docs', category: 'Docs',
    description: 'Cloudflare’s documentation, searchable. No account needed.',
    transport: 'http', url: 'https://docs.mcp.cloudflare.com/mcp', auth: 'none',
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  },
  {
    id: 'grafana', label: 'Grafana', category: 'Observability',
    description: 'Dashboards, datasources, Prometheus and Loki queries, incidents.',
    transport: 'http', url: 'https://mcp.grafana.com/mcp', auth: 'oauth',
    homepage: 'https://grafana.com/docs/grafana/latest/observability-as-code/mcp-server/',
  },

  // ---- local, no network --------------------------------------------------
  {
    id: 'postgres', label: 'PostgreSQL (DBHub)', category: 'Data',
    description: 'Query a relational database through a connection string. Point it at a READ-ONLY '
      + 'user — an unattended run should not be able to write to your database.',
    transport: 'stdio', command: 'npx',
    args: ['-y', '@bytebase/dbhub', '--dsn', '${DATABASE_URL}'],
    auth: 'env',
    authNote: 'Set DATABASE_URL in the console’s own environment before starting it — a read-only DSN.',
    homepage: 'https://github.com/bytebase/dbhub',
  },
  {
    id: 'filesystem', label: 'Filesystem', category: 'Local',
    description: 'Read and write files under directories you name. Rarely worth attaching: Claude '
      + 'Code already has Read, Write and Edit scoped to the working tree.',
    transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT}'],
    auth: 'env',
    authNote: 'Set MCP_FS_ROOT to the directory this server may see.',
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'memory', label: 'Memory', category: 'Local',
    description: 'A knowledge graph the session can write to and read back — persistent notes across '
      + 'phases, in a plan whose phases genuinely need to share findings.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
    auth: 'none', homepage: 'https://github.com/modelcontextprotocol/servers',
  },
];

/** The curated list, filtered by a search string over id, label and description. */
export function searchCurated(query: string): CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  const all = CURATED.map((entry) => ({ ...entry, source: 'curated' as const }));
  if (!needle) return all;
  return all.filter((entry) =>
    entry.id.includes(needle)
    || entry.label.toLowerCase().includes(needle)
    || entry.category.toLowerCase().includes(needle)
    || entry.description.toLowerCase().includes(needle));
}

/** Where the registry half of the catalog stands, said with the answer. */
export type RegistryState = {
  /**
   * `fresh` — read within `REGISTRY_TTL_MS`; `stale` — older, a refresh is
   * running behind; `refreshing` — no copy yet, the first read is running;
   * `unavailable` — no copy, and the last read failed (`error` says why).
   */
  state: 'fresh' | 'stale' | 'refreshing' | 'unavailable';
  /** When the copy searched was read from the registry. */
  fetchedAt?: string;
  /** How many servers the copy holds. */
  count: number;
  /** The last read's failure, when it failed. */
  error?: string;
};

export type CatalogResult = {
  entries: CatalogEntry[];
  /** The registry copy this answer searched, and whether it is being read again. */
  registry?: RegistryState;
  /** Set when there is no registry copy to search — the entries are curated only. */
  registryError?: string;
};

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

/**
 * The registry is read whole, a page at a time, and searched HERE (#363).
 *
 * Its own search (`?search=`) is slow at the registry — 13.7 to 29.8 s
 * measured on 2026-10-14 — while a bare page answers in well under three, so
 * the 8 s timeout the search ran under failed every query and the catalog
 * never found anything outside the curated list. Paging the list into a cache
 * costs a minute in the background once a day, and a search is then a read of
 * a local file: no network, no timeout, on the request path never.
 */
export const REGISTRY_CACHE_FILE = join(MCP_DIR, 'registry.json');
/** A copy younger than this is searched as it is; an older one is read again behind. */
export const REGISTRY_TTL_MS = 24 * 60 * 60_000;
/** One page's wall clock — a page, never a search, so a slow one is a slow registry. */
export const REGISTRY_PAGE_TIMEOUT_MS = 30_000;
/** Servers per page: the registry's own ceiling. */
const REGISTRY_PAGE_LIMIT = 100;
/** A bound on the walk, so a cursor that never ends cannot read for ever. */
const REGISTRY_MAX_PAGES = 400;
/** How many registry matches one answer carries. */
const REGISTRY_RESULT_LIMIT = 50;

type RegistryCacheFile = {
  version: 1;
  fetchedAt: string;
  /** False when the walk stopped at its page bound. */
  complete: boolean;
  entries: CatalogEntry[];
};

/**
 * The registry, cached at `<instance state>/mcp/registry.json`.
 *
 * Single-flight: one read of the registry at a time, whoever asks. A read
 * that fails keeps the copy it would have replaced, so a registry that is down
 * today costs a day-old answer rather than none. A cache that cannot be read
 * is no copy at all, never an error.
 */
export class RegistryCatalog {
  private readonly file: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private copy: RegistryCacheFile | null | undefined;
  private inFlight: Promise<void> | null = null;
  private lastError: string | undefined;

  constructor(opts: { file?: string; fetchFn?: typeof fetch; now?: () => number; ttlMs?: number } = {}) {
    this.file = opts.file ?? REGISTRY_CACHE_FILE;
    this.fetchFn = opts.fetchFn ?? ((...args) => fetch(...args));
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? REGISTRY_TTL_MS;
  }

  /** The copy on disk, read once and kept. */
  private read(): RegistryCacheFile | null {
    if (this.copy !== undefined) return this.copy;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as RegistryCacheFile;
      this.copy = parsed?.version === 1 && Array.isArray(parsed.entries) && typeof parsed.fetchedAt === 'string'
        ? parsed : null;
    } catch {
      this.copy = null;
    }
    return this.copy;
  }

  /** Where the copy stands — what every answer says beside its entries. */
  state(): RegistryState {
    const copy = this.read();
    if (!copy) {
      return this.inFlight
        ? { state: 'refreshing', count: 0 }
        : { state: 'unavailable', count: 0, ...(this.lastError ? { error: this.lastError } : {}) };
    }
    const stale = this.now() - Date.parse(copy.fetchedAt) >= this.ttlMs;
    return {
      state: stale ? 'stale' : 'fresh',
      fetchedAt: copy.fetchedAt,
      count: copy.entries.length,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /**
   * Start a read of the registry behind the caller when the copy is missing
   * or old, and return at once. True when one was started.
   */
  ensureFresh(): boolean {
    if (this.inFlight) return false;
    const copy = this.read();
    if (copy && this.now() - Date.parse(copy.fetchedAt) < this.ttlMs) return false;
    void this.refresh();
    return true;
  }

  /** Read the whole registry, page by page, and replace the copy. Shared by concurrent callers. */
  refresh(): Promise<void> {
    this.inFlight ??= this.walk().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async walk(): Promise<void> {
    const started = this.now();
    // Seeded from the WHOLE curated list. `known` is a collision guard on the
    // id a server would register under: a registry row never takes a name out
    // of the curated namespace (a third party's server published as `github`
    // would otherwise resolve every plan naming `github` to somebody else's
    // command), and the first row to claim any other id keeps it.
    const known = new Set(CURATED.map((entry) => entry.id));
    const entries: CatalogEntry[] = [];
    let cursor: string | undefined;
    let pages = 0;
    try {
      do {
        // `version=latest` matters: without it the registry returns every
        // published version of every server and the list reads as duplicates.
        const url = `${REGISTRY_URL}?version=latest&limit=${REGISTRY_PAGE_LIMIT}`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const response = await this.fetchFn(url, { signal: AbortSignal.timeout(REGISTRY_PAGE_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`the registry answered ${response.status}`);
        const body = await response.json() as { servers?: unknown; metadata?: { nextCursor?: unknown } };
        for (const row of Array.isArray(body?.servers) ? body.servers : []) {
          const entry = fromRegistry(row);
          if (entry && !known.has(entry.id)) {
            known.add(entry.id);
            entries.push(entry);
          }
        }
        const next = body?.metadata?.nextCursor;
        cursor = typeof next === 'string' && next && next !== cursor ? next : undefined;
        pages += 1;
      } while (cursor && pages < REGISTRY_MAX_PAGES);
    } catch (error) {
      // Degrade, never fail: the copy we have stays, and the curated list is
      // the answer to most questions anyway.
      this.lastError = (error as Error).message;
      log.warn('mcp.catalog.refresh-failed', { error: this.lastError, pages, servers: entries.length });
      return;
    }
    const copy: RegistryCacheFile = {
      version: 1,
      fetchedAt: new Date(this.now()).toISOString(),
      complete: !cursor,
      entries,
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(copy)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      // The copy is still good in memory; the next console start reads again.
      log.warn('mcp.catalog.write-failed', { error: (error as Error).message });
    }
    this.copy = copy;
    this.lastError = undefined;
    log.info('mcp.catalog.refreshed', { pages, servers: entries.length, ms: Math.max(0, this.now() - started), complete: copy.complete });
  }

  /** The copy's matches for a query, best first. Empty when there is no copy or no query. */
  search(query: string, limit = REGISTRY_RESULT_LIMIT): CatalogEntry[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const copy = this.read();
    if (!copy || !words.length) return [];
    const scored: { entry: CatalogEntry; score: number }[] = [];
    for (const entry of copy.entries) {
      const id = entry.id;
      const label = entry.label.toLowerCase();
      const name = (entry.registryName ?? '').toLowerCase();
      const text = `${id} ${label} ${name} ${entry.description.toLowerCase()}`;
      if (!words.every((word) => text.includes(word))) continue;
      const first = words[0]!;
      const score = id === first || label === first ? 0
        : id.startsWith(first) || label.startsWith(first) ? 1
          : id.includes(first) || label.includes(first) || name.includes(first) ? 2 : 3;
      scored.push({ entry, score });
    }
    scored.sort((a, b) => a.score - b.score || a.entry.id.localeCompare(b.entry.id));
    return scored.slice(0, limit).map((item) => item.entry);
  }
}

/** The console's one copy of the registry. */
export const registryCatalog = new RegistryCatalog();

/**
 * Curated matches first, then the registry copy's.
 *
 * Never waits on the network: the registry half is the cached copy, and a
 * missing or old copy is read again BEHIND this answer — the answer says so
 * (`registry.state`), and the page asks again once the read is done.
 */
export async function searchCatalog(
  query: string,
  opts: { limit?: number; includeRegistry?: boolean; registry?: RegistryCatalog } = {},
): Promise<CatalogResult> {
  const curated = searchCurated(query);
  if (opts.includeRegistry === false) return { entries: curated };
  const registry = opts.registry ?? registryCatalog;
  registry.ensureFresh();
  const state = registry.state();
  const found = query.trim() ? registry.search(query, Math.min(opts.limit ?? REGISTRY_RESULT_LIMIT, 100)) : [];
  return {
    entries: [...curated, ...found],
    registry: state,
    ...(state.state === 'unavailable' && state.error ? { registryError: state.error } : {}),
  };
}

type RegistryRow = {
  server?: {
    name?: unknown;
    title?: unknown;
    description?: unknown;
    websiteUrl?: unknown;
    repository?: unknown;
    remotes?: unknown;
    packages?: unknown;
  };
};

/**
 * One registry row → a catalog entry, or null when we cannot start it.
 *
 * Remotes are preferred over packages: an HTTP endpoint needs no install and
 * supports OAuth, while a package means running somebody's code locally. A row
 * offering neither is skipped rather than shown as something that cannot be added.
 */
function fromRegistry(row: unknown): CatalogEntry | null {
  const server = (row as RegistryRow)?.server;
  if (!server || typeof server.name !== 'string') return null;

  // Registry names are reverse-DNS (`io.github.owner/server`); the last segment
  // is what a person would call it and what our id rules accept.
  const id = server.name.split('/').pop()?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) ?? '';
  if (!id) return null;

  const label = typeof server.title === 'string' && server.title.trim() ? server.title : id;
  const description = typeof server.description === 'string' ? server.description : '';
  // Many registry rows carry only a repository; it is the docs link then (#363).
  const repository = (server.repository as { url?: unknown } | undefined)?.url;
  const homepage = typeof server.websiteUrl === 'string' ? server.websiteUrl
    : typeof repository === 'string' && /^https:\/\//.test(repository) ? repository : undefined;

  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  for (const remote of remotes as { type?: unknown; url?: unknown; headers?: unknown }[]) {
    if (typeof remote?.url !== 'string') continue;
    const raw = typeof remote.type === 'string' ? remote.type : 'http';
    const transport: McpTransport = raw === 'sse' ? 'sse' : raw === 'ws' ? 'ws' : 'http';
    const headers = Array.isArray(remote.headers) ? remote.headers : [];
    const secret = (headers as { name?: unknown; isSecret?: unknown }[])
      .find((header) => header?.isSecret === true && typeof header.name === 'string');
    return {
      id, label, description, transport, url: remote.url,
      auth: secret ? 'header' : 'oauth',
      ...(secret ? { secretRefs: [{ kind: 'header' as const, name: String(secret.name) }] } : {}),
      category: 'From the registry', registryName: server.name, source: 'registry',
      ...(homepage ? { homepage } : {}),
    };
  }

  const packages = Array.isArray(server.packages) ? server.packages : [];
  for (const pkg of packages as { registryType?: unknown; identifier?: unknown; runtimeHint?: unknown }[]) {
    if (typeof pkg?.identifier !== 'string') continue;
    if (pkg.registryType !== 'npm') continue;   // pypi/oci would need a different runner
    return {
      id, label, description, transport: 'stdio',
      command: typeof pkg.runtimeHint === 'string' ? pkg.runtimeHint : 'npx',
      args: ['-y', pkg.identifier],
      auth: 'none',
      category: 'From the registry', registryName: server.name, source: 'registry',
      ...(homepage ? { homepage } : {}),
    };
  }

  return null;
}

/**
 * A registered server's pin, against the curated entry of the same id
 * (measured-console phase 27): `held` when its command still names the
 * package at `>=<min>`. Undefined for a server the catalog pins nothing for.
 */
export function pinOf(id: string, args: readonly string[] | undefined): { min: string; held: boolean } | undefined {
  const pin = CURATED.find((entry) => entry.id === id)?.pin;
  if (!pin) return undefined;
  return { min: pin.min, held: (args ?? []).includes(`${pin.package}@>=${pin.min}`) };
}

/** Whether the curated entry of this id marks its output untrusted. */
export function untrustedOutputOf(id: string): boolean {
  return CURATED.find((entry) => entry.id === id)?.untrustedOutput === true;
}
