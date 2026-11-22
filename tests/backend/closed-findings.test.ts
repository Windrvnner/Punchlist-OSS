// @vitest-environment node
// Closed findings checked too: when documents arrive and on request, a closed finding is asked whether it
// stays closed; one brought into question is marked, and stays closed: the app never reopens it.
import { describe, it, expect } from 'vitest';
import { setup, doc, val, deal, finding, itemsIn, Mem, OK, type Call } from './reviewKit';

const FA = doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'margin'] });
const TS = doc(2, 'Term sheet.pdf', { pages: 12, words: ['term', 'sheet', 'margin'] });
const list = () => ({ broad: [{ id: 'c1', text: 'Margin agrees between the documents' }], product: [], sector: [] });
const okAll = (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) });
const closedAsk = (c: Call) => c.prompt.includes('a person has closed it');
const stored = async (repo: any, id: string) => val<any>(await repo.get('finding', id)).envelope.data;

describe('closed findings checked too', () => {
  it('on request: a closed finding the standard model says no longer stays closed is marked, and stays closed', async () => {
    const s = setup(okAll, { d1: [FA, TS] }, { shared: new Mem(), installId: 'pc', checklist: list, verify: (c) => (closedAsk(c) ? { stands: c.model === 'fast', why: 'The amendment sets another margin' } : { stands: true, why: '' }) });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    await finding(s.repo, 'f_1', 'Margin differs', { status: 'closed', sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] });
    await finding(s.repo, 'f_2', 'Margin is high', { status: 'closed', sources: [{ doc: FA.name, loc: 'p. 3', docId: FA.docId }] });
    // the fast model lets both stand closed: the standard model looks at a sample of what it passed, and here overturns them
    const r = val(await s.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(s.verifyCalls.filter(closedAsk).length).toBe(2); expect(r.toReassess).toBe(2);
    for (const id of ['f_1', 'f_2']) expect(await stored(s.repo, id)).toMatchObject({ status: 'closed', updated: true, updatedWhy: 'Check of everything' });
  });

  it('when documents arrive: the fast model names a closed finding they could change; it is looked at with them and marked', async () => {
    let arrived = false;
    const s = setup(okAll, { d1: [FA, TS] }, { shared: new Mem(), installId: 'pc', checklist: list,
      affects: (c) => ({ affected: c.prompt.includes('(closed)') ? ['F1 N1'] : [] }),
      verify: (c) => ({ stands: !(arrived && closedAsk(c)), why: 'The amendment changes the margin' }) });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    await finding(s.repo, 'f_1', 'Margin differs', { status: 'closed', sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] });
    s.recs.d1 = [...s.recs.d1, doc(3, 'Amendment.pdf', { words: ['amendment', 'margin'] })]; arrived = true;
    val(await s.ai.firstPass('d1'));
    expect(s.affectCalls.some((c) => c.prompt.includes('F1: Margin differs (closed)'))).toBe(true);
    expect(await stored(s.repo, 'f_1')).toMatchObject({ status: 'closed', updated: true, updatedWhy: 'Amendment.pdf arrived' });
  });
});
