/**
 * The controls, grouped by what they decide — the sections every stage and
 * the flat layout are made of.
 *
 * Each section reads the form through `useSetupForm()`, renders nothing when
 * the mode shows none of its fields, and is written ONCE: the staged layout
 * places sections on stages, the flat layout stacks them in order, and a
 * control written in two places is how one of them stops sending its value.
 * The labels are the words `reachability.test.tsx` finds each control by, so
 * they are the accessible names and they do not move.
 *
 * Two controls changed shape in Phase 8, both for the same measured defect
 * (register rows 433–440): a native `<select>` cuts an option it cannot fit
 * rather than wrapping it, and the part it cut was the part the option
 * existed to show. The ACCOUNT option is now who the account is and nothing
 * else, with its usage meters drawn UNDER the control as real meters; the
 * PERMISSIONS option is the profile's name, with its one-line qualifier and
 * the deny wall under it. More is shown than the option ever managed, and
 * nothing is cut.
 */

import { RefreshMeters } from '@/components/refresh-meters';
import { bucketLabel } from '@/components/limits-widget';
import { Badge, Disclosure, Meter, field } from '@/components/ui';
import type { AccountView } from '@/lib/api';
import { cn } from '@/lib/cn';
import { countdown } from '@/lib/format';
import { usePolicy } from '@/lib/queries';
import { SkillPicker } from '@/features/run-setup/skill-picker';
import { McpPicker } from '@/features/run-setup/mcp-picker';
import { PRIORITY_LABELS, RUN_PRIORITIES, type RunPriority } from '@shared/orchestration-model.js';
import { QA_FIX_STRATEGIES, QA_FIX_STRATEGY_LABELS } from '@shared/run-settings.js';
import {
  DEFAULT_MAX_PER_REPO,
  ISOLATED,
  RETENTION_LABELS,
  SETTLE_LABELS,
  SETTLE_PUSHES,
  SETTLE_STRATEGIES,
  WORKTREE_RETENTION,
} from '@shared/worktree-model.js';
import type { UltraReviewMode } from '@shared/run-lifecycle.js';
import { NumberField, PressField, SelectField, SetupField, ToggleField } from './fields';
import { DecisionsSection } from './decisions';
import { permissionModeFor } from './modes';
import { PerPhase } from './per-phase';
import type { RunSetupValues } from './schema';
import { useSetupForm } from './form-context';
import { AUTONOMY_HELP, AUTONOMY_LABEL } from '@/features/runs/defaults';

/** Two controls side by side above the phone breakpoint, one below it. */
const PAIR = 'grid grid-cols-1 gap-3 sm:grid-cols-2';

/* ------------------------------------------------------------------ *
 * What runs
 * ------------------------------------------------------------------ */

export function ScopeSection() {
  const f = useSetupForm();
  if (!f.on('onlyPhases') && !f.on('startAfter')) return null;
  return (
    <div className="flex flex-col gap-3">
      {f.on('onlyPhases') && (
        <SetupField
          label="Only these phases"
          hint="Empty runs the whole plan. Ranges are fine: 1, 3, 5-7."
          source={f.src('onlyPhases')}
          error={f.errors.onlyPhases}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="text"
              inputMode="numeric"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className={cn(field, 'w-full')}
              placeholder="the whole plan"
              value={f.values.onlyPhases}
              onChange={(event) => f.set('onlyPhases', event.target.value)}
            />
          )}
        </SetupField>
      )}
      {/* A chain, not a schedule: the run boards nothing until the named plan's
          latest run ends, however it ends. Start-only — `modes.ts` drops it
          from a live run's field list, because a run already mid-plan cannot
          un-begin — and unvalidated on purpose: a slug that names no plan
          settles at once rather than refusing the start of a run whose
          predecessor the operator is about to create. */}
      {f.on('startAfter') && (
        <SetupField
          label="Start after (optional)"
          hint="A plan slug. This run boards nothing until that plan's latest run ends — finished, paused, parked or stopped. Empty starts as soon as the queue allows."
          source={f.src('startAfter')}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              type="text"
              aria-describedby={describedBy}
              className={cn(field, 'w-full')}
              placeholder="start as soon as the queue allows"
              value={f.values.startAfter}
              onChange={(event) => f.set('startAfter', event.target.value)}
            />
          )}
        </SetupField>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * How it runs
 * ------------------------------------------------------------------ */

export function ModelSection() {
  const f = useSetupForm();
  if (!f.on('model') && !f.on('effort')) return null;
  return (
    <div className={PAIR}>
      {f.on('model') && (
        <SelectField
          label="Model"
          source={f.src('model')}
          value={f.values.model}
          placeholder="default — this machine’s"
          options={f.modelOptions}
          onChange={(next) => f.set('model', next)}
        />
      )}
      {f.on('effort') && (
        <SelectField
          label="Effort"
          source={f.src('effort')}
          value={f.values.effort}
          options={f.effortOptions}
          onChange={(next) => f.set('effort', next)}
        />
      )}
    </div>
  );
}

export function PerPhaseSection() {
  const f = useSetupForm();
  if (!f.on('phaseOptions') || !f.planPhases.length) return null;
  return (
    <PerPhase
      planPhases={f.planPhases}
      overrides={f.values.phaseOptions}
      runModel={f.values.model}
      runEffort={f.values.effort}
      models={f.models}
      skills={f.skills}
      runSkills={f.values.skills}
      servers={f.mcpServers}
      runMcp={f.values.mcpServers}
      onChange={(next) => f.set('phaseOptions', next)}
    />
  );
}

