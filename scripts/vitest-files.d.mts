export const testInclude: string[];
export function liveExclude(env: Record<string, string | undefined>): string[];
export function isLive(env: Record<string, string | undefined>): boolean;
export function isAiCheck(env: Record<string, string | undefined>): boolean;
