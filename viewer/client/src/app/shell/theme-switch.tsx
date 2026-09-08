import { usePrefs, type Theme } from '@/lib/prefs';
import { Button, ButtonGroup } from '@/components/ui';

/**
 * Auto · Night · Paper — the console's one theme control.
 *
 * It was written twice, verbatim, in the two places a phone and a desktop each
 * reach for it (`header.tsx` on a wide screen, `more-sheet.tsx` on a narrow
 * one), THEMES list included. Two copies of a three-word vocabulary is two
 * chances for a fourth theme to appear in one of them.
 *
 * The names are deliberate and not the usual System/Dark/Light: "Auto" says
 * the choice is being made for you, and "Night" and "Paper" name what the
 * screen looks like rather than what a setting is called.
 */
const THEMES: readonly [Theme, string][] = [
  ['system', 'Auto'],
  ['dark', 'Night'],
  ['light', 'Paper'],
];

export function ThemeSwitch({ className }: { className?: string }) {
  const [prefs, setPrefs] = usePrefs();
  return (
    <ButtonGroup aria-label="Theme" className={className}>
      {THEMES.map(([value, label]) => (
        <Button
          key={value}
          size="sm"
          variant="ghost"
          aria-pressed={prefs.theme === value}
          onClick={() => setPrefs({ theme: value })}
        >
          {label}
        </Button>
      ))}
    </ButtonGroup>
  );
}
