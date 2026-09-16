/**
 * The MCP facade — every answer that leaves this module is already redacted.
 *
 * Same boundary discipline as `accounts/index.ts`: a route never reaches into
 * the store, never touches `credentials.ts`, and never has to remember to strip
 * something. `McpServerView` is what the browser is allowed to know, and it is
 * constructed in exactly one place.
 *
 * What this module is responsible for, beyond CRUD:
 *
 *  - **Health, cached.** Probing costs a process, so a set is probed once and
 *    the answer is reused with its age attached. Stale-with-an-age is always
 *    preferable to an error: the runner's own failure classifier works fine
 *    with health unavailable, and a console that refuses to render because a
 *    probe timed out would be worse than one that says "as of four minutes ago".
 *  - **The rug-pull check.** Every probe fingerprints what each server
 *    advertised. A server whose tool list changes under a plan that already
 *    trusted it is the documented MCP supply-chain attack, and the only defence
 *    a client can offer is to have written down what it used to be.
 *  - **The unattended-safety check.** A tool marked
 *    `anthropic/requiresUserInteraction` can never be approved in `claude -p`
 *    (the CLI converts an allow from a prompt tool into a deny), so a run that
 *    depends on one is a run that will stall. Named at attach time, not at 3am.
 */

import { realExec, type Exec } from '../accounts/credentials.ts';
import { log } from '../log.ts';
import { doorActor } from '../actor.ts';
import type { Actor, StartDoor } from '../runner/state.ts';
import { buildMcpConfig, redactConfig, writeMcpConfigFile, type McpConfigDoc } from './config.ts';
import { McpCredentials, refKey } from './credentials.ts';
import { blocksBoarding, probeMcp, type McpHealth, type McpProbe, type McpStatus } from './health.ts';
import {
  assertUsableId, McpStore, normaliseTransport,
  type McpSecretRef, type McpServerMeta, type McpTransport,
} from './store.ts';

export { CURATED, searchCatalog, searchCurated, type CatalogEntry } from './catalog.ts';
export { blocksBoarding, type McpHealth, type McpStatus } from './health.ts';
export { MCP_TRANSPORTS, type McpServerMeta, type McpTransport } from './store.ts';

/** What leaves the server. No secrets, no filesystem paths. */
export type McpServerView = {
  id: string;
  label: string;
  transport: McpTransport;
  /** Remote servers only. Safe to show: a URL with a secret in it is refused on add. */
  url?: string;
  /** stdio only, as a display string — `npx -y @playwright/mcp@latest`. */
  command?: string;
  enabled: boolean;
  /** How this server authenticates, and whether it currently can. */
  auth: {
    kind: 'none' | 'oauth' | 'header' | 'env';
    /** Which values it needs, and whether we hold each. Never the values. */
    secrets: { ref: string; held: boolean }[];
  };
  status: McpStatus;
  /** Age of that status, so the UI can say "as of 4 minutes ago" honestly. */
  checkedAt?: string;
  /** Why it failed, when the CLI said. Already redacted by the CLI itself. */
  issue?: string;
  toolCount?: number;
  /** Tools that can never be approved in an unattended run. */
  interactiveTools?: string[];
  /** Set when the advertised tools changed since we last looked. */
  toolsChanged?: { added: string[]; removed: string[]; seenAt: string };
  /**
   * Environment variables this server's own configuration still refers to and
   * nothing supplies — `MCP_FS_ROOT` in the catalog's filesystem entry, which
   * ships as `npx … @modelcontextprotocol/server-filesystem ${MCP_FS_ROOT}`.
   *
   * `${VAR}` is passed to the CLI unexpanded on purpose (`config.ts`), so an
   * unset one is not an error anybody sees: the CLI expands it to nothing, the
   * server starts without a root, and it probes `failed` forever. It looked
   * like a flaky server rather than an unfinished registration — one was
   * attached to a real run and blocked three phases at boarding.
   *
   * Absent when there is nothing outstanding. A server with entries here can be
   * shown, but never silently attached.
   */
  needsConfig?: string[];
  source?: string;
  lastUsed?: string;
};

