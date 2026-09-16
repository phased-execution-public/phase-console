/**
 * The flags a shell script implements, read from its `--flag)` / `--a|--b)`
 * case arms. ONE reader for the two suites that couple a document to the
 * scripts' actual surface — `docs-parity` (SKILL.md ↔ every helper script)
 * and `agent` (the plan wizard's questions ↔ `phase-graph.sh`'s plan-field
 * flags) — because two regexes that agree today are two that disagree the
 * day a script gains an arm shaped like `--a|--b|--c)`.
 */
export const scriptFlags = (src: string): Set<string> => {
  const out = new Set<string>();
  for (const m of src.matchAll(/^[ \t]*((?:--[a-z][a-z0-9-]*\|)*--[a-z][a-z0-9-]*)\)/gm)) {
    for (const flag of m[1].split('|')) out.add(flag);
  }
  return out;
};
