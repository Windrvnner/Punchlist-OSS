export const SUITE_TIMES: string;
export function measuredTimes(
  entries: { name: string; passed: number; total: number; secs: number; rerun?: boolean }[] | undefined,
): Record<string, number>;
export function ciScale(kept: Record<string, number>, measured: Record<string, number>): number;
export function updatedTimes(
  kept: Record<string, number>, measured: Record<string, number>, suites: string[],
): { times: Record<string, number>; scale: number };
