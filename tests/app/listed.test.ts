import { describe, it, expect } from 'vitest';
import { initialState, listedFindings, findingListed, workstreamHead, type State } from '../../src/app/state';
import '../ui/keptTextSession';
import { markText } from '../../src/ui/findings';
import { findingRowsFor } from '../../src/app/transfer';
import type { Finding } from '../../src/domain/model';

const D = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const f = (n: number, patch: Partial<Finding> = {}): Finding => ({
  id: `f_${n}`, rev: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', dealId: D, title: `Finding ${n}`, workstream: 'Legal',
  status: 'open', raisedAt: `2026-11-0${n}T00:00:00.000Z`, body: [], sources: [], origin: 'ai', updated: false,
    updatedWhy: '', ...patch,
} as unknown as Finding);
const state = (list: Finding[]): State => ({ ...initialState(), findings: Object.fromEntries(list.map((x) => [x.id, x])) });
const FF = (patch: Partial<State['ui']['findingFilter']> = {}) => ({
  status: 'all' as const, workstream: '', reviewed: '' as const, ...patch,
});

describe('the reason on a marked finding names the questions it came from by the numbers they have now', () => {
  it('follows a question that is renumbered, leaves out one that has been deleted, and falls back to the words as first written', () => {
    const m = f(1, { updated: true, updatedWhy: 'Response received on Q12, Q14', updatedOn: { questions: ['q_a', 'q_b'] } } as Partial<Finding>);
    expect(markText(m, { q_a: { n: 12 }, q_b: { n: 14 } })).toBe('May be out of date · Response received on Q12, Q14');
    expect(markText(m, { q_a: { n: 13 }, q_b: { n: 14 } })).toBe('May be out of date · Response received on Q13, Q14');   // Q12 was made Q13
    expect(markText(m, { q_b: { n: 14 } })).toBe('May be out of date · Response received on Q14');                          // the other question has been deleted
    expect(markText(m, {})).toBe('May be out of date · Response received on Q12, Q14');                                      // neither is here: the words as written
    expect(markText(m)).toBe('May be out of date · Response received on Q12, Q14');
    expect(markText(f(2, { updated: true, updatedWhy: 'Side letter.pdf arrived' }), { q_a: { n: 13 } })).toBe('May be out of date · Side letter.pdf arrived');   // a mark from something else is untouched
    const five = f(3, { updated: true, updatedWhy: 'x', updatedOn: { questions: ['a', 'b', 'c', 'd', 'e'] } } as Partial<Finding>);
    expect(markText(five, { a: { n: 1 }, b: { n: 2 }, c: { n: 3 }, d: { n: 4 }, e: { n: 5 } })).toBe('May be out of date · Response received on Q1, Q2, Q3 and 2 more');
  });
});

describe('the Findings list and the queue beside an open finding use one order and one filter', () => {
  it('puts open findings marked for an update first, then newest raised first', () => {
    const s = state([f(1), f(2, { updated: true }), f(3), f(4, { updated: true, status: 'closed' })]);
    // Finding 2 is marked and open, so it leads; Finding 4 is marked but closed, so it stays where its date puts it
    expect(listedFindings(s, D).map((x) => x.title)).toEqual(['Finding 2', 'Finding 4', 'Finding 3', 'Finding 1']);
  });
  it('filters by status, "to update", workstream and review, and never hides a finding in two versions', () => {
    const a = f(1), b = f(2, { updated: true }), c = f(3, { status: 'closed', workstream: 'Tax', reviewed: { by: 'A', at: '2026-11-05T00:00:00.000Z' } as any });
    const s = state([a, b, c]);
    const shown = (ff: ReturnType<typeof FF>) => listedFindings(s, D).filter((x) => findingListed(s, x, ff)).map((x) => x.title);
    expect(shown(FF())).toEqual(['Finding 2', 'Finding 1', 'Finding 3']);   // Legal before Tax, A to Z
    expect(shown(FF({ status: 'open' }))).toEqual(['Finding 2', 'Finding 1']);
    expect(shown(FF({ status: 'reassess' }))).toEqual(['Finding 2']);
    expect(shown(FF({ status: 'closed' }))).toEqual(['Finding 3']);
    expect(shown(FF({ workstream: 'Tax' }))).toEqual(['Finding 3']);
    expect(shown(FF({ reviewed: 'yes' }))).toEqual(['Finding 3']);
    expect(shown(FF({ reviewed: 'no' }))).toEqual(['Finding 2', 'Finding 1']);
    // the filter menu holds Workstream and Reviewed, and no word filter (#1068)
    expect(Object.keys(initialState().ui.findingFilter).sort()).toEqual(['reviewed', 'status', 'workstream']);
    const clash = { ...s, conflicts: { [a.id]: { id: a.id, dealId: D, kind: 'finding', versions: [] } } } as unknown as State;
    expect(listedFindings(clash, D).filter((x) => findingListed(clash, x, FF({ status: 'closed' }))).map((x) => x.title)).toEqual(['Finding 1', 'Finding 3']);
  });
});

