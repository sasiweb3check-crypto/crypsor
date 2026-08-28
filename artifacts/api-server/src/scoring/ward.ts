/**
 * Compatibility surface for routes / UI that still import from scoring/ward.
 * Live decisions live in scoring/omo.ts (omotrades gate).
 */
export {
  PHASES,
  type Phase,
  type TapeWindow,
  type Call,
  type Decision,
  type Check,
  type AuditRule,
  emptyTape,
  decide,
  nextPhase,
  prognosis,
  failsOf,
  callOf,
  tapeLead,
  money,
} from "./omo";

export type Factor = {
  id: string;
  label: string;
  points: number;
  max: number;
  hold: boolean | null;
  reason: string;
};

export type Verdict = {
  score: number;
  factors: Factor[];
  holds: string[];
  fails: string[];
  unknowns: string[];
  tapeLead: "buyers" | "sellers" | "two_sided" | "unknown";
  chase: boolean;
  dead: boolean;
  tradeOk: boolean;
};

const DEFAULT_WEIGHTS: Record<string, number> = {
  tape: 1, liquidity: 1, holders: 1, structure: 1, conviction: 1, timing: 1,
};
let weights = { ...DEFAULT_WEIGHTS };

export function getWeights(): Record<string, number> {
  return { ...weights };
}
export function setWeights(next: Record<string, number>): void {
  weights = { ...DEFAULT_WEIGHTS, ...next };
}
export function resetWeights(): void {
  weights = { ...DEFAULT_WEIGHTS };
}
