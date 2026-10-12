/**
 * The inspector's Raw tab: the record as the machine holds it, as mono text —
 * design.md principle 5's one use of the mono face for a whole block. Nothing
 * is removed (the third door to depth is "every datum within two
 * interactions"), so a long record is long.
 */
export function RawTab({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="min-w-0 overflow-x-auto font-mono text-meta leading-relaxed whitespace-pre-wrap break-words text-ink-muted">
      {text}
    </pre>
  );
}
