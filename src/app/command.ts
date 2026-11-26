/**
 * A command is a named, schema-validated, pure plan. The executor (store.ts)
 * turns a plan into one repository transaction and applies it to state only
 * after the repository accepted it.
 */
import type { z } from 'zod';
import type { State } from './state';
import type { Result } from '../domain/result';
import type { RecordKind, AuditKind } from '../domain/model';
import type { Seen, Services } from '../ports';
import type { Store } from './store';

export interface PlanCtx { at: string; actor: string; firm: string; opId: string; ids: { next(prefix: 'd' | 'q' | 'f' | 'doc' | 'op'): string } }

/** Work that needs a service after the plan committed (an AI call, say). It returns the follow-up command to dispatch, or null. Never touches state itself. */
export type Effect = (services: Services, ctx: { opId: string }) => Promise<{ command: string; input: unknown } | null>;

/** expectedRev: the rev the plan read (optimistic check); null means the record must not exist yet */
export interface Upsert { kind: RecordKind; record: { id: string } & Record<string, unknown>; expectedRev: number | null | 'any'; /** version ids this write replaces: a person chose between them */ resolves?: string[]; /** see Write.beside */ beside?: boolean }
/** rev null = delete without an optimistic check (tombstones) */
/** `resolves`: a person chose the deleted version of a record that had two (see Delete.resolves) */
/** `undoesImport`: takes back a question an import made (see Delete in the ports) */
export interface Remove { kind: RecordKind; id: string; rev: number | null; resolves?: string[]; undoesImport?: true }

export interface AuditDraft { kind: AuditKind; recordId: string; dealId: string; field?: string; from?: unknown; to?: unknown; text?: string; ref?: { questionId?: string; findingId?: string; doc?: string }; undoes?: string }

export interface Plan {
  dealId?: string;
  upserts: Upsert[];
  removes?: Remove[];
  /** remove everything filed under this deal (see Transaction.purgeDeal) */
  purgeDeal?: string;
  /** with `purgeDeal`: what this PC had taken in when the person began deleting (see Transaction.seen) */
  seen?: Seen;
  /** index membership changes for records filed under a deal; see Transaction.index.
   * `remove` accompanies deletion and takes nothing off by itself.
   */
  index?: { dealId: string; add?: { kind: RecordKind; id: string }[]; remove?: { kind: RecordKind; id: string }[] };
  /** records the plan read but does not write: refused at commit if one changed (see Transaction.expects) */
  expects?: { kind: RecordKind; id: string; rev: number }[];
  /** the records of a kind under a deal that the plan read: refused at commit if the set changed
   * (see Transaction.expectsMembers)
   */
  expectsMembers?: { dealId: string; kind: RecordKind; ids: string[] };
  audit: AuditDraft[];
  /** Undo of a choice between versions: they stand again, unchosen (see Transaction.reopen) */
  reopen?: { kind: RecordKind; id: string; versions: { id: string; by: string; from: string; at: string; data: unknown; here?: boolean }[] }[];
  /** the command that reverses this one, as data */
  inverse?: { command: string; input: unknown };
  /** what the journal keeps of the input once the action is done, when the input is large and nothing reads it after (an import's rows) */
  settledInput?: unknown;
  /** the inverse takes back, record by record, only what is still as this left it, so a change since to one record does not refuse the whole Undo */
  undoesSafely?: true;
  /** short confirmation for the toast; undo is offered when `inverse` exists */
  message?: string;
  /** the part of the message that gives way when the notice is short of room, such as a long deal name (#27) */
  messageCut?: string;
  /** Show success even if the caller handles refusals, or if the person must still be offered Undo. */
  alwaysSay?: boolean;
  /** runs after commit; its follow-up command is dispatched quietly */
  effect?: Effect;
  /** Folder paths to index on the PC that requested this change, once the deal write has committed. */
  indexFolders?: string[];
}

export interface Command<I = unknown, In = I> {
  name: string;
  input: z.ZodType<I, In>;
  /** records this command will write; used to sequence operations per record */
  targets(state: State, input: I): string[];
  /** Load inputs that must be current immediately before planning, once the target queue drains. */
  prepare?(store: Pick<Store, 'get' | 'refreshChecklist'>, input: I, context: { retained: boolean }): Promise<void>;
  plan(state: State, input: I, ctx: PlanCtx): Result<Plan>;
}

export const define = <I, In>(c: Command<I, In>): Command<I, In> => c;
