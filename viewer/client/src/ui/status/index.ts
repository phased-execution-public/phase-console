/**
 * The typed status family (7.0, quiet-console phase 1) — deliberately NOT in
 * the `@/ui` barrel, which is one modulepreloaded chunk every visitor downloads
 * before the first frame. Import it as `@/ui/status`.
 *
 * Every member draws a `StatusView` from `shared/status-model.js` through one
 * renderer, `DotWord`: a 6 px dot in the hue, a precise word in ink,
 * `data-status` / `data-paint` / `data-attention`. Each accepts only its own
 * vocabulary — a QA word handed to `RunStatus` is a type error. A settled thing
 * wears a hollow dot and goes quiet; a summons paints its word too.
 */
export { AccountStatus, type AccountStatusProps } from './account';
export { AttentionMark } from './attention';
export { CountBadge } from './count';
export { DotWord, FactPart } from './dot-word';
export { FactMark } from './fact';
export { McpStatus } from './mcp';
export { OpsStatus, type OpsVocab } from './ops';
export { PhaseStatus, type PhaseStatusProps } from './phase';
export { PlanStatus } from './plan';
export { QaStatus, type QaStatusProps } from './qa';
export { RunStatus, type RunStatusProps } from './run';
export { PhaseShare, PlanProgress, shareName, sharePaint, type ShareWord } from './share';
export { SeverityMark } from './severity';
export { SessionStatus, type SessionVocab } from './session';
export { TurnReadiness, TurnStatus } from './turn';
export { NOTE_ICONS, STATUS_ICONS, statusIcon } from './status-icons';
export { isQuiet, viewHeadline, viewTitle, type Chrome, type WordOf } from './view';