/**
 * The profile, then the wall. The option is the profile's NAME; its qualifier
 * (the part of the label after the dash) and what that profile raises a card
 * for sit under the control, where a sentence can wrap. The deny list is
 * stated once, under all three, because it is the same under all three.
 */
export function PermissionsSection() {
  const f = useSetupForm();
  if (!f.on('permissionProfile')) return null;
  const profile = f.values.permissionProfile;
  const qualifier = f.permissionQualifier(profile);
  return (
    <div className="flex flex-col gap-2">
      <SelectField
        label="Permissions"
        source={f.src('permissionProfile')}
        value={profile}
        options={f.permissionOptions.map(([id]) => [id, f.permissionName(id)] as const)}
        hint={
          <>
            {qualifier ? `${qualifier[0]!.toUpperCase()}${qualifier.slice(1)}. ` : ''}
            {f.permissionHint(profile)}
          </>
        }
        onChange={(next) => {
          f.set('permissionProfile', next as RunSetupValues['permissionProfile']);
          // The two spellings of one choice stay in step: a session's CLI
          // mode is derived, never a second thing to keep aligned by hand.
          f.set('permissionMode', permissionModeFor(next));
        }}
      />
      {f.context.slug &&
        (f.mode === 'start' || f.mode === 'continue' || f.mode === 'phase' || f.mode === 'live') && (
          <DenyWall slug={f.context.slug} />
        )}
    </div>
  );
}

/**
 * The deny wall, as the fact it is: identical under every profile, enforced
 * by the CLI, standing with this console dead. Its size comes from the policy
 * the console actually holds; the rules themselves are one fold down.
 */
