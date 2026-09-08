/**
 * Per-phase overrides — what ONE phase runs as, when the run's answer is wrong
 * for it.
 *
 * Three things can decide what a phase runs as, and this table says which did.
 * The plan's own `**Model:**` / `**Effort:**` bullets have been in the format
 * from the beginning and were read by nothing, so a phase that said it wanted
 * Opus quietly ran on whatever the run defaulted to. Here they show as the
 * *inherited* value, and choosing something overrules them for this run only —
 * per field, so setting a model does not discard an effort the plan asked for.
 *
 * Moved here from `views/run/phase-matrix.tsx` in Phase 6: this is a part of
 * RunSetup, not of the run page, and every mode that configures a whole run
 * renders it. Two overrides the server has always accepted joined it in the
 * same move — `tools` and `permissionMode` (`PhaseOptions`, filtered by
 * `phaseOptions()` in the route) — which the matrix had simply never offered,
 * so a plan could name a phase's tool list and no surface could set one.
 *
 * ## Two shapes
 *
 * Seven columns of form controls is a matrix on a laptop and nothing at all on
 * a phone: at 390px it was a table wider than the screen whose selects were 28
 * pixels tall. Below the shell breakpoint the same controls stack into one card
 * per phase. Every control is written ONCE, in the helpers inside `PerPhase`,
 * and the two shapes only arrange them — a second copy of a tri-state select is
 * how one shape ends up storing `false` and the other deleting the key.
 */

