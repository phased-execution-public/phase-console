/**
 * This process — which console is serving this page, and what it is running
 * (7.0's since quiet-console phase 23).
 *
 * ```
 * This process
 * Server code    current with what is on disk
 * Serving        the built client (client/dist)
 * Interface      current with the server's build (af1cadb343f7)
 * Skill          phased-execution at af1cadb343f7 in ~/.claude — the console's own commit
 * Supervisor     launchd, KeepAlive: a clean exit comes straight back
 * Node           --max-old-space-size=6144
 * Started        2 hours ago
 * [Get the latest interface]
 * ```
 *
 * "I deployed and still see the old app" is always one of two halves, and the
 * page shows both: the SERVER (Node reads `server/` once, at startup — Restart
 * replaces it) and the BUNDLE THIS TAB RUNS (a service worker keeps a cached
 * shell until an update applies — *Get the latest interface* replaces it). The
 * skill sessions load is the third copy, and its row says when it is another
 * commit than this console.
 */

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CrashLoopCard } from '@/cards/halt-mark';
import { api, type BootHold, type ConsoleState, type SkillCopyView } from '@/data/api';
import { keys } from '@/data/keys';
import { homePath } from '@/lib/format';
import { applyUpdateNow } from '@/lib/pwa';
import { Banner, Button, KeyValue, Mono, RelativeTime, toast } from '@/ui';
import { ArgWords, SettingsGroup, failureWords } from './setting';

/**
 * THIS TAB's build against the server's — the Interface row. `__BUILD_REV__`
 * is baked by Vite from the function that stamps `dist/.build-rev`, so equal
 * strings mean "the page you are reading is the page this server serves".
 */
export function interfaceWords(distRev: string | null | undefined, mine: string): ReactNode {
  if (!distRev || distRev === 'unknown' || mine === 'unknown') {
    return 'Unknown — an unstamped build, or a server that predates the report';
  }
  if (mine === distRev) {
    return (
      <span>
        Current with the server’s build <Mono value={mine} chars={12} copyable />
      </span>
    );
  }
  return (
    <span className="text-ink">
      This tab was built from <Mono value={mine} chars={12} copyable />; the server now serves{' '}
      <Mono value={distRev} chars={12} copyable /> — get the latest interface below
    </span>
  );
}

/**
 * The ONE skill copy sessions load — the plugin each Claude Code config dir
 * installed, its commit and its path — against the server's build
 * (control-tower phase 98, #151).
 */
export function skillWords(view: SkillCopyView | null | undefined, home: string | undefined): ReactNode {
  if (!view) return 'Unknown — this server predates the skill-copy report';
  const installed = view.copies.filter((copy) => copy.install);
  if (!installed.length)
    return 'No plugin copy is installed — sessions read the skill from wherever Claude Code finds it';
  return (
    <span className="flex min-w-0 flex-col gap-1">
      {installed.map((copy) => {
        const install = copy.install!;
        const commit = install.commit ?? install.version;
        const drifted = view.drift.some((one) => one.configDir === copy.configDir);
        return (
          <span key={copy.configDir} className="min-w-0">
            {view.plugin} at {commit ? <Mono value={commit} chars={12} /> : 'an unknown commit'} in{' '}
            <span className="wrap-anywhere font-mono text-meta">{homePath(copy.configDir, home)}</span>
            {drifted
              ? ' — another commit than this console'
              : view.consoleRev
                ? ' — the console’s own commit'
                : ''}
          </span>
        );
      })}
    </span>
  );
}

/** What stands in front of this process: a server older than its files, a held boot, a skill at another commit. */
export function ProcessBanners({ state }: { state: ConsoleState }) {
  return (
    <>
      {state.serverStale && (
        <Banner severity="warn">
          The server files on disk are newer than this process. Restart it, below, to run them.
        </Banner>
      )}
      {state.bootHold &&
        (state.bootHold.kind === 'crash-loop' ? (
          // The crash loop is a stop like a run's, drawn through the halt family (#20).
          <CrashLoopCard hold={state.bootHold} allowRun={state.allowRun === true} />
        ) : (
          <BootHoldBanner hold={state.bootHold} allowRun={state.allowRun === true} />
        ))}
      {state.skillCopy && state.skillCopy.drift.length > 0 && (
        <Banner severity="warn" data-testid="skill-drift">
          The skill sessions read is at another commit than this console, so they follow a procedure its
          scripts no longer match:{' '}
          {state.skillCopy.drift.map((copy) => homePath(copy.configDir, state.home)).join(', ')}. Move it to
          this console with <code className="wrap-anywhere font-mono">{state.skillCopy.update}</code> — open
          sessions pick it up on <code className="font-mono">/reload-plugins</code> or a restart.
        </Banner>
      )}
    </>
  );
}