function DenyWall({ slug }: { slug: string }) {
  const { data: policy } = usePolicy(slug);
  const deny = policy?.effective.deny ?? [];
  return (
    <div className="rounded border border-rule bg-ground px-3 py-2 text-2xs text-ink-muted">
      <p>
        The deny list is the same under every profile
        {deny.length ? ` — ${deny.length} ${deny.length === 1 ? 'rule' : 'rules'}` : ''}: pushes, destructive
        git, deploys and publishes are refused outright, by the CLI, so it holds with this console dead. Only
        the ask list moves between profiles.
      </p>
      {deny.length > 0 && (
        <Disclosure label="The deny list" count={deny.length} className="mt-1">
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-2xs text-ink-muted">
            {deny.map((rule) => (
              <li key={rule} className="min-w-0 break-all">
                {rule}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

export function BranchSection() {
  const f = useSetupForm();
  const { values, mode, context, isolationPreflight } = f;
  if (!f.on('gitMode')) return null;
  const Bool = f.Bool;
  const branch = values.gitMode === 'new-branch';
  // A base branch is a fact about the past once the run's branch has been cut
  // (`checkout` set): the door 409s a new word, so the control says so and
  // takes nothing rather than letting an operator type a fork that never
  // happened and learn it from the refusal.
  const baseLocked = mode === 'live' && Boolean(context.run?.checkout);
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="Branch"
        source={f.src('gitMode')}
        value={values.gitMode}
        options={[
          ['default-branch', 'Work on the current branch'],
          [
            'new-branch',
            context.slug
              ? `Create a work branch per run (pe/${context.slug})`
              : 'Create a work branch per run',
          ],
        ]}
        onChange={(next) => f.set('gitMode', next as RunSetupValues['gitMode'])}
      />

      {/* Two controls for ONE fact, so only one of them is ever on screen.
          `settle` is the newer and wider question — a pull request is one of
          four answers to it — and `openPr` is the tick that predates it. A mode
          that offers both renders the select; a mode that offers only `openPr`
          (or a client older than the field) keeps the tick. Rendering both
          would let an operator ask for `integration` and untick "open a PR" in
          the same form, and the payload would carry a contradiction the server
          resolves by order rather than by intent. */}
      {f.live('settle') && (
        <SelectField
          label="When the plan completes"
          hint={
            values.settle === 'integration'
              ? `The console merges the branch into its own staging checkout (pe/integration) and stops. Nothing is pushed and no session is spent; a conflict aborts the merge and leaves every commit on the branch.${isolationPreflight?.kind === 'mirror' && values.isolation === ISOLATED ? ' NOTE: this plan spans several repositories — a mirror run refuses this strategy by name at the end and keeps its branches instead. Use pr or keep.' : ''}`
              : values.settle === 'merge-queue'
                ? `One more session rebases the branch on whatever landed while the run drove, re-runs the plan’s end-to-end verification, and pushes only if that passes — after one approval tap on the push.${isolationPreflight?.kind === 'mirror' && values.isolation === ISOLATED ? ' NOTE: this plan spans several repositories — a mirror run refuses this strategy by name at the end and keeps its branches instead. Use pr or keep.' : ''}`
                : values.settle === 'keep'
                  ? 'Nothing happens to the branch. It and its checkout stay exactly where they are, for you to look at first.'
                  : 'The final phase pushes the branch and opens the PR — after one approval tap on the push. Force-pushes stay denied outright.'
          }
          source={f.src('settle')}
          value={values.settle}
          options={SETTLE_STRATEGIES.map((strategy) => [strategy, SETTLE_LABELS[strategy]])}
          onChange={(next) => {
            const strategy = next as RunSetupValues['settle'];
            f.set('settle', strategy);
            // Kept in step here as well as on the server, so the payload this
            // form sends never disagrees with itself. `pr` is the one strategy
            // that ends at a pull request; `newRun` writes the same mirror.
            f.set('openPr', strategy === 'pr');
          }}
        />
      )}
      {f.live('openPr') && !f.on('settle') && (
        <Bool
          label="Open a PR when the plan completes"
          hint="The final phase pushes the branch and opens the PR — after one approval tap on the push. Force-pushes stay denied outright."
          source={f.src('openPr')}
          value={values.openPr}
          onChange={(next) => f.set('openPr', next)}
        />
      )}
      {/* Isolation rides the same `gitMode === 'new-branch'` gate as `openPr`,
          and for the same reason: a run with no branch of its own has nothing
          to check out. On a LIVE run the control can only be turned off — the
          route 409s a raise, because a run's commits are on the branch in the
          checkout it started in and there is no honest moment to move them. */}
      {f.live('isolation') && (
        <Bool
          label="Give this run its own checkout"
          hint={
            mode === 'live' && values.isolation === 'queue'
              ? 'Off, and it cannot be turned on while the run is going — the run’s commits are on the branch in the checkout it started in. Stop it and start it again to isolate it.'
              : isolationPreflight && !isolationPreflight.available
                ? `Unavailable for this plan — ${isolationPreflight.refusal ?? 'refused'}: ${isolationPreflight.detail ?? 'the run would keep the shared checkout and queue on scope.'}`
                : isolationPreflight?.kind === 'mirror'
                  ? `The console builds a MIRROR — one worktree per scoped repository (${(isolationPreflight.mounts ?? []).join(', ')}), each on the run’s branch — and its sessions work there, so a run on the same repositories can drive at the same time instead of queueing.${isolationPreflight.skipped?.length ? ` Not mounted (uninitialized): ${isolationPreflight.skipped.join(', ')}.` : ''}`
                  : 'The console makes a git worktree for the run’s branch and its sessions work there, so a run on the same repository can drive at the same time instead of queueing. Off is today’s behaviour: overlapping runs wait their turn.'
          }
          source={f.src('isolation')}
          value={values.isolation === ISOLATED}
          disabled={
            (mode === 'live' && values.isolation === 'queue') ||
            (mode !== 'live' && isolationPreflight?.available === false)
          }
          onChange={(next) => f.set('isolation', next ? ISOLATED : 'queue')}
        />
      )}
      {/* Phase 15's three of the branch and the checkout. Every one is ALSO a
          plan line or a console default, and the plan outranks the run: the
          hints say so, because a control that reads as the last word and is
          not one is how an operator sets a base the plan then ignores. */}
      {f.live('baseBranch') && (
        <SetupField
          label="Base branch"
          hint={
            mode === 'defaults'
              ? 'What pe/<slug> — and every lane branch — is cut from when the plan says nothing: origin/HEAD (the remote’s default, a fresh cut), head (wherever the checkout stands), or a branch name.'
              : baseLocked
                ? 'The run’s branch has already been cut from this word — a base branch can be changed only before the first phase boards. Stop the run and start it again to fork elsewhere.'
                : 'What pe/<slug> — and every lane branch — is cut from: origin/HEAD (the remote’s default, a fresh cut), head (wherever the checkout stands), or a branch name. Empty takes the plan’s Base branch: line, else the console’s preference. A plan that names one outranks this either way.'
          }
          source={f.src('baseBranch')}
          error={f.errors.baseBranch}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              type="text"
              aria-describedby={describedBy}
              className={cn(field, 'w-full')}
              placeholder={
                mode === 'defaults' ? 'origin/HEAD' : 'the plan’s line, else the console’s preference'
              }
              value={values.baseBranch}
              disabled={baseLocked}
              onChange={(event) => f.set('baseBranch', event.target.value)}
            />
          )}
        </SetupField>
      )}
      {f.live('maxConcurrentPerRepo') && (
        <NumberField
          label="Runs beside it in the repository"
          hint={
            mode === 'defaults'
              ? 'How many isolated runs this console may hold in ONE repository at once — beside the machine-wide worktree cap, and the narrower one answers first. A repository nobody can read is a different cost from a full disk.'
              : 'How many isolated runs this run will stand beside in its repository before it waits its turn. Empty takes the console’s number; a number here can only be smaller than it — a run may make itself more conservative, never outbid the console.'
          }
          source={f.src('maxConcurrentPerRepo')}
          error={f.errors.maxConcurrentPerRepo}
          value={values.maxConcurrentPerRepo}
          min={1}
          placeholder={mode === 'defaults' ? String(DEFAULT_MAX_PER_REPO) : 'the console’s cap'}
          onChange={(next) => f.set('maxConcurrentPerRepo', next)}
        />
      )}
      {f.live('worktreeRetention') && (
        <SelectField
          label="When the run settles, its checkouts"
          hint="What becomes of the trees the console made for this run once it settles. A tree holding uncommitted work is never removed under any word; keep-on-failure keeps only a run that ended badly, because its checkout holds the only copy of what went wrong."
          source={f.src('worktreeRetention')}
          value={values.worktreeRetention}
          options={RETENTION_OPTIONS}
          onChange={(next) => f.set('worktreeRetention', next)}
        />
      )}
      {/* The `openPr` carve-out pins `git push` and `gh pr create` to *ask* even
          under the Trusted profile — a push and a PR are the run's one
          world-visible act, and the deal is one human tap. The answer window is
          an hour; the only thing that tells anyone a card is up is a push. With
          push down that deal silently becomes "the run parks in an hour", which
          is exactly what happened: a real run raised a `git push` card at
          midday, nobody could know, and the journal records the park. Said
          before launching, because afterwards it costs the run its afternoon. */}
      {f.live('openPr') && SETTLE_PUSHES.has(values.settle) && f.pushBroken && (
        <p className="text-2xs text-ink-muted">
          This console cannot deliver notifications right now, and a PR run stops for one approval tap on the
          push. Nothing will tell you the card is up, and it expires after an hour — fix delivery in Settings
          ▸ Notifications, or watch the run yourself.
        </p>
      )}
      {/* Said rather than simply hidden: a row that disappears reads as a
          setting that does not exist, and this one is only inapplicable. */}
      {mode === 'defaults' && f.on('openPr') && !branch && (
        <p className="text-2xs text-ink-muted">
          PR-on-completion applies to work-branch runs; pick “Create a work branch per run” to use it.
        </p>
      )}
    </div>
  );
}

/**
 * The retention picker's options: the three closed words, and three `ttl:<h>`
 * presets rather than a free number — a parameterised member the operator
 * cannot mistype, on a control that would otherwise need a second input to
 * say "and how many hours".
 */
const RETENTION_OPTIONS: [string, string][] = [
  ...WORKTREE_RETENTION.map((word): [string, string] => [word, RETENTION_LABELS[word]]),
  ['ttl:6', 'are removed after six hours'],
  ['ttl:24', 'are removed after a day'],
  ['ttl:168', 'are removed after a week'],
];



/**
 * Who this run spends as, and how much room that account has left.
 *
 * The option names the account and nothing else. The meters — every window
 * the endpoint reports, worst first — are drawn under the control for the
 * account that will actually pay, so an account at 12% for the session and
 * 98% for the week reads as the wall it is rather than as the obvious choice.
 */
export function AccountSection() {
  const f = useSetupForm();
  if (!f.on('accountId')) return null;
  const chosen = f.values.accountId;
  const auto = chosen === 'auto';
  const account = auto
    ? mostHeadroom(f.accounts)
    : (f.accounts.find((a) => a.id === chosen) ??
      (chosen === 'default' ? f.accounts.find((a) => a.builtIn) : undefined));
  return (
    <div className="flex flex-col gap-2">
      <SetupField
        label="Account"
        source={f.src('accountId')}
        hint={
          <>
            <strong>auto</strong> picks the account with the most headroom, and a run that hits a wall moves
            to one that can pay — see “On usage limit”. Meters are polled on a budget, so re-read them if a
            window just reset.
          </>
        }
      >
        {({ id, describedBy }) => (
          <div className="flex min-w-0 items-center gap-2">
            <select
              id={id}
              aria-describedby={describedBy}
              className={cn(field, 'min-w-0 flex-1')}
              value={chosen}
              onChange={(event) => f.set('accountId', event.target.value)}
            >
              <option value="auto">auto — the most headroom</option>
              {f.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountWho(a)}
                </option>
              ))}
              {f.accounts.length === 0 && <option value="default">machine login</option>}
            </select>
            {/* On the launch form as well as the panels: the moment that
                matters for "which account can run this" is the moment
                somebody is choosing one. */}
            <RefreshMeters variant="ghost" label="" className="shrink-0" />
          </div>
        )}
      </SetupField>
      {account && <Headroom account={account} auto={auto} />}
    </div>
  );
}

/** Who an account is — a name, else its email, else its id; the machine login by that name. */
export function accountWho(account: AccountView): string {
  if (account.builtIn) return account.name ?? 'machine login';
  return account.name ?? account.email ?? account.id;
}

/**
 * The account `auto` would most likely pick right now: no window already hit,
 * then the lowest worst-window utilisation. The server decides at boarding;
 * this says what it would decide from the meters on screen.
 */
export function mostHeadroom(accounts: AccountView[]): AccountView | undefined {
  const worst = (a: AccountView) =>
    Math.max(0, ...Object.values(a.usage?.buckets ?? {}).map((b) => b.utilization));
  return [...accounts]
    .filter((a) => !Object.keys(a.limitedUntil ?? {}).length)
    .sort((a, b) => worst(a) - worst(b) || Number(b.builtIn) - Number(a.builtIn))[0];
}

/** Warn at 80, alert at 95 — the thresholds the server announces at (`limits-widget.tsx`). */
function meterTone(pct: number): 'done' | 'needs-you' | 'failed' {
  if (pct >= 95) return 'failed';
  if (pct >= 80) return 'needs-you';
  return 'done';
}

function Headroom({ account, auto }: { account: AccountView; auto: boolean }) {
  const buckets = Object.entries(account.usage?.buckets ?? {}).sort(
    ([, a], [, b]) => b.utilization - a.utilization,
  );
  const walled = Object.entries(account.limitedUntil ?? {});
  return (
    <div className="flex flex-col gap-2 rounded border border-rule bg-ground px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium text-ink">
          {auto ? 'Likely ' : ''}
          {accountWho(account)}
        </span>
        {account.email && account.email !== accountWho(account) && (
          <span className="min-w-0 break-all font-mono text-2xs text-ink-muted">{account.email}</span>
        )}
        {auto && <span className="text-2xs text-ink-muted">— the most headroom on the meters right now</span>}
      </div>
      {account.usage?.unsupported ? (
        <p className="text-2xs text-ink-muted">
          The usage endpoint does not serve this credential — limits are learned when a run hits one.
        </p>
      ) : buckets.length ? (
        buckets.map(([key, bucket]) => {
          const pct = Math.round(bucket.utilization);
          const left = countdown(Date.parse(bucket.resetsAt));
          return (
            <Meter
              key={key}
              value={bucket.utilization}
              max={100}
              label={bucketLabel(key)}
              valueText={`${pct} % used${left ? `, resets in ${left.replace(' left', '')}` : ''}`}
              tone={meterTone(bucket.utilization)}
            >
              <div className="mt-0.5 flex flex-wrap justify-between gap-x-2 text-2xs text-ink-muted">
                <span>{bucketLabel(key)}</span>
                <span className="tnum">
                  {pct}% used{left ? ` · ${left}` : ''}
                </span>
              </div>
            </Meter>
          );
        })
      ) : (
        <p className="text-2xs text-ink-muted">
          No usage data{account.usage?.error ? ` — ${account.usage.error}` : ' yet'}.
        </p>
      )}
      {walled.map(([bucket, iso]) => (
        <p key={bucket} className="text-2xs font-medium text-failed">
          At its {bucketLabel(bucket).toLowerCase()} limit — {countdown(Date.parse(iso)) || 'reset due'}.
        </p>
      ))}
    </div>
  );
}

export function SkillsSection() {
  const f = useSetupForm();
  const { values, mode, defaultSkills } = f;
  const attach = f.on('attachDefaultSkills');
  const picker = f.on('skills') && f.skillsEnabled;
  if (!attach && !picker) return null;
  return (
    <div className="flex flex-col gap-3">
      {attach && defaultSkills.length > 0 && (
        <PressField
          label="Attach default skills"
          hint={
            <>
              This machine's list:{' '}
              {defaultSkills.map((s) => (
                <code key={s} className="mr-1">
                  {s}
                </code>
              ))}
            </>
          }
          on="Attached"
          source={f.src('attachDefaultSkills')}
          value={values.attachDefaultSkills}
          onChange={(next) => f.set('attachDefaultSkills', next)}
        />
      )}
      {attach && defaultSkills.length === 0 && mode === 'defaults' && (
        <PressField
          label="Attach default skills to new sessions"
          hint="This machine has no default skills configured."
          on="Attached"
          value={values.attachDefaultSkills}
          onChange={(next) => f.set('attachDefaultSkills', next)}
        />
      )}
      {picker && (
        <SkillPicker
          skills={f.skills}
          chosen={values.skills}
          planSkills={f.planSkills}
          defaultSkills={defaultSkills}
          onChange={(next) => f.set('skills', next)}
          label={
            mode === 'qa'
              ? 'Skills for this review'
              : mode === 'session'
                ? 'Skills for this session'
                : 'Skills for this run'
          }
        />
      )}
    </div>
  );
}

export function McpSection() {
  const f = useSetupForm();
  const { values, planMcp } = f;
  if (!f.on('mcpServers') && !f.on('mcpPolicy')) return null;
  return (
    <div className="flex flex-col gap-3">
      {f.on('mcpServers') && (
        <>
          {/* Servers are attached at a PHASE boundary, never mid-phase:
              connecting one busts the prompt cache and re-reads the context. */}
          <McpPicker
            servers={f.mcpServers}
            chosen={values.mcpServers}
            planServers={planMcp}
            onChange={(next) => f.set('mcpServers', next)}
            label="MCP servers for this run"
            note="Checked before the phase boards, so a wall costs a probe rather than an hour."
          />
          {(values.mcpServers.length > 0 || planMcp.length > 0) && f.on('mcpPolicy') && (
            <SelectField
              label="If one will not connect"
              hint="A phase whose plan says it requires its servers still parks — this cannot overrule that."
              source={f.src('mcpPolicy')}
              value={values.mcpPolicy}
              options={[
                ['continue', 'Run the phase without it'],
                ['require', 'Park the phase'],
              ]}
              onChange={(next) => f.set('mcpPolicy', next as RunSetupValues['mcpPolicy'])}
            />
          )}
        </>
      )}
      {f.on('mcpPolicy') && !f.on('mcpServers') && (
        <SelectField
          label="When an MCP server is unavailable"
          hint="A plan or a single phase can still demand its servers — this is only where every run starts."
          value={values.mcpPolicy}
          options={[
            ['continue', 'Continue and warn'],
            ['require', 'Park the phase'],
          ]}
          onChange={(next) => f.set('mcpPolicy', next as RunSetupValues['mcpPolicy'])}
        />
      )}
    </div>
  );
}

/**
 * The console's review on top of a plan that already reviews itself.
 *
 * Run `deadaff9` paid twice for every phase it finished: the plan's own
 * §Adversarial review, dispatched by each builder, and this toggle's session
 * ($9.62 on P1, $7.26 on P8). Said, not prevented — two reviews of one diff can
 * be what somebody wants; paying for them without knowing is the defect. Two
 * signals, both read before a session is spent: the plan's words ordering a
 * reviewer (`plan.reviewers`, `inPlanReviewers` on the server) and a QA gate that
 * is on, whose phase-finish sends every phase to a fresh reviewer anyway.
 *
 * It reads the toggle's VALUE itself rather than being gated on it inline: this
 * is a sentence, not a control, so it has no summary row and no `LIVE_WHEN`
 * entry for `summaryRows()` to consult (`stages.test.ts`, the H1 scan).
 */
function ReviewDoubled() {
  const { planReviewers, qaMode, values } = useSetupForm();
  const qaOn = /^on\b/.test(qaMode ?? '');
  const [first, ...more] = planReviewers;
  if (!values.reviewEachPhase || (!first && !qaOn)) return null;
  return (
    <p className="text-2xs text-ink-muted" data-testid="review-doubled">
      Every phase would be reviewed twice.{' '}
      {first && (
        <>
          This plan already dispatches its own reviewer — §{first.section || 'the plan'}: &ldquo;
          {first.excerpt}
          &rdquo;
          {more.length > 0 ? ` (and ${more.length} more ${more.length === 1 ? 'place' : 'places'})` : ''}
          .{' '}
        </>
      )}
      {qaOn && <>This plan&rsquo;s QA gate already sends every finished phase to a fresh reviewer. </>}
      The console&rsquo;s review on top measured $7–10 a phase — keep one of the two.
    </p>
  );
}

export function ReviewersSection() {
  const f = useSetupForm();
  const { values } = f;
  const Bool = f.Bool;
  if (!f.on('reviewEachPhase') && !f.on('ultracode') && !f.on('ultraReview')) return null;
  return (
    <div className="flex flex-col gap-3">
      {f.on('reviewEachPhase') && (
        <Bool
          label="Review each phase"
          hint="When a phase finishes, a fresh session that did not write the code reads its diff against the plan's exit criteria and records what it finds. Costs about a quarter of a phase budget each time."
          source={f.src('reviewEachPhase')}
          value={values.reviewEachPhase}
          onChange={(next) => f.set('reviewEachPhase', next)}
        />
      )}
      {f.on('reviewEachPhase') && <ReviewDoubled />}
      {/* Only meaningful with the reviewer on, and worth its own row rather
          than a footnote: this is the setting that decides whether an
          unattended run can STOP ITSELF on an opinion nobody has read. */}
      {f.on('reviewEachPhase') && f.live('reviewerPolicy') && (
        <Bool
          label="…and let it hold dependent phases"
          hint="Off: findings are recorded and shown, and nothing is held. On: the reviewer may record changes-requested, which stops every phase that depends on the reviewed one until a person approves or withdraws it."
          source={f.src('reviewerPolicy')}
          value={values.reviewerPolicy === 'may-hold'}
          onChange={(next) => f.set('reviewerPolicy', next ? 'may-hold' : 'comment-only')}
        />
      )}
      {f.on('ultracode') && (
        <Bool
          label="Ultracode"
          hint="Every prompt this run composes carries the standing ultracode licence, so a session may use the Workflow tool where the work genuinely fans out. A workflow runs dozens of agents at once — this is a token bill, not a speed setting."
          source={f.src('ultracode')}
          value={values.ultracode}
          onChange={(next) => f.set('ultracode', next)}
        />
      )}
      {f.on('ultraReview') && (
        <SelectField
          label="Cloud review"
          hint="Runs `claude ultrareview` on this run's branch — a multi-agent review in Anthropic's cloud, billed to the account this run spends. Its findings land beside the reviewer's, under the same hold rule. If the CLI here has no such command, the run says so and carries on."
          source={f.src('ultraReview')}
          value={values.ultraReview}
          options={[
            ['off', 'Never'],
            ['each-phase', 'After every phase'],
            ['at-settle', 'Once, before the branch settles'],
          ]}
          onChange={(next) => f.set('ultraReview', next as UltraReviewMode)}
        />
      )}
    </div>
  );
}

export function QaSection() {
  const f = useSetupForm();
  const { values, mode, qaMode, allowWrites } = f;
  const Bool = f.Bool;
  const three = f.on('qaModel') || f.on('qaEffort') || f.on('qaMaxRounds') || f.on('qaFixStrategy');
  if (!f.on('qa') && !three) return null;
  return (
    <div className="flex flex-col gap-3">
      {/* The review's own activation sentence — a different act from the run
          toggle below it, and the only checkbox this dialog has. */}
      {f.on('qa') && mode === 'qa' && qaMode === 'off' && (
        <ToggleField
          label={
            <>
              Turn QA on for this plan (<code className="font-mono">--qa</code>)
            </>
          }
          hint={
            allowWrites === false ? (
              <>
                Writes are off — restart the console with <code className="font-mono">--allow-writes</code> to
                turn QA on from here. The review still runs; its verdict just gates nothing until then.
              </>
            ) : (
              <>
                Creates <code className="font-mono">test-status.md</code> so verdicts gate dependents. Phases
                that finished before now are recorded as <em>waived</em>, so turning it on does not
                retroactively hold the board. Without this the review still runs — its verdict just gates
                nothing.
              </>
            )
          }
          source={f.src('qa')}
          value={values.qa}
          disabledReason={
            allowWrites === false
              ? 'Writes are disabled. Restart the console with --allow-writes.'
              : undefined
          }
          onChange={(next) => f.set('qa', next)}
        />
      )}

      {f.on('qa') && mode !== 'qa' && (qaMode === 'off' || mode === 'defaults') && (
        <Bool
          label={
            mode === 'defaults' ? 'Turn the QA gate on for new runs' : 'Turn the QA gate on for this plan'
          }
          hint="Each finished phase then waits for an independent review. Phases that finished before now are recorded as waived, so turning it on does not retroactively hold the board."
          source={f.src('qa')}
          value={values.qa}
          disabledReason={
            mode !== 'defaults' && !f.canQaToggle
              ? 'Writes are disabled. Restart the console with --allow-writes.'
              : undefined
          }
          onChange={(next) => f.set('qa', next)}
        />
      )}

      {/* How this run's work gets REVIEWED, as opposed to how it gets built.
          Empty on all three means what QA meant before they existed: the
          reviewer inherits the builder's model and effort, and the round budget
          keeps its shipped default. They are offered whatever the plan's gate
          says, because a run may turn QA on and because the plan may already
          have it on — a control that appeared only for a gate-off plan would be
          missing exactly where reviewing is certain to happen. */}
      {three && (
        <div className={PAIR}>
          {f.on('qaModel') && (
            <SelectField
              label="QA model"
              hint="The reviewer's own tier. A review is a different job from the build and is often worth a different model in either direction."
              source={f.src('qaModel')}
              value={values.qaModel}
              placeholder="same as the phase being reviewed"
              options={f.modelOptions}
              onChange={(next) => f.set('qaModel', next)}
            />
          )}
          {f.on('qaEffort') && (
            <SelectField
              label="QA effort"
              source={f.src('qaEffort')}
              value={values.qaEffort}
              placeholder="same as the phase being reviewed"
              options={f.effortOptions}
              onChange={(next) => f.set('qaEffort', next)}
            />
          )}
          {f.on('qaMaxRounds') && (
            <NumberField
              label="Stop after N failed QA rounds"
              hint="Then the phase parks with one errand naming the last report. Empty leaves the shipped default of 3."
              source={f.src('qaMaxRounds')}
              error={f.errors.qaMaxRounds}
              value={values.qaMaxRounds}
              min={1}
              step={1}
              placeholder="3"
              onChange={(next) => f.set('qaMaxRounds', next)}
            />
          )}
          {/* Only the `qa-fix` mode shows this: it is a fact about a RECOVERY,
              and on a run that is not recovering a verdict there is no fix
              session for it to describe. */}
          {f.on('qaFixStrategy') && (
            <SelectField
              label="How the fix session starts"
              hint="Resuming is cheap — that session already holds the context the report is about. A fresh one gets the findings verbatim under the phase's own boot prompt, and is what the loop falls back to when no session survives."
              source={f.src('qaFixStrategy')}
              value={values.qaFixStrategy}
              placeholder={QA_FIX_STRATEGY_LABELS.resume}
              options={QA_FIX_STRATEGIES.map((id) => [id, QA_FIX_STRATEGY_LABELS[id]] as const)}
              onChange={(next) => f.set('qaFixStrategy', next)}
            />
          )}
        </div>
      )}

      {/* Said rather than simply hidden, the same rule the PR row follows.
          The QA control is offered only when the plan's gate is OFF, so on a plan
          that declares "**QA gate:** on" the dialog said nothing about QA at all
          — and an operator whose console default is "QA off" reasonably concluded
          it was off. It was not: the plan outranks the default, every finished
          phase then owes a verdict, and a `fail` or a still-`pending` row holds
          every dependent. That is a thing to learn before launching, not after a
          plan has been held for a day. */}
      {f.on('qa') && mode !== 'qa' && mode !== 'defaults' && qaMode && qaMode !== 'off' && (
        <p className="text-2xs text-ink-muted">
          {qaMode === 'waived'
            ? 'This plan declares “**QA gate:** off”, so recorded verdicts do not hold dependents.'
            : 'This plan declares “**QA gate:** on”, so it gates on QA whatever this console’s default ' +
              'is: each finished phase owes an independent verdict, and a phase without one holds ' +
              'every phase that depends on it. Turn it off in the plan’s §Session budget.'}
        </p>
      )}
    </div>
  );
}

export function PromptSection() {
  const f = useSetupForm();
  if (!f.on('prompt')) return null;
  return (
    <SetupField label="First prompt (optional)" source={f.src('prompt')}>
      {({ id, describedBy }) => (
        // text-base = 16px — below that iOS zooms the page on focus.
        <textarea
          id={id}
          aria-describedby={describedBy}
          className="min-h-28 w-full rounded border border-rule bg-ground p-2 text-base"
          placeholder="Sent as your first message. Leave empty to just open the session."
          maxLength={16000}
          value={f.values.prompt}
          onChange={(event) => f.set('prompt', event.target.value)}
        />
      )}
    </SetupField>
  );
}

/* ------------------------------------------------------------------ *
 * Money and stops
 * ------------------------------------------------------------------ */

export function MoneySection() {
  const f = useSetupForm();
  if (!f.on('phaseBudgetUsd') && !f.on('runBudgetUsd') && !f.on('qaRoundBudgetUsd')) return null;
  return (
    <div className={PAIR}>
      {f.on('phaseBudgetUsd') && (
        <NumberField
          label="Budget per phase ($)"
          source={f.src('phaseBudgetUsd')}
          error={f.errors.phaseBudgetUsd}
          value={f.values.phaseBudgetUsd}
          min={0}
          step={0.5}
          onChange={(next) => f.set('phaseBudgetUsd', next)}
        />
      )}
      {f.on('runBudgetUsd') && (
        <NumberField
          label="Budget for the run ($)"
          source={f.src('runBudgetUsd')}
          error={f.errors.runBudgetUsd}
          value={f.values.runBudgetUsd}
          min={0}
          step={1}
          onChange={(next) => f.set('runBudgetUsd', next)}
        />
      )}
      {/* A stop for ONE round, and the hint says so in as many words: a loop
          under a phase budget alone spends the whole allowance on round one,
          and the round that would have fixed it has nothing left. */}
      {f.on('qaRoundBudgetUsd') && (
        <NumberField
          label="Budget per QA round ($)"
          hint="A hard stop for each round on its own — never for the run. Empty means no per-round ceiling."
          source={f.src('qaRoundBudgetUsd')}
          error={f.errors.qaRoundBudgetUsd}
          value={f.values.qaRoundBudgetUsd}
          min={0}
          step={0.5}
          onChange={(next) => f.set('qaRoundBudgetUsd', next)}
        />
      )}
    </div>
  );
}

export function StopsSection() {
  const f = useSetupForm();
  const { values, mode } = f;
  const Bool = f.Bool;
  const any = (
    ['maxConsecutiveFailures', 'maxParallel', 'priority', 'onLimit', 'autonomy', 'autoRecover'] as const
  ).some((field) => f.on(field));
  if (!any) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className={PAIR}>
        {f.on('maxConsecutiveFailures') && (
          <NumberField
            label="Stop after N failures"
            hint="Consecutive failed phases before the run halts. Empty leaves the run's own ceiling."
            source={f.src('maxConsecutiveFailures')}
            error={f.errors.maxConsecutiveFailures}
            value={values.maxConsecutiveFailures}
            min={1}
            step={1}
            placeholder="run default"
            onChange={(next) => f.set('maxConsecutiveFailures', next)}
          />
        )}
        {f.on('maxParallel') && (
          <NumberField
            label="Max parallel"
            hint={`Lanes this run may hold at once${f.concurrencyMax ? ` — this console allows ${f.concurrencyMax}` : ''}. Empty means the console's own ceiling.`}
            source={f.src('maxParallel')}
            error={f.errors.maxParallel}
            value={values.maxParallel}
            min={1}
            step={1}
            placeholder="console default"
            onChange={(next) => f.set('maxParallel', next)}
          />
        )}
        {f.on('onLimit') && (
          <SelectField
            label="On usage limit"
            source={f.src('onLimit')}
            value={values.onLimit}
            options={[
              ['switch', 'switch account, else wait'],
              ['wait', 'wait for the reset'],
              ['pause', 'pause and ask me'],
            ]}
            onChange={(next) => f.set('onLimit', next as RunSetupValues['onLimit'])}
          />
        )}
        {f.on('autonomy') && (
          <SelectField
            label="If something is unclear"
            // The hint follows the choice: what a QA fail does is the one
            // difference between the two modes the labels never said.
            hint={AUTONOMY_HELP[values.autonomy]}
            source={f.src('autonomy')}
            value={values.autonomy}
            options={[
              ['keep-going', AUTONOMY_LABEL['keep-going']],
              ['halt-on-everything', AUTONOMY_LABEL['halt-on-everything']],
            ]}
            onChange={(next) => f.set('autonomy', next as RunSetupValues['autonomy'])}
          />
        )}
        {f.on('priority') && (
          <SelectField
            label="Queue priority"
            source={f.src('priority')}
            value={values.priority}
            options={RUN_PRIORITIES.map((p) => [p, PRIORITY_LABELS[p]])}
            onChange={(next) => f.set('priority', next as RunPriority)}
          />
        )}
      </div>
      {f.on('autoRecover') && (
        <Bool
          label={mode === 'defaults' ? 'Auto-recover halted runs' : 'Auto-recover halts'}
          hint="A halt an agent can clear (failed verification, missing handoff, a crash) launches the fix agent by itself — at most 2 tries per phase, never the same failure twice — and the run resumes when the board reads fixed."
          source={f.src('autoRecover')}
          value={values.autoRecover}
          disabledReason={
            mode !== 'defaults' && !f.canAutoRecover
              ? 'Auto-recovery needs --allow-agent — the healer is an agent session.'
              : undefined
          }
          onChange={(next) => f.set('autoRecover', next)}
        />
      )}
    </div>
  );
}

/**
 * The flat layout — every section in order, for the modes that carry too few
 * fields for a stage bar (a QA review, a recovery, the launcher, the plan
 * wizard, the Automation defaults). The order is the staged order read top
 * to bottom, so a control sits where it would on the stages.
 */
export function FlatForm() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <DecisionsSection />
      <ScopeSection />
      <ModelSection />
      <AccountSection />
      <PermissionsSection />
      <MoneySection />
      <StopsSection />
      <BranchSection />
      <ReviewersSection />
      <PromptSection />
      <SkillsSection />
      <McpSection />
      <QaSection />
      <PerPhaseSection />
    </div>
  );
}

/** A scope token as a chip that can break — a slug is text the app did not write. */
export function ScopeChip({ children }: { children: string }) {
  return (
    <Badge mono className="max-w-full break-all whitespace-normal">
      {children}
    </Badge>
  );
}
