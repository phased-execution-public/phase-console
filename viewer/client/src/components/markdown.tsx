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
import { copy } from '@/components/ui/toast';

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

/** Which way a text reads — the content's own, never the page's guess (control-tower phase 137). */
export type TextDirection = 'ltr' | 'rtl';

/**
 * Parse markdown to an inert, swept DocumentFragment.
 *
 * After the sweep — so nothing in the content can supply one of its own —
 * every `code` and `pre` reads left-to-right whatever surrounds it (a command
 * is a command in any language), each fenced block gets its copy button, and
 * a right-to-left text has its left-to-right runs isolated (`isolateRuns`).
 */
export function toFragment(markdown: string, inline = false, dir?: TextDirection): DocumentFragment {
  const template = document.createElement('template');
  const source = String(markdown);
  // `async: false` is what narrows marked's return type to a string; the option
  // is already the default, so this changes nothing but the types.
  template.innerHTML = inline
    ? marked.parseInline(source, { async: false })
    : marked.parse(source, { async: false });
  sweep(template.content);
  for (const code of template.content.querySelectorAll('code, pre')) code.setAttribute('dir', 'ltr');
  if (!inline) wrapTables(template.content);
  if (!inline) addCopyButtons(template.content);
  if (dir === 'rtl') isolateRuns(template.content);
  return template.content;
}

/** The attribute this module's own copy buttons carry — the click is read off it. */
const COPY_MARK = 'data-md-copy';

/**
 * A copy button on every fenced block (control-tower phase 137, #214): a guide
 * a person follows is mostly commands, and selecting a block by hand on a
 * phone is the step that goes wrong. Built HERE, after `sweep` — a `<button>`
 * in the content is still removed — and pressed through one listener on the
 * block (`useCopyButtons`), which copies the block's own text and never runs it.
 */
function addCopyButtons(root: DocumentFragment): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.parentElement?.classList.contains('md-code')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'md-code';
    pre.replaceWith(wrap);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-copy';
    button.setAttribute(COPY_MARK, '');
    button.textContent = 'Copy';
    wrap.append(pre, button);
  }
}

/**
 * A run of left-to-right characters — printable ASCII words and the spaces
 * BETWEEN them, as ONE run: isolated word by word, a right-to-left paragraph
 * would lay "gh auth status" out as "status auth gh".
 */
const LTR_RUN = /[\x21-\x7e]+(?:[ \t]+[\x21-\x7e]+)*/g;

/**
 * Isolate every left-to-right run of a right-to-left text in a `<bdi
 * dir="ltr">` — a ref (`github.com/login/device`), a number, a flag — so the
 * bidi algorithm cannot reorder its neutral characters against the words
 * around it. A command is already isolated (`code`, `pre`), and so is a link.
 */
function isolateRuns(root: DocumentFragment | Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node.parentElement as Element | null)?.closest('code, pre, bdi, a')) continue;
    texts.push(node as Text);
  }
  for (const text of texts) {
    const value = text.data;
    LTR_RUN.lastIndex = 0;
    if (!LTR_RUN.test(value)) continue;
    LTR_RUN.lastIndex = 0;
    const parts: Node[] = [];
    let at = 0;
    for (let match = LTR_RUN.exec(value); match; match = LTR_RUN.exec(value)) {
      // Punctuation alone (a sentence's full stop) is the paragraph's own: the
      // bidi algorithm already puts it where a right-to-left reader expects it.
      if (!/[A-Za-z0-9]/.test(match[0])) continue;
      if (match.index > at) parts.push(document.createTextNode(value.slice(at, match.index)));
      const bdi = document.createElement('bdi');
      bdi.setAttribute('dir', 'ltr');
      bdi.textContent = match[0];
      parts.push(bdi);
      at = match.index + match[0].length;
    }
    if (at < value.length) parts.push(document.createTextNode(value.slice(at)));
    text.replaceWith(...parts);
  }
}

/** What a block's copy button copies: the block's text, without the newline marked closes it with. */
function blockText(button: Element): string {
  return (button.parentElement?.querySelector('pre')?.textContent ?? '').replace(/\s+$/, '');
}

/**
 * The one listener a block's copy buttons are pressed through. A listener on
 * the block rather than a React handler, because the buttons are not React's:
 * `replaceChildren` puts them there.
 */
function useCopyButtons(ref: React.RefObject<HTMLElement | null>, mounted: boolean): void {
  useEffect(() => {
    const node = ref.current;
    if (!mounted || !node) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onClick = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest?.(`button[${COPY_MARK}]`);
      if (!button || !node.contains(button)) return;
      void copy(blockText(button), 'Copied').then((ok) => {
        if (!ok) return;
        button.textContent = 'Copied';
        const timer = setTimeout(() => {
          button.textContent = 'Copy';
          timers.delete(timer);
        }, 1400);
        timers.add(timer);
      });
    };
    node.addEventListener('click', onClick);
    return () => {
      node.removeEventListener('click', onClick);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [ref, mounted]);
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
function inlineFragment(text: string, dir?: TextDirection): DocumentFragment {
  // The direction is part of the key: a right-to-left text is drawn with its
  // runs isolated, and the same words left-to-right are not.
  const key = dir === 'rtl' ? `rtl\u0000${text}` : text;
  const hit = inlineCache.get(key);
  if (hit) {
    inlineCache.delete(key);
    inlineCache.set(key, hit);
    return hit;
  }
  const fragment = toFragment(text, true, dir);
  inlineCache.set(key, fragment);
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

function useRendered(text: string | undefined, inline: boolean, dir?: TextDirection) {
  const ref = useRef<HTMLElement>(null);
  const fragment = useMemo(
    () => (text ? (inline ? inlineFragment(text, dir) : toFragment(text, false, dir)) : null),
    [text, inline, dir],
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
  /**
   * The CONTENT's language and the direction it reads in (control-tower phase
   * 137) — a guide carries both, the grammar having taken the direction from
   * the language (`shared/guide-grammar.js` `guideDirection`). Absent, the text
   * reads in the page's; the chrome stays English either way.
   */
  lang?: string;
  dir?: TextDirection;
}

/** Block markdown — headings, lists, tables, fenced code, each block with its copy button. */
export function Markdown({ text, className, lang, dir }: MarkdownProps) {
  const ref = useRendered(text, false, dir);
  useCopyButtons(ref, Boolean(text));
  if (!text) return null;
  return (
    <div className={cn('md', className)} lang={lang} dir={dir} ref={ref as React.RefObject<HTMLDivElement>} />
  );
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
export const MarkdownInline = memo(function MarkdownInline({ text, className, lang, dir }: MarkdownProps) {
  const ref = useRendered(text, true, dir);
  if (!text) return null;
  return (
    <span
      className={cn('md-inline', className)}
      lang={lang}
      dir={dir}
      ref={ref as React.RefObject<HTMLSpanElement>}
    />
  );
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