import { useState, type ReactNode } from 'react';
import {
  Checkbox,
  Chip,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
  field,
  stickyHeadCell,
  useTableFit,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { EFFORTS, effortAlias, modelAlias } from '@/features/runs/defaults';
import { SkillPicker } from '@/features/run-setup/skill-picker';
import { McpPicker } from '@/features/run-setup/mcp-picker';
import { PERMISSION_MODE_LABELS, PHASE_PERMISSION_MODES } from './modes';
import type { McpServerView, PhaseOptions, PhaseView, SkillInfo } from '@/lib/api';

export function PerPhase({
  planPhases,
  overrides,
  runModel,
  runEffort,
  models,
  skills,
  runSkills = [],
  servers = [],
  runMcp = [],
  disabled,
  onChange,
}: {
  planPhases: PhaseView[];
  overrides: Record<string, PhaseOptions>;
  runModel: string;
  runEffort: string;
  /** The model names to offer — the server's own list, via RunSetup. */
  models: readonly string[];
  skills: SkillInfo[];
  /** What the run gives every phase — what the Skip box turns off for one. */
  runSkills?: string[];
  /** The registry, so a phase can attach one the run did not. */
  servers?: McpServerView[];
  /** What the RUN attaches — what `skip run's` would drop for this phase. */
  runMcp?: string[];
  disabled?: boolean;
  onChange: (next: Record<string, PhaseOptions>) => void;
}) {
  const { wrapRef, tableRef, overflows, measured } = useTableFit();
  // Sticky only where sticky can work — see the wrapper below — and only once
  // the box has actually answered, because until then the wrapper scrolls.
  const head = !overflows && measured ? stickyHeadCell : undefined;
  const phone = usePhone();
  const [skillsFor, setSkillsFor] = useState<number | null>(null);
  const [mcpFor, setMcpFor] = useState<number | null>(null);
  const [moreFor, setMoreFor] = useState<number | null>(null);
  // Phase, Title, Model, Effort, More, plus whichever optional columns render.
  const columns = 5 + (skills.length ? 1 : 0) + (servers.length ? 1 : 0);
  if (!planPhases.length) return null;

  const set = (phase: number, key: keyof PhaseOptions, value: string | string[] | boolean) => {
    const key2 = String(phase);
    const next: Record<string, PhaseOptions> = { ...overrides, [key2]: { ...(overrides[key2] ?? {}) } };
    // `false` clears for the same reason `''` and `[]` do: it is this control's
    // way of saying "no choice here", and a stored `false` would show as an
    // override on a row where nothing was chosen.
    if (value && (!Array.isArray(value) || value.length)) {
      (next[key2] as Record<string, unknown>)[key] = value;
    } else {
      delete (next[key2] as Record<string, unknown>)[key];
    }
    if (!Object.keys(next[key2]).length) delete next[key2];
    onChange(next);
  };

  /**
   * `set` for a TRI-STATE boolean. Its sibling deletes on `false` — correct for
   * every field where false means "no choice" — but `autoApprove: false` IS a
   * choice ("ask me in this phase") that must beat a plan or global true, so
   * both booleans are stored and only `undefined` clears back to inherit.
   */
  const setTri = (phase: number, key: keyof PhaseOptions, value: boolean | undefined) => {
    const key2 = String(phase);
    const next: Record<string, PhaseOptions> = { ...overrides, [key2]: { ...(overrides[key2] ?? {}) } };
    if (value === undefined) delete (next[key2] as Record<string, unknown>)[key];
    else (next[key2] as Record<string, unknown>)[key] = value;
    if (!Object.keys(next[key2]).length) delete next[key2];
    onChange(next);
  };

  /* ---- the controls, written once and arranged twice ---- */

  /** What a phase would run as with nothing chosen here. */
  const inherited = (p: PhaseView) => {
    const planModel = modelAlias(p.model);
    const planEffort = effortAlias(p.effort);
    return {
      model: planModel ? `${planModel} (plan)` : `${runModel} (run)`,
      effort: planEffort ? `${planEffort} (plan)` : `${runEffort || 'default'} (run)`,
    };
  };

  const modelSelect = (p: PhaseView, own: PhaseOptions) => (
    <>
      <label className="sr-only" htmlFor={`model-${p.phase}`}>
        Model for phase {p.phase}
      </label>
      <select
        id={`model-${p.phase}`}
        value={own.model ?? ''}
        disabled={disabled}
        onChange={(e) => set(p.phase, 'model', e.target.value)}
        // `field`, not a hand-rolled `h-7`: the shared control class carries
        // the thumb floor on a coarse pointer, which a 28px select does not.
        className={cn(field, 'w-full text-2xs')}
      >
        <option value="">{inherited(p).model}</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </>
  );

  const effortSelect = (p: PhaseView, own: PhaseOptions) => (
    <>
      <label className="sr-only" htmlFor={`effort-${p.phase}`}>
        Effort for phase {p.phase}
      </label>
      <select
        id={`effort-${p.phase}`}
        value={own.effort ?? ''}
        disabled={disabled}
        onChange={(e) => set(p.phase, 'effort', e.target.value)}
        className={cn(field, 'w-full text-2xs')}
      >
        <option value="">{inherited(p).effort}</option>
        {EFFORTS.filter(Boolean).map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
    </>
  );

  /** The `add`/`N extra` trigger both list columns use. */
  const listTrigger = (p: PhaseView, open: boolean, onToggle: () => void, chosen: number, what: string) => (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={open}
      aria-label={`${what} for phase ${p.phase}`}
      onClick={onToggle}
      className="rounded border border-rule px-1.5 py-0.5 text-2xs disabled:opacity-50 [@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:px-3"
    >
      {chosen ? `${chosen} extra` : 'add'}
    </button>
  );

  /**
   * "Run this phase without the run's own X." A real `Checkbox`, not a bare
   * `<input type=checkbox>`: the primitive draws a 16px box with the thumb
   * floor as a transparent inset, so the same control is pressable with a
   * finger without becoming a 44px square in a dense matrix.
   */
  const skipBox = (p: PhaseView, key: 'skillsOff' | 'mcpOff', on: boolean, title: string) => (
    <label className="flex items-center gap-1.5 text-2xs text-ink-muted" title={title}>
      <Checkbox
        checked={on}
        disabled={disabled}
        onCheckedChange={(next) => set(p.phase, key, next === true)}
        aria-label={`Phase ${p.phase}: skip the run's ${key === 'skillsOff' ? 'skills' : 'MCP servers'}`}
      />
      skip run&rsquo;s
    </label>
  );

  const skillsCell = (p: PhaseView, own: PhaseOptions) => (
    <div className="flex flex-wrap items-center gap-2">
      {listTrigger(
        p,
        skillsFor === p.phase,
        () => setSkillsFor(skillsFor === p.phase ? null : p.phase),
        own.skills?.length ?? 0,
        'Extra skills',
      )}
      {/* Only where there is something to skip. A checkbox that turns off an
          empty list is a control that cannot do anything, offered on every row. */}
      {runSkills.length > 0 &&
        skipBox(
          p,
          'skillsOff',
          Boolean(own.skillsOff),
          `Run phase ${p.phase} without the run's skills (${runSkills.join(', ')}). ` +
            'Extras chosen here still apply.',
        )}
    </div>
  );

  const mcpCell = (p: PhaseView, own: PhaseOptions) => (
    <div className="flex flex-wrap items-center gap-2">
      {listTrigger(
        p,
        mcpFor === p.phase,
        () => setMcpFor(mcpFor === p.phase ? null : p.phase),
        own.mcpServers?.length ?? 0,
        'Extra MCP servers',
      )}
      {runMcp.length > 0 &&
        skipBox(
          p,
          'mcpOff',
          Boolean(own.mcpOff),
          `Run phase ${p.phase} without the run's MCP servers (${runMcp.join(', ')}). ` +
            "The plan's own still apply, and so do extras chosen here.",
        )}
    </div>
  );

  const moreTrigger = (p: PhaseView, own: PhaseOptions) => (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={moreFor === p.phase}
      aria-label={`More for phase ${p.phase}`}
      onClick={() => setMoreFor(moreFor === p.phase ? null : p.phase)}
      className="rounded border border-rule px-1.5 py-0.5 text-2xs disabled:opacity-50 [@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:px-3"
      title="Permission mode and tool list for this phase alone."
    >
      {own.permissionMode || own.tools?.length || own.autoApprove != null ? 'set' : 'add'}
    </button>
  );

  const skillsPanel = (p: PhaseView, own: PhaseOptions) => (
    <SkillPicker
      label={`Extra skills for phase ${p.phase} only`}
      skills={skills}
      chosen={own.skills ?? []}
      disabled={disabled}
      onChange={(next) => set(p.phase, 'skills', next)}
    />
  );

  const mcpPanel = (p: PhaseView, own: PhaseOptions) => (
    <>
      <McpPicker
        label={`Extra MCP servers for phase ${p.phase} only`}
        servers={servers}
        chosen={own.mcpServers ?? []}
        onChange={(next) => set(p.phase, 'mcpServers', next)}
      />
      {/* Inside the expansion rather than as a column: this is the ONE level
          that can overrule a plan saying `require`, so it belongs where
          somebody is already thinking about this phase's servers — not as a
          per-row control easy to change in bulk. */}
      <label className="mt-1.5 flex flex-wrap items-center gap-2 text-2xs">
        <span className="text-ink-muted">If one will not connect, in phase {p.phase} only</span>
        <select
          value={own.mcpPolicy ?? ''}
          disabled={disabled}
          onChange={(e) => set(p.phase, 'mcpPolicy', e.target.value)}
          className={cn(field, 'max-w-full text-2xs')}
        >
          <option value="">inherit (plan, then run)</option>
          <option value="continue">run the phase without it</option>
          <option value="require">park the phase</option>
        </select>
      </label>
    </>
  );

  const morePanel = (p: PhaseView, own: PhaseOptions) => (
    <div className="flex flex-col gap-2">
      <label className="flex flex-wrap items-center gap-2 text-2xs">
        <span className="text-ink-muted">Permission mode for phase {p.phase} only</span>
        <select
          value={own.permissionMode ?? ''}
          disabled={disabled}
          onChange={(e) => set(p.phase, 'permissionMode', e.target.value)}
          className={cn(field, 'max-w-full text-2xs')}
        >
          <option value="">inherit (the run&rsquo;s profile)</option>
          {PHASE_PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {PERMISSION_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-wrap items-center gap-2 text-2xs">
        <span className="text-ink-muted">Auto-grant approvals in phase {p.phase} only</span>
        <select
          value={own.autoApprove == null ? '' : own.autoApprove ? 'on' : 'off'}
          disabled={disabled}
          onChange={(e) =>
            setTri(p.phase, 'autoApprove', e.target.value === '' ? undefined : e.target.value === 'on')
          }
          className={cn(field, 'max-w-full text-2xs')}
        >
          <option value="">inherit (the plan&rsquo;s policy, then the console&rsquo;s)</option>
          <option value="on">auto-grant — ask-list cards answer themselves</option>
          <option value="off">ask me — every card waits for a person</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-2xs">
        <span className="text-ink-muted">
          Tools for phase {p.phase} only — comma separated, empty inherits
        </span>
        <input
          type="text"
          value={(own.tools ?? []).join(', ')}
          disabled={disabled}
          placeholder="Read, Edit, Bash"
          aria-label={`Tools for phase ${p.phase}`}
          onChange={(e) =>
            set(
              p.phase,
              'tools',
              e.target.value
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean),
            )
          }
          className={cn(field, 'max-w-md text-2xs')}
        />
        <span className="text-ink-muted">
          The CLI&rsquo;s <code className="font-mono">--tools</code> list. Naming any turns every other tool
          OFF for this phase, so a phase told only &ldquo;Read&rdquo; cannot write — useful for a review, and
          a way to strand a build phase.
        </span>
      </label>
    </div>
  );

  /** Whichever panels this phase has open, in the order the columns are in. */
  const panelsFor = (p: PhaseView, own: PhaseOptions): { key: string; node: ReactNode }[] =>
    [
      skillsFor === p.phase ? { key: 'skills', node: skillsPanel(p, own) } : null,
      mcpFor === p.phase ? { key: 'mcp', node: mcpPanel(p, own) } : null,
      moreFor === p.phase ? { key: 'more', node: morePanel(p, own) } : null,
    ].filter(Boolean) as { key: string; node: ReactNode }[];

  const count = Object.keys(overrides).length;

  return (
    <details className="rounded-lg border border-rule bg-surface">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm [@media(hover:none)]:min-h-(--tap-min)">
        <span>Per phase</span>
        {count ? (
          <Chip tone="ok">{count} overridden</Chip>
        ) : (
          <span className="text-2xs text-ink-muted">every phase inherits the run's model and effort</span>
        )}
      </summary>

      <div className="border-t border-rule">
        {phone ? (
          // One card per phase. The same controls, stacked, at a size a thumb
          // can hit — a seven-column matrix at 390px is a table wider than the
          // screen whose selects are 28 pixels tall.
          <ul className="flex flex-col gap-2 p-3">
            {planPhases.map((p) => {
              const own = overrides[String(p.phase)] ?? {};
              const panels = panelsFor(p, own);
              return (
                <li
                  key={p.phase}
                  className={cn(
                    'flex flex-col gap-2 rounded-lg border border-rule bg-ground p-3',
                    p.state === 'done' && 'text-ink-muted',
                  )}
                >
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-muted">
                      P{p.phase}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm" title={p.title}>
                      {p.title}
                    </span>
                    {p.state === 'done' && <span className="shrink-0 text-2xs">done</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-2xs uppercase tracking-wide text-ink-muted">Model</span>
                      {modelSelect(p, own)}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-2xs uppercase tracking-wide text-ink-muted">Effort</span>
                      {effortSelect(p, own)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    {skills.length > 0 && skillsCell(p, own)}
                    {servers.length > 0 && mcpCell(p, own)}
                    {moreTrigger(p, own)}
                  </div>
                  {panels.map((panel) => (
                    <div key={panel.key} className="border-t border-rule pt-2">
                      {panel.node}
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        ) : (
          /* Sticky is only true on the branch that does NOT scroll: a header
             inside an overflow-x wrapper can stick to nothing, so the two are
             one decision (`components/ui/table.tsx`). This table asked for both
             at once and got a header that left the screen. */
          <TableWrap ref={wrapRef} scrolls={overflows || !measured}>
            {/* hand-rolled because: every cell is a live form control bound to
                one phase's overrides, and the phone rendering above is a `<ul>`
                of labelled fields rather than a card list — a `<select>` folded
                into a detail row is a control the reader cannot see is set.
                `DataTable`'s cut and its `CardList` both assume a cell is
                something to read. */}
            <Table ref={tableRef} fixed aria-label="Per-phase overrides">
              {/* Form controls, so the tracks are what the CONTROLS need rather
                  than what a title happens to be — a select that shrinks to fit
                  a column is a select nobody can read the options in. Title
                  takes what is left, and truncates: under a fixed layout a title
                  that will not wrap escapes its column instead of widening it. */}
              <THead>
                <TR>
                  <TH scope="col" className={cn('w-16', head)}>
                    Phase
                  </TH>
                  <TH scope="col" className={head}>
                    Title
                  </TH>
                  <TH scope="col" className={cn('w-36', head)}>
                    Model
                  </TH>
                  <TH scope="col" className={cn('w-32', head)}>
                    Effort
                  </TH>
                  {skills.length > 0 && (
                    <TH scope="col" className={cn('w-32', head)}>
                      Skills
                    </TH>
                  )}
                  {servers.length > 0 && (
                    <TH scope="col" className={cn('w-32', head)}>
                      MCP
                    </TH>
                  )}
                  <TH scope="col" className={cn('w-20', head)}>
                    More
                  </TH>
                </TR>
              </THead>
              <TBody>
                {planPhases.map((p) => {
                  const own = overrides[String(p.phase)] ?? {};
                  return [
                    <TR key={p.phase} className={p.state === 'done' ? 'text-ink-muted' : undefined}>
                      <TD className="font-mono tabular-nums">{p.phase}</TD>
                      <TD className="text-2xs">
                        <span className="block truncate" title={p.title}>
                          {p.title}
                          {p.state === 'done' && <span className="text-ink-muted"> · done</span>}
                        </span>
                      </TD>
                      <TD>{modelSelect(p, own)}</TD>
                      <TD>{effortSelect(p, own)}</TD>
                      {skills.length > 0 && <TD>{skillsCell(p, own)}</TD>}
                      {servers.length > 0 && <TD>{mcpCell(p, own)}</TD>}
                      <TD>{moreTrigger(p, own)}</TD>
                    </TR>,
                    ...panelsFor(p, own).map((panel) => (
                      <TR key={`${p.phase}-${panel.key}`}>
                        <TD colSpan={columns}>{panel.node}</TD>
                      </TR>
                    )),
                  ];
                })}
              </TBody>
            </Table>
          </TableWrap>
        )}
        <p className="max-w-prose px-3 py-2 text-2xs text-ink-muted">
          A phase already running keeps what it started with — these apply to phases that have not begun.
          Clearing a row hands it back to the plan, or to the run's own default.
        </p>
      </div>
    </details>
  );
}