/**
 * What a set of named ids resolves to — four buckets, because there are four
 * distinct answers and collapsing any of them costs an operator an errand.
 */
export type McpResolved = {
  servers: McpServerMeta[];
  /** Named, but this machine has no such registration. */
  unknown: string[];
  /** Registered, and the operator switched it off. */
  disabled: string[];
  /** Registered and on, but its own config still names a `${VAR}` nothing fills. */
  unconfigured: { id: string; missing: string[] }[];
};

export type McpOptions = {
  exec?: Exec;
  platform?: NodeJS.Platform;
  onChange?: () => void;
  /** A server's tool list changed under us — the rug-pull announcement. */
  onToolsChanged?: (view: McpServerView, added: string[], removed: string[]) => void;
  /** A server went from working to needing attention. Transitions only. */
  onStatusChange?: (view: McpServerView, status: McpStatus) => void;
  now?: () => number;
  /** Injected in tests so no suite ever spawns a real CLI. */
  probeFn?: typeof probeMcp;
  /**
   * The instance's start ceiling (`start-ceiling.ts`): the probe is one of
   * the fourteen automatic `claude` starts, so it asks before it spawns and
   * charges after. Absent (a harness): no ceiling.
   */
  ceiling?: {
    admit: (actor: Actor) => { ok: true } | { ok: false; ceiling: string; until: string };
    charge: (actor: Actor) => void;
  };
};

/**
 * How long a health answer is reused before the next probe.
 *
 * Exported because it is also the CLOCK: `Service.startMcpHealthClock` ticks on
 * exactly this, so the TTL and the thing that makes the TTL expire are one
 * number. They were two, and one of them was missing entirely.
 */
export const HEALTH_TTL_MS = 5 * 60_000;

export class Mcp {
  private readonly store = new McpStore();
  private readonly creds: McpCredentials;
  private readonly opts: McpOptions;
  private readonly probe: typeof probeMcp;
  private readonly now: () => number;
  /** id → last health row, with the time it was taken. */
  private health = new Map<string, { row: McpHealth; at: number }>();
  /** id → last announced status, so only transitions are announced. */
  private announced = new Map<string, McpStatus>();
  /** id → the change we found but have not yet had acknowledged. */
  private drift = new Map<string, { added: string[]; removed: string[]; seenAt: string }>();
  private inFlight: Promise<{ probed: boolean }> | null = null;
  /** What the last probe answered about ITSELF — for a preflight reading a cache the probe could not fill. */
  private lastProbe: { at: number; error?: string } | null = null;

  constructor(opts: McpOptions = {}) {
    this.opts = opts;
    this.creds = new McpCredentials(opts.exec ?? realExec, opts.platform ?? process.platform);
    this.probe = opts.probeFn ?? probeMcp;
    this.now = opts.now ?? Date.now;
  }

  /* ---------------- reading ---------------- */

  has(id: string): boolean { return this.store.has(id); }
  isEnabled(id: string): boolean { return this.store.isEnabled(id); }
  meta(id: string): McpServerMeta | undefined { return this.store.get(id); }

  /**
   * The ids a run may attach — registered, switched on, AND configured.
   *
   * This is also what the engine is told through `PE_MCP_SERVERS`, which is how
   * F15 knows what a plan may name.
   *
   * A server with an unfilled `${VAR}` is excluded, and that is the point: it
   * can never connect (the CLI expands the variable to nothing and the server
   * starts without the argument it needed), so listing it as attachable made
   * three different things lie at once — the plan linted clean against a name
   * that would fail, the run attached it, and the preflight reported it as a
   * server that was DOWN rather than one that was never finished. `needsConfig`
   * on the view is how it stays visible; this is how it stays unattachable.
   */
  enabledIds(): string[] {
    return this.store.enabledIds().filter((id) => {
      const meta = this.store.get(id);
      return !meta || !unresolvedVars(meta).length;
    });
  }

