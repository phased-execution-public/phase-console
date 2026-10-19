/**
 * The guided MCP sign-in (one-pool phase 19, #372) — every step on the page.
 *
 * ```
 * Sign in to Linear                                         4:12 left
 * ✓ 1  The Claude CLI asks Linear for a sign-in page
 * ● 2  Approve in the browser that opened        [ Open sign-in page ]
 *   3  The console checks Linear
 * ```
 *
 * At this machine the CLI opens the browser and takes the answer itself, so
 * there is nothing to paste. Reached from elsewhere (a phone, Tailscale) the
 * browser the CLI could open is on a screen nobody is looking at, so the CLI
 * prints the page instead (`--no-browser`) and waits for the address the
 * browser lands on — a step that used to be said nowhere, and four sign-ins
 * timed out on it in one day. The sheet says it, takes the address and hands
 * it to the CLI. Both end the same way: the console re-probes the server and
 * the sheet says Connected — or why not, naming the step the flow stopped on,
 * with *Try again*.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type McpLoginFlow, type McpLoginStart, type McpServerView } from '@/data/api';
import { keys } from '@/data/keys';
import { useMcpLoginFlow } from '@/data/mcp';
import { sessionsHref } from '@/shell/routes';
import { Banner, Button, Input, Label, toast } from '@/ui';
import { usePageNow, useFineClock } from '@/ui/clock';
import { CodeBlock } from '@/ui/code-block';
import { Dialog, DialogContent } from '@/ui/dialog';
import { failureWords } from './setting';

/** The steps a flow walks, as the sheet lists them — the paste only when the person is elsewhere. */
export function signInSteps(
  server: { label: string },
  remote: boolean,
): { step: McpLoginFlow['step']; words: string }[] {
  return [
    { step: 'starting', words: `The Claude CLI asks ${server.label} for a sign-in page` },
    remote
      ? {
          step: 'paste',
          words: 'Open the sign-in page, approve, and paste back the address the browser lands on',
        }
      : { step: 'approve', words: 'Approve in the browser that opened on this machine' },
    { step: 'checking', words: `The console checks ${server.label}` },
  ];
}

/** Where a step stands against the flow's current one: done, now, or later. */
export function stepState(
  steps: readonly { step: McpLoginFlow['step'] }[],
  index: number,
  current: McpLoginFlow['step'],
): 'done' | 'now' | 'later' {
  if (current === 'connected') return 'done';
  const at = steps.findIndex((item) => item.step === current);
  if (at < 0) return 'later';
  return index < at ? 'done' : index === at ? 'now' : 'later';
}