/**
 * A console holding its automation says so where its off switch lives, with
 * the one press that lifts it (SHD-5, FLT-9): releasing it runs the boot pass
 * that was held — the re-adoption and the convergence loop.
 */
function BootHoldBanner({ hold, allowRun }: { hold: BootHold; allowRun: boolean }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const release = async () => {
    setBusy(true);
    try {
      await api.releaseBootHold();
      toast('Released — this console re-adopts and converges its runs now.', 'ok');
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: keys.state() });
      void client.invalidateQueries({ queryKey: keys.shutdown() });
    }
  };
  return (
    <Banner severity="warn" data-testid="boot-hold">
      <span className="flex min-w-0 flex-col gap-2">
        <span>
          <strong>
            {hold.kind === 'stopped'
              ? 'Stopped on purpose — automation is held.'
              : 'Automation is held at boot.'}
          </strong>{' '}
          {hold.why}
        </span>
        {allowRun ? (
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            disabled={busy}
            onClick={() => void release()}
          >
            {hold.kind === 'stopped' ? 'Clear the stop and resume' : 'Release it for this boot'}
          </Button>
        ) : (
          <span className="text-meta text-ink-muted">
            Releasing it starts work, which needs <code className="font-mono">--allow-run</code>.
          </span>
        )}
      </span>
    </Banner>
  );
}

/**
 * The client-side twin of Restart: Restart replaces the PROCESS; this replaces
 * the BUNDLE THIS TAB RUNS — the half a service-worker app hides.
 */
function UpdateInterface() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void applyUpdateNow().then((result) => {
            if (result === 'current') {
              toast('This tab already runs the newest interface.', 'ok');
              setBusy(false);
            } else if (result === 'unsupported') {
              toast('No service worker here — a plain reload already gets the newest build.', 'info');
              setBusy(false);
            }
            // 'reloading' needs nothing: the page is replacing itself.
          });
        }}
      >
        {busy ? 'Checking…' : 'Get the latest interface'}
      </Button>
      <span className="max-w-(--measure) text-meta text-ink-muted">
        Restarting the server does not update an open tab: its interface is cached and swaps when you say so,
        usually from the new-version notice. This pulls the newest build into this tab now.
      </span>
    </div>
  );
}

export function ProcessGroup({ state }: { state: ConsoleState }) {
  const mine = typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'unknown';
  return (
    <SettingsGroup id="process" title="This process">
      <div data-testid="process-facts" className="min-w-0">
        <KeyValue
          items={[
            [
              'Server code',
              state.serverStale ? (
                <span key="s" className="text-ink">
                  Older than what is on disk — restart it
                </span>
              ) : (
                'Current with what is on disk'
              ),
            ],
            // Reported rather than inferred: the pick is per request, so a
            // build cuts a live console over with no restart.
            [
              'Serving',
              state.staticRoot === 'dist' ? (
                <span key="d">
                  The built client, <span className="font-mono text-meta">client/dist</span>
                </span>
              ) : state.staticRoot === 'not-built' ? (
                <span key="n">
                  Nothing — <span className="font-mono text-meta">client/dist</span> is missing; run{' '}
                  <span className="font-mono text-meta">npm run build</span>
                </span>
              ) : (
                'Unknown — this server predates the static-root report'
              ),
            ],
            ['Interface', interfaceWords(state.distRev, mine)],
            ['Skill', skillWords(state.skillCopy, state.home)],
            ['Supervisor', state.supervisor?.detail ?? 'Unknown'],
            state.execArgv?.length
              ? [
                  'Node',
                  <span key="node" className="font-mono text-meta">
                    <ArgWords args={state.execArgv} />
                  </span>,
                ]
              : null,
            state.bootedAt ? ['Started', <RelativeTime key="started" at={state.bootedAt} />] : null,
          ]}
        />
      </div>
      <UpdateInterface />
    </SettingsGroup>
  );
}