  async list(): Promise<McpServerView[]> {
    return Promise.all(this.store.list().map((meta) => this.view(meta)));
  }

  /**
   * The set a phase would actually run with, from the ids it named.
   *
   * Unknown and disabled ids are reported rather than dropped: a plan naming a
   * server this machine does not have is exactly the situation the preflight
   * exists to catch, and silently running without it would be the one outcome
   * nobody asked for.
   */
  resolve(ids: readonly string[]): McpResolved {
    const servers: McpServerMeta[] = [];
    const unknown: string[] = [];
    const disabled: string[] = [];
    const unconfigured: { id: string; missing: string[] }[] = [];
    for (const id of [...new Set(ids)]) {
      const meta = this.store.get(id);
      if (!meta) { unknown.push(id); continue; }
      if (!this.store.isEnabled(id)) { disabled.push(id); continue; }
      // A fourth bucket, not a fourth kind of "unknown". An unfilled `${VAR}`
      // is a registration nobody finished, and it is neither absent (the row
      // exists, the operator can see it) nor switched off (nobody chose this).
      // It used to fall through into `servers`, get probed, fail to connect,
      // and be reported as a server that was DOWN — so the errand the operator
      // was handed was "this server is flaky" when it was "you never gave it a
      // value". Named separately so the message can name the variable.
      const missing = unresolvedVars(meta);
      if (missing.length) { unconfigured.push({ id, missing }); continue; }
      servers.push(meta);
    }
    return { servers, unknown, disabled, unconfigured };
  }

  /* ---------------- writing ---------------- */

  async add(input: {
    id?: string;
    label: string;
    transport: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    secretRefs?: McpSecretRef[];
    secrets?: Record<string, string>;
    alwaysLoad?: boolean;
    timeoutMs?: number;
    source?: 'manual' | 'catalog' | 'imported';
  }): Promise<McpServerView> {
    const transport = normaliseTransport(input.transport);
    if (!transport) throw new Error(`unknown transport ${JSON.stringify(input.transport)}`);

    const label = input.label.trim();
    if (!label) throw new Error('name the server — plans and permission rules refer to it by name');
    const id = (input.id?.trim() || this.store.newId(label)).toLowerCase();
    assertUsableId(id);

    if (transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('a stdio server needs a command to run');
    } else {
      const url = input.url?.trim() ?? '';
      if (!url) throw new Error('a remote server needs a URL');
      assertSafeUrl(url);
    }

    const meta: McpServerMeta = {
      id,
      transport,
      label,
      createdAt: new Date(this.now()).toISOString(),
      ...(transport === 'stdio'
        ? {
            command: input.command!.trim(),
            ...(input.args?.length ? { args: input.args } : {}),
            ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
          }
        : {
            url: input.url!.trim(),
            ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
          }),
      ...(input.secretRefs?.length ? { secretRefs: input.secretRefs } : {}),
      ...(input.alwaysLoad ? { alwaysLoad: true } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.source ? { source: input.source } : {}),
    };

    // Secrets FIRST, then the row — and the row only if every secret landed.
    //
    // The other order half-registers. `store.add` persists immediately, so a
    // keychain that refused (locked, or the operator cancelled the access
    // prompt) left a server in `servers.json` advertising a `secretRefs` entry
    // whose value does not exist: `has()` says true, `list()` shows it, a plan
    // may name it, and it probes `needs-auth` for ever with no way to tell that
    // apart from a genuinely signed-out server. Storing first means a failure
    // registers nothing at all, which is the state the operator can retry from.
    //
    // The rollback is for the write that fails PART WAY through a multi-secret
    // server: those secrets are already in the keychain, and leaving them would
    // orphan them under an id no row claims — precisely the leak `deleteAll`'s
    // prefix enumeration exists to clean up, so do not create it here.
    const stored: McpSecretRef[] = [];
    try {
      for (const ref of meta.secretRefs ?? []) {
        const secret = input.secrets?.[refKey(ref)];
        if (!secret) continue;
        await this.creds.store(id, ref, secret);
        stored.push(ref);
      }
    } catch (error) {
      for (const ref of stored) {
        try { await this.creds.delete(id, ref); } catch { /* best effort */ }
      }
      throw error;
    }
    this.store.add(meta);
    this.changed();
    return this.view(meta);
  }

