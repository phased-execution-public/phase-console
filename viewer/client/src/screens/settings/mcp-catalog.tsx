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
 * The search asks the console, which answers from its curated list and the
 * official registry; when the registry cannot be reached the curated list is
 * still the whole answer, and the page says so. Adding needs `--allow-mcp`;
 * the equivalent `claude mcp add` line is offered either way, so somebody can
 * do it outside the console.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type McpCatalogEntry } from '@/data/api';
import { keys } from '@/data/keys';
import { useMcpCatalog } from '@/data/mcp';
import { Banner, Button, Empty, Input, Label, Mono, SectionHeading, Skeleton, toast } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Dialog, DialogContent } from '@/ui/dialog';
import { ToolbarSearch } from '@/ui/toolbar';
import { failureWords } from './setting';

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

export function McpCatalog({ allowed, registered }: { allowed: boolean; registered: ReadonlySet<string> }) {
  const [query, setQuery] = useState('');
  const { data, isFetching } = useMcpCatalog(query);
  const [adding, setAdding] = useState<McpCatalogEntry | null>(null);
  const entries = data?.entries ?? [];
  const groups = new Map<string, McpCatalogEntry[]>();
  for (const entry of entries) groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="mcp-catalog">
      <div className="flex min-w-0 max-w-(--measure) flex-col gap-2">
        <ToolbarSearch
          value={query}
          onChange={setQuery}
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
          The official registry could not be reached ({data.registryError}), so this is the curated list only.
          Everything below still works.
        </Banner>
      )}
      {isFetching && !entries.length ? (
        <Skeleton className="h-24" aria-busy="true" />
      ) : !entries.length ? (
        <Empty title="Nothing in the catalog matches. Try a shorter search, or a product name." />
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
  const [busy, setBusy] = useState(false);
  const ref = entry.secretRefs?.[0];
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
