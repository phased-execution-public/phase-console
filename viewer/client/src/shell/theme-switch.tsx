import { THEMES } from '@shared/prefs-model.js';
import { Button, ButtonGroup } from '@/ui';
import { usePrefs, type Theme } from '@/lib/prefs';

/**
 * Auto · Night · Paper — the console's one theme control.
 *
 * Not in the header any more (7.0): theme and density live in Settings ▸
 * Appearance and in the palette, and this is the control both draw. The names
 * are deliberate: "Auto" says the choice is being made for you, and "Night"
 * and "Paper" name what the screen looks like rather than what a setting is
 * called. The words themselves are the owner's (`shared/prefs-model.js`
 * `THEMES`); only their names and their order are this control's.
 */
const THEME_WORDS: Readonly<Record<Theme, { label: string; rank: number }>> = {
  system: { label: 'Auto', rank: 0 },
  dark: { label: 'Night', rank: 1 },
  light: { label: 'Paper', rank: 2 },
};

const THEME_CHOICES: readonly Theme[] = [...THEMES].sort((a, b) => THEME_WORDS[a].rank - THEME_WORDS[b].rank);

/** A theme's name as the console says it. */
export const themeLabel = (theme: Theme): string => THEME_WORDS[theme].label;

export function ThemeSwitch({ className }: { className?: string }) {
  const [prefs, setPrefs] = usePrefs();
  return (
    <ButtonGroup aria-label="Theme" className={className}>
      {THEME_CHOICES.map((value) => (
        <Button
          key={value}
          size="sm"
          variant="ghost"
          aria-pressed={prefs.theme === value}
          onClick={() => setPrefs({ theme: value })}
        >
          {THEME_WORDS[value].label}
        </Button>
      ))}
    </ButtonGroup>
  );
}
