/**
 * What an unattended session may run unasked — the permission rules, and the
 * part that matters: WHICH LAYER actually stops a call (7.0's since
 * quiet-console phase 23; `policy.tsx` is Automation's policy answers, so the
 * rule editor is `rules.tsx`, drawn by Permissions).
 *
 * ```
 * These rules apply  [ everywhere ▾ ]                   ~/…/permissions.json
 * [x] Auto-grant approvals
 *
 * Denied — the wall                                    Restore defaults
 * Evaluated inside the CLI with no network …
 * Bash(rm -rf:*) ×   Bash(git push --force:*) ×   …
 * Struck here: ̶R̶e̶a̶d̶(̶~̶/̶.̶s̶s̶h̶/̶*̶*̶)̶  Restore
 *
 * Add a rule
 * Form [Command prefix ▾]  Tool [Bash]  Value [git commit]  to [ask ▾]
 * Bash(git commit:*)                                      [Add everywhere]
 * ```
 *
 * These three lists look alike and are nothing alike. `deny` is evaluated
 * inside the CLI with no network involved, and was measured holding with this
 * console stopped: it is the wall. `ask` goes through the HTTP hook, which
 * FAILS OPEN — with nothing listening the call proceeds. `allow` never round-
 * trips, and the ones a person adds outrank `ask`. Presenting them as one list
 * would be the most dangerous thing this page could do, so the difference is
 * the first thing said about each.
 *
 * Striking a SHIPPED deny rule is the one edit wide enough to confirm first:
 * it widens what every future run may do, on every profile, with this console
 * dead included. Every other removal is one press, and every strike is
 * reversible here. An edit is a press through the owner door (`press()`):
 * with an owner key enrolled it may come back as a request the owner confirms.
 *
 * The builder exists because a free-text box assumes the writer remembers that
 * `:*` only works at the end, that `ls *` and `ls*` are different rules, and
 * that `Write(…)` paths are silently ignored. Almost nobody does.
 */

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { PolicyAdvisoryKind } from '@shared/ops-vocab.js';
import { api, type PolicyEdit, type PolicyLists, type PolicyView } from '@/data/api';
import { keys } from '@/data/keys';
import { usePlans } from '@/data/plans';
import { usePolicy } from '@/data/policy';
import { press } from '@/data/press';
import { cn } from '@/lib/cn';
import { Banner, Button, Input, Label, Mono, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { ConfirmDialog } from '@/ui/confirm';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';
import { SettingsGroup, failureWords } from './setting';

type ListName = keyof PolicyLists;

/** The rule forms, and what each one builds. */
export const RULE_FORMS = [
  {
    id: 'prefix',
    label: 'Command prefix',
    tool: 'Bash',
    placeholder: 'git commit',
    build: (tool: string, value: string) => `${tool}(${value}:*)`,
    hint: 'Matches the command and anything after it, at a word boundary. Bash(ls:*) is Bash(ls *) — it does not match lsof.',
  },
  {
    id: 'glob',
    label: 'Command glob',
    tool: 'Bash',
    placeholder: 'npm run test *',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: '* spans anything. Mind the space: `ls *` is not `ls*`.',
  },
  {
    id: 'tool',
    label: 'A whole tool',
    tool: 'WebFetch',
    placeholder: '',
    build: (tool: string) => tool,
    hint: 'Every use of that tool. As a deny rule, this removes the tool from the session entirely.',
  },
  {
    id: 'param',
    label: 'One parameter',
    tool: 'Agent',
    placeholder: 'model:opus',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: 'One parameter per rule; * is allowed in the value. Bash(command:…) is NOT one of these — it is ignored.',
  },
  {
    id: 'path',
    label: 'A path',
    tool: 'Read',
    placeholder: '~/.ssh/**',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: '//abs · ~/home · ./cwd · a bare name means anywhere, so Read(.env) is Read(**/.env). Only Read(…) and Edit(…) are consulted.',
  },
  {
    id: 'domain',
    label: 'A web domain',
    tool: 'WebFetch',
    placeholder: '*.example.com',
    build: (tool: string, value: string) => `${tool}(domain:${value})`,
    hint: '*.example.com covers subdomains of it, not the bare domain.',
  },
  {
    id: 'mcp',
    label: 'An MCP server or tool',
    tool: 'mcp__server',
    placeholder: '',
    build: (tool: string) => tool,
    hint: 'mcp__server covers everything it exposes; mcp__server__tool is one of them.',
  },
  {
    id: 'agent',
    label: 'A subagent type',
    tool: 'Agent',
    placeholder: 'Explore',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: 'The agent type as it is dispatched.',
  },
  {
    id: 'cd',
    label: 'A directory',
    tool: 'Cd',
    placeholder: '~/code/**',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: '~/code/* is one segment deep; ~/code/** is any depth.',
  },
  {
    id: 'free',
    label: 'Write it myself',
    tool: '',
    placeholder: 'Bash(task deploy:*)',
    build: (_tool: string, value: string) => value,
    hint: 'Anything the syntax accepts. Checked before it is written.',
  },
] as const;

/** What each list IS, said before what it holds. */
export const LIST_WORDS: Readonly<Record<ListName, { title: string; detail: string; to: string }>> = {
  deny: {
    title: 'Denied — the wall',
    detail:
      'Evaluated inside the CLI, with no network involved, and measured holding with this console stopped. Nothing approves past it at run time — and striking a shipped rule here is the one edit that widens what every future run may do, so it asks first.',
    to: 'deny — never, whatever I press',
  },
  ask: {
    title: 'Asked — the workflow',
    detail:
      'These raise a card and wait for you, through the HTTP hook — which FAILS OPEN: with this console not running, the call proceeds unasked. Useful, and never the thing to rely on for what must not happen.',
    to: 'ask — stop and show me',
  },
  allow: {
    title: 'Allowed',
    detail:
      'Never round-trip to the hook. The shipped ones are read-only work a phase does constantly; the ones you add also outrank the ask list, which is what makes “Always allow this” on a card stop the asking.',
    to: 'allow — stop asking about it',
  },
};

const FALLBACK_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Agent',
  'Cd',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

/** A shipped deny rule this scope's own file does not hold — the strike that confirms first. */
export function isShippedDeny(policy: PolicyView, rule: string, own: readonly string[]): boolean {
  return policy.defaults.deny.includes(rule) && !own.includes(rule);
}

/** What an edit did, in the words of the toast. */
export function editWords(edit: Omit<PolicyEdit, 'scope'>, where: string): string {
  if ('autoApprove' in edit) {
    return edit.autoApprove == null
      ? `Auto-grant now inherits${where}`
      : `Auto-grant ${edit.autoApprove ? 'on' : 'off'}${where || ' everywhere'}`;
  }
  if (edit.reset?.length) return `Restored ${edit.reset.join(', ')} to the shipped defaults${where}`;
  const added = edit.add && Object.entries(edit.add)[0];
  if (added) return `Added ${added[1]?.[0]} to ${added[0]}${where}`;
  if (edit.restore) return `Brought the shipped rule back${where}`;
  return `Removed${where}`;
}

export function RulesGroup({ allowWrites }: { allowWrites: boolean }) {
  const client = useQueryClient();
  const [scope, setScope] = useState<'global' | 'plan'>('global');
  const [slug, setSlug] = useState('');
  const [strike, setStrike] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The last scope stays drawn while the next is read — the picker keeps its
  // focus — and nothing is written against it until the new answer lands.
  const { data: policy, isPlaceholderData: reading } = usePolicy(slug || undefined, { keepPrevious: true });
  const { data: plans } = usePlans();
  const planScope = scope === 'plan';
  const targetKnown = !planScope || Boolean(slug);
  const where = planScope ? ` for ${slug}` : '';
  const scopeWords = planScope ? `the ${slug} scope` : 'the global scope';

  /** Whether the server took the edit — written, or asked of the owner. */
  const edit = async (patch: Omit<PolicyEdit, 'scope' | 'slug'>): Promise<boolean> => {
    setBusy(true);
    try {
      const pressed = await press(() => api.editPolicy({ scope, slug: slug || null, ...patch }));
      if (pressed.state === 'asked') {
        toast(pressed.words, 'info', 6000);
        return true;
      }
      client.setQueryData(keys.policy(slug || ''), pressed.result);
      toast(editWords(patch, where), 'ok');
      return true;
    } catch (error) {
      toast(failureWords(error), 'error');
      return false;
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ['policy'] });
    }
  };

  const acknowledge = async (kind: PolicyAdvisoryKind) => {
    try {
      await api.acknowledgePolicyAdvisory(kind);
      toast('Acknowledged — it comes back if the rules change.', 'ok');
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      void client.invalidateQueries({ queryKey: ['policy'] });
    }
  };

  // A console whose server predates the policy endpoint has nothing to show,
  // and a group of controls over no data is worse than none.
  if (!policy) return null;

  const extras = planScope ? policy.plan?.extra : policy.extra;
  const mine = (name: ListName): string[] => extras?.[name] ?? [];
  const struck = (name: ListName): string[] => extras?.removed?.[name] ?? [];
  const editable = allowWrites && targetKnown && !busy && !reading;
  const auto = policy.autoApprove;
  const autoOn = auto ? (auto.global ?? auto.effective) : true;

  return (
    <SettingsGroup
      id="permission-rules"
      title="What a session may run unasked"
      lead={
        <>
          Highlighted rules are this scope’s own; the rest ship with the console.{' '}
          <Mono value={planScope && policy.plan ? policy.plan.path : policy.file} />
        </>
      }
    >
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3" data-testid="rules-scope">
        <span className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="rules-scope">These rules apply</Label>
          <NativeSelect
            id="rules-scope"
            className="w-full sm:w-56"
            value={scope}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as 'global' | 'plan';
              setScope(next);
              if (next === 'global') setSlug('');
            }}
          >
            <option value="global">Everywhere</option>
            <option value="plan">To one plan only</option>
          </NativeSelect>
        </span>
        {planScope && (
          <span className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="rules-plan">Plan</Label>
            <NativeSelect
              id="rules-plan"
              className="w-full sm:w-56"
              value={slug}
              disabled={busy}
              onChange={(event) => setSlug(event.target.value)}
            >
              <option value="">Choose a plan</option>
              {(plans ?? []).map((plan) => (
                <option key={plan.slug} value={plan.slug}>
                  {plan.slug}
                </option>
              ))}
            </NativeSelect>
          </span>
        )}
      </div>
      {planScope && slug && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          The global rules and <span className="font-mono">{slug}</span>’s own. The global ones are edited
          from the Everywhere scope.
        </p>
      )}

      {auto && (
        <div className="flex min-w-0 flex-col gap-1" data-testid="auto-grant">
          {!planScope ? (
            <label className="tap-row flex min-w-0 items-start gap-2.5 text-body">
              <Checkbox
                className="mt-0.5"
                checked={autoOn}
                disabled={!allowWrites || busy || reading}
                onCheckedChange={(next) => void edit({ autoApprove: next === true })}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-ink">
                  Auto-grant approvals{auto.global == null ? ' (on as shipped)' : ''}
                </span>
                <span className="max-w-(--measure) text-meta text-ink-muted">
                  A card the ask list raises is answered Allow by itself — still recorded, marked decided by
                  auto-grant, and in the queue’s history. The deny list refuses whatever this says.
                </span>
              </span>
            </label>
          ) : slug ? (
            <span className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="rules-auto">Auto-grant approvals for {slug}</Label>
              <NativeSelect
                id="rules-auto"
                className="w-full sm:w-72"
                value={auto.plan == null ? '' : auto.plan ? 'on' : 'off'}
                disabled={!allowWrites || busy || reading}
                onChange={(event) =>
                  void edit({ autoApprove: event.target.value === '' ? null : event.target.value === 'on' })
                }
              >
                <option value="">Inherit (everywhere: {(auto.global ?? true) ? 'on' : 'off'})</option>
                <option value="on">On — cards answer themselves</option>
                <option value="off">Off — every card waits for a person</option>
              </NativeSelect>
            </span>
          ) : null}
        </div>
      )}

      {(['deny', 'ask', 'allow'] as const).map((name) => (
        <section
          key={name}
          className="flex min-w-0 flex-col gap-2"
          data-rule-list={name}
          aria-label={LIST_WORDS[name].title}
        >
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-body font-semibold text-ink">{LIST_WORDS[name].title}</h3>
            {allowWrites && targetKnown && (mine(name).length > 0 || struck(name).length > 0) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || reading}
                onClick={() => void edit({ reset: [name] })}
              >
                Restore defaults
              </Button>
            )}
          </div>
          <p className="max-w-(--measure) text-meta text-ink-muted">{LIST_WORDS[name].detail}</p>
          <RuleChips
            rules={policy.effective[name]}
            own={mine(name)}
            defaults={policy.defaults[name]}
            list={name}
            removable={editable}
            scopeWords={scopeWords}
            onRemove={(rule) =>
              name === 'deny' && isShippedDeny(policy, rule, mine('deny'))
                ? setStrike(rule)
                : void edit({ remove: { [name]: [rule] } })
            }
          />
          {struck(name).length > 0 && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-meta text-ink-muted">Shipped rules struck at {scopeWords}:</span>
              {struck(name).map((rule) => (
                <span key={rule} className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="wrap-anywhere font-mono text-meta text-ink-faint line-through">
                    {rule}
                  </span>
                  {allowWrites && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || reading}
                      aria-label={`Restore ${rule}`}
                      onClick={() => void edit({ restore: { [name]: [rule] } })}
                    >
                      Restore
                    </Button>
                  )}
                </span>
              ))}
            </div>
          )}
        </section>
      ))}

      <ConfirmDialog
        open={strike != null}
        onOpenChange={(open) => !open && setStrike(null)}
        title="Remove a shipped deny rule?"
        confirmLabel="Remove it"
        cancelLabel="Keep the wall"
        destructive
        description={
          <>
            <span className="font-mono">{strike}</span> is part of the shipped deny list — the layer enforced
            inside the CLI, which holds even with this console stopped. Removed at {scopeWords}, every future
            run, on every profile, may then do it without asking.
          </>
        }
        details={
          <p className="mt-2 text-meta text-ink-muted">
            Reversible here: the struck rule stays listed with Restore, and Restore defaults brings the whole
            wall back. The edit is written with your name on it and journalled.
          </p>
        }
        onConfirm={() => {
          const rule = strike;
          setStrike(null);
          if (rule) void edit({ remove: { deny: [rule] } });
        }}
      />

      {(policy.advisory ?? [])
        .filter((advisory) => !advisory.acknowledged)
        .map((advisory) => (
          <Banner key={advisory.kind} severity="warn" data-policy-advisory={advisory.kind}>
            <span className="flex min-w-0 flex-col gap-2">
              <span>
                <strong>
                  {advisory.kind === 'ask-empty' ? 'Nothing here asks.' : 'The deny wall is struck.'}
                </strong>{' '}
                {advisory.message}
              </span>
              {advisory.rules.length ? (
                <span className="flex min-w-0 flex-wrap gap-x-3 font-mono text-meta">
                  {advisory.rules.map((rule) => (
                    <span key={rule} className="wrap-anywhere">
                      {rule}
                    </span>
                  ))}
                </span>
              ) : null}
              <Button size="sm" className="self-start" onClick={() => void acknowledge(advisory.kind)}>
                I have read this
              </Button>
            </span>
          </Banner>
        ))}

      {policy.inert?.length ? (
        <Banner severity="warn">
          <span className="flex min-w-0 flex-col gap-1">
            <strong>These parse and do nothing.</strong>
            {policy.inert.map((rule) => (
              <span key={rule.raw}>
                <span className="wrap-anywhere font-mono">{rule.raw}</span> — {rule.note}
              </span>
            ))}
          </span>
        </Banner>
      ) : null}

      {allowWrites ? (
        <AddRule
          policy={policy}
          busy={busy}
          reading={reading}
          targetKnown={targetKnown}
          planSlug={planScope ? slug : null}
          onAdd={edit}
        />
      ) : (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          Start the console with <code className="font-mono">--allow-writes</code> to edit rules here, or edit{' '}
          <span className="wrap-anywhere font-mono">{policy.file}</span> directly.
        </p>
      )}
    </SettingsGroup>
  );
}

