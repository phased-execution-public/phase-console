/**
 * Where else the console speaks — the same events, to a channel you watch.
 *
 * The two cards above this one answer "what may be said" and "which of my
 * browsers hears it". This one answers the question neither can: *everywhere
 * else*. A team on Slack, a Discord server, a Telegram chat, a relay somebody
 * wrote — none of those needs a service worker, a signing key or a phone with
 * the console installed, and all of them are where an operator already looks.
 *
 * Three things about this card are deliberate and read as omissions otherwise:
 *
 * **There is no URL on screen, ever.** A webhook URL is the whole
 * authorisation — anyone holding a Slack incoming-webhook URL can post to that
 * channel — so the server never sends it back and there is nothing here to
 * copy. A row is its origin plus the last few characters of its path.
 *
 * **There is no Edit.** For the same reason: the URL is a secret this console
 * cannot show you, so "change it" would mean typing a new one blind. Pasting a
 * URL that is already registered replaces that row (and clears its backoff),
 * which is the same act with an honest name.
 *
 * **Off is off, and the card still renders.** Without `--allow-webhooks` the
 * verbs are disabled and say why, but the registered rows are still listed:
 * seeing where your own console *would* speak is display, and hiding it is how
 * an operator ends up not knowing a URL is on file.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, toastError, useWebhooks } from '@/lib/queries';
import { api, type WebhookRow } from '@/lib/api';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CardSkeleton,
  Checkbox,
  Chip,
  Empty,
  SectionHeading,
  field,
  toast,
} from '@/components/ui';
import { plural } from '@/lib/format';

export function WebhooksCard() {
  const client = useQueryClient();
  const { data, isPending, isError } = useWebhooks();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: keys.webhooks() });

  const add = useMutation({
    mutationFn: () => api.webhookAdd({ url: url.trim(), label: label.trim() }),
    onSuccess: async (result) => {
      if (result.error) {
        toast(result.error, 'error');
        return;
      }
      setUrl('');
      setLabel('');
      toast('Registered. Nothing is sent until a matching event happens — use Test to prove it now.', 'ok');
      await refresh();
    },
    onError: toastError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.webhookRemove(id),
    onSuccess: refresh,
    onError: toastError,
  });

  const test = useMutation({
    mutationFn: (id: string) => api.webhookTest(id),
    onSuccess: async (result) => {
      toast(
        result.ok ? `Delivered — ${result.detail}` : `Not delivered — ${result.detail}`,
        result.ok ? 'ok' : 'error',
      );
      await refresh();
    },
    onError: toastError,
  });

  const categories = useMutation({
    mutationFn: ({ id, next }: { id: string; next: Record<string, boolean> }) =>
      api.webhookCategories(id, next),
    onSuccess: refresh,
    onError: toastError,
  });

  // A console whose server predates this endpoint answers 404. Say nothing
  // rather than showing a card whose every verb would fail.
  if (isError) return null;
  if (isPending && !data) return <CardSkeleton loading h="48" />;

  const allowed = data?.allowWebhooks ?? false;
  const hooks = data?.hooks ?? [];
  const catalogue = data?.categories ?? [];
  const busy = add.isPending || remove.isPending || test.isPending || categories.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <span className="text-2xs text-ink-faint">{plural(hooks.length, 'destination')}</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {!allowed && (
          <Banner severity="info">
            <strong>Outbound webhooks are off.</strong> Restart with <code>--allow-webhooks</code> to register
            one. Until then this console makes no outbound request at all — including for any destination
            already listed below.
          </Banner>
        )}

        <p className="text-2xs text-ink-muted">
          Every announcement this console makes — the same categories, after the same switches — POSTed as
          JSON. Payloads carry ids, titles and a link back here; secret-shaped strings are masked on the way
          out. The URL you paste is a credential, so it is stored and never shown again.
        </p>

        {allowed && (
          <div className="flex flex-col gap-2 rounded border border-rule bg-surface-raised px-3 py-2">
            <label className="flex flex-col gap-1">
              <SectionHeading as="span">Webhook URL</SectionHeading>
              <input
                type="url"
                value={url}
                placeholder="https://hooks.slack.com/services/…"
                aria-label="Webhook URL"
                className={field}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <SectionHeading as="span">Name (optional)</SectionHeading>
              <input
                type="text"
                value={label}
                placeholder="#builds"
                aria-label="Webhook name"
                className={field}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <div>
              <Button size="sm" disabled={busy || !url.trim()} onClick={() => add.mutate()}>
                Add destination
              </Button>
            </div>
          </div>
        )}

        {allowed && hooks.length === 0 && (
          <Empty
            title="No destination yet"
            body="Paste an incoming-webhook URL above — a Slack or Discord channel, a Telegram chat, or a relay of your own — and the announcements this console already makes go there too."
          />
        )}

        {hooks.map((hook) => (
          <Destination
            key={hook.id}
            hook={hook}
            catalogue={catalogue}
            allowed={allowed}
            busy={busy}
            expanded={open === hook.id}
            onToggleOpen={() => setOpen(open === hook.id ? null : hook.id)}
            onTest={() => test.mutate(hook.id)}
            onRemove={() => remove.mutate(hook.id)}
            onCategories={(next) => categories.mutate({ id: hook.id, next })}
          />
        ))}

        <p className="text-2xs text-ink-muted">
          Slack and Telegram render the payload&apos;s <code>text</code>; Discord renders <code>content</code>
          . Both are the same line, so a plain incoming-webhook URL works with no relay in between — the field
          list and the recipes are in{' '}
          <a
            className="underline"
            href="https://github.com/phased-execution-public/phase-console/blob/main/docs/webhooks.md"
            target="_blank"
            rel="noreferrer"
          >
            docs/webhooks.md
          </a>
          . (A packaged copy ships no <code>docs/</code> directory, so this is a link rather than a path.)
        </p>
      </CardBody>
    </Card>
  );
}

function Destination({
  hook,
  catalogue,
  allowed,
  busy,
  expanded,
  onToggleOpen,
  onTest,
  onRemove,
  onCategories,
}: {
  hook: WebhookRow;
  catalogue: { id: string; label: string; detail: string; urgent: boolean }[];
  allowed: boolean;
  busy: boolean;
  expanded: boolean;
  onToggleOpen: () => void;
  onTest: () => void;
  onRemove: () => void;
  onCategories: (next: Record<string, boolean>) => void;
}) {
  const chosen = Object.values(hook.categories ?? {}).filter(Boolean).length;
  const quiet = hook.quietUntil && hook.quietUntil > Date.now();
  return (
    <div className="rounded border border-rule px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <strong className="text-sm text-ink">{hook.label}</strong>
          <span className="ml-1.5 text-2xs text-ink-faint">
            {hook.origin}
            {hook.tail}
          </span>
          <span className="mt-0.5 block text-2xs text-ink-muted">
            {plural(chosen, 'category', 'categories')}
            {hook.lastOkAt
              ? ` · last reached ${new Date(hook.lastOkAt).toLocaleString()}`
              : ' · never reached'}
          </span>
          {hook.failures > 0 && (
            <span className="mt-0.5 block text-2xs text-blocked">
              {plural(hook.failures, 'failure')} in a row
              {hook.lastFailure
                ? ` — ${hook.lastFailure.status || 'no answer'}${hook.lastFailure.reason ? ` ${hook.lastFailure.reason}` : ''}`
                : ''}
              {quiet ? '. Backing off; it will try again on its own.' : ''}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" onClick={onToggleOpen}>
            {expanded ? 'Done' : 'Categories'}
          </Button>
          <Button size="sm" disabled={!allowed || busy} onClick={onTest}>
            Test
          </Button>
          <Button size="sm" variant="danger" disabled={!allowed || busy} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 flex flex-col gap-1 border-t border-rule pt-2">
          {catalogue.map((category) => (
            <label key={category.id} className="flex items-start gap-2 text-2xs">
              <Checkbox
                className="mt-0.5"
                disabled={!allowed || busy}
                checked={hook.categories?.[category.id] ?? false}
                aria-label={category.label}
                onCheckedChange={(next) => onCategories({ ...hook.categories, [category.id]: next === true })}
              />
              <span className="min-w-0">
                <span className="text-ink">{category.label}</span>
                {category.urgent && (
                  <Chip tone="warn" className="ml-1.5">
                    urgent
                  </Chip>
                )}
                <span className="mt-0.5 block text-2xs text-ink-muted">{category.detail}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
