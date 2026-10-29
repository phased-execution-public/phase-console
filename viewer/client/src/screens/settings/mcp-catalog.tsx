/**
 * The MCP catalog — "what could I have", as opposed to the registry's "what do
 * I have, and is it working" (`#/settings/mcp?tab=catalog`; 7.0's since
 * quiet-console phase 23).
 *
 * ```
 * [Find a server — github, browser, database, docs]
 * Keep the attached set small — three to six. …
 *
 * Code
 * GitHub  github   http · signs in      Add   Copy the command   Docs ↗
 * Issues, pull requests and code search across your repositories.
 * ```
 *
 * The search asks the console, which answers from its curated list and its
 * cached copy of the official registry — read whole in the background and
 * searched locally, so a search never waits on the network (#363); the box is
 * debounced, and while the copy is first being read the page says so and asks
 * again. When there is no copy the curated list is still the whole answer, and
 * the page says so. Adding needs `--allow-mcp`; the equivalent `claude mcp
 * add` line is offered either way, so somebody can do it outside the console,
 * and a server in neither list is added by hand (`./mcp-manual`).
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type McpCatalogEntry, type McpRegistryState } from '@/data/api';
import { keys } from '@/data/keys';
import { useMcpCatalog } from '@/data/mcp';
import {
  Banner,
  Button,
  Empty,
  Input,
  Label,
  Mono,
  RelativeTime,
  SectionHeading,
  Skeleton,
  toast,
} from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Dialog, DialogContent } from '@/ui/dialog';
import { ToolbarSearch } from '@/ui/toolbar';
import { varsOf } from './mcp-manual';
import { failureWords } from './setting';

/** How long the box waits after the last keystroke before it asks — Your turn's search's 250 ms. */
export const SEARCH_DEBOUNCE_MS = 250;

/** How a catalog entry signs in, in words. */
export function authWords(auth: McpCatalogEntry['auth']): string | null {
  if (auth === 'oauth') return 'signs in';
  if (auth === 'header') return 'needs a token';
  if (auth === 'env') return 'needs an environment variable';
  return null;
}

/**
 * The equivalent `claude mcp add`, so somebody can do it outside the console —
 * with every secret the entry needs as a `<value>` to fill in, in its header's
 * own shape (`Bearer {}`): a copied line that left one out would register a
 * server that can never sign in.
 */
export function addCommand(entry: McpCatalogEntry): string {
  const secrets = (entry.secretRefs ?? []).map((ref) =>
    ref.kind === 'header'
      ? ` --header "${ref.name}: ${(ref.template ?? '{}').replace('{}', '<value>')}"`
      : ` -e ${ref.name}=<value>`,
  );
  if (entry.transport === 'stdio') {
    return `claude mcp add${secrets.join('')} ${entry.id} -- ${entry.command ?? ''} ${(entry.args ?? []).join(' ')}`.trim();
  }
  return `claude mcp add --transport ${entry.transport}${secrets.join('')} ${entry.id} ${entry.url ?? ''}`.trim();
}

/** What the registry half of an answer is, in words — or nothing when there is nothing to say. */
export function registryWords(registry: McpRegistryState | undefined, query: string): string | null {
  if (!registry) return null;
  if (registry.state === 'refreshing') {
    return 'Reading the official registry for the first time — about a minute. The curated list is here meanwhile, and this search runs again when it is in.';
  }
  if (registry.state === 'unavailable') return null;
  const copy = `${registry.count.toLocaleString('en')} servers in the registry copy`;
  if (registry.state === 'stale') return `Searching ${copy}, which is being read again.`;
  return query.trim() ? `Searched the curated list and ${copy}.` : null;
}