  async setSecret(id: string, ref: McpSecretRef, secret: string): Promise<void> {
    const meta = this.store.get(id);
    if (!meta) throw new Error(`no MCP server called ${id}`);
    // The ref has to be one this server DECLARED. Without the check any
    // `{kind, name}` from the wire minted its own keychain item under this
    // server's prefix — a value nothing would ever splice into a config
    // (`buildMcpConfig` walks `secretRefs`, not the keychain), that the UI
    // would never show (`view` walks `secretRefs` too), and that only
    // `deleteAll`'s enumeration would ever find again. A write nobody can read
    // or see is not a feature with no callers; it is a place to put secrets and
    // forget them.
    const declared = (meta.secretRefs ?? []).some((known) => refKey(known) === refKey(ref));
    if (!declared) {
      throw new Error(
        `${id} does not ask for ${refKey(ref)} — declare it on the server before setting a value`,
      );
    }
    await this.creds.store(id, ref, secret);
    // A new credential can only change the answer, so stop reusing the old one.
    this.health.delete(id);
    this.changed();
  }

  async rename(id: string, label: string): Promise<McpServerView | undefined> {
    const next = label.trim();
    if (!next) throw new Error('a server needs a name');
    const meta = this.store.update(id, { label: next });
    if (!meta) return undefined;
    this.changed();
    return this.view(meta);
  }

  setEnabled(id: string, on: boolean): boolean {
    const ok = this.store.setEnabled(id, on);
    if (ok) this.changed();
    return ok;
  }

  async remove(id: string): Promise<boolean> {
    const gone = this.store.remove(id);
    if (!gone) return false;
    await this.creds.deleteAll(gone);
    this.health.delete(id);
    this.announced.delete(id);
    this.drift.delete(id);
    this.changed();
    return true;
  }

  /** The operator has seen the tool-list change; stop flagging it. */
  acknowledgeDrift(id: string): boolean {
    const had = this.drift.delete(id);
    if (had) this.changed();
    return had;
  }

  /* ---------------- health ---------------- */

