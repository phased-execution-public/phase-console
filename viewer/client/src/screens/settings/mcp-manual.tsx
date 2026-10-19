/**
 * Adding a server by hand, and finishing one whose `${VAR}` nothing fills
 * (one-pool phase 19, #363).
 *
 * ```
 * Add a server by hand
 * Name        [ Obs           ]   Id (optional) [ obs ]
 * Transport   [ stdio ▾ ]
 * Command     [ npx ]             Arguments (one per line) [ -y ⏎ obs-mcp ⏎ ${OBS_ROOT} ]
 * Environment (NAME=value, one per line)
 * A secret it needs   [ env ▾ ] [ OBS_TOKEN ]  [ •••••• ]
 * OBS_ROOT    [ /srv/vault ]   ← one field per ${VAR} the fields above write
 *                                                            [ Add server ]
 * ```
 *
 * The form posts the `source: manual` registration the server always took and
 * no page could send: the 18 curated entries were the only servers this
 * console could ever register. Its fields are the registration's own — label,
 * id, transport, command and arguments or URL, environment, headers, one
 * secret and every variable — and the same body is what `phase-console mcp add
 * --manual` sends. Secrets and variables go to the keychain, never the
 * registry file and never back to the page.
 */

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MCP_TRANSPORTS } from '@shared/ops-vocab.js';
import { api, type McpServerView, type McpTransport } from '@/data/api';
import { keys } from '@/data/keys';
import { Button, Input, Label, toast } from '@/ui';
import { Dialog, DialogContent } from '@/ui/dialog';
import { NativeSelect } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';
import { failureWords } from './setting';

/** Every `${VAR}` the texts write, in order, once each — `${VAR:-default}` supplies its own and is left out. */
export function varsOf(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g)) {
      if (match[2]) continue;
      if (!out.includes(match[1]!)) out.push(match[1]!);
    }
  }
  return out;
}

/** `NAME=value` (or `Name: value` for headers) lines → an object; a line without the separator is an error. */
export function parsePairs(
  text: string,
  separator: '=' | ':',
): { pairs: Record<string, string> } | { error: string } {
  const pairs: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at <= 0)
      return {
        error: `“${line}” has no ${separator === '=' ? '= between the name and the value' : ': after the header name'}`,
      };
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { pairs };
}

/** What the form holds, as a person typed it. */
export interface ManualFields {
  label: string;
  id: string;
  transport: McpTransport;
  command: string;
  /** One argument per line. */
  args: string;
  url: string;
  /** `NAME=value` per line — stdio. */
  env: string;
  /** `Name: value` per line — remote. */
  headers: string;
  secretKind: 'header' | 'env';
  secretName: string;
  /** For a header: `Bearer {}` puts the secret after `Bearer `. */
  secretTemplate: string;
  secret: string;
  vars: Record<string, string>;
}

export const EMPTY_MANUAL: ManualFields = {
  label: '',
  id: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  headers: '',
  secretKind: 'env',
  secretName: '',
  secretTemplate: '',
  secret: '',
  vars: {},
};

/** The variables the form's own fields write, which each get a value field. */
export function manualVars(fields: ManualFields): string[] {
  const envNames = Object.keys(pairsOrEmpty(fields.env, '='));
  const texts =
    fields.transport === 'stdio'
      ? [fields.command, ...fields.args.split('\n'), fields.env]
      : [fields.url, fields.headers];
  return varsOf(texts).filter((name) => !envNames.includes(name) && name !== fields.secretName.trim());
}

function pairsOrEmpty(text: string, separator: '=' | ':'): Record<string, string> {
  const parsed = parsePairs(text, separator);
  return 'pairs' in parsed ? parsed.pairs : {};
}

