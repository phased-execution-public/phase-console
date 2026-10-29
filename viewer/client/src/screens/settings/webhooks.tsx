/**
 * Webhooks — the same announcements, to a channel a person already watches
 * (7.0, quiet-console phase 22; the Webhooks card of 6.x).
 *
 * ```
 * Webhooks
 * URL   [https://hooks.slack.com/services/…]
 * Name  [#builds]                 [Add webhook]
 * #builds   https://hooks.slack.com…a1b2   12 kinds   last reached 3 h ago   [Send a test] [Remove]
 *   What it receives  ▸
 * ```
 *
 * Three things here read as omissions and are not. **No URL is ever on
 * screen**: a webhook URL is the whole authorisation — anyone holding a Slack
 * incoming-webhook URL can post to its channel — so the server never sends it
 * back, and a row is its origin and the last characters of its path. **There is
 * no Edit**: changing a URL this console cannot show would mean typing a new
 * one blind; pasting a URL already registered replaces that row and clears its
 * backoff, the same act with an honest name. **Off is off, and the group still
 * draws**: without `--allow-webhooks` every press is disabled and says why, but
 * the registered rows are listed — seeing where your console WOULD speak is
 * reading, and hiding it is how a URL on file goes unnoticed.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type NotificationCategory, type WebhookRow } from '@/data/api';
import { keys } from '@/data/keys';
import { useWebhooks } from '@/data/webhooks';
import { plural } from '@/lib/format';
import { Banner, Button, Input, Mono, RelativeTime, Skeleton, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { ConfirmButton } from '@/ui/confirm';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import { SettingRow, SettingsGroup, failureWords } from './setting';

/** Why a press cannot be made here. */
const NEEDS_FLAG = 'Start the console with --allow-webhooks to change a webhook.';

/** The field list and the recipes — a link, because a packaged copy ships no `docs/` directory. */
const WEBHOOKS_DOC = 'https://github.com/phased-execution-public/phase-console/blob/main/docs/webhooks.md';

/** A webhook's failures in words: how many in a row, the last answer, and whether it is backing off. */
export function failureLine(hook: WebhookRow, now: number): string | null {
  if (hook.failures <= 0) return null;
  const last = hook.lastFailure
    ? `: ${hook.lastFailure.status || 'no answer'}${hook.lastFailure.reason ? ` ${hook.lastFailure.reason}` : ''}`
    : '';
  const backing = (hook.quietUntil ?? 0) > now ? '. Backing off; it tries again by itself.' : '.';
  return `${plural(hook.failures, 'failure')} in a row${last}${backing}`;
}

function usePresses() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(which: string, call: () => Promise<T>, after?: (result: T) => void) => {
    setBusy(which);
    try {
      // Awaited on its own line: `after?.(await call())` short-circuits when there is no `after`,
      // and the call is never made — a press with nothing to say afterwards sent nothing at all.
      const result = await call();
      after?.(result);
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: keys.webhooks() });
    }
  };
  return { busy, run };
}

