/**
 * This instance — which console is running, how it is reached, and how to
 * replace or stop it.
 *
 * The last section, because it is the one whose two buttons END things. Phase 7
 * moved the start command and the launcher OUT of here and into Essentials:
 * they answer *how do I run a console*, which is a question you have before you
 * have one, and burying them under a heading named after an implementation is
 * where an operator looking for "how do I turn runs on" would never look. What
 * is left is genuinely about the process serving this page.
 *
 * The two replace buttons are deliberately on the same screen and deliberately
 * distinct: **Restart** replaces the SERVER (Node reads `server/` once, at
 * startup) and **Get the latest interface** replaces the BUNDLE THIS TAB RUNS
 * (a service worker keeps a cached shell until an update applies). "I deployed
 * and still see the old app" is always one of those two, and a page that
 * offered only one made the other invisible.
 */

import { CrashLoopCard } from '@/components/halt-mark';
import { useState } from 'react';
import { api, type SkillCopyView } from '@/lib/api';
import { homePath } from '@/lib/format';
import { keys, useApiMutation, useConsoleState } from '@/lib/queries';
import { applyUpdateNow } from '@/lib/pwa';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  KeyValue,
  MonoId,
  Skeleton,
  toast,
} from '@/components/ui';
import { settingsHref } from '@/app/routes';
import { SettingsSectionFrame, sectionFor } from './nav';
import { RestartButton } from './restart';
import { RetentionCard } from './retention';
import { ShutdownButton } from './shutdown';
import { TailscaleCard } from './tailscale';

export function InstanceSection() {
  const { data: state } = useConsoleState();
  const section = sectionFor('instance')!;

  if (!state) {
    return (
      <SettingsSectionFrame section={section}>
        <Skeleton className="h-56" />
        <Skeleton className="h-40" />
      </SettingsSectionFrame>
    );
  }

  return (
    <SettingsSectionFrame section={section}>
      {state.serverStale && (
        <Banner severity="warn">
          The server files on disk are newer than this process. Restart it below to run them.
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
          this console: <code>{state.skillCopy.update}</code> — open sessions pick it up on{' '}
          <code>/reload-plugins</code> or a restart.
        </Banner>
      )}

      <Card>
        <CardHeader>
          <CardTitle>This process</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <KeyValue
            items={[
              [
                'Server code',
                state.serverStale ? (
                  <span key="s" className="text-action">
                    older than what is on disk
                  </span>
                ) : (
                  'current with what is on disk'
                ),
              ],
              // Reported rather than inferred — the pick is per request, so a
              // build cuts a live console over with no restart. `not-built` is
              // reachable from here: a precached shell keeps running after
              // `client/dist` is deleted, and this row is how it says so.
              [
                'Serving',
                state.staticRoot === 'dist' ? (
                  <span key="d">
                    the built client (<code>client/dist</code>)
                  </span>
                ) : state.staticRoot === 'not-built' ? (
                  <span key="n">
                    nothing — <code>client/dist</code> is missing; run <code>npm run build</code>
                  </span>
                ) : (
                  'unknown — this server predates the static-root report'
                ),
              ],
              // THIS TAB against the server's build — the diagnostic for "I
              // deployed and still see the old app".
              ['Interface', interfaceRow(state.distRev)],
              // The OTHER half of the install (#151): the skill copy the
              // sessions this console starts load, against its build.
              ['Skill', skillRow(state.skillCopy, state.home)],
              ['Supervisor', state.supervisor?.detail ?? 'unknown'],
            ]}
          />
          <RestartButton />
          <p className="text-2xs text-ink-faint">
            Node reads <code>server/</code> once, at startup. Reloading the page reloads the client and
            nothing else, so a server fix you already have looks like it did not work until this process is
            replaced. Restart brings it back with the arguments it was started with: the console starts its
            own successor.
            <a href={settingsHref('essentials')} className="text-action underline">
              Essentials
            </a>{' '}
            shows this console&rsquo;s start command, with every capability.
          </p>
          <div className="border-t border-rule pt-3">
            <UpdateInterfaceButton />
            <p className="mt-2 text-2xs text-ink-faint">
              The other half of the same coin: restarting the SERVER does not update open tabs. The interface
              is cached by a service worker and swaps only when you approve — usually via the &ldquo;new
              version&rdquo; toast. If that toast is gone, this pulls the newest build into this tab now.
            </p>
          </div>
          <div className="border-t border-rule pt-3">
            <ShutdownButton />
          </div>
        </CardBody>
      </Card>

      <RetentionCard />
      {/* Two retentions, two pages, said once (phase 15): the card above is
          what becomes of this console's LOGS; what becomes of a settled run's
          CHECKOUTS is a launch default, edited where the other launch
          defaults are. */}
      <p className="text-2xs text-ink-faint">
        Logs and their retention are above. What becomes of a run&rsquo;s checkouts when it settles is a
        launch default — <em>When the run settles, its checkouts</em> in{' '}
        <a href={settingsHref('automation')} className="text-action underline">
          Automation
        </a>
        .
      </p>

      <TailscaleCard
        port={state.port ?? 4123}
        remoteHosts={state.remoteHosts}
        remoteUsers={state.remoteUsers}
      />
    </SettingsSectionFrame>
  );
}

