/**
 * The lucide icon each phase-driving vehicle wears — one table, shared by the
 * route map's driver chips and the run page's actor line, and deliberately the
 * sessions page's own `KIND_ICON` vocabulary (Cpu = autopilot lane, Bot =
 * console agent, TerminalSquare = someone's own CLI).
 *
 * Its own module rather than an export of `dag.tsx` so the runs chunk does not
 * pull the whole SVG map in for three glyphs.
 */
import { Bot, Cpu, TerminalSquare } from 'lucide-react';
import type { PhaseActor } from '@/lib/api';

export const ACTOR_ICON: Record<PhaseActor, typeof Cpu> = {
  autopilot: Cpu,
  agent: Bot,
  external: TerminalSquare,
};