  /**
   * Probe every enabled server, unless a fresh answer is already in hand.
   *
   * Single-flight: concurrent callers share one probe. A caller that needs the
   * truth right now (the operator pressed Refresh) passes `force`.
   */
  async refresh(opts: { force?: boolean; cwd?: string; door?: StartDoor } = {}): Promise<{ probed: boolean }> {
    // A probe already in flight is shared, and it is the OTHER caller's start:
    // this one waits for the answer and spawned nothing.
    if (this.inFlight) return this.inFlight.then(() => ({ probed: false }));
    const ids = this.store.enabledIds();
    if (!ids.length) return { probed: false };
    if (!opts.force && ids.every((id) => this.fresh(id))) return { probed: false };

    this.inFlight = this.runProbe(ids, opts.cwd, opts.door ?? 'mcp-health-probe').finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * Probe a specific set and say whether it may board.
   *
   * This is the preflight. It answers with the rows so the caller can write a
   * halt message that names the server and the reason, rather than "an MCP
   * server is unhappy" — the same standard the §Verification park is held to.
   */
  async preflight(ids: readonly string[], opts: { cwd?: string } = {}): Promise<{
    ok: boolean;
    rows: McpHealth[];
    blocking: McpHealth[];
    unknown: string[];
    disabled: string[];
    unconfigured: { id: string; missing: string[] }[];
    probeError?: string;
    /** How many `claude` processes THIS preflight started: 0 when the clock's answer was fresh, else 1. */
    probes: number;
  }> {
    const { servers, unknown, disabled, unconfigured } = this.resolve(ids);
    // The resolvable ones are probed even when some ids did not resolve. This
    // used to short-circuit, which cost a whole extra boarding per problem: a
    // phase naming one unregistered server and one signed-out one reported the
    // first, and only learned about the second after somebody fixed it. One
    // answer, naming everything wrong with the set.
    const settled = !unknown.length && !disabled.length && !unconfigured.length;
    if (!servers.length) {
      return { ok: settled, rows: [], blocking: [], unknown, disabled, unconfigured, probes: 0 };
    }

    // The clock's cache, its TTL and its single flight — not a probe of this
    // preflight's own (SLF-3). `preflight` used to call `this.probe` bare, so
    // a phase naming a resolvable server started a full server tree at every
    // boarding attempt on top of the five-minute clock, with no cap per phase,
    // run or day; `refresh` answers from a fresh row and shares an in-flight
    // probe, so two boardings inside one TTL cost one `claude`. The whole
    // enabled set is what the clock probes, and this phase's servers are a
    // subset of it (`resolve` keeps disabled ones out).
    let probes = 0;
    if (!servers.every((meta) => this.fresh(meta.id))) {
      const { probed } = await this.refresh({ cwd: opts.cwd, door: 'mcp-boarding-preflight' });
      if (probed) probes = 1;
    }
    const rows = servers.map((meta) => this.health.get(meta.id)?.row).filter((row): row is McpHealth => Boolean(row));
    if (rows.length < servers.length) {
      // Could not check ≠ they are down. Boarding proceeds: the run's own
      // failure handling is still there, and refusing to start a phase because
      // a probe timed out would turn a flaky check into a stopped plan. The
      // ids that never resolved are still reported — that verdict needed no
      // probe and is not in doubt.
      return {
        ok: settled,
        rows: [], blocking: [], unknown, disabled, unconfigured,
        probeError: this.lastProbe?.error ?? 'the probe answered for none of these servers',
        probes,
      };
    }
    // No `unconfigured` rescue here any more: `resolve` now keeps such a server
    // out of the probed set entirely, so a row that blocks did so on its own
    // merits and the CLI's reason for it is the true one.
    const blocking = rows.filter((row) => blocksBoarding(row.status));
    return {
      ok: blocking.length === 0 && settled,
      rows, blocking, unknown, disabled, unconfigured, probes,
    };
  }

  /**
   * The `--mcp-config` file for one PHASE of a run, or null when it attaches
   * nothing.
   *
   * Callers pass the path to `spawn` together with `--strict-mcp-config`, which
   * is what makes the resolved set the only set the session gets — and is also
   * why the phase has to be part of the path. See `writeMcpConfigFile`.
   */
  async configFor(runId: string, phase: number, ids: readonly string[]): Promise<string | null> {
    const { servers } = this.resolve(ids);
    if (!servers.length) return null;
    const doc = await buildMcpConfig(servers, this.creds);
    for (const meta of servers) this.store.update(meta.id, { lastUsed: new Date(this.now()).toISOString() });
    return writeMcpConfigFile(runId, phase, doc);
  }

  /** The same document a run would get, with every secret masked. */
  async previewFor(ids: readonly string[]): Promise<McpConfigDoc> {
    const { servers } = this.resolve(ids);
    return redactConfig(await buildMcpConfig(servers, this.creds));
  }

  /* ---------------- internals ---------------- */

  private fresh(id: string): boolean {
    const held = this.health.get(id);
    return Boolean(held && this.now() - held.at < HEALTH_TTL_MS);
  }

  private async runProbe(ids: string[], cwd: string | undefined, door: StartDoor): Promise<{ probed: boolean }> {
    const { servers } = this.resolve(ids);
    if (!servers.length) return { probed: false };
    // One of the fourteen automatic starts: it names its door, asks the
    // ceiling, and its cadence is on the record (SLF-2 ii) — `session.start`
    // before, `mcp.probe.ran` with the milliseconds after.
    const actor = doorActor(door, {
      by: 'console', via: door === 'mcp-health-probe' ? 'timer' : 'event', origin: 'mcp',
      trigger: servers.map((meta) => meta.id).join(','), guard: 'fresh,!inFlight', counter: `HEALTH_TTL_MS:${HEALTH_TTL_MS}`,
    });
    const verdict = this.opts.ceiling?.admit(actor) ?? { ok: true };
    if (!verdict.ok) {
      log.warn('mcp.probe.refused', { door, ceiling: verdict.ceiling, until: verdict.until, servers: servers.length });
      return { probed: false };   // the cache goes stale, which is what it does overnight anyway
    }
    this.opts.ceiling?.charge(actor);
    log.info('session.start', { ...actor, servers: servers.length });
    const doc = await buildMcpConfig(servers, this.creds);
    const started = this.now();
    const probe = await this.probe(doc, cwd ? { cwd } : {});
    log.info('mcp.probe.ran', {
      door, ms: Math.max(0, this.now() - started), servers: servers.length,
      ...(probe.probeError ? { error: probe.probeError } : {}),
    });
    this.lastProbe = { at: this.now(), ...(probe.probeError ? { error: probe.probeError } : {}) };
    if (probe.probeError) {
      log.warn('mcp.probe.failed', { error: probe.probeError });
      return { probed: true };   // keep the last known answer, with its age
    }
    await this.absorb(probe);
    this.changed();
    return { probed: true };
  }

  /** Fold a probe into the cache, raising the two alarms it can raise. */
  private async absorb(probe: McpProbe): Promise<void> {
    const at = Date.parse(probe.checkedAt) || this.now();
    for (const row of probe.servers) {
      this.health.set(row.id, { row, at });

      if (row.status === 'connected' && row.tools.length) {
        const { changed, before } = this.store.noteTools(row.id, row.tools);
        if (changed && before) {
          const added = row.tools.filter((tool) => !before.includes(tool));
          const removed = before.filter((tool) => !row.tools.includes(tool));
          const seenAt = probe.checkedAt;
          this.drift.set(row.id, { added, removed, seenAt });
          log.warn('mcp.tools.changed', { server: row.id, added, removed });
          const meta = this.store.get(row.id);
          if (meta && this.opts.onToolsChanged) {
            this.opts.onToolsChanged(await this.view(meta), added, removed);
          }
        }
      }

      const previous = this.announced.get(row.id);
      // Only the transition INTO a problem is worth telling somebody about; a
      // first observation of a server that has always needed signing in is not
      // news, it is the state the operator is looking at the page to fix.
      //
      // The recovery is worth telling too, and used to be silent. A phase
      // parked on a server is unparked by that server coming back, and the only
      // trigger for that was a `claude mcp login` terminal exiting — so a
      // server that recovered any other way (a credential refreshed, a stdio
      // command that started working, an operator fixing it outside the
      // console) left the run parked on a problem that no longer existed.
      const notable = blocksBoarding(row.status) || row.status === 'connected';
      if (previous && previous !== row.status && notable) {
        const meta = this.store.get(row.id);
        if (meta && this.opts.onStatusChange) this.opts.onStatusChange(await this.view(meta), row.status);
      }
      this.announced.set(row.id, row.status);
    }
  }

  /** The single construction point for everything the browser sees. */
  private async view(meta: McpServerMeta): Promise<McpServerView> {
    const held = this.health.get(meta.id);
    const secrets = await Promise.all((meta.secretRefs ?? []).map(async (ref) => ({
      ref: refKey(ref),
      held: await this.creds.has(meta.id, ref),
    })));
    const drift = this.drift.get(meta.id);
    const interactive = meta.interactiveTools ?? [];

    return {
      id: meta.id,
      label: meta.label ?? meta.id,
      transport: meta.transport,
      ...(meta.url ? { url: meta.url } : {}),
      ...(meta.command ? { command: [meta.command, ...(meta.args ?? [])].join(' ') } : {}),
      enabled: this.store.isEnabled(meta.id),
      auth: { kind: authKind(meta), secrets },
      status: held?.row.status ?? 'unknown',
      ...(held ? { checkedAt: new Date(held.at).toISOString() } : {}),
      ...(held?.row.error ? { issue: held.row.error.message } : {}),
      ...(held?.row.tools.length ? { toolCount: held.row.tools.length } : {}),
      ...(interactive.length ? { interactiveTools: interactive } : {}),
      ...(drift ? { toolsChanged: drift } : {}),
      ...(unresolvedVars(meta).length ? { needsConfig: unresolvedVars(meta) } : {}),
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.lastUsed ? { lastUsed: meta.lastUsed } : {}),
    };
  }