/** The `POST /api/mcp` body the form sends — or the sentence that says what is missing. */
export function manualBody(fields: ManualFields): { body: Record<string, unknown> } | { error: string } {
  const label = fields.label.trim();
  if (!label) return { error: 'name the server — plans and permission rules refer to it' };
  const stdio = fields.transport === 'stdio';
  if (stdio && !fields.command.trim()) return { error: 'a stdio server needs a command to run' };
  if (!stdio && !fields.url.trim()) return { error: 'a remote server needs its address' };
  const env = parsePairs(stdio ? fields.env : '', '=');
  if ('error' in env) return { error: `Environment: ${env.error}` };
  const headers = parsePairs(stdio ? '' : fields.headers, ':');
  if ('error' in headers) return { error: `Headers: ${headers.error}` };
  const secretName = fields.secretName.trim();
  const kind = stdio ? 'env' : fields.secretKind;
  const secretRef = secretName
    ? {
        kind,
        name: secretName,
        ...(kind === 'header' && fields.secretTemplate.trim()
          ? { template: fields.secretTemplate.trim() }
          : {}),
      }
    : null;
  const vars = Object.fromEntries(
    manualVars(fields)
      .map((name) => [name, fields.vars[name]?.trim() ?? ''])
      .filter(([, value]) => value),
  );
  return {
    body: {
      label,
      ...(fields.id.trim() ? { id: fields.id.trim().toLowerCase() } : {}),
      transport: fields.transport,
      ...(stdio
        ? {
            command: fields.command.trim(),
            args: fields.args
              .split('\n')
              .map((arg) => arg.trim())
              .filter(Boolean),
            ...(Object.keys(env.pairs).length ? { env: env.pairs } : {}),
          }
        : {
            url: fields.url.trim(),
            ...(Object.keys(headers.pairs).length ? { headers: headers.pairs } : {}),
          }),
      ...(secretRef ? { secretRefs: [secretRef] } : {}),
      ...(secretRef && fields.secret.trim()
        ? { secrets: { [`${secretRef.kind}:${secretRef.name}`]: fields.secret.trim() } }
        : {}),
      ...(Object.keys(vars).length ? { vars } : {}),
      source: 'manual',
    },
  };
}

