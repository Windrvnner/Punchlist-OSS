import { describe, it, expect } from 'vitest';
import { GLANCE_ROWS, RISK_WEIGHT, memoContent, stillOpen, longDate, type MemoInput, type Rating } from '../../src/domain/memo';
import { Deal, Finding, Question } from '../../src/domain/model';
import { scaleMemoInput } from '../fixtures/memoScale';

const D = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-11-01T10:00:00.000Z';
const deal = Deal.parse({ id: D, rev: 1, createdAt: AT, updatedAt: AT, name: 'Project Southridge', counterparty: 'Southridge Solar Holdings LLC', product: 'Construction-to-term loan', sector: 'Solar', technology: '' });
let seq = 0;
const fid = () => `f_01HZZZZZZZZZZZZZZZZZZZZZ${(seq++).toString().padStart(2, '0')}`.replace(/[ILOU]/g, 'Z');
const finding = (title: string, more: Partial<Finding> = {}) => Finding.parse({ id: fid(), dealId: D, rev: 1, createdAt: AT, updatedAt: AT, title, workstream: 'Technical', raisedAt: AT, origin: 'ai', body: [], sources: [], ...more });
const question = (n: number, more: Partial<Question> = {}) => Question.parse({ id: `q_01HZZZZZZZZZZZZZZZZZZZZZ${n.toString().padStart(2, '0')}`, dealId: D, rev: 1, createdAt: AT, updatedAt: AT, n, text: `Question ${n}`, ...more });
const input = (more: Partial<MemoInput>): MemoInput => ({
  deal,
  firm: 'Firm',
  today: '2026-11-15',
  findings: [],
  questions: [],
  checklist: null,
  summary: [],
  ratings: {},
  keyRisks: 8,
  ...more,
});

