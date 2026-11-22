/** A typed outcome. Ports and commands return these instead of throwing. */
export type Failure =
  | { kind: 'invalid'; message: string; fields?: Record<string, string> }
  | { kind: 'conflict'; message: string; recordId?: string; expected?: number; actual?: number }
  | { kind: 'notFound'; message: string; recordId?: string }
  | { kind: 'rejected'; message: string } // a business rule said no
  | { kind: 'storageFull'; message: string }
  | { kind: 'unreachable'; message: string }
  | { kind: 'failed'; message: string }; // service failed for this one call

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: Failure): Result<T> => ({ ok: false, error });
export const invalid = (message: string, fields?: Record<string, string>): Failure => ({ kind: 'invalid', message, fields });
export const rejected = (message: string): Failure => ({ kind: 'rejected', message });
export const notFound = (message: string, recordId?: string): Failure => ({ kind: 'notFound', message, recordId });
