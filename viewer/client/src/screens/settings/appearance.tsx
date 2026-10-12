/**
 * Settings ▸ Appearance (7.0, quiet-console phase 21).
 *
 * Two homes for a preference, said on the page because they behave
 * differently. THIS BROWSER keeps the theme, the density, the plan list's
 * documents and the terminal's two switches (`lib/prefs.ts`): two people
 * watching one console from two devices each keep their own. EVERY DEVICE —
 * the server's person-wide keys (`config.json`) — keeps the plans library's
 * order and the model a session plan is sized for, so a phone opens the
 * library the way the desk left it.
 */

import { DENSITIES } from '@shared/prefs-model.js';
import { useConsoleState } from '@/data/console';
import { usePrefs, type Density } from '@/lib/prefs';
import { offeredModelOptions } from '@/screens/launch/model/defaults';
import { SORTS } from '@/screens/plans/model';
import { ThemeSwitch } from '@/shell/theme-switch';
import { Button, ButtonGroup } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { SettingRow, SettingsGroup, WordSetting, useSetting } from './setting';

const DENSITY_WORDS: Readonly<Record<Density, string>> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
};

function DensitySwitch() {
  const [prefs, setPrefs] = usePrefs();
  return (
    <ButtonGroup aria-label="Density">
      {DENSITIES.map((density) => (
        <Button
          key={density}
          size="sm"
          variant="ghost"
          aria-pressed={prefs.density === density}
          onClick={() => setPrefs({ density })}
        >
          {DENSITY_WORDS[density]}
        </Button>
      ))}
    </ButtonGroup>
  );
}

/** A switch this browser keeps — the checkbox before its name, as every boolean in Settings. */
function BrowserToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="tap-row flex min-w-0 items-start gap-2.5 text-body">
      <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="min-w-0 break-words text-ink">{label}</span>
        <span className="max-w-(--measure) break-words text-meta text-ink-muted">{hint}</span>
      </span>
    </label>
  );
}

export function AppearanceSection() {
  const [prefs, setPrefs] = usePrefs();
  const { data: state } = useConsoleState();
  const model = useSetting<string>('model');
  const stored = typeof model.value === 'string' ? model.value : '';

  return (
    <>
      <SettingsGroup
        id="appearance-browser"
        title="This browser"
        lead="Kept in this browser only, so two people watching one console each keep their own."
      >
        <SettingRow label="Theme" hint="Auto follows the device's own light or dark setting.">
          <ThemeSwitch />
        </SettingRow>
        <SettingRow
          label="Density"
          hint="Compact tightens the padding by about a fifth. Type and tap sizes stay."
        >
          <DensitySwitch />
        </SettingRow>
        <BrowserToggle
          label="Show documents in the plan list"
          hint="Handoff folders with no plan file, and the loose documents beside them."
          checked={prefs.showDocuments}
          onChange={(showDocuments) => setPrefs({ showDocuments })}
        />
      </SettingsGroup>

      <SettingsGroup
        id="appearance-terminal"
        title="The terminal"
        lead="Kept in this browser. The font size is on the session itself, beside its key bar."
      >
        <BrowserToggle
          label="WebGL renderer"
          hint="Faster on a real retina screen. Off by default: under a headless browser it painted nothing at a high pixel ratio. Turn it off again if a session's pane goes blank."
          checked={prefs.terminalWebgl}
          onChange={(terminalWebgl) => setPrefs({ terminalWebgl })}
        />
        <BrowserToggle
          label="Screen reader mode"
          hint="Gives the terminal an accessibility tree, a live region per row. Turn it on when a screen reader is in use: on a busy session it is not free."
          checked={prefs.terminalScreenReader}
          onChange={(terminalScreenReader) => setPrefs({ terminalScreenReader })}
        />
      </SettingsGroup>

      <SettingsGroup
        id="appearance-person"
        title="Every device"
        lead="Kept on the server for you, so every browser and every console of yours opens the same way."
      >
        <WordSetting
          pref="sort"
          label="Plans library order"
          hint="How the plans library orders the plans when you open it. Changing it there changes it here."
          options={SORTS.map((sort) => [sort.id, sort.label] as const)}
        />
        <WordSetting
          pref="model"
          label="Session plan model"
          hint="Whose budget a plan's session plan is sized for, until you pick another on the plan."
          options={offeredModelOptions(state?.models, stored).map(
            (id) => [id, id || 'Each plan’s own target model'] as const,
          )}
        />
      </SettingsGroup>
    </>
  );
}
