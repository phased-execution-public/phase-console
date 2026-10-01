/**
 * The typed status badge family (control-tower phase 16) — deliberately NOT in
 * the `@/components/ui` barrel, which is one modulepreloaded chunk every visitor
 * downloads before the first frame. Import it as `@/components/ui/status`.
 *
 * Every member draws a `StatusView` from `shared/status-model.js` through one
 * renderer: an icon, a precise word, `data-status` / `data-paint` /
 * `data-attention`, and a paint from the eight hues. Each accepts only its own
 * vocabulary — a QA word handed to `RunStatusBadge` is a type error.
 */
export { AccountBadge, type AccountBadgeProps } from './account-badge';
export { AttentionMark } from './attention-mark';
export { FactBadge } from './fact-badge';
export { McpBadge } from './mcp-badge';
export { OpsBadge, type OpsVocab } from './ops-badge';
export { PhaseStatusBadge, type PhaseStatusBadgeProps } from './phase-status-badge';
export { PlanStatusBadge } from './plan-status-badge';
export { QaBadge, type QaBadgeProps } from './qa-badge';
export { RunStatusBadge, type RunStatusBadgeProps } from './run-status-badge';
export { SeverityBadge } from './severity-badge';
export { NOTE_ICONS, STATUS_ICONS, statusIcon } from './status-icons';
export { FactPart, ViewBadge, viewTitle, type BadgeChrome, type WordOf } from './view-badge';
