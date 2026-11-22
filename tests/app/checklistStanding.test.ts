import { describe, it, expect } from 'vitest';
import { initialState, itemStanding, type State } from '../../src/app/state';
import type { Finding, Tombstone } from '../../src/domain/model';
import type { ChecklistRow } from '../../src/ports';

const D = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const F = 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const finding = (patch: Partial<Finding> = {}): Finding => ({
  id: F, rev: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', dealId: D, title: 'Lock-up ratio differs', workstream: 'Legal',
  status: 'open', raisedAt: '2026-11-01T00:00:00.000Z', body: [], sources: [], origin: 'ai', note: '', reviewed: null,
    updated: false, updatedWhy: '', ...patch,
} as unknown as Finding);
const row = (patch: Partial<ChecklistRow> = {}): ChecklistRow => ({ id: 'i1', text: 'Lock-up ratio matches the term sheet', result: 'finding', findingId: F, docs: [], ...patch });
const state = (patch: Partial<State> = {}): State => ({ ...initialState(), dealLoad: { [D]: 'loaded' }, ...patch });

describe('a checklist item whose check raised a finding stands as that finding stands (linking design, sections 10 and 12)', () => {
  it('stays Flagged while the finding is open', () => {
    expect(itemStanding(state({ findings: { [F]: finding() } }), D, row()).kind).toBe('finding');
  });
  it('is Resolved by a person once a person closes the finding', () => {
    const s = state({ findings: { [F]: finding({ status: 'closed' }) } });
    expect(itemStanding(s, D, row())).toMatchObject({ kind: 'person', finding: { id: F } });
  });
  it('is Finding deleted once the finding is deleted, and names the deleted finding so it can be restored', () => {
    const gone = {
      kind: 'finding',
      dealId: D,
      id: F,
      title: 'Lock-up ratio differs',
      at: '2026-11-02T00:00:00.000Z',
      actor: 'adoe',
      snapshot: finding(),
    } as Tombstone;
    expect(itemStanding(state({ tombstones: { [F]: gone } }), D, row())).toEqual({ kind: 'gone', gone });
  });
  it('stays Flagged while the finding has two versions, whatever either says, and names them', () => {
    const versions = { kind: 'finding' as const, id: F, dealId: D, versions: [] };
    expect(itemStanding(state({ findings: { [F]: finding({ status: 'closed' }) }, conflicts: { [F]: versions } }), D, row())).toMatchObject({ kind: 'finding', versions });
    expect(itemStanding(state({ conflicts: { [F]: versions } }), D, row())).toMatchObject({ kind: 'finding', versions });   // one version is a delete
  });
  it('stays as the check left it until the deal’s records are loaded, or when the finding cannot be found at all', () => {
    expect(itemStanding(state({ dealLoad: {}, findings: { [F]: finding({ status: 'closed' }) } }), D, row()).kind).toBe('finding');
    expect(itemStanding(state(), D, row()).kind).toBe('finding');
    expect(itemStanding(state(), D, row({ findingId: undefined })).kind).toBe('finding');
  });
  it('groups the other results as before: gaps, satisfied, and both kinds of not settled', () => {
    expect(['gap', 'satisfied', 'unsettled', 'unchecked'].map((result) => itemStanding(state(), D, row({ result: result as ChecklistRow['result'], findingId: undefined })).kind)).toEqual(['gap', 'satisfied', 'open', 'open']);
  });
});
