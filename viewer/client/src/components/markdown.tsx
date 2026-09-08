/**
 * Markdown rendering for plan and handoff bodies.
 *
 * The files are local and written by agents, but they are still untrusted input
 * to a browser. Parsed HTML goes into a `<template>` first — its content is an
 * inert fragment, so images do not load and no handler can fire — then it is
 * swept for scripts, event attributes and unsafe URLs, and only the survivors
 * are moved into the live document.
 *
 * ---- Why this is a port and not a rewrite ----
 *
 * `sweep()` below is `web/components/markdown.js` verbatim: the same FORBIDDEN
 * list, the same attribute rules, the same protocol allowlist, the same
 * `target=_blank rel=noopener` on every link. A sanitizer is the one place in a
 * rewrite where "cleaner" is worth nothing and "identical" is worth everything —
 * every difference is a hole nobody meant to open. `react-markdown` was
 * considered and rejected for the same reason: it would swap a reviewed
 * sanitizer for a different one to gain nothing this app needs.
 *
 * React does not render the result — `replaceChildren` does. That is deliberate:
 * `dangerouslySetInnerHTML` would hand the *unswept* string to the live document
 * and sanitize nothing, and a React tree built from parsed nodes would be a
 * second parser to keep in step with the first.
 */

import { marked } from 'marked';
import { memo, useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/cn';

marked.setOptions({ gfm: true, breaks: false });

const ALLOWED_PROTOCOL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;
const FORBIDDEN = /^(script|style|iframe|object|embed|form|input|button|link|meta|base|svg|math)$/i;

/**
 * Strip everything that could execute or navigate somewhere unsafe.
 *
 * Exported so the hostile-fixture test can call it on a fragment directly,
 * rather than asserting against rendered output and hoping the render path was
 * the one that mattered.
 */
export function sweep(root: ParentNode): void {
  for (const node of root.querySelectorAll('*')) {
    if (FORBIDDEN.test(node.tagName)) {
      node.remove();
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcset') {
        node.removeAttribute(attribute.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && !ALLOWED_PROTOCOL.test(attribute.value.trim())) {
        node.removeAttribute(attribute.name);
      }
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

/** Parse markdown to an inert, swept DocumentFragment. */
export function toFragment(markdown: string, inline = false): DocumentFragment {
  const template = document.createElement('template');
  const source = String(markdown);
  // `async: false` is what narrows marked's return type to a string; the option
  // is already the default, so this changes nothing but the types.
  template.innerHTML = inline
    ? marked.parseInline(source, { async: false })
    : marked.parse(source, { async: false });
  sweep(template.content);
  if (!inline) wrapTables(template.content);
  return template.content;
}

/**
 * Every prose table gets the same scroller the rest of the client's tables have.
 *
 * `.md table` already asked to scroll itself — `display: block; width:
 * max-content; max-width: 100%; overflow-x: auto` — and it is the one table in
 * the client that still clipped: measured 275px inside a 266px help sheet, cut
 * at the card's `overflow-hidden` edge with no scrollbar anywhere to reach the
 * last column. A `max-width: 100%` on a `display: block` table depends on
 * every ancestor between it and the sheet resolving a definite width, and the
 * guide's cards are `<details>` inside a column flex inside a portal.
 *
 * A wrapper does not depend on any of that. A plain block div is as wide as the
 * box it is in, whatever produced that box, and the table overflows the div
 * rather than the card. It is exactly what `TableWrap` is, written for a table
 * that arrives as markdown at runtime and so has no render site to put one at.
 *
 * `role="group"` + `tabIndex` for the same reason `ChartNumbers` carries them:
 * a scrollable region a keyboard cannot enter is one nobody can read the end of.
 * And NAMED, for the other half of the reason `ChartNumbers` carries them: it
 * pairs the role with `aria-label={caption}`, and a table nobody can name is a
 * table nobody can find. Unnamed, a guide section with twenty tables was twenty
 * consecutive tab stops all announcing the bare word "group".
 */
function wrapTables(root: DocumentFragment | Element): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('md-tablewrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'md-tablewrap';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('aria-label', tableName(table));
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

/**
 * What to call one prose table.
 *
 * Its own column names first — they are what distinguishes twenty tables in one
 * section from each other, and they are the caption a markdown table never has.
 * The heading it sits under is the fallback, and the bare word is the last
 * resort, for a table with neither.
 */
function tableName(table: HTMLTableElement): string {
  const heads = Array.from(table.querySelectorAll('th'), (th) => th.textContent?.trim()).filter(Boolean);
  if (heads.length) return `Table: ${heads.join(', ')}`;
  for (let node = table.previousElementSibling; node; node = node.previousElementSibling) {
    if (/^H[1-6]$/.test(node.tagName)) {
      const heading = node.textContent?.trim();
      if (heading) return `Table under ${heading}`;
    }
  }
  return 'Table';
}

/* ---------------- the inline cache ---------------- */

/**
 * Inline markdown is parsed ONCE per distinct string, for the life of the page.
 *
 * `useMemo` keys on the component INSTANCE, so a board that mounts and unmounts
 * its rows — which is what virtualizing the departures board makes it do — paid
 * the whole cost again for every title it scrolled back to: `parseInline`, an
 * `innerHTML` write into a template, then a `querySelectorAll('*')` sweep of
 * every node and every attribute. Per row, per mount.
 *
 * The strings this runs on are titles and one-line goals: short, few, and the
 * same handful repeated across every surface that draws the same plan. So the
 * hit rate is near one and the parse is paid once per distinct title rather
 * than once per appearance of it.
 *
 * BLOCK markdown is deliberately NOT cached. Plan and handoff bodies are long,
 * effectively unique, and rendered one at a time behind a route — a cache of
 * them would be memory spent for a hit rate near zero. `Markdown` keeps its
 * per-instance `useMemo`, which is the right shape for that traffic.
 *
 * Bounded, and LRU by re-insertion: a `Map` iterates in insertion order, so
 * deleting and re-setting a hit moves it to the end and the first key the
 * iterator yields is the least recently used. An unbounded map here would be
 * the same defect this plan already fixed on the server twice — a console tab
 * is left open for days.
 */
const INLINE_CACHE_MAX = 256;
const inlineCache = new Map<string, DocumentFragment>();

/**
 * The parsed fragment for one inline string — cached, and never handed out.
 *
 * The caller MUST clone before consuming it: `replaceChildren` empties the
 * fragment it is given, so spending the cached one would blank every later
 * render of the same text. `useRendered` already clones for its own reasons
 * (see below) and that clone is now load-bearing for this too.
 */
function inlineFragment(text: string): DocumentFragment {
  const hit = inlineCache.get(text);
  if (hit) {
    inlineCache.delete(text);
    inlineCache.set(text, hit);
    return hit;
  }
  const fragment = toFragment(text, true);
  inlineCache.set(text, fragment);
  if (inlineCache.size > INLINE_CACHE_MAX) {
    const oldest = inlineCache.keys().next();
    if (!oldest.done) inlineCache.delete(oldest.value);
  }
  return fragment;
}

/** How many distinct inline strings are held — for the bound's own test. */
export function inlineCacheSize(): number {
  return inlineCache.size;
}

function useRendered(text: string | undefined, inline: boolean) {
  const ref = useRef<HTMLElement>(null);
  const fragment = useMemo(
    () => (text ? (inline ? inlineFragment(text) : toFragment(text, false)) : null),
    [text, inline],
  );

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!fragment) {
      node.replaceChildren();
      return;
    }
    // A fragment is emptied by the first `replaceChildren` that consumes it, so
    // the memoised one is cloned rather than spent — otherwise a re-render with
    // the same text (a theme flip, a parent state change) blanks the block. The
    // inline cache above shares ONE fragment between every mount of the same
    // string, so this clone is now what keeps the second row from blanking the
    // first as well.
    node.replaceChildren(fragment.cloneNode(true));
  }, [fragment]);

  return ref;
}

export interface MarkdownProps {
  text?: string;
  className?: string;
}

/** Block markdown — headings, lists, tables, fenced code. */
export function Markdown({ text, className }: MarkdownProps) {
  const ref = useRendered(text, false);
  if (!text) return null;
  return <div className={cn('md', className)} ref={ref as React.RefObject<HTMLDivElement>} />;
}

/**
 * Inline markdown (a table cell, a one-line goal) without block spacing.
 *
 * Memoised because both props are strings: on a board of thirty rows, a render
 * caused by one phase changing state re-rendered thirty of these, and each one
 * re-ran the effect that writes into the DOM. With `memo` the twenty-nine whose
 * title did not change do nothing at all — the cache above makes the parse
 * cheap, this makes it unnecessary.
 */
export const MarkdownInline = memo(function MarkdownInline({ text, className }: MarkdownProps) {
  const ref = useRendered(text, true);
  if (!text) return null;
  return <span className={cn('md-inline', className)} ref={ref as React.RefObject<HTMLSpanElement>} />;
});

/**
 * Markdown with the emphasis characters removed instead of interpreted — for the
 * places a goal or an exit criterion has to fit one line of a table cell, where
 * `**bold**` reads as literal asterisks and a real `<strong>` reads as shouting.
 *
 * It LIVES in `@/lib/plain-text` and is re-exported here so that every caller
 * that only wants text can import it without dragging `marked` into its chunk —
 * which is the whole Now page. Existing importers are unchanged.
 */
export { plainText } from '@/lib/plain-text';