describe('the Findings list is grouped by workstream', () => {
  it('puts the groups A to Z, whatever the names, case aside, and findings with no workstream last', () => {
    const s = state([f(1, { workstream: 'Tax' }), f(2, { workstream: '' }), f(3, { workstream: 'Zoning' }), f(4, { workstream: 'Technical' }), f(5, { workstream: 'Access' }), f(6, { workstream: 'Legal' }), f(7, { workstream: '  ' }), f(8, { workstream: 'insurance' })]);
    expect(listedFindings(s, D).map(workstreamHead)).toEqual(['Access', 'insurance', 'Legal', 'Tax', 'Technical', 'Zoning', 'No workstream', 'No workstream']);
  });
  it('keeps marked open findings first within each group, and the kept order after them', () => {
    const s = state([f(1, { workstream: 'Legal' }), f(2, { workstream: 'Tax', updated: true }), f(3, { workstream: 'Legal', updated: true }), f(4, { workstream: 'Tax' }), f(5, { workstream: 'Legal' })]);
    expect(listedFindings(s, D).map((x) => x.title)).toEqual(['Finding 3', 'Finding 5', 'Finding 1', 'Finding 2', 'Finding 4']);
  });
  it('keeps each workstream in one run at deal scale, so a group never appears twice', () => {
    const ws = ['Technical', 'Legal', 'Commercial', 'Financial', 'Insurance', 'Tax', 'Environmental & social', 'Permitting', ''];
    const many = Array.from({ length: 120 }, (_, i) => f(i + 10, { workstream: ws[(i * 7) % ws.length], updated: i % 5 === 0, status: i % 4 === 0 ? 'closed' : 'open' }));
    const heads = listedFindings(state(many), D).map(workstreamHead);
    const runs = heads.filter((h, i) => i === 0 || heads[i - 1] !== h);
    expect(runs).toEqual(['Commercial', 'Environmental & social', 'Financial', 'Insurance', 'Legal', 'Permitting', 'Tax', 'Technical', 'No workstream']);
    expect(heads).toHaveLength(120);
  });
});

describe('workstream groups and the filter agree on names', () => {
  it('takes spaces at the ends off, so " Legal" and "Legal " are one group, which the filter shows whole', () => {
    const s = state([f(1, { workstream: ' Legal' }), f(2, { workstream: 'Legal' }), f(3, { workstream: 'Legal ' }), f(4, { workstream: 'Commercial' })]);
    expect(listedFindings(s, D).map(workstreamHead)).toEqual(['Commercial', 'Legal', 'Legal', 'Legal']);
    expect(listedFindings(s, D).filter((x) => findingListed(s, x, FF({ workstream: 'Legal' }))).length).toBe(3);
  });
  it('lets the filter pick "No workstream", and puts numbers in order', () => {
    const s = state([f(1, { workstream: '' }), f(2, { workstream: 'Phase 10' }), f(3, { workstream: 'Phase 2' }), f(4, { workstream: ' ' })]);
    expect(listedFindings(s, D).map(workstreamHead)).toEqual(['Phase 2', 'Phase 10', 'No workstream', 'No workstream']);
    expect(listedFindings(s, D).filter((x) => findingListed(s, x, FF({ workstream: 'No workstream' }))).map((x) => x.title).sort()).toEqual(['Finding 1', 'Finding 4']);
  });
});

describe('Export holds what the filtered Findings list shows', () => {
  it('counts the same findings for "No workstream" and for a name with stray spaces, at deal scale', () => {
    const names = ['Legal', ' Legal', 'Legal ', '', '  ', 'Tax'];
    const s = state(Array.from({ length: 2000 }, (_, i) => f(i + 10, { workstream: names[i % names.length], status: i % 3 ? 'open' : 'closed' })));
    for (const ws of ['No workstream', 'Legal', 'Tax']) {
      const listed = listedFindings(s, D).filter((x) => findingListed(s, x, FF({ status: 'open', workstream: ws }))).length;
      expect(findingRowsFor(s, D, { status: 'open', workstream: ws, reviewedOnly: false }).length).toBe(listed);
      expect(listed).toBeGreaterThan(100);
    }
  });
});