function RuleChips({
  rules,
  own,
  defaults,
  list,
  removable,
  scopeWords,
  onRemove,
}: {
  rules: string[];
  own: string[];
  defaults: string[];
  list: ListName;
  removable: boolean;
  scopeWords: string;
  onRemove: (rule: string) => void;
}) {
  if (!rules.length) return <p className="text-meta text-ink-muted">None.</p>;
  return (
    // A wrapped bag of chips on a desk; under a coarse pointer a column of
    // full-width rows, so each remove control has a row of its own to fill —
    // a 44 px target in a wrapped bag would cover its neighbours'.
    <ul
      aria-label={`${LIST_WORDS[list].title}: ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}`}
      className="flex min-w-0 flex-wrap gap-1.5 [@media(hover:none)]:flex-col [@media(hover:none)]:flex-nowrap"
    >
      {rules.map((rule) => {
        const isOwn = own.includes(rule);
        const canRemove = removable && (isOwn || defaults.includes(rule));
        return (
          <li
            key={rule}
            title={
              isOwn
                ? `Yours, at ${scopeWords}`
                : !defaults.includes(rule)
                  ? // At a plan's scope the rest are the console-wide rules, edited there.
                    'Yours, for every plan — remove it at the global scope.'
                  : list === 'deny'
                    ? 'Shipped deny rule — the wall at run time. Removing it asks first.'
                    : 'Shipped — removing it strikes it here; Restore defaults brings it back.'
            }
            className={cn(
              'inline-flex min-w-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-meta',
              '[@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:justify-between [@media(hover:none)]:px-2',
              isOwn ? 'border-rule-strong bg-surface-raised text-ink' : 'border-rule text-ink-muted',
            )}
          >
            <span className="min-w-0 wrap-anywhere">{rule}</span>
            {canRemove && (
              <button
                type="button"
                aria-label={`Remove ${rule}`}
                onClick={() => onRemove(rule)}
                className="tap-area shrink-0 rounded-sm text-ink-faint hover:text-failed"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AddRule({
  policy,
  busy,
  reading,
  targetKnown,
  planSlug,
  onAdd,
}: {
  policy: PolicyView;
  busy: boolean;
  /** Another scope is being read: nothing may be added against the one still drawn. */
  reading: boolean;
  targetKnown: boolean;
  planSlug: string | null;
  onAdd: (patch: Omit<PolicyEdit, 'scope' | 'slug'>) => Promise<boolean>;
}) {
  const [formId, setFormId] = useState<string>(RULE_FORMS[0].id);
  const form = RULE_FORMS.find((one) => one.id === formId) ?? RULE_FORMS[0];
  const [tool, setTool] = useState<string>(form.tool);
  const [value, setValue] = useState('');
  const [list, setList] = useState<ListName>('ask');
  // A form that asks for a value builds nothing until it has one: `Bash(:*)`
  // is a rule the server refuses, so the page never offers it.
  const rule = form.placeholder && !value.trim() ? '' : form.build(tool.trim(), value.trim()).trim();
  const tools = useMemo(
    () => [...new Set([...(policy.hookTools ?? []), ...(policy.seen ?? []), ...FALLBACK_TOOLS])],
    [policy.hookTools, policy.seen],
  );
  const add = async () => {
    if (!rule || !targetKnown || reading) return;
    // The value is cleared once the server took the rule: a refused one is
    // corrected where it was typed, not typed again.
    if (await onAdd({ add: { [list]: [rule] } })) setValue('');
  };

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Add a rule" data-testid="add-rule">
      <h3 className="text-body font-semibold text-ink">Add a rule</h3>
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3">
        <span className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="rule-form">Form</Label>
          <NativeSelect
            id="rule-form"
            className="w-full sm:w-52"
            value={formId}
            disabled={busy}
            onChange={(event) => {
              const next = RULE_FORMS.find((one) => one.id === event.target.value) ?? RULE_FORMS[0];
              setFormId(next.id);
              setTool(next.tool);
              setValue('');
            }}
          >
            {RULE_FORMS.map((one) => (
              <option key={one.id} value={one.id}>
                {one.label}
              </option>
            ))}
          </NativeSelect>
        </span>
        {form.id !== 'free' && (
          <span className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="rule-tool">Tool</Label>
            <Input
              id="rule-tool"
              className="w-full font-mono sm:w-44"
              value={tool}
              disabled={busy}
              spellCheck={false}
              list="rule-tools"
              onChange={(event) => setTool(event.target.value)}
            />
          </span>
        )}
        {form.placeholder && (
          <span className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="rule-value">{form.id === 'free' ? 'Rule' : 'Value'}</Label>
            <Input
              id="rule-value"
              className="w-full font-mono"
              value={value}
              placeholder={form.placeholder}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void add();
                }
              }}
            />
          </span>
        )}
        <span className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="rule-list">To</Label>
          <NativeSelect
            id="rule-list"
            className="w-full sm:w-64"
            value={list}
            disabled={busy}
            onChange={(event) => setList(event.target.value as ListName)}
          >
            {(['deny', 'ask', 'allow'] as const).map((name) => (
              <option key={name} value={name}>
                {LIST_WORDS[name].to}
              </option>
            ))}
          </NativeSelect>
        </span>
      </div>
      <datalist id="rule-tools">
        {tools.map((one) => (
          <option key={one} value={one} />
        ))}
      </datalist>
      <p className="max-w-(--measure) text-meta text-ink-muted">{form.hint}</p>
      {policy.seen?.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-meta text-ink-muted">Tools this console has been asked about:</span>
          {policy.seen.map((one) => (
            <Button key={one} size="sm" variant="ghost" disabled={busy} onClick={() => setTool(one)}>
              {one}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code
          className="min-w-0 wrap-anywhere rounded border border-rule bg-ground px-2 py-1 font-mono text-body text-ink"
          data-testid="rule-preview"
        >
          {rule || '—'}
        </code>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || reading || !rule || !targetKnown}
          onClick={() => void add()}
        >
          {busy ? 'Writing…' : planSlug != null ? `Add for ${planSlug || 'a plan'}` : 'Add everywhere'}
        </Button>
        {!targetKnown && <span className="text-meta text-ink-muted">Choose a plan first.</span>}
      </div>
      <Banner severity={list === 'allow' ? 'warn' : 'info'}>
        {list === 'allow' ? (
          <span>
            <strong>This widens what an unattended run may do.</strong> It is written with your name on it,
            recorded in the live run’s journal, and removable from its chip. The deny list still refuses it
            whatever this says.
          </span>
        ) : (
          <span>
            Adding to deny or ask makes a run more careful. Every rule is removable from its chip — shipped
            ones are struck by name and Restore defaults brings them back. Striking a shipped deny rule is the
            widest edit this page makes, so that one asks first.
          </span>
        )}
      </Banner>
      <Disclosure label="How these are evaluated — the parts that surprise people">
        <ul className="flex max-w-(--measure) list-disc flex-col gap-1 ps-5 text-meta text-ink-muted">
          <li>
            <strong>deny → allow-you-wrote → ask → allow.</strong> The first match wins and specificity is
            irrelevant — a more specific rule does not beat an earlier one.
          </li>
          <li>
            Wrappers are seen through:{' '}
            <code className="font-mono">timeout time nice nohup stdbuf command builtin noglob</code> and bare{' '}
            <code className="font-mono">xargs</code>. Not{' '}
            <code className="font-mono">{(policy.wrappersNotStripped ?? []).join(' ')}</code> — a rule about
            what those run will not fire.
          </li>
          <li>
            <code className="font-mono">watch</code>, <code className="font-mono">setsid</code>,{' '}
            <code className="font-mono">flock</code> and <code className="font-mono">find -exec</code> never
            auto-approve: what they run cannot be seen from the outside, so they get a card.
          </li>
          <li>
            Only <code className="font-mono">Read(…)</code> and <code className="font-mono">Edit(…)</code>{' '}
            path rules are consulted; <code className="font-mono">Write(…)</code>,{' '}
            <code className="font-mono">NotebookEdit(…)</code> and <code className="font-mono">Glob(…)</code>{' '}
            paths are ignored.
          </li>
          <li>
            <code className="font-mono">Bash(command:rm *)</code> looks like a parameter rule and is dropped.
          </li>
          <li>
            Only <code className="font-mono">{(policy.hookTools ?? []).join(' ')}</code> reach this console’s
            hook. Rules about anything else are real, but the CLI enforces them and nothing here shows them
            being hit.
          </li>
        </ul>
      </Disclosure>
    </section>
  );
}
