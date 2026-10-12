/**
 * Markdown with the emphasis characters removed instead of interpreted.
 *
 * ## Why this is a module of its own
 *
 * It lived in `components/markdown.tsx`, which imports `marked` — a parser that
 * renders nothing for the callers that only want one line of text. Now was the
 * home page and the first chunk a phone downloaded, and every surface on it
 * needed a plan title as text: a strip heading, a lane subtitle, a next-up row,
 * an inbox row's plan name. Not one of them rendered markup.
 *
 * So the function that does not need the parser stopped living in the file that
 * has one. `ui/markdown.tsx` re-exports it, so a caller may take it from either
 * and there is still exactly one implementation.
 *
 * The rule it encodes: where a goal or a title has to fit one line of a row,
 * `**bold**` reads as literal asterisks and a real `<strong>` reads as
 * shouting. Strip them and collapse the whitespace.
 */
export function plainText(markdown: string | undefined): string {
  return (markdown ?? '').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
}