describe('the deal memo’s content', () => {
  it('writes the date out and lists the deal’s facts that are set', () => {
    const m = memoContent(input({}));
    expect(m.date).toBe('November 15, 2026'); expect(longDate('2026-01-02')).toBe('January 2, 2026');
    expect(m.facts).toEqual(['Southridge Solar Holdings LLC', 'Construction-to-term loan', 'Solar']);
  });

  it('puts every High risk in the body, fills the rest with Medium ones, and lists the others after them as smaller risks', () => {
    const fs = [1, 2, 3].map((k) => finding(`High ${k}`, { raisedAt: `2026-11-0${k}T10:00:00.000Z` })).concat([1, 2].map((k) => finding(`Medium ${k}`, { raisedAt: `2026-11-0${k}T10:00:00.000Z` })), [finding('Low 1'), finding('Unrated')]);
    const ratings = Object.fromEntries(fs.filter((f) => f.title !== 'Unrated').map((f) => [f.id, f.title.split(' ')[0] as Rating]));
    const m = memoContent(input({ findings: fs, ratings, keyRisks: 4 }));
    expect(m.risks.map((r) => r.title)).toEqual(['High 1', 'High 2', 'High 3', 'Medium 1']);
    expect(m.minor.map((o) => `${o.rating}:${o.title}`)).toEqual(['Medium:Medium 2', 'Low:Low 1', 'null:Unrated']);
    // the cap never drops a High risk
    expect(memoContent(input({ findings: fs, ratings, keyRisks: 1 })).risks.map((r) => r.rating)).toEqual(['High', 'High', 'High']);
  });

  it('numbers references once each, in the order first cited, without file extensions or citation markers', () => {
    const a = finding('A', { body: ['The advisor supports a lower figure. [1] The base case uses the higher one. [2]', 'Second paragraph is left out. [1]'], sources: [{ doc: 'Technical advisor report.pdf', docId: 'doc_1', loc: 'p. 41' }, { doc: 'Financial model.xlsx', docId: 'doc_2', loc: 'Revenue!D14' }] });
    const b = finding('B', { body: ['Same report again. [1]'], sources: [{ doc: 'Technical advisor report.pdf', docId: 'doc_1', loc: 'p. 41' }] });
    const m = memoContent(input({ findings: [a, b], ratings: { [a.id]: 'High', [b.id]: 'Medium' } }));
    expect(m.refs).toEqual(['Technical advisor report, p. 41', 'Financial model, Revenue!D14']);
    expect(m.risks[0].paras).toEqual([[{ text: 'The advisor supports a lower figure.', refs: [1] }, { text: ' ', refs: [] }, { text: 'The base case uses the higher one.', refs: [2] }]]);
    expect(m.risks[1].paras).toEqual([[{ text: 'Same report again.', refs: [1] }]]);
    expect(m.risks.flatMap((r) => r.paras.flat().map((p) => p.text)).join('')).not.toMatch(/\[\d/);
  });

  it('closes a risk on the questions still unanswered on its findings, and never says its next step', () => {
    const f = finding('F', { next: 'Ask the sponsor to rerun the model.' }); const g = finding('G');
    const qs = [
      question(14, { linkedFinding: f.id, received: '2026-10-30', response: 'The carrier has only provided a draft.' }),
      question(9, {
        linkedFinding: f.id, status: 'answered', response: 'Execution expected by year end.', responded: '2026-11-12',
      }),
      question(3, { linkedFinding: f.id, status: 'closed' }), question(20),
      question(21, { linkedFinding: g.id, received: '2025-12-01' }),
    ];
    expect(stillOpen([f.id], qs, '2026-11-15')).toBe('Q14 (Oct 30) is still unanswered.');
    // A typed response does not change Open status.
    expect(stillOpen([f.id, g.id], qs, '2026-11-15')).toBe('Q14 (Oct 30) and Q21 (Dec 1, 2025) are still unanswered.');
    expect(stillOpen([g.id, f.id, 'f_x'], [...qs, question(30, { linkedFinding: g.id })], '2026-11-15')).toBe('Q14 (Oct 30), Q21 (Dec 1, 2025) and Q30 are still unanswered.');
    expect(stillOpen(['f_x'], qs, '2026-11-15')).toBe('');
    const m = memoContent(input({ findings: [f], questions: qs, ratings: { [f.id]: 'High' } }));
    expect(m.risks[0].open).toBe('Q14 (Oct 30) is still unanswered.');
    expect(JSON.stringify(m)).not.toContain('rerun');
    expect(JSON.stringify(m.risks)).not.toContain('The carrier has only provided a draft.');
    expect(JSON.stringify(m.risks)).not.toContain('Execution expected by year end.');
  });

  it('lists findings and questions with no workstream as "No workstream", apart from one actually named Other', () => {
    const fs = [finding('A', { workstream: '' }), finding('B', { workstream: 'Zoning' }), finding('C', { workstream: 'Other' }), finding('D', { workstream: 'Legal' })];
    const m = memoContent(input({ findings: fs, questions: [question(1, { workstream: ' ' })], ratings: Object.fromEntries(fs.map((f) => [f.id, 'Low' as const])) }));
    expect(m.glance.map((g) => [g.workstream, g.Low, g.open])).toEqual([['No workstream', 1, 1], ['Legal', 1, 0], ['Other', 1, 0], ['Zoning', 1, 0]]);   // its open question ranks it first
    // other names in the dropdowns' order: numbers by value
    const ps = [finding('P10', { workstream: 'Phase 10' }), finding('P2', { workstream: 'Phase 2' })];
    expect(memoContent(input({ findings: ps, ratings: {} })).glance.map((g) => g.workstream)).toEqual(['Phase 2', 'Phase 10']);
  });

  it('ranks the glance rows by High, then Medium, Low and open questions, "No workstream" too, ties A to Z', () => {
    const fs = [finding('a', { workstream: 'Tax' }), finding('b', { workstream: 'Legal' }), finding('c', { workstream: 'Legal' }), finding('d', { workstream: 'Commercial' }), finding('e', { workstream: 'Structure' }), finding('n', { workstream: '' })];
    const m = memoContent(input({ findings: fs, ratings: { [fs[0].id]: 'High', [fs[1].id]: 'Medium', [fs[2].id]: 'Medium', [fs[3].id]: 'Medium', [fs[4].id]: 'High', [fs[5].id]: 'High' } }));
    // "No workstream" ranks by its risks like any other row, and comes after the others only on a tie
    expect(m.glance.map((g) => g.workstream)).toEqual(['Structure', 'Tax', 'No workstream', 'Legal', 'Commercial']);
    const two = [finding('x', { workstream: '' }), finding('y', { workstream: '' }), finding('z', { workstream: 'Legal' })];
    expect(memoContent(input({ findings: two, ratings: { [two[0].id]: 'High', [two[1].id]: 'High', [two[2].id]: 'High' } })).glance.map((g) => g.workstream)).toEqual(['No workstream', 'Legal']);
  });

  it('lists risks by severity, A to Z by title within each; the body still takes the oldest Medium ones', () => {
    const at = (d: string) => `2026-11-${d}T09:00:00.000Z`;
    const fs = [finding('Zoning permit lapsed', { raisedAt: at('01') }), finding('Access road not granted', { raisedAt: at('02') }),
      finding('Tariff indexation unclear', { raisedAt: at('03') }), finding('Lock-up ratio differs', { raisedAt: at('04') }), finding('Base case too high', { raisedAt: at('05') }),
      finding('Warranty period short', { raisedAt: at('06') }), finding('Cover lapses at COD', { raisedAt: at('07') })];
    const r = { High: [0, 1], Medium: [2, 3, 4], Low: [5, 6] } as const;
    const ratings = Object.fromEntries(Object.entries(r).flatMap(([k, ix]) => ix.map((x) => [fs[x].id, k as 'High' | 'Medium' | 'Low'])));
    const m = memoContent(input({ findings: fs, ratings, keyRisks: 4 }));
    expect(m.risks.map((x) => x.title)).toEqual(['Access road not granted', 'Zoning permit lapsed', 'Lock-up ratio differs', 'Tariff indexation unclear']);
    expect(m.minor.map((x) => x.title)).toEqual(['Base case too high', 'Cover lapses at COD', 'Warranty period short']);
  });

  it('keeps the glance table to what fits on the first page, the least severe rows added up in one row', () => {
    const names = Array.from({ length: 20 }, (_, i) => `Workstream ${String(i + 1).padStart(2, '0')}`);
    const fs = names.map((w, i) => finding(w, { workstream: w }));
    const ratings = Object.fromEntries(fs.map((f, i) => [f.id, (i < 3 ? 'High' : i < 8 ? 'Medium' : 'Low') as 'High' | 'Medium' | 'Low']));
    const g = memoContent(input({ findings: fs, ratings })).glance;
    expect(g).toHaveLength(GLANCE_ROWS);
    expect(g.at(-1)).toEqual({ workstream: 'Other workstreams (9)', High: 0, Medium: 0, Low: 9, open: 0 });
    expect(g.reduce((t, x) => t + x.High + x.Medium + x.Low, 0)).toBe(20);   // nothing is lost from the totals
    expect(memoContent(input({ findings: fs.slice(0, GLANCE_ROWS), ratings })).glance.map((x) => x.workstream)).not.toContain('Other workstreams (1)');
  });

  it('ranks the glance rows by weighted risk count, High 9, Medium 3, Low 1; equal weights go to more High', () => {
    expect(RISK_WEIGHT).toEqual({ High: 9, Medium: 3, Low: 1 });
    const rows: [string, 'High' | 'Medium' | 'Low', number][] = [['Legal', 'High', 1], ['Tax', 'Medium', 4], ['Insurance', 'Low', 9], ['Structure', 'Medium', 2]];
    const fs = rows.flatMap(([w, r, n]) => Array.from({ length: n }, (_, i) => ({ f: finding(`${w} ${i}`, { workstream: w }), r })));
    const m = memoContent(input({ findings: fs.map((x) => x.f), ratings: Object.fromEntries(fs.map((x) => [x.f.id, x.r])) }));
    // Tax 4 Medium = 12 beats Legal 1 High = 9; Legal ties Insurance 9 Low = 9 and wins on its High; Structure 2 Medium = 6
    expect(m.glance.map((g) => g.workstream)).toEqual(['Tax', 'Legal', 'Insurance', 'Structure']);
  });

  it('counts open findings by workstream and rating, with open questions beside them, most severe first', () => {
    const fs = [finding('L', { workstream: 'Legal' }), finding('T', { workstream: 'Technical' }), finding('C', { workstream: 'Legal', status: 'closed', closedAt: '2026-11-10T09:00:00.000Z' })];
    const m = memoContent(input({ findings: fs, questions: [question(1, { workstream: 'Tax' }), question(2, { workstream: 'Legal', status: 'answered' })], ratings: { [fs[0].id]: 'High', [fs[1].id]: 'Low' } }));
    expect(m.glance).toEqual([{ workstream: 'Legal', High: 1, Medium: 0, Low: 0, open: 0 }, { workstream: 'Technical', High: 0, Medium: 0, Low: 1, open: 0 }, { workstream: 'Tax', High: 0, Medium: 0, Low: 0, open: 1 }]);
  });

  it('counts the checklist and the Q&A in one line, with nothing listed at the back', () => {
    const checklist = [
      { text: 'a', list: 'General', kind: 'satisfied' as const }, { text: 'b', list: 'General', kind: 'gap' as const, need: 'Signed copy' },
      { text: 'c', list: 'Solar', kind: 'finding' as const }, { text: 'd', list: 'Solar', kind: 'person' as const }, { text: 'e', list: 'Solar', kind: 'open' as const },
    ];
    const qs = [question(1, { received: '2026-10-23' }), question(2, { received: '2026-11-01' }), question(3, { status: 'answered' }), question(4, { status: 'closed' })];
    const m = memoContent(input({ checklist, questions: qs }));
    expect(m.counts).toBe('No open findings. Of 5 checklist items, 2 are settled, 1 flagged and 1 gap; 1 not settled. 2 questions to the counterparty are open; the oldest, Q1, was received 23 days ago.');
  });

  it('counts unrated open findings even when grouped into one rated risk', () => {
    const open = scaleMemoInput.findings.filter((f) => f.status === 'open');
    const [yieldFinding, p90, dscr] = open;
    const groups = [{
      title: 'Debt sizing uses the base case yield',
      findings: [yieldFinding.id, p90.id, dscr.id],
    }];
    const grouped = { ...scaleMemoInput, groups };
    const allMissing = memoContent({ ...grouped, ratings: {} });
    expect(allMissing.counts).toMatch(/^42 open findings in 40 risks: 0 High, 0 Medium, 0 Low, 42 unrated\./);
    const partial = memoContent({ ...grouped, ratings: { [yieldFinding.id]: 'High', f_removed: 'Low' } });
    expect(partial.counts).toMatch(/^42 open findings in 40 risks: 1 High, 0 Medium, 0 Low, 41 unrated\./);
    const ratings = Object.fromEntries(open.map((f) => [f.id, 'Low' as const]));
    const complete = memoContent({ ...grouped, ratings });
    expect(complete.counts).toMatch(/^42 open findings in 40 risks: 0 High, 0 Medium, 40 Low\./);
  });

  it('makes one risk of the findings the model grouped, rated as its most severe and aged as its oldest, written up in its own paragraphs', () => {
    const at = (d: string) => `2026-11-${d}T09:00:00.000Z`;
    const a = finding('Yield above the advisor’s', { raisedAt: at('05'), workstream: 'Technical', body: ['Own words. [1]'], sources: [{ doc: 'Technical advisor report.pdf', docId: 'doc_1', loc: 'p. 41' }] });
    const b = finding('No P90 case', { raisedAt: at('02'), workstream: 'Financial' }); const c = finding('Lock-up differs', { raisedAt: at('01'), workstream: 'Legal' });
    const d = finding('Notice address', { workstream: 'Legal' }); const closed = finding('Closed', { status: 'closed' });
    const ratings = { [a.id]: 'Medium', [b.id]: 'High', [c.id]: 'Medium', [d.id]: 'Low' } as Record<string, Rating>;
    const qs = [question(4, { linkedFinding: a.id, received: '2026-11-10' }), question(7, { linkedFinding: b.id, status: 'answered', response: 'Being run.', responded: '2026-11-12' })];
    const sources = [{ doc: 'Financial model.xlsx', docId: 'doc_2', loc: 'Inputs!F22' }, { doc: 'Technical advisor report.pdf', docId: 'doc_1', loc: 'p. 41' }];
    const groups = [{ title: '  Debt is sized on a yield the advisor does not support ', findings: [a.id, b.id, closed.id, 'f_gone'], body: ['The base case uses 2,085. [1] The advisor supports 2,010. [2]', 'The model has no P90 case. [1]'], sources }, { title: 'Again', findings: [a.id] }];
    const m = memoContent(input({ findings: [a, b, c, d, closed], questions: qs, ratings, groups, keyRisks: 2 }));
    expect(m.risks.map((r) => [r.rating, r.title, r.workstream])).toEqual([['High', 'Debt is sized on a yield the advisor does not support', 'Financial, Technical'], ['Medium', 'Lock-up differs', 'Legal']]);
    expect(m.risks[0].paras).toEqual([[{ text: 'The base case uses 2,085.', refs: [1] }, { text: ' ', refs: [] }, { text: 'The advisor supports 2,010.', refs: [2] }], [{ text: 'The model has no P90 case.', refs: [1] }]]);
    expect(m.refs).toEqual(['Financial model, Inputs!F22', 'Technical advisor report, p. 41']);
    // what is still open, from every finding in it: only the unanswered
    expect(m.risks[0].open).toBe('Q4 (Nov 10) is still unanswered.');
    expect(m.risks[1].open).toBe('');
    expect(m.minor.map((x) => [x.rating, x.title])).toEqual([['Low', 'Notice address']]);
    // the counts speak of risks, as the body does
    expect(m.counts).toMatch(/^4 open findings in 3 risks: 1 High, 1 Medium, 1 Low\./);
    // the glance table counts the same risks: one of several findings once, under its most severe finding's workstream
    expect(m.glance).toEqual([{ workstream: 'Financial', High: 1, Medium: 0, Low: 0, open: 0 }, { workstream: 'Legal', High: 0, Medium: 1, Low: 1, open: 0 }, { workstream: 'No workstream', High: 0, Medium: 0, Low: 0, open: 1 }]);
  });

  it('keeps a smaller risk to a sentence or two, each of its findings in turn', () => {
    const src = [{ doc: 'a.pdf', docId: 'doc_1', loc: 'p. 1' }];
    const a = finding('A', { body: ['First fact. [1] Second fact. [1] Third fact that is left out. [1]'], sources: src }); const b = finding('B', { body: ['Other. [1]'], sources: src });
    const m = memoContent(input({ findings: [a, b], ratings: { [a.id]: 'Low', [b.id]: 'Low' }, groups: [{ title: 'Both', findings: [a.id, b.id] }] }));
    expect(m.minor).toHaveLength(1); expect(m.minor[0].detail.map((x) => x.text).join('')).toBe('First fact. Second fact.');
    const one = memoContent(input({ findings: [b, a], ratings: { [a.id]: 'Low', [b.id]: 'Low' }, groups: [{ title: 'Both', findings: [b.id, a.id] }] }));
    expect(one.minor[0].detail.map((x) => x.text).join('')).toBe('Other. First fact.');
  });

  it('writes nothing that advises', () => {
    const f = finding('F', { body: ['Fact. [1]'], sources: [{ doc: 'x.pdf', docId: 'doc_3', loc: 'p. 1' }], next: 'You should renegotiate.' });
    const text = JSON.stringify(memoContent(input({ findings: [f], ratings: { [f.id]: 'Medium' }, checklist: [{ text: 'a', list: 'General', kind: 'gap' }] })));
    expect(text).not.toMatch(/\b(should|recommend|suggest|advise|consider|next step|mitigant)\b/i);
  });
});
