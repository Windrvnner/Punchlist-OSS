// @vitest-environment node
// Editing the control file's `limits.askedCutoff` changes which points are checked by the model (#1218).
import { expect, it, vi } from 'vitest';
import { askedCandidates } from '../../src/app/unresolvedLinks';

const mutable = vi.hoisted(() => ({ cutoff: 80 }));
vi.mock('../../src/control', async (original) => {
  const actual = await original<typeof import('../../src/control')>();
  const limits = { ...actual.control.limits, get askedCutoff() { return mutable.cutoff; } };
  return { ...actual, control: { ...actual.control, limits } };
});

const point = {
  key: 'i:a', kind: 'gap' as const, itemId: 'i_a', what: 'Insurance advisor report (final)', need: '', workstream: '',
};
const pool = [{ id: 'q1', n: 1, text: 'Please send the insurance advisor report.' }] as never[];   // names 75 percent

it('uses the control value when no cutoff is given', () => {
  mutable.cutoff = 80;
  expect(askedCandidates([point], pool).candidates).toEqual([]);
  mutable.cutoff = 75;
  expect(askedCandidates([point], pool).candidates).toHaveLength(1);
  mutable.cutoff = 76;
  expect(askedCandidates([point], pool).candidates).toEqual([]);
});