function WebhookKinds({
  hook,
  catalogue,
  disabled,
  onChange,
}: {
  hook: WebhookRow;
  catalogue: readonly NotificationCategory[];
  disabled: boolean;
  onChange: (next: Record<string, boolean>) => void;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 pt-2" data-webhook-kinds={hook.id}>
      <legend className="mb-1 max-w-(--measure) text-meta text-ink-muted">
        What it receives — a narrowing of what the console announces.
      </legend>
      {catalogue.map((category) => (
        <label
          key={category.id}
          className="flex min-w-0 items-start gap-2.5 text-body [@media(hover:none)]:min-h-(--tap-min)"
        >
          <Checkbox
            className="mt-0.5"
            disabled={disabled}
            checked={hook.categories?.[category.id] ?? false}
            aria-label={`${category.label}, to ${hook.label}`}
            onCheckedChange={(next) => onChange({ ...hook.categories, [category.id]: next === true })}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="min-w-0 break-words text-ink">{category.label}</span>
            {category.urgent && <span className="text-meta text-ink-muted">Urgent</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function WebhookItem({
  hook,
  catalogue,
  allowed,
  busy,
  now,
  onTest,
  onRemove,
  onKinds,
}: {
  hook: WebhookRow;
  catalogue: readonly NotificationCategory[];
  allowed: boolean;
  busy: string | null;
  now: number;
  onTest: () => void;
  onRemove: () => void;
  onKinds: (next: Record<string, boolean>) => void;
}) {
  const kinds = Object.values(hook.categories ?? {}).filter(Boolean).length;
  const failing = failureLine(hook, now);
  const off = !allowed || busy !== null;
  return (
    <li
      data-webhook={hook.id}
      className="flex min-w-0 flex-col gap-2 border-t border-rule pt-3 first:border-t-0 first:pt-0"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
          <span className="min-w-0 break-words text-body font-medium text-ink">{hook.label}</span>
          {/* The server's tail carries its own ellipsis where it cut the path (`maskUrl`), none where it did not. */}
          <Mono value={`${hook.origin}${hook.tail}`} className="min-w-0 wrap-anywhere" />
          <span className="flex min-w-0 flex-wrap gap-x-3 text-meta text-ink-muted">
            <span>{plural(kinds, 'kind')}</span>
            {hook.secretHint && <span data-testid="webhook-secret-hint">signed with {hook.secretHint}</span>}
            {(hook.queued ?? 0) > 0 && (
              <span data-testid="webhook-queued">{plural(hook.queued ?? 0, 'announcement')} waiting</span>
            )}
            <span>
              {hook.lastOkAt ? (
                <>
                  last reached <RelativeTime at={hook.lastOkAt} live={false} />
                </>
              ) : (
                'never reached'
              )}
            </span>
          </span>
          {failing && (
            <span className="max-w-(--measure) text-meta text-ink" data-testid="webhook-failing">
              {failing}
            </span>
          )}
        </div>
        <span className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" disabled={off} title={allowed ? undefined : NEEDS_FLAG} onClick={onTest}>
            {busy === `test:${hook.id}` ? 'Sending…' : 'Send a test'}
          </Button>
          <ConfirmButton
            size="sm"
            variant="ghost"
            destructive
            disabled={off}
            title={`Remove the webhook ${hook.label}?`}
            description="Its URL is kept nowhere else: to send there again, paste the URL anew."
            onConfirm={onRemove}
          >
            Remove
          </ConfirmButton>
        </span>
      </div>
      <Disclosure label="What it receives" openLabel="Done" testId={`webhook-open-${hook.id}`}>
        <WebhookKinds hook={hook} catalogue={catalogue} disabled={off} onChange={onKinds} />
      </Disclosure>
    </li>
  );
}

export function WebhooksGroup() {
  const { data, isPending, isError } = useWebhooks();
  const { busy, run } = usePresses();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  /** The secret a new row was given — shown here once, never again (measured-console phase 17). */
  const [fresh, setFresh] = useState<{ label: string; secret: string } | null>(null);

  // A server that predates webhooks answers 404: say nothing rather than draw presses that would fail.
  if (isError) return null;

  const allowed = data?.allowWebhooks ?? false;
  const hooks = data?.hooks ?? [];
  const catalogue = data?.categories ?? [];
  const now = Date.now();

  const add = () =>
    run(
      'add',
      () => api.webhookAdd({ url: url.trim(), label: label.trim() }),
      (result) => {
        const refused = (result as { error?: string }).error;
        if (refused) {
          toast(refused, 'error');
          return;
        }
        setUrl('');
        setLabel('');
        const made = (result as { hook?: WebhookRow }).hook;
        if (made?.secret) setFresh({ label: made.label, secret: made.secret });
        toast('Added. Nothing is sent until a matching announcement — send a test to prove it now.', 'ok');
      },
    );

  return (
    <SettingsGroup
      id="webhooks"
      title="Webhooks"
      lead="Every announcement this console makes — the same kinds, after the same switches — sent as JSON to a channel you watch. A payload carries ids, titles and a link back here, with anything shaped like a secret masked. The URL you paste is a credential: it is stored and never shown again."
      aside={
        data ? <span className="text-meta text-ink-muted">{plural(hooks.length, 'webhook')}</span> : undefined
      }
    >
      {!allowed && data && (
        <Banner severity="info" data-testid="webhooks-off">
          Outbound webhooks are off. Restart the console with{' '}
          <code className="font-mono">--allow-webhooks</code> to add one; until then it sends nothing — to the
          webhooks below included.
        </Banner>
      )}
      {fresh && (
        <Banner severity="info" data-testid="webhook-secret">
          <span className="flex min-w-0 flex-col gap-1.5">
            <span>
              {fresh.label}&rsquo;s signing secret — shown this once. Every delivery carries{' '}
              <code className="font-mono">X-Phase-Console-Signature: sha256=…</code>, the HMAC-SHA256 of its
              body under this secret; give it to the receiver so it can check one.
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Mono value={fresh.secret} className="min-w-0 wrap-anywhere" />
              <CopyButton text={fresh.secret} />
              <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
                Done
              </Button>
            </span>
          </span>
        </Banner>
      )}
      {isPending && !data ? (
        <Skeleton className="h-16" aria-busy="true" aria-label="Reading the webhooks" />
      ) : (
        <>
          {allowed && (
            <form
              className="flex min-w-0 flex-col gap-4"
              data-testid="webhook-add"
              onSubmit={(event) => {
                event.preventDefault();
                if (url.trim()) void add();
              }}
            >
              <SettingRow
                label="Webhook URL"
                hint="An incoming-webhook URL: a Slack or Discord channel, a Telegram chat, or a relay of your own. Pasting one already registered replaces that webhook and clears its backoff."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="url"
                    aria-describedby={describedBy}
                    className="w-full font-mono sm:w-80"
                    value={url}
                    placeholder="https://hooks.slack.com/services/…"
                    autoComplete="off"
                    onChange={(event) => setUrl(event.target.value)}
                  />
                )}
              </SettingRow>
              <SettingRow label="Name" hint="Optional — how the webhook is listed here.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    className="w-full sm:w-80"
                    value={label}
                    placeholder="#builds"
                    onChange={(event) => setLabel(event.target.value)}
                  />
                )}
              </SettingRow>
              <div>
                <Button type="submit" size="sm" disabled={busy !== null || !url.trim()}>
                  {busy === 'add' ? 'Adding…' : 'Add webhook'}
                </Button>
              </div>
            </form>
          )}
          {allowed && hooks.length === 0 && (
            <p className="text-body text-ink-muted" data-testid="webhooks-empty">
              No webhook yet — the announcements this console already makes go to the first one you add.
            </p>
          )}
          {hooks.length > 0 && (
            <ul className="flex min-w-0 flex-col gap-3" data-testid="webhooks">
              {hooks.map((hook) => (
                <WebhookItem
                  key={hook.id}
                  hook={hook}
                  catalogue={catalogue}
                  allowed={allowed}
                  busy={busy}
                  now={now}
                  onTest={() =>
                    void run(
                      `test:${hook.id}`,
                      () => api.webhookTest(hook.id),
                      (result) =>
                        toast(
                          result.ok ? `Delivered: ${result.detail}` : `Not delivered: ${result.detail}`,
                          result.ok ? 'ok' : 'error',
                        ),
                    )
                  }
                  onRemove={() =>
                    void run(
                      `remove:${hook.id}`,
                      () => api.webhookRemove(hook.id),
                      () => toast(`Removed ${hook.label}.`, 'ok'),
                    )
                  }
                  onKinds={(next) => void run(`kinds:${hook.id}`, () => api.webhookCategories(hook.id, next))}
                />
              ))}
            </ul>
          )}
          <p className="max-w-(--measure) text-meta text-ink-muted">
            Slack and Telegram show the payload’s <code className="font-mono">text</code>; Discord shows its{' '}
            <code className="font-mono">content</code>. Both are the same line, so a plain incoming-webhook
            URL works with no relay in between. The fields and the recipes are in{' '}
            {/* One line: a link wrapped across two has its middle between them, where a thumb lands on nothing. */}
            <a
              className="tap-line whitespace-nowrap text-ink underline decoration-ink-faint underline-offset-2 hover:decoration-ink"
              href={WEBHOOKS_DOC}
              target="_blank"
              rel="noreferrer"
            >
              the webhooks guide
            </a>
            .
          </p>
        </>
      )}
    </SettingsGroup>
  );
}