/**
 * THIS TAB's build against the server's — the words for the Interface row.
 *
 * `__BUILD_REV__` is baked by Vite from the same function that stamps
 * `dist/.build-rev`, so equal strings mean "the page you are reading is the
 * page this server serves". Either side unknowable degrades to saying so.
 */
function interfaceRow(distRev: string | null | undefined): React.ReactNode {
  const mine = typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'unknown';
  if (!distRev || distRev === 'unknown' || mine === 'unknown') {
    return 'unknown (an unstamped build, or a server that predates the report)';
  }
  // Twelve characters is the recognisable prefix; the whole revision is on the
  // hover, which is the difference between reading it off the screen and being
  // able to paste it into a `git show`.
  if (mine === distRev)
    return (
      <span>
        current with the server&rsquo;s build (<MonoId id={mine} chars={12} copyable />)
      </span>
    );
  return (
    <span className="text-action">
      this tab was built from <MonoId id={mine} chars={12} copyable />; the server now serves{' '}
      <MonoId id={distRev} chars={12} copyable /> — use &ldquo;Get the latest interface&rdquo; below
    </span>
  );
}

/**
 * The ONE skill copy sessions load — the plugin each Claude Code config dir
 * installed, its commit and its path — against the server's build (control-tower
 * phase 98, #151). Fourteen copies once sat on one machine with nothing saying
 * which was live; this row is where that is said.
 */
function skillRow(view: SkillCopyView | null | undefined, home: string | undefined): React.ReactNode {
  if (!view) return 'unknown — this server predates the skill-copy report';
  const installed = view.copies.filter((copy) => copy.install);
  if (!installed.length) {
    return 'no plugin copy installed — sessions read the skill from wherever Claude Code finds it';
  }
  return (
    <span className="flex flex-col gap-1">
      {installed.map((copy) => {
        const install = copy.install!;
        const commit = install.commit ?? install.version;
        const drifted = view.drift.some((one) => one.configDir === copy.configDir);
        return (
          <span key={copy.configDir} className={drifted ? 'text-action' : undefined}>
            {view.plugin} at {commit ? <MonoId id={commit} chars={12} copyable /> : 'an unknown commit'} in{' '}
            <code>{homePath(copy.configDir, home)}</code>
            {drifted
              ? ' — another commit than this console'
              : view.consoleRev
                ? ' — the console’s own commit'
                : ''}{' '}
            <code className="text-2xs text-ink-faint">{homePath(install.installPath, home)}</code>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The client-side twin of Restart. The server button replaces the PROCESS;
 * this replaces the BUNDLE THIS TAB RUNS — the half a service-worker app hides,
 * and the half "I restarted and it still looks old" is actually about.
 */
function UpdateInterfaceButton() {
  const [busy, setBusy] = useState(false);
  return (
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
            toast(
              'No service worker here (dev server, or an unsupported browser) — a plain reload already gets the newest build.',
              'info',
            );
            setBusy(false);
          }
          // 'reloading' needs nothing: the page is replacing itself.
        });
      }}
    >
      {busy ? 'Checking…' : 'Get the latest interface'}
    </Button>
  );
}

/**
 * A console holding its automation says so where its off switch lives, with
 * the one press that lifts it (SHD-5, FLT-9). The hold is the console's own
 * decision about what it starts by itself — a "stay off" that came back, or a
 * profile saying it does not start its work unattended — so releasing it runs
 * the boot pass that was held: the re-adoption and the convergence loop.
 */
function BootHoldBanner({ hold, allowRun }: { hold: NonNullable<ConsoleStateBootHold>; allowRun: boolean }) {
  const release = useApiMutation({
    fn: () => api.releaseBootHold(),
    say: 'Released — this console re-adopts and converges its runs now.',
    invalidates: [keys.state(), keys.shutdown()],
  });
  return (
    <Banner severity="warn" data-testid="boot-hold">
      <span className="flex flex-col gap-2">
        <span>
          <strong className="text-ink">
            {hold.kind === 'stopped'
              ? 'Stopped on purpose — automation is held.'
              : 'Automation is held at boot.'}
          </strong>{' '}
          {hold.why}
        </span>
        {allowRun ? (
          <Button
            size="sm"
            variant="action"
            className="self-start"
            disabled={release.isPending}
            onClick={() => release.mutate()}
          >
            {hold.kind === 'stopped' ? 'Clear the stop and resume' : 'Release it for this boot'}
          </Button>
        ) : (
          <span className="text-2xs text-ink-muted">
            Releasing it starts work, which needs <code>--allow-run</code>.
          </span>
        )}
      </span>
    </Banner>
  );
}

type ConsoleStateBootHold = NonNullable<ReturnType<typeof useConsoleState>['data']>['bootHold'];