/** `m:ss` left until the deadline, or null once it has passed. */
export function timeLeft(deadline: string, now: number): string | null {
  const ms = Date.parse(deadline) - now;
  if (!(ms > 0)) return null;
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The sheet, opened by the row's *Sign in*. It starts the flow as it opens and follows it to its end. */
export function SignInSheet({
  server,
  accountId,
  onClose,
}: {
  server: McpServerView;
  accountId?: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [started, setStarted] = useState<McpLoginStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const start = async () => {
    setStarted(null);
    setStarting(true);
    setProblem(null);
    try {
      const answer = await api.mcpLogin(server.id, accountId ? { accountId } : {});
      setStarted(answer);
      void client.invalidateQueries({ queryKey: keys.mcpLogin(server.id) });
    } catch (error) {
      setProblem(failureWords(error));
    } finally {
      setStarting(false);
    }
  };

  // The press that opened the sheet is the press that starts it — once, even
  // where a development build runs an effect twice.
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the opening press, once
  }, []);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={`Sign in to ${server.label}`} description="Every step is on this page.">
        <div className="flex min-w-0 flex-col gap-4" data-testid="mcp-signin" data-mcp-signin={server.id}>
          {!started ? (
            <>
              <p className="max-w-(--measure) text-body text-ink">
                {server.label} signs in with OAuth. The Claude CLI asks it for a sign-in page, you approve
                there, and the token goes to the CLI’s own store — this console never reads or writes it.
              </p>
              {problem && <Banner severity="error">{problem}</Banner>}
              <span className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" disabled={starting} onClick={() => void start()}>
                  {starting ? 'Starting…' : 'Try again'}
                </Button>
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </span>
            </>
          ) : started.mode === 'embedded' && started.flow ? (
            <FlowSteps
              server={server}
              initial={started.flow}
              onRetry={() => void start()}
              onClose={onClose}
            />
          ) : (
            <ByHand server={server} started={started} onClose={onClose} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FlowSteps({
  server,
  initial,
  onRetry,
  onClose,
}: {
  server: McpServerView;
  initial: McpLoginFlow;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { data } = useMcpLoginFlow(server.id);
  // The started flow is the answer until the first read lands — and a read
  // of an older flow (a previous attempt) never stands in for this one.
  const flow = data?.flow && data.flow.startedAt >= initial.startedAt ? data.flow : initial;
  const steps = signInSteps(server, flow.remote);
  const box = useRef<HTMLDivElement>(null);
  const ended = flow.step === 'connected' || flow.step === 'failed' || flow.step === 'timed-out';
  useFineClock(box, !ended);
  const now = usePageNow();
  const left = timeLeft(flow.deadline, now);

  return (
    <div ref={box} className="flex min-w-0 flex-col gap-4" data-login-step={flow.step}>
      {!ended && (
        <p className="tnum text-meta text-ink-muted" aria-live="off">
          {left
            ? `${left} left — the Claude CLI gives up five minutes after it starts.`
            : 'The five minutes are up.'}
        </p>
      )}
      <ol className="flex min-w-0 flex-col gap-3">
        {steps.map((item, index) => {
          const state =
            flow.step === 'failed' || flow.step === 'timed-out'
              ? stoppedState(steps, index, flow)
              : stepState(steps, index, flow.step);
          return (
            <li key={item.step} className="flex min-w-0 gap-3" data-step={item.step} data-step-state={state}>
              <span
                aria-hidden
                className={`tnum grid size-6 shrink-0 place-items-center rounded-full text-meta ${state === 'now' ? 'bg-ink text-ground' : state === 'done' ? 'text-ink' : 'text-ink-faint'}`}
              >
                {state === 'done' ? '✓' : index + 1}
              </span>
              <span className="flex min-w-0 flex-col gap-2">
                <span className={state === 'later' ? 'text-body text-ink-muted' : 'text-body text-ink'}>
                  {item.words}
                  <span className="sr-only">
                    {state === 'done' ? ' — done' : state === 'now' ? ' — now' : ''}
                  </span>
                </span>
                {state === 'now' && item.step !== 'starting' && item.step !== 'checking' && (
                  <StepAct server={server} flow={flow} />
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {flow.step === 'connected' && (
        <Banner severity="ok">
          {server.label} is connected. Runs on this console can use it from now on.
        </Banner>
      )}
      {(flow.step === 'failed' || flow.step === 'timed-out') && (
        <Banner severity="error">{flow.detail ?? 'The sign-in did not finish.'}</Banner>
      )}
      <span className="flex flex-wrap gap-2">
        {ended && flow.step !== 'connected' && (
          <Button size="sm" variant="primary" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button size="sm" variant={flow.step === 'connected' ? 'primary' : 'ghost'} onClick={onClose}>
          {ended ? 'Done' : 'Close — it keeps running'}
        </Button>
        {!ended && flow.sessionId && (
          <Button size="sm" variant="ghost" asChild>
            <a href={sessionsHref(flow.sessionId)}>Open the terminal</a>
          </Button>
        )}
      </span>
    </div>
  );
}

/** Which step a stopped flow stopped on: the one it was waiting at when it ended. */
function stoppedState(
  steps: readonly { step: McpLoginFlow['step'] }[],
  index: number,
  flow: McpLoginFlow,
): 'done' | 'now' | 'later' {
  const at = flow.pastedAt ? 'checking' : flow.authUrl ? (flow.remote ? 'paste' : 'approve') : 'starting';
  return stepState(steps, index, at);
}

/** The act of the current step: the sign-in page, and — from elsewhere — the paste field. */
function StepAct({ server, flow }: { server: McpServerView; flow: McpLoginFlow }) {
  const client = useQueryClient();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex min-w-0 flex-col gap-3">
      {flow.authUrl ? (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Button size="sm" variant={flow.remote ? 'primary' : 'ghost'} asChild>
            <a href={flow.authUrl} target="_blank" rel="noreferrer">
              Open sign-in page
            </a>
          </Button>
          {!flow.remote && (
            <span className="text-meta text-ink-muted">If no browser opened, open it from here.</span>
          )}
        </span>
      ) : (
        <span className="text-meta text-ink-muted">Waiting for the sign-in page…</span>
      )}
      {flow.remote && (
        <form
          className="flex min-w-0 flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!address.trim()) return;
            setBusy(true);
            api
              .mcpLoginPaste(server.id, address.trim())
              .then(() => {
                setAddress('');
                void client.invalidateQueries({ queryKey: keys.mcpLogin(server.id) });
              })
              .catch((error: unknown) => toast(failureWords(error), 'error'))
              .finally(() => setBusy(false));
          }}
        >
          <Label htmlFor={`mcp-paste-${server.id}`}>The address the browser lands on</Label>
          <span className="max-w-(--measure) text-meta text-ink-muted">
            After you approve, the browser goes to an address starting with http://localhost — it may say the
            page cannot be reached. That is expected: copy the whole address from the address bar and paste it
            here.
          </span>
          <span className="flex min-w-0 flex-wrap gap-2">
            <Input
              id={`mcp-paste-${server.id}`}
              className="w-full sm:w-96"
              value={address}
              placeholder="http://localhost:…/callback?code=…"
              onChange={(event) => setAddress(event.target.value)}
            />
            <Button type="submit" size="sm" variant="primary" disabled={busy || !address.trim()}>
              {busy ? 'Sending…' : 'Send it to the CLI'}
            </Button>
          </span>
        </form>
      )}
    </span>
  );
}

/** No terminal here: the person runs the line themselves, and the row says when it worked. */
function ByHand({
  server,
  started,
  onClose,
}: {
  server: McpServerView;
  started: McpLoginStart;
  onClose: () => void;
}) {
  const commands = started.commands?.length ? started.commands : [started.command];
  return (
    <div className="flex min-w-0 flex-col gap-3" role="status">
      <p className="max-w-(--measure) text-body text-ink">
        {started.mode === 'external'
          ? `A terminal opened on this machine for ${server.label}'s sign-in — finish it there.`
          : `This console cannot run the sign-in for ${server.label} itself.`}
      </p>
      {started.detail && <p className="max-w-(--measure) text-meta text-ink-muted">{started.detail}</p>}
      {started.mode !== 'external' && commands.some(Boolean) && (
        <>
          <p className="max-w-(--measure) text-meta text-ink-muted">
            Run {commands.length > 1 ? 'these' : 'this'} in a terminal, then press Re-check all.
            {started.configDir ? ` The token lands in ${started.configDir}.` : ''}
          </p>
          <CodeBlock
            code={commands.join('\n')}
            label="The sign-in by hand"
            testId="mcp-signin-by-hand"
            claudeCode={false}
          />
        </>
      )}
      <span className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </span>
    </div>
  );
}
