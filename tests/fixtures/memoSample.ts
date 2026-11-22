// A made-up deal's memo, for the tests of the memo document: eight open findings rated, one closed, four questions and 162 checklist items.
import { memoContent, type Rating } from '../../src/domain/memo';
import { Deal, Finding, Question } from '../../src/domain/model';
const D = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ'; const AT = '2026-11-01T10:00:00.000Z';
const deal = Deal.parse({ id: D, rev: 1, createdAt: AT, updatedAt: AT, name: 'Project Southridge', counterparty: 'Southridge Solar Holdings LLC', product: 'Construction-to-term loan', sector: 'Solar', technology: 'Storage' });
let k = 10; const fid = () => `f_01HZZZZZZZZZZZZZZZZZZZZZ${k++}`;
const F = (title: string, ws: string, body: string, src: [string, string][], more: Partial<Finding> = {}) => Finding.parse({ id: fid(), dealId: D, rev: 1, createdAt: AT, updatedAt: AT, title, workstream: ws, raisedAt: AT, origin: 'ai', body: [body], sources: src.map(([doc, loc], i) => ({ doc, loc, docId: `doc_${doc.length}${i}` })), ...more });
const fs_ = [
  F('Base case energy yield is above what the technical advisor supports', 'Technical', 'The technical advisor supports a P50 yield of 2,010 kWh/kWp. [1] The base case uses 2,085 kWh/kWp throughout the forecast. [2]', [['Technical advisor report.pdf', 'p. 41'], ['Information memorandum.pdf', 'p. 22']]),
  F('Offtake contract covers less capacity than the base case assumes', 'Commercial', 'The executed power purchase agreement covers 300 MW. [1] The model treats all 400 MW as contracted from COD. [2]', [['Power purchase agreement.pdf', 'p. 3'], ['Financial model.xlsx', 'Revenue!D14']]),
  F('Interconnection agreement is not executed', 'Legal', 'Only an unsigned draft is in the data room. [1] The schedule assumes backfeed in month 19. [2]', [['LGIA (draft).pdf', 'p. 1'], ['EPC schedule.pdf', 'p. 7']]),
  F('Lock-up ratio in the draft credit agreement differs from the term sheet', 'Legal', 'The draft sets the lock-up at 1.25x. [1] The signed term sheet has 1.30x. [2]', [['Credit agreement (draft 3).pdf', 'p. 142'], ['Term sheet (signed).pdf', 'p. 6']]),
  F('Battery degradation warranty ends before the loan’s tenor', 'Technical', 'The warranty runs 10 years. [1] The loan amortizes over 18. [2]', [['Battery supply agreement.pdf', 'p. 2'], ['Financial model.xlsx', 'Reserves!F30']]),
  F('Construction contingency is below the advisor’s estimate', 'Financial', 'Contingency is 4.0% of EPC. [1] The advisor gives 6–8%. [2]', [['Sources and uses.pdf', 'p. 1'], ['Technical advisor report.pdf', 'p. 41']]),
  F('Delay-in-start-up cover sized at 12 months', 'Insurance', 'Cover is 12 months. [1]', [['Insurance report.pdf', 'p. 9']]),
  F('Notice address for the agent differs between drafts & <versions>', 'Legal', 'Two addresses. [1]', [['Credit agreement (draft 3).pdf', 'p. 150']]),
  F('Phase I site assessment older than 180 days', 'Environmental & social', 'Old. [1]', [['Phase I.pdf', 'p. 1']], { status: 'closed', closedAt: '2026-11-06T10:00:00.000Z' }),
];
const R: Rating[] = ['High', 'High', 'High', 'Medium', 'Medium', 'Medium', 'Low', 'Low'];
const ratings = Object.fromEntries(fs_.slice(0, 8).map((f, i) => [f.id, R[i]]));
const Q = (n: number, more: Partial<Question>) => Question.parse({ id: `q_01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, "0")}`, dealId: D, rev: 1, createdAt: AT, updatedAt: AT, n, text: 'q', workstream: 'Legal', ...more });
const qs = [Q(14, { linkedFinding: fs_[0].id, received: '2026-10-30', workstream: 'Technical' }), Q(22, { linkedFinding: fs_[1].id, status: 'answered', response: 'A term sheet for the remaining capacity is in negotiation.', responded: '2026-11-09', workstream: 'Commercial' }), Q(9, { linkedFinding: fs_[2].id, status: 'answered', response: 'Execution expected by year end.', responded: '2026-11-12' }), Q(31, { received: '2026-10-23' })];
const lists = [['General', 74, 69], ['Construction-to-term loan', 38, 33], ['Solar', 28, 25], ['Storage', 22, 19]] as const;
const checklist = lists.flatMap(([list, n, ok]) => Array.from({ length: n }, (_, i) => ({ text: `${list} item ${i}`, list, kind: (i < ok ? 'satisfied' : i % 2 ? 'gap' : 'finding') as 'satisfied' | 'gap' | 'finding', need: 'Signed copy' })));
/** the made-up deal's memo content */
export const sampleMemo = () => memoContent({
  deal, firm: '[firm name]', today: '2026-11-15', findings: fs_, questions: qs, checklist, ratings, keyRisks: 8,
  summary: ['A 400 MW solar project with a 200 MW battery, financed through a construction-to-term loan. '
    + 'Three risks rate High: the base case yield is above the advisor’s figure, the offtake covers 280 of 400 MW, '
    + 'and the interconnection agreement is not executed.'],
});