  private changed(): void {
    this.opts.onChange?.();
  }
}

/**
 * How a server proves who it is.
 *
 * A remote server with no header we hold falls to `oauth`, because that is what
 * the CLI will try — and `claude mcp login` is the verb the UI should offer.
 */
/**
 * `${VAR}` references in this server's own configuration that nothing fills.
 *
 * Three places can supply one: the server's `env` map, a stored secret ref, or
 * the console process's own environment (a server legitimately written against
 * a variable the operator exports for everything). Anything left over is a
 * registration somebody did not finish — the catalog's filesystem entry ships
 * as `… server-filesystem ${MCP_FS_ROOT}` with an `authNote` asking for a value,
 * and nothing ever collected one.
 *
 * `${VAR:-default}` counts as satisfied: it supplies its own.
 */
export function unresolvedVars(meta: McpServerMeta): string[] {
  const supplied = new Set([
    ...Object.keys(meta.env ?? {}),
    ...(meta.secretRefs ?? []).filter((ref) => ref.kind === 'env').map((ref) => ref.name),
  ]);
  const haystack = [
    meta.command ?? '', ...(meta.args ?? []), meta.url ?? '',
    ...Object.values(meta.headers ?? {}), ...Object.values(meta.env ?? {}),
  ].join('\n');
  const out: string[] = [];
  for (const match of haystack.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g)) {
    const [, name, fallback] = match;
    if (fallback) continue;
    if (supplied.has(name) || process.env[name]) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * How a server proves who it is.
 *
 * Exported because `mcp/login.ts` has to ask the same question: only an `oauth`
 * server has a sign-in flow at all, and a console that offered one for a
 * header-authenticated server would be issue #8's "a verb that cannot succeed"
 * wearing a different hat. One definition, so the card and the server cannot
 * disagree about which servers are signable.
 */
export function authKind(meta: McpServerMeta): 'none' | 'oauth' | 'header' | 'env' {
  const refs = meta.secretRefs ?? [];
  if (refs.some((ref) => ref.kind === 'header')) return 'header';
  if (refs.some((ref) => ref.kind === 'env')) return 'env';
  if (meta.transport === 'stdio') return 'none';
  return meta.headers?.Authorization ? 'header' : 'oauth';
}

/**
 * Refuse a URL that carries its own credential.
 *
 * A URL is shown in the UI, in logs and in the config preview, and the CLI
 * itself declines to print an expanded server URL for exactly this reason: a
 * token in a query string ends up somewhere it was never meant to be. Whoever
 * wants that server should paste the token as a header, where it is kept.
 */
function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${JSON.stringify(url)} is not a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:' && parsed.hostname !== 'localhost'
      && parsed.hostname !== '127.0.0.1') {
    throw new Error('a remote MCP server must be https (or wss), unless it is on localhost');
  }
  if (parsed.username || parsed.password) {
    throw new Error('put credentials in a header, not in the URL — a URL is shown in the UI and in logs');
  }
  for (const [key, value] of parsed.searchParams) {
    if (/token|key|secret|password|auth/i.test(key) && value) {
      throw new Error(
        `the URL carries a credential in ?${key}= — add it as a header instead, `
        + 'so it is stored in the keychain rather than displayed',
      );
    }
  }
}
