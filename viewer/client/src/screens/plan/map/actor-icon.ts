/**
 * The lucide icon each phase-driving vehicle wears on the map's driver chip —
 * the sessions page's own vocabulary for the same three vehicles: Cpu is an
 * autopilot lane, Bot a console agent, TerminalSquare someone's own CLI. The
 * words beside them are the shared ones (`PHASE_ACTOR_LABELS`).
 *
 * Its own module rather than an export of `dag.tsx`, so a page that wants the
 * three glyphs does not pull the whole SVG map in.
 */
import { Bot, Cpu, TerminalSquare } from 'lucide-react';
import type { PhaseActor } from '@/data/api';

export const ACTOR_ICON: Readonly<Record<PhaseActor, typeof Cpu>> = {
  autopilot: Cpu,
  agent: Bot,
  external: TerminalSquare,
};