export function McpCatalog({ allowed, registered }: { allowed: boolean; registered: ReadonlySet<string> }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  // Debounced: every keystroke used to start a registry search that ran to
  // its 8 s timeout (#363). The answer is a local read now, and still one per pause.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const { data, isFetching } = useMcpCatalog(query);
  const said = registryWords(data?.registry, query);
  const [adding, setAdding] = useState<McpCatalogEntry | null>(null);
  const entries = data?.entries ?? [];
  const groups = new Map<string, McpCatalogEntry[]>();
  for (const entry of entries) groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="mcp-catalog">
      <div className="flex min-w-0 max-w-(--measure) flex-col gap-2">
        <ToolbarSearch
          value={typed}
          onChange={setTyped}
          label="Search the MCP catalog"
          placeholder="Find a server — github, browser, docs"
        />
        <p className="text-meta text-ink-muted">
          Keep the attached set small — three to six. Every server costs context on every turn, and its tool
          descriptions enter your prompts: connect only ones you would trust with the repository this console
          reads.
        </p>
      </div>
      {data?.registryError && (
        <Banner severity="warn">
          The official registry could not be read ({data.registryError}), so this is the curated list only.
          Everything below still works, and a server in neither list can be added by hand.
        </Banner>
      )}
      {said && (
        <p
          className="max-w-(--measure) text-meta text-ink-muted"
          role="status"
          data-registry-state={data?.registry?.state}
        >
          {said}
          {data?.registry?.fetchedAt && data.registry.state !== 'refreshing' && (
            <>
              {' '}
              Read <RelativeTime at={data.registry.fetchedAt} />.
            </>
          )}
        </p>
      )}
      {isFetching && !entries.length ? (
        <Skeleton className="h-24" aria-busy="true" />
      ) : !entries.length ? (
        <Empty title="Nothing in the catalog matches. Try a shorter search or a product name — or add the server by hand under Registered." />
      ) : (
        [...groups].map(([category, items]) => (
          <section key={category} className="flex min-w-0 flex-col gap-3" aria-label={category}>
            <SectionHeading as="h3">{category}</SectionHeading>
            <ul className="flex min-w-0 flex-col gap-5">
              {items.map((entry) => (
                <CatalogEntry
                  key={entry.id}
                  entry={entry}
                  allowed={allowed}
                  already={registered.has(entry.id)}
                  onAdd={() => setAdding(entry)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      {adding && <AddDialog entry={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function CatalogEntry({
  entry,
  allowed,
  already,
  onAdd,
}: {
  entry: McpCatalogEntry;
  allowed: boolean;
  already: boolean;
  onAdd: () => void;
}) {
  const facts = [
    entry.transport,
    authWords(entry.auth),
    entry.source === 'registry' ? 'from the registry' : null,
    entry.pin ? `pinned ≥ ${entry.pin.min}` : null,
    entry.untrustedOutput ? 'untrusted output' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex min-w-0 flex-col gap-1.5" data-catalog-entry={entry.id}>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-body font-medium text-ink">{entry.label}</span>
        <Mono value={entry.id} className="text-meta text-ink-muted" />
        <span className="text-meta text-ink-muted">{facts}</span>
      </span>
      <p className="max-w-(--measure) text-body text-ink-muted">{entry.description}</p>
      {entry.authNote && <p className="max-w-(--measure) text-meta text-ink-muted">{entry.authNote}</p>}
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {already ? (
          <span className="text-meta text-ink-muted">Registered</span>
        ) : allowed ? (
          <Button size="sm" onClick={onAdd}>
            Add
          </Button>
        ) : (
          <span className="text-meta text-ink-muted">
            Adding needs <code className="font-mono">--allow-mcp</code>
          </span>
        )}
        <CopyButton size="sm" variant="ghost" text={addCommand(entry)} label="Copy the command" />
        {entry.homepage && (
          <a
            className="tap-line text-meta text-ink-muted underline decoration-ink-faint underline-offset-2 hover:text-ink"
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </a>
        )}
      </span>
    </li>
  );
}

function AddDialog({ entry, onClose }: { entry: McpCatalogEntry; onClose: () => void }) {
  const client = useQueryClient();
  const [secret, setSecret] = useState('');
  // A field for every `${VAR}` the entry's command or address writes (#363):
  // the curated filesystem and database servers could never be finished.
  const vars = varsOf([entry.command ?? '', ...(entry.args ?? []), entry.url ?? '']);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ref = entry.secretRefs?.[0];
  const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()));
  const add = async () => {
    setBusy(true);
    try {
      await api.mcpAdd({
        id: entry.id,
        label: entry.label,
        transport: entry.transport,
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.secretRefs ? { secretRefs: entry.secretRefs } : {}),
        ...(ref && secret.trim() ? { secrets: { [`${ref.kind}:${ref.name}`]: secret.trim() } } : {}),
        ...(Object.keys(filled).length ? { vars: filled } : {}),
        source: 'catalog',
      });
      onClose();
      toast(
        entry.auth === 'oauth'
          ? `${entry.label} registered — sign it in from its row under Registered.`
          : `${entry.label} registered. Checking the connection…`,
        'ok',
      );
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: keys.mcp() });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={`Add ${entry.label}`} description={entry.description}>
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <p className="text-meta text-ink-muted">
            It registers as <code className="font-mono">{entry.id}</code> — the name a plan uses on its MCP
            servers line, and a permission rule as <code className="font-mono">mcp__{entry.id}</code>.
          </p>
          {entry.auth === 'oauth' && (
            <p className="text-body text-ink">
              It signs in with OAuth. Register it now, then sign it in from its row — the token goes to the
              Claude CLI’s own store, which this console never reads or writes.
            </p>
          )}
          {ref && (
            <span className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={`mcp-add-${entry.id}`}>{ref.name}</Label>
              <Input
                id={`mcp-add-${entry.id}`}
                type="password"
                autoFocus
                value={secret}
                placeholder="Paste the token — stored in this machine’s keychain"
                onChange={(event) => setSecret(event.target.value)}
              />
            </span>
          )}
          {vars.map((name) => (
            <span key={name} className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={`mcp-add-${entry.id}-${name}`}>{name}</Label>
              <Input
                id={`mcp-add-${entry.id}-${name}`}
                value={values[name] ?? ''}
                placeholder={`What \${${name}} stands for — held in this machine’s keychain`}
                onChange={(event) => setValues((was) => ({ ...was, [name]: event.target.value }))}
              />
            </span>
          ))}
          {vars.length > 0 && (
            <p className="max-w-(--measure) text-meta text-ink-muted">
              Its command refers to {vars.map((name) => `\${${name}}`).join(', ')}. Fill{' '}
              {vars.length === 1 ? 'it' : 'them'} in now, or later from its row — until then it cannot
              connect.
            </p>
          )}
          <span className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add server'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </span>
        </form>
      </DialogContent>
    </Dialog>
  );
}
