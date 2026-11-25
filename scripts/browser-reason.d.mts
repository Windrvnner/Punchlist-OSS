export function summaryOf(out: string): { passed: number; total: number; valid: boolean };
export function noResultReason(code: number | null, signal: string | null, out: string, serverUp: boolean): string;
export function rerunWarnings(names: string[], onGitHub: boolean): string[];
