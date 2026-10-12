import { SEVERITY_UI } from '@shared/attention-model.js';
import { ATTENTION_META, type AttentionLevel, type StatusView } from '@shared/status-model.js';
import type { UiState } from '@shared/status-vocab.js';
import { DotWord } from './dot-word';
import type { Chrome } from './view';

/**
 * Does a person have to act — the attention axis on its own, for a row whose
 * status says what it is and needs this said beside it. Painted through the
 * inbox's own `SEVERITY_UI`, so a mark and the inbox row it stands for are one
 * colour. `none` draws nothing: an absence of attention is not a datum worth a
 * mark.
 */
export function AttentionMark({
  level,
  ...chrome
}: { level: AttentionLevel } & Omit<Chrome, 'live' | 'withNote'>) {
  if (level === 'none') return null;
  const meta = ATTENTION_META[level];
  const view: StatusView = {
    vocab: 'attention',
    word: level,
    known: true,
    label: meta.label,
    icon: meta.icon,
    paint: SEVERITY_UI[level] as UiState,
    tense: 'standing',
    attention: level,
  };
  return <DotWord view={view} {...chrome} />;
}
