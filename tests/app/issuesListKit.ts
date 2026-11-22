import type { z } from 'zod';
import { CreateFinding } from '../../src/app/commands/findings';
import { FIRM } from '../../src/app/state';
import type { Store } from '../../src/app/store';

export function issuesListClock() {
  const clock = {
    tick: 0,
    now: (): string => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, clock.tick++)).toISOString(),
  };
  return clock;
}

type FindingInput = z.input<typeof CreateFinding.input>;

export function planIssuesListSeed(
  store: Store, dealId: string, clock: ReturnType<typeof issuesListClock>, inputs: FindingInput[],
) {
  const actor = store.get().user?.name ?? 'Unknown';
  const { ids } = store.services;
  // Match the original command cadence so imported findings still interleave with the same seeds.
  const firstTick = clock.tick;
  const ticksPerFinding = 7;
  const plans = inputs.map((input, index) => {
    clock.tick = firstTick + index * ticksPerFinding;
    const at = clock.now();
    const opId = ids.next('op');
    const parsed = CreateFinding.input.parse(input);
    const planned = CreateFinding.plan(store.get(), parsed, { at, actor, firm: FIRM, opId, ids });
    if (!planned.ok) throw new Error(planned.error.message);
    return { plan: planned.value, at, opId };
  });
  const bulkTicksToImportPlan = 3;
  clock.tick += ticksPerFinding - bulkTicksToImportPlan;
  return {
    actor,
    plans,
    writes: plans.flatMap(({ plan }) => plan.upserts.map(({ kind, record, expectedRev }) =>
      ({ kind, id: record.id, data: record, expectedRev }))),
    index: { dealId, add: plans.flatMap(({ plan }) => plan.index?.add ?? []) },
  };
}
