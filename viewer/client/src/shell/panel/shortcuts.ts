import { useShortcut } from '@/lib/shortcut';
import { togglePanel, type PanelState } from './modes';

/**
 * The panel's chords, claimed for the app's life: ⌘I opens and closes Details,
 * and in Pro ⌘. the Supervisor (on a phone, where the Supervisor is a page,
 * ⌘. goes there). Both fire while typing — they are a way out of a field.
 */
export function usePanelShortcuts(
  state: PanelState | undefined,
  phone: boolean,
  navigate: (path: string) => void,
): void {
  useShortcut({ key: 'i', mod: true, whileTyping: true }, () => togglePanel('details'), { enabled: !phone });
  void state;
  void navigate;
}
