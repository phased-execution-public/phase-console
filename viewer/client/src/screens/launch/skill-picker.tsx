/**
 * Which skills a run's sessions should invoke.
 *
 * The plan can already name skills every session must use, and those stay where
 * they are — shown here as fixed, because they are the plan's statement and not
 * this control's to change. What this adds is everything for one run: a list of
 * what is actually installed, what each is for, and a way to turn one on without
 * editing a versioned file.
 *
 * ## Why it is shaped like this
 *
 * There are a few hundred skills on a working machine, which is well past the
 * point where a list is browsable. The shape follows from that number: it opens
 * folded; the ones you have chosen are pinned to the top where they can be
 * removed without hunting; a source filter cuts the list by an order of magnitude
 * in one press; and search matches the description as well as the name, because
 * "the one that does screenshots" is how people actually look.
 *
 * The list is capped rather than virtualised. A cap is one honest sentence
 * ("117 more — narrow the search"); a virtualiser is a scroll container that lies
 * about its contents to every find-in-page and screen reader that meets it.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button, Input, Mono } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Disclosure } from '@/ui/disclosure';
import type { SkillInfo } from '@/data/api';

const SOURCE_LABEL: Record<string, string> = {
  project: 'this repo',
  personal: 'personal',
  plugin: 'plugins',
};
const SOURCE_ORDER = ['project', 'personal', 'plugin'];

/** A source's words as a group's heading — sentence case. */
const heading = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * Past this, the browser is being asked to lay out more than anyone will read.
 *
 * Twelve, because the list does not scroll inside itself: a second vertical
 * scroller nested in the dialog's own eats the flick meant for the outer one
 * (`ui/table.tsx` bans the same arrangement for tables). The list lays out in
 * the dialog's scroller, so the cap is what keeps a 60-skill group from being a
 * screen and a half of rows; the search is the way to the rest, and the
 * sentence under the cap says so.
 */
const SHOWN_PER_GROUP = 12;