/** The *Add by hand* dialog: any server, not only the catalog's. */
export function ManualAddDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [fields, setFields] = useState<ManualFields>(EMPTY_MANUAL);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof ManualFields>(key: K, value: ManualFields[K]) =>
    setFields((was) => ({ ...was, [key]: value }));
  const stdio = fields.transport === 'stdio';
  const vars = manualVars(fields);

  const add = async () => {
    const made = manualBody(fields);
    if ('error' in made) {
      setProblem(made.error);
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const { server } = await api.mcpAdd(made.body);
      onClose();
      toast(
        server.needsConfig?.length
          ? `${server.label} registered as ${server.id} — it still needs ${server.needsConfig.join(', ')}.`
          : server.auth.kind === 'oauth'
            ? `${server.label} registered as ${server.id} — sign it in from its row.`
            : `${server.label} registered as ${server.id}. Checking the connection…`,
        'ok',
      );
    } catch (error) {
      setProblem(failureWords(error));
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: keys.mcp() });
    }
  };

  const field = (id: string, label: string, control: ReactNode, hint?: string) => (
    <span className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
      {hint && <span className="text-meta text-ink-muted">{hint}</span>}
    </span>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Add a server by hand"
        description="Any MCP server — what its own documentation says to put in a .mcp.json. Secrets and variables are held in this machine’s keychain."
      >
        <form
          className="flex min-w-0 flex-col gap-3"
          data-testid="mcp-manual-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          {field(
            'mcp-manual-label',
            'Name',
            <Input
              id="mcp-manual-label"
              autoFocus
              value={fields.label}
              maxLength={80}
              onChange={(e) => set('label', e.target.value)}
            />,
          )}
          {field(
            'mcp-manual-id',
            'Id (optional)',
            <Input
              id="mcp-manual-id"
              value={fields.id}
              maxLength={48}
              onChange={(e) => set('id', e.target.value)}
            />,
            'What a plan names on its MCP servers line. Made from the name when left empty.',
          )}
          {field(
            'mcp-manual-transport',
            'Transport',
            <NativeSelect
              id="mcp-manual-transport"
              value={fields.transport}
              onChange={(e) => {
                const transport = e.target.value as McpTransport;
                setFields((was) => ({
                  ...was,
                  transport,
                  secretKind: transport === 'stdio' ? 'env' : 'header',
                }));
              }}
            >
              {MCP_TRANSPORTS.map((word) => (
                <option key={word} value={word}>
                  {word === 'stdio'
                    ? 'stdio — a command on this machine'
                    : `${word} — a server at an address`}
                </option>
              ))}
            </NativeSelect>,
          )}
          {stdio ? (
            <>
              {field(
                'mcp-manual-command',
                'Command',
                <Input
                  id="mcp-manual-command"
                  value={fields.command}
                  placeholder="npx"
                  onChange={(e) => set('command', e.target.value)}
                />,
              )}
              {field(
                'mcp-manual-args',
                'Arguments, one per line',
                <Textarea
                  id="mcp-manual-args"
                  rows={3}
                  value={fields.args}
                  placeholder={'-y\n@scope/server-mcp'}
                  onChange={(e) => set('args', e.target.value)}
                />,
              )}
              {field(
                'mcp-manual-env',
                'Environment, NAME=value per line',
                <Textarea
                  id="mcp-manual-env"
                  rows={2}
                  value={fields.env}
                  onChange={(e) => set('env', e.target.value)}
                />,
                'Values that are not secret. A secret goes in the field below.',
              )}
            </>
          ) : (
            <>
              {field(
                'mcp-manual-url',
                'Address',
                <Input
                  id="mcp-manual-url"
                  value={fields.url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => set('url', e.target.value)}
                />,
                'https, or http on localhost. A token never goes in the address — put it in the secret below.',
              )}
              {field(
                'mcp-manual-headers',
                'Headers, Name: value per line',
                <Textarea
                  id="mcp-manual-headers"
                  rows={2}
                  value={fields.headers}
                  onChange={(e) => set('headers', e.target.value)}
                />,
              )}
            </>
          )}
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-meta text-ink-muted">
              A secret it needs, if any — {stdio ? 'an environment variable' : 'a header'} whose value is held
              in the keychain
            </legend>
            <span className="flex min-w-0 flex-wrap gap-2">
              <Input
                aria-label={stdio ? 'Secret variable name' : 'Secret header name'}
                className="w-full sm:w-48"
                value={fields.secretName}
                placeholder={stdio ? 'API_KEY' : 'Authorization'}
                onChange={(e) => set('secretName', e.target.value)}
              />
              {!stdio && (
                <Input
                  aria-label="Header value shape"
                  className="w-full sm:w-40"
                  value={fields.secretTemplate}
                  placeholder="Bearer {}"
                  onChange={(e) => set('secretTemplate', e.target.value)}
                />
              )}
              <Input
                aria-label="Secret value"
                type="password"
                className="w-full sm:w-56"
                value={fields.secret}
                placeholder="Paste the value"
                onChange={(e) => set('secret', e.target.value)}
              />
            </span>
          </fieldset>
          {vars.map((name) =>
            field(
              `mcp-manual-var-${name}`,
              name,
              <Input
                id={`mcp-manual-var-${name}`}
                value={fields.vars[name] ?? ''}
                onChange={(e) => set('vars', { ...fields.vars, [name]: e.target.value })}
              />,
              `What \${${name}} stands for. Held in the keychain and filled in when a session starts.`,
            ),
          )}
          {problem && (
            <p className="text-body text-ink" role="alert">
              {problem}
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

/** *Fill it in*: a value for each `${VAR}` a registration writes and nothing supplies. */
export function FillVarsDialog({ server, onClose }: { server: McpServerView; onClose: () => void }) {
  const client = useQueryClient();
  const names = server.needsConfig ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const vars = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Fill in ${server.label}`}
        description="Each value is held in this machine’s keychain and filled into the server’s command when a session starts."
      >
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!Object.keys(vars).length) return;
            setBusy(true);
            api
              .mcpPatch(server.id, { vars })
              .then(() => {
                onClose();
                toast('Held. Re-checking the connection…', 'ok');
              })
              .catch((error: unknown) => toast(failureWords(error), 'error'))
              .finally(() => {
                setBusy(false);
                void client.invalidateQueries({ queryKey: keys.mcp() });
              });
          }}
        >
          {names.map((name, index) => (
            <span key={name} className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={`mcp-fill-${server.id}-${name}`}>{name}</Label>
              <Input
                id={`mcp-fill-${server.id}-${name}`}
                autoFocus={index === 0}
                value={values[name] ?? ''}
                onChange={(event) => setValues((was) => ({ ...was, [name]: event.target.value }))}
              />
            </span>
          ))}
          <span className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy || !Object.keys(vars).length}>
              {busy ? 'Storing…' : 'Store and re-check'}
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
