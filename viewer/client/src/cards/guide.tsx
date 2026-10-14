/**
 * The guide an item carries, drawn on the line (7.0; control-tower phase 137,
 * #214).
 *
 * ONE grammar reads a guide — `shared/guide-grammar.js`; the server parsed this
 * one at the declaration and stored what it read, and `guideOf` reads one that
 * arrived as text through the same parser, never a second. This file only
 * draws it:
 *
 *   - **the why**, a paragraph, through the one Markdown component;
 *   - **the steps as a route** — the console's one graphic (`ui/track`, a plan
 *     is a line and its phases are stations) at the size of a task: each step a
 *     station, and the station IS its tick. A tick is the person's own mark of
 *     where they are, kept in this browser per item and never sent anywhere:
 *     the check, not the tick, says the item is done;
 *   - **each command in the one command block** (`ui/code-block.tsx`, turn-by-turn
 *     phase 8): copied as it is, or behind `!` for the person's own Claude Code
 *     session; a template says what to fill in first. The page never runs one;
 *   - what to **expect**, a **warning**, and a **link** that shows its whole
 *     address before it opens;
 *   - **If it goes wrong**, symptom and fix.
 *
 * A guide carries its language: a right-to-left one is drawn `dir="rtl"` —
 * the line mirrors with it, every side being logical — its commands
 * left-to-right, its refs and numbers isolated (`ui/markdown`).
 */

import { useCallback, useState } from 'react';
import { CircleCheck, ExternalLink, TriangleAlert } from 'lucide-react';
import { parseGuide, type Guide } from '@shared/guide-grammar.js';
import { cn } from '@/lib/cn';
import { CodeBlock } from '@/ui/code-block';
import { Markdown, MarkdownInline } from '@/ui/markdown';
import { Station } from '@/ui/track/station';
import { Track } from '@/ui/track/track';
import './guide.css';

function isGuide(value: unknown): value is Guide {
  const guide = value as Partial<Guide> | null;
  return Boolean(
    guide && typeof guide === 'object' && Array.isArray(guide.steps) && typeof guide.summary === 'string',
  );
}

/**
 * A stored guide as the grammar reads it: a parsed one as it is; text — bare,
 * or `{text, lang}` as a declaration carries it — through `parseGuide`; and
 * nothing at all for what the grammar refuses, which is never drawn as though
 * it were a guide.
 */
export function guideOf(raw: unknown): Guide | null {
  if (isGuide(raw)) return raw;
  if (typeof raw === 'string') {
    const read = parseGuide(raw);
    return read.ok ? read.guide : null;
  }
  if (raw && typeof raw === 'object' && typeof (raw as { text?: unknown }).text === 'string') {
    const { text, lang } = raw as { text: string; lang?: string };
    const read = parseGuide(text, { lang });
    return read.ok ? read.guide : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The ticks — the person's own marks, per item, in this browser
 * ------------------------------------------------------------------ */

const TICKS = (item: string) => `turn:ticks:${item}`;

function readTicks(item: string): Set<number> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(TICKS(item)) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n)) : []);
  } catch {
    return new Set();
  }
}

function useTicks(item: string): [Set<number>, (step: number) => void] {
  const [ticks, setTicks] = useState(() => readTicks(item));
  const toggle = useCallback(
    (step: number) =>
      setTicks((was) => {
        const next = new Set(was);
        if (next.has(step)) next.delete(step);
        else next.add(step);
        try {
          window.localStorage.setItem(TICKS(item), JSON.stringify([...next].sort((a, b) => a - b)));
        } catch {
          /* a private window keeps the tick for this visit — it was never more than a mark */
        }
        return next;
      }),
    [item],
  );
  return [ticks, toggle];
}

/* ------------------------------------------------------------------ *
 * The guide
 * ------------------------------------------------------------------ */

export function GuideView({
  guide,
  itemId,
  className,
}: {
  guide: Guide;
  itemId: string;
  className?: string;
}) {
  const [ticks, toggle] = useTicks(itemId);
  const { dir, lang } = guide;
  return (
    <section
      data-testid="turn-guide"
      lang={lang}
      dir={dir}
      aria-label="The guide"
      className={cn('flex min-w-0 flex-col gap-4', className)}
    >
      {guide.summary && (
        <div data-testid="guide-why" className="max-w-prose text-body text-ink">
          <Markdown text={guide.summary} lang={lang} dir={dir} className="md-guide" />
        </div>
      )}
      {guide.steps.length > 0 && (
        <Track orientation="vertical" align="start" label="Steps" className="guide-track">
          {guide.steps.map((step, index) => {
            const n = index + 1;
            const done = ticks.has(index);
            return (
              <Station
                key={`${index}-${step.text}`}
                paint={done ? 'done' : 'queued'}
                fill={done}
                data-testid="guide-step"
                data-done={done ? 'true' : 'false'}
                tick={{
                  checked: done,
                  onChange: () => toggle(index),
                  label: `Step ${n} done`,
                  title: done ? 'Done — press to untick' : 'Tick it when done',
                  face: (
                    <span data-testid="guide-step-number" dir="ltr">
                      {n}
                    </span>
                  ),
                }}
              >
                <div className="flex min-w-0 flex-col gap-2 pt-1">
                  <p data-testid="guide-step-text" className="max-w-prose text-body font-medium text-ink">
                    <MarkdownInline text={step.text} lang={lang} dir={dir} />
                  </p>
                  {step.code && <CodeBlock code={step.code} testId="guide-command" />}
                  {step.expect && (
                    <p data-testid="guide-expect" className="flex max-w-prose items-start gap-1.5 text-body">
                      <CircleCheck size={14} aria-hidden className="mt-1 shrink-0 text-done" />
                      <span className="min-w-0 text-ink">
                        <span className="font-medium">Expect: </span>
                        <MarkdownInline text={step.expect} lang={lang} dir={dir} />
                      </span>
                    </p>
                  )}
                  {step.warn && (
                    <p data-testid="guide-warning" className="flex max-w-prose items-start gap-1.5 text-body">
                      <TriangleAlert size={14} aria-hidden className="mt-1 shrink-0 text-ink" />
                      <span className="min-w-0 text-ink">
                        <span className="font-medium">Warning: </span>
                        <MarkdownInline text={step.warn} lang={lang} dir={dir} />
                      </span>
                    </p>
                  )}
                  {step.link && (
                    <p data-testid="guide-link" className="flex min-w-0 flex-col gap-0.5">
                      <a
                        href={step.link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tap-row inline-flex w-fit items-center gap-1 text-body text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
                      >
                        {step.link.label}
                        <ExternalLink size={12} aria-hidden />
                      </a>
                      {/* The whole address, before it opens: a guide is a session's
                          words, and a link it names is read before it is followed. */}
                      <bdi
                        data-testid="guide-link-address"
                        dir="ltr"
                        className="font-mono text-meta wrap-anywhere text-ink-muted"
                      >
                        {step.link.url}
                      </bdi>
                    </p>
                  )}
                </div>
              </Station>
            );
          })}
        </Track>
      )}
      {guide.trouble.length > 0 && (
        <section data-testid="guide-trouble" className="flex max-w-prose flex-col gap-1.5">
          <h4 className="text-body font-semibold text-ink">If it goes wrong</h4>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-body text-ink">
            {guide.trouble.map((t, index) => (
              <li key={`${index}-${t.symptom}`}>
                <MarkdownInline text={t.symptom} lang={lang} dir={dir} className="font-medium" />
                {t.fix && (
                  <>
                    {' — '}
                    <MarkdownInline text={t.fix} lang={lang} dir={dir} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