export function SkillPicker({
  skills,
  chosen,
  planSkills = [],
  defaultSkills = [],
  disabled,
  onChange,
  label = 'Skills for this run',
}: {
  skills: SkillInfo[];
  chosen: string[];
  planSkills?: string[];
  /**
   * Skills this console starts every run with. Marked `default` on whichever
   * are chosen, so a box nobody ticked is explained rather than mysterious —
   * and unticking one is visibly a decision about THIS run.
   */
  defaultSkills?: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');

  const picked = new Set(chosen);
  const byDefault = new Set(defaultSkills);
  const planKey = planSkills.join(',');

  const selectable = useMemo(
    () => skills.filter((s) => !new Set(planKey ? planKey.split(',') : []).has(s.id)),
    [skills, planKey],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return selectable.filter((s) => {
      if (source && s.source !== source) return false;
      if (!needle) return true;
      return s.id.toLowerCase().includes(needle) || (s.description ?? '').toLowerCase().includes(needle);
    });
  }, [selectable, query, source]);

  const groups = useMemo(() => {
    const out = new Map<string, SkillInfo[]>();
    for (const skill of matches) {
      if (!out.has(skill.source)) out.set(skill.source, []);
      out.get(skill.source)!.push(skill);
    }
    return [...out.entries()].sort((a, b) => SOURCE_ORDER.indexOf(a[0]) - SOURCE_ORDER.indexOf(b[0]));
  }, [matches]);

  const available = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of selectable) counts[s.source] = (counts[s.source] ?? 0) + 1;
    return counts;
  }, [selectable]);

  const toggle = (id: string) => onChange(picked.has(id) ? chosen.filter((s) => s !== id) : [...chosen, id]);

  // A chosen skill that is not installed here still has to be removable, so it
  // is shown from the id alone rather than dropped for want of a description.
  //
  // Minus what the PLAN names, the same subtraction `selectable` makes: a QA
  // review seeds `chosen` from the plan's own skills, and a plan skill listed
  // again as removable offers a removal that does nothing an operator can see —
  // the plan puts it back into every boot prompt.
  const fromPlan = new Set(planSkills);
  const chosenSkills = chosen
    .filter((id) => !fromPlan.has(id))
    .map((id) => skills.find((s) => s.id === id) ?? { id, description: 'not installed on this machine' });

  // The fold's own line, drawn open and folded alike.
  const summary = (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-start">
      <span className="text-body font-medium text-ink">{label}</span>
      {chosenSkills.length > 0 && <span className="tnum text-ink">{chosenSkills.length} chosen</span>}
      {planSkills.length > 0 && <span className="tnum">{planSkills.length} from the plan</span>}
      {!chosenSkills.length && !planSkills.length && <span>none, unless the plan names some</span>}
    </span>
  );

  return (
    <Disclosure
      className="min-w-0"
      label={summary}
      openLabel={summary}
      bodyClassName="flex min-w-0 flex-col gap-3 pt-2 ps-4"
    >
      {planSkills.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="max-w-(--measure) text-meta text-ink-muted">
            The plan's <Mono value="Skills (every session)" /> line already puts these in every boot prompt.
            They are not this control's to turn off — edit the plan if they are wrong.
          </p>
          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {planSkills.map((id) => (
              <Mono key={id} value={id} className="min-w-0 wrap-anywhere text-ink" />
            ))}
          </div>
        </div>
      )}

      {chosenSkills.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Chosen skills">
          {chosenSkills.map((s) => (
            <Button
              key={s.id}
              size="sm"
              disabled={disabled}
              title={
                byDefault.has(s.id)
                  ? `${s.description} — on by default for every run on this console; click to remove it from this one`
                  : `${s.description} — click to remove`
              }
              aria-label={`Remove ${s.id}`}
              onClick={() => toggle(s.id)}
              // A skill id is text the app did not write: the chip may wrap
              // rather than push past the dialog.
              className="h-auto min-h-7 max-w-full shrink whitespace-normal py-0.5 text-start"
            >
              <Mono value={s.id} className="min-w-0 wrap-anywhere text-ink" />
              {byDefault.has(s.id) && <span className="font-normal text-ink-muted">default</span>}
              <X size={12} aria-hidden className="shrink-0 text-ink-muted" />
            </Button>
          ))}
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-2">
        <Input
          type="search"
          block
          aria-label="Search skills by name or purpose"
          placeholder={`Search ${selectable.length} skills — name or what it is for`}
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          className="text-meta"
        />
        <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Filter by source">
          <FilterChip pressed={source === ''} disabled={disabled} onClick={() => setSource('')}>
            all {selectable.length}
          </FilterChip>
          {SOURCE_ORDER.filter((s) => available[s]).map((s) => (
            <FilterChip
              key={s}
              pressed={source === s}
              disabled={disabled}
              onClick={() => setSource(source === s ? '' : s)}
            >
              {SOURCE_LABEL[s]} {available[s]}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* No scroller of its own — see SHOWN_PER_GROUP. Each row takes the
          thumb floor as its BOX (`tap-row`): a row in a stack of rows cannot
          use the checkbox's overlay floor, which would reach into the rows
          above and below it. */}
      <div className="flex min-w-0 flex-col gap-2">
        {groups.length ? (
          groups.map(([group, list]) => (
            <div key={group} className="flex min-w-0 flex-col">
              <p className="flex gap-2 py-1 text-meta text-ink-muted">
                <span>{heading(SOURCE_LABEL[group] ?? group)}</span>
                <span className="tnum">{list.length}</span>
              </p>
              {list.slice(0, SHOWN_PER_GROUP).map((skill) => (
                <label
                  key={skill.id}
                  className="tap-row flex min-w-0 items-baseline gap-2 py-0.5 text-meta hover:bg-surface-raised"
                >
                  <Checkbox
                    checked={picked.has(skill.id)}
                    disabled={disabled}
                    onCheckedChange={() => toggle(skill.id)}
                    aria-label={skill.id}
                  />
                  {/* The id gives way only when it alone is wider than the row:
                      the description's zero basis takes the shrinking first. */}
                  <Mono value={skill.id} className="min-w-0 wrap-anywhere text-ink" />
                  {byDefault.has(skill.id) && (
                    <span
                      className="shrink-0 text-ink-muted"
                      title="On by default for every run on this console"
                    >
                      default
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-ink-muted" title={skill.description}>
                    {skill.description || 'no description'}
                  </span>
                </label>
              ))}
              {list.length > SHOWN_PER_GROUP && (
                <p className="py-1 text-meta text-ink-muted">
                  <span className="tnum">{list.length - SHOWN_PER_GROUP}</span> more in{' '}
                  {SOURCE_LABEL[group] ?? group} — narrow the search to reach them
                </p>
              )}
            </div>
          ))
        ) : (
          <p className="py-2 text-meta text-ink-muted">
            Nothing matches {query ? <span className="font-medium text-ink">“{query}”</span> : 'that filter'}.
            {source && (
              <>
                {' '}
                Try{' '}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto px-1 py-0 align-baseline underline underline-offset-2"
                  onClick={() => setSource('')}
                >
                  all sources
                </Button>
                .
              </>
            )}
          </p>
        )}
      </div>

      <p className="max-w-(--measure) text-meta text-ink-muted">
        Chosen skills are named in the boot prompt of every phase in this run, on top of anything the plan
        asks for. Whether a skill then applies is still the session's judgement — naming one makes it
        available and says it is wanted, which is all naming a skill has ever done.
      </p>
    </Disclosure>
  );
}

/** A source filter: pressed is the quiet button, the rest are words until hovered. */
function FilterChip({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={pressed ? 'default' : 'ghost'}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="tnum"
    >
      {children}
    </Button>
  );
}
