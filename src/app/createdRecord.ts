import { CreateDeal } from './commands/deals';
import { CreateFinding } from './commands/findings';
import { CreateQuestion } from './commands/questions';
import type { State } from './state';

const CREATE_COMMAND = { deals: CreateDeal.name, findings: CreateFinding.name, questions: CreateQuestion.name };

/** Resolve the live record made by this operation, even when its wording is shared by another record. */
export function createdRecord<Bucket extends keyof typeof CREATE_COMMAND>(
  state: State, opId: string, bucket: Bucket,
): State[Bucket][string] | undefined {
  const operation = state.ops[opId];
  if (operation?.state !== 'succeeded' || operation.command !== CREATE_COMMAND[bucket]) return undefined;
  const written = operation.resultRevs ? Object.keys(operation.resultRevs) : operation.targets;
  const records = state[bucket] as Record<string, State[Bucket][string]>;
  const id = written.find((target) => records[target]);
  return id ? records[id] : undefined;
}
