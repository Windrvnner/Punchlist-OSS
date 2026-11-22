// A made-up deal at realistic scale, for the deal memo: 2,000 checklist items, 42 open findings across 15 workstreams,
// 140 questions to the counterparty, and the risks as the model groups and writes them up. The write-ups and summary are
// stand-ins written to the prompts in src/backend/ai.ts (memo), so the layout can be judged at scale without a model.
import { memoContent, type Rating, type RiskGroup } from '../../src/domain/memo';
import { Deal, Finding, Question, type Source } from '../../src/domain/model';

const D = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const deal = Deal.parse({ id: D, rev: 1, createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-11-17T10:00:00.000Z', name: 'Project Southridge', counterparty: 'Southridge Solar Holdings LLC', product: 'Construction-to-term loan', sector: 'Solar', technology: 'Storage' });
const src = (doc: string, loc: string): Source => ({ doc, loc, docId: `doc_${doc.replace(/\W+/g, '').slice(0, 20)}` });
let k = 100;
type Row = [title: string, ws: string, rating: Rating, day: number, body: string, sources: Source[]];
const rows: Record<string, Row> = {
  yield: ['Base case energy yield is above what the technical advisor supports', 'Technical', 'High', 3, 'The technical advisor supports a P50 yield of 2,010 kWh/kWp. [1] The base case uses 2,085 kWh/kWp throughout the forecast. [2]', [src('Technical advisor report.pdf', 'p. 41'), src('Financial model v14.xlsx', 'Inputs!F22')]],
  p90: ['The model has no P90 one-year case', 'Financial', 'High', 6, 'The model runs the base case and a P50 downside only. [1] The term sheet sizes debt on the P90 one-year case. [2]', [src('Financial model v14.xlsx', 'Scenarios!B4'), src('Term sheet (signed).pdf', 'p. 4')]],
  dscr: ['Minimum DSCR rests on the base case yield', 'Financial', 'High', 6, 'The model shows a minimum DSCR of 1.31x. [1]', [src('Financial model v14.xlsx', 'Outputs!H40')]],
  ppa: ['Offtake contract covers less capacity than the base case assumes', 'Commercial', 'High', 2, 'The executed power purchase agreement covers 300 MW. [1] The model treats all 400 MW as contracted from COD. [2]', [src('Power purchase agreement.pdf', 'p. 3'), src('Financial model v14.xlsx', 'Revenue!D14')]],
  merchant: ['Merchant prices come from the sponsor’s own curve', 'Commercial', 'High', 9, 'Merchant revenue after the PPA term uses the sponsor’s curve. [1] No independent market report is in the data room index of advisors’ reports. [2]', [src('Financial model v14.xlsx', 'Prices!C8'), src('Information memorandum.pdf', 'p. 58')]],
  lgia: ['Interconnection agreement is not executed', 'Interconnection', 'High', 1, 'Only an unsigned draft of the large generator interconnection agreement is in the data room. [1]', [src('LGIA (draft).pdf', 'p. 1')]],
  upgrades: ['Network upgrade costs are not allocated', 'Interconnection', 'High', 4, 'The facilities study estimates network upgrades at $40 million. [1] The draft agreement leaves the cost allocation blank. [2]', [src('Facilities study.pdf', 'p. 17'), src('LGIA (draft).pdf', 'p. 44')]],
  backfeed: ['EPC schedule assumes backfeed earlier than the utility’s study', 'Construction', 'High', 8, 'The EPC schedule assumes backfeed in month 19. [1] The facilities study gives an in-service date for the upgrades in month 24. [2]', [src('EPC schedule.pdf', 'p. 7'), src('Facilities study.pdf', 'p. 22')]],
  lds: ['Delay damages are capped below the advisor’s estimate of exposure', 'Construction', 'High', 5, 'The EPC contract caps delay liquidated damages at 10% of the contract price. [1] The advisor puts the exposure from a six-month delay at 15%. [2]', [src('EPC contract.pdf', 'p. 88'), src('Technical advisor report.pdf', 'p. 63')]],
  pcg: ['EPC parent guarantee is not signed', 'Legal', 'High', 10, 'The parent company guarantee in the data room is an unsigned form. [1]', [src('EPC parent guarantee (form).pdf', 'p. 1')]],
  lockup: ['Lock-up ratio in the draft credit agreement differs from the term sheet', 'Legal', 'Medium', 11, 'The draft sets the lock-up at 1.25x. [1] The signed term sheet has 1.30x. [2]', [src('Credit agreement (draft 3).pdf', 'p. 142'), src('Term sheet (signed).pdf', 'p. 6')]],
  testperiod: ['Distribution test is measured over a shorter period than the term sheet', 'Legal', 'Medium', 12, 'The draft tests the ratio over the last six months. [1] The term sheet tests it over twelve. [2]', [src('Credit agreement (draft 3).pdf', 'p. 143'), src('Term sheet (signed).pdf', 'p. 6')]],
  battery: ['Battery degradation warranty ends before the loan’s tenor', 'Technical', 'Medium', 13, 'The warranty runs 10 years. [1] The loan amortizes over 18. [2]', [src('Battery supply agreement.pdf', 'p. 22'), src('Term sheet (signed).pdf', 'p. 3')]],
  augment: ['Battery augmentation is not in the operating budget', 'Financial', 'Medium', 14, 'The operating budget has no line for augmentation after year 10. [1]', [src('Financial model v14.xlsx', 'Opex!E30')]],
  contingency: ['Construction contingency is below the advisor’s estimate', 'Financial', 'Medium', 15, 'Contingency is 4.0% of EPC. [1] The advisor gives 6–8%. [2]', [src('Sources and uses.pdf', 'p. 1'), src('Technical advisor report.pdf', 'p. 71')]],
  flip: ['Tax equity flip date differs between the model and the term sheet', 'Tax', 'Medium', 16, 'The model assumes the flip in year 6. [1] The tax equity term sheet targets year 8. [2]', [src('Financial model v14.xlsx', 'TaxEquity!C12'), src('Tax equity term sheet.pdf', 'p. 2')]],
  adder: ['Domestic content adder is assumed without a supporting analysis', 'Tax', 'Medium', 18, 'The model adds 10 points of ITC for domestic content. [1] The tax advisor’s memo does not cover domestic content. [2]', [src('Financial model v14.xlsx', 'TaxEquity!C20'), src('Tax advisor memo.pdf', 'p. 3')]],
  title: ['Title commitment lists exceptions over 40 acres of the site', 'Real estate', 'Medium', 19, 'Schedule B lists 14 exceptions, including a pipeline easement across 40 acres. [1]', [src('Title commitment.pdf', 'p. 9')]],
  options: ['Two lease options expire before financial close', 'Real estate', 'Medium', 20, 'Two option agreements expire on December 31, 2026. [1]', [src('Lease option schedule.xlsx', 'Options!B7')]],
  eagle: ['Eagle take permit application is pending', 'Permitting', 'Medium', 21, 'The application was filed in July and is under review. [1]', [src('Permit matrix.xlsx', 'Federal!C9')]],
  cup: ['Conditional use permit is still open to appeal', 'Permitting', 'Medium', 22, 'The county granted the permit on October 28, 2026, with a 30-day appeal window. [1]', [src('Conditional use permit.pdf', 'p. 2')]],
  dsu: ['Delay-in-start-up cover is shorter than the critical path delay', 'Insurance', 'Medium', 23, 'Cover is 12 months. [1] The advisor’s critical path shows an 18-month exposure for a main transformer failure. [2]', [src('Insurance report.pdf', 'p. 9'), src('Technical advisor report.pdf', 'p. 66')]],
  availability: ['O&M availability guarantee is below the model’s assumption', 'Operations', 'Medium', 24, 'The O&M agreement guarantees 98.0% availability. [1] The model assumes 99.0%. [2]', [src('O&M agreement.pdf', 'p. 31'), src('Financial model v14.xlsx', 'Inputs!F30')]],
  tariff: ['Module supply has no allocation of tariff risk', 'Regulatory', 'Medium', 25, 'The module supply agreement is silent on antidumping and countervailing duties. [1]', [src('Module supply agreement.pdf', 'p. 40')]],
  curtail: ['Curtailment assumption is below the interconnection study', 'Interconnection', 'Medium', 26, 'The model assumes 1.5% curtailment. [1] The system impact study estimates 3.2%. [2]', [src('Financial model v14.xlsx', 'Inputs!F25'), src('System impact study.pdf', 'p. 30')]],
  swap: ['Swap notional profile does not follow the debt amortization', 'Financial', 'Medium', 27, 'The hedging term sheet amortizes the notional straight-line. [1] The debt is sculpted. [2]', [src('Hedging term sheet.pdf', 'p. 2'), src('Financial model v14.xlsx', 'Debt!D10')]],
  notice: ['Notice address for the agent differs between drafts', 'Legal', 'Low', 28, 'Draft 3 gives a different address for the agent than draft 2. [1]', [src('Credit agreement (draft 3).pdf', 'p. 150')]],
  kyc: ['Sponsor KYC documents are more than a year old', 'KYC', 'Low', 29, 'The certificate of good standing is dated August 2025. [1]', [src('Sponsor KYC pack.pdf', 'p. 4')]],
  esa: ['Phase I site assessment is older than 180 days', 'Environmental & social', 'Low', 30, 'The Phase I is dated March 2026. [1]', [src('Phase I ESA.pdf', 'p. 1')]],
  cultural: ['Cultural resources survey covers 92% of the site', 'Environmental & social', 'Low', 31, 'The survey excludes 38 acres in the north array. [1]', [src('Cultural resources survey.pdf', 'p. 6')]],
  aro: ['Asset retirement obligation is not booked', 'Accounting', 'Low', 32, 'The opening balance sheet has no asset retirement obligation. [1]', [src('Financial model v14.xlsx', 'BS!C40')]],
  broker: ['Insurance broker’s letter is unsigned', 'Insurance', 'Low', 33, 'The broker’s letter of undertaking is an unsigned draft. [1]', [src('Broker letter (draft).pdf', 'p. 1')]],
  version: ['Model version on the cover differs from its file name', 'Financial', 'Low', 34, 'The model’s cover sheet says version 13, while the file in the data room is named version 14. [1]', [src('Financial model v14.xlsx', 'Cover!B2')]],
  wetland: ['Wetland delineation awaits confirmation by the Corps of Engineers', 'Environmental & social', 'Low', 35, 'The delineation report was submitted for a jurisdictional determination. [1]', [src('Wetland delineation.pdf', 'p. 2')]],
  orgchart: ['Structure chart leaves out one project company', 'Legal', 'Low', 36, 'The chart does not show Southridge Storage LLC, a party to the battery supply agreement. [1]', [src('Structure chart.pdf', 'p. 1'), src('Battery supply agreement.pdf', 'p. 1')]],
  spares: ['Spare parts list is a draft', 'Operations', 'Low', 37, 'The spare parts schedule is marked draft. [1]', [src('O&M agreement.pdf', 'p. 70')]],
  pilot: ['Property tax agreement is a draft', 'Tax', 'Low', 38, 'The payment in lieu of taxes agreement is unsigned. [1]', [src('PILOT agreement (draft).pdf', 'p. 1')]],
  fire: ['Fire code review for the battery is pending', 'Permitting', 'Low', 39, 'The fire marshal’s review of the battery yard is listed as pending. [1]', [src('Permit matrix.xlsx', 'Local!C14')]],
  bond: ['Decommissioning bond amounts differ between the county and the leases', 'Real estate', 'Low', 40, 'The county requires $4 million. [1] The leases require $3 million. [2]', [src('Conditional use permit.pdf', 'p. 11'), src('Ground lease (form).pdf', 'p. 19')]],
  cba: ['Community benefit agreement is unsigned', 'Regulatory', 'Low', 41, 'Only a term sheet for the community benefit agreement is in the data room. [1]', [src('Community benefit term sheet.pdf', 'p. 1')]],
  scada: ['SCADA cybersecurity standard is not specified', 'Technical', 'Low', 42, 'The EPC specification names no cybersecurity standard for SCADA. [1]', [src('EPC contract.pdf', 'p. 210')]],
  mbr: ['Market-based rate authority application is not filed', 'Regulatory', 'Low', 43, 'The regulatory memo lists the application as to be filed. [1]', [src('Regulatory memo.pdf', 'p. 5')]],
};
const day = (n: number) => `2026-10-${String(n % 31 || 1).padStart(2, '0')}T10:00:00.000Z`;
const F: Record<string, Finding> = Object.fromEntries(Object.entries(rows).map(([key, [title, workstream, , d, body, sources]]) => [key, Finding.parse({ id: `f_01HZZZZZZZZZZZZZZZZZZZZ${k++}`, dealId: D, rev: 1, createdAt: day(d), updatedAt: day(d), title, workstream, raisedAt: day(d), origin: 'ai', body: [body], sources })]));
const closedF = ['Construction budget omits the switchyard', 'Survey does not match the legal description', 'Lender’s engineer scope letter missing'].map((title, i) => Finding.parse({ id: `f_01HZZZZZZZZZZZZZZZZZZZZ${k++}`, dealId: D, rev: 1, createdAt: day(2), updatedAt: day(2), title, workstream: ['Construction', 'Real estate', 'Technical'][i], raisedAt: day(2), origin: 'ai', body: ['Closed.'], status: 'closed', closedAt: `2026-11-${String(4 + i * 4).padStart(2, '0')}T10:00:00.000Z` }));
const ratings = Object.fromEntries(Object.entries(rows).map(([key, r]) => [F[key].id, r[2]]));

// questions: 140, some linked to findings with responses
const linked: [number, string, Partial<Question>][] = [
  [14, 'yield', { received: '2026-10-08' }],
  [22, 'ppa', { status: 'answered', response: 'A term sheet for the remaining 100 MW with a second offtaker is in negotiation; we expect signing in Q1 2027.', responded: '2026-11-09' }],
  [9, 'lgia', { status: 'answered', response: 'The utility has confirmed it expects to tender the execution version by year end.', responded: '2026-11-12' }],
  [31, 'upgrades', { received: '2026-10-10' }],
  [37, 'backfeed', { received: '2026-10-14' }],
  [40, 'lds', { status: 'answered', response: 'The contractor has declined to raise the cap above 10%.', responded: '2026-11-03' }],
  [41, 'pcg', { received: '2026-10-15' }],
  [52, 'lockup', { status: 'answered', response: 'The 1.25x in draft 3 is a drafting error and will be corrected in draft 4.', responded: '2026-11-14' }],
  [55, 'battery', { received: '2026-10-18' }],
  [60, 'contingency', { status: 'answered', response: 'The sponsor considers 4% adequate given the fixed-price EPC.', responded: '2026-11-10' }],
  [63, 'flip', { received: '2026-10-20' }],
  [64, 'adder', { received: '2026-10-20' }],
  [70, 'merchant', { received: '2026-10-22' }],
];
const WS = ['Technical', 'Commercial', 'Legal', 'Financial', 'Insurance', 'Environmental & social', 'Permitting', 'Interconnection', 'Construction', 'Tax', 'Real estate', 'Operations', 'Regulatory', 'Accounting', 'KYC'];
const qs = Array.from({ length: 140 }, (_, i) => {
  const n = i + 1; const l = linked.find((x) => x[0] === n);
  const base = { id: `q_01HZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, '0')}`, dealId: D, rev: 1, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', n, text: `Question ${n}`, workstream: l ? F[l[1]].workstream : WS[i % WS.length] };
  if (l) return Question.parse({ ...base, linkedFinding: F[l[1]].id, ...l[2] });
  const st = n % 5 === 0 ? 'closed' : n % 3 === 0 ? 'open' : 'answered';
  return Question.parse({ ...base, status: st, ...(st === 'open' ? { received: `2026-10-${String(1 + (n % 28)).padStart(2, '0')}` } : { response: 'Provided in the data room.', responded: '2026-11-02' }) });
});

// checklist: 2,000 items in four lists
const lists = [['General', 820, 742], ['Construction-to-term loan', 520, 461], ['Solar', 380, 339], ['Storage', 280, 241]] as const;
const checklist = lists.flatMap(([list, n, ok]) => Array.from({ length: n }, (_, i) => ({ text: `${list} item ${i + 1}`, list, kind: (i < ok ? 'satisfied' : i % 3 === 0 ? 'gap' : i % 3 === 1 ? 'finding' : 'open') as 'satisfied' | 'gap' | 'finding' | 'open', need: 'Executed copy' })));

// the risks as the model groups them, the eight key ones written up from the documents
const W = (keys: string[], title: string, body?: string[], sources?: Source[]): RiskGroup => ({ title, findings: keys.map((x) => F[x].id), ...(body ? { body, sources } : {}) });
const groups: RiskGroup[] = [
  W(['yield', 'p90', 'dscr'], 'Debt is sized on an energy yield above the technical advisor’s figure', [
    'The base case assumes a P50 specific yield of 2,085 kWh/kWp in every year of the forecast. [1] The technical advisor’s independent assessment supports 2,010 kWh/kWp, 75 kWh/kWp lower, after it applied higher soiling and availability losses than the sponsor’s energy report. [2] The model does not run the P90 one-year case on which the signed term sheet sizes debt; it runs only the base case and a P50 downside. [3] [4]',
    'The model’s minimum DSCR of 1.31x, against a 1.30x sculpting target and a 1.10x default ratio, is calculated on the base case yield. [5] [4] The model has no case at the advisor’s yield. [3]',
  ], [src('Financial model v14.xlsx', 'Inputs!F22'), src('Technical advisor report.pdf', 'p. 41'), src('Financial model v14.xlsx', 'Scenarios!B4'), src('Term sheet (signed).pdf', 'p. 4'), src('Financial model v14.xlsx', 'Outputs!H40')]),
  W(['ppa', 'merchant'], '25% of the capacity is uncontracted but modeled as contracted', [
    'The executed power purchase agreement with the utility covers 300 MW of the project’s 400 MW at a fixed price of $40/MWh for 15 years. [1] The model treats all 400 MW as contracted at that price from COD. [2] The remaining 100 MW, 30% of capacity, has no offtake agreement in the data room. After year 15, all output is sold at merchant prices taken from the sponsor’s own price curve; no independent market advisor’s report is listed among the advisors’ reports. [3] [4]',
    'From year 16 to maturity in year 18, all of the project’s revenue in the model is merchant revenue priced on the sponsor’s curve. [3]',
  ], [src('Power purchase agreement.pdf', 'p. 3'), src('Financial model v14.xlsx', 'Revenue!D14'), src('Financial model v14.xlsx', 'Prices!C8'), src('Information memorandum.pdf', 'p. 58')]),
  W(['lgia', 'upgrades', 'backfeed'], 'Interconnection is unsigned, its upgrade costs unallocated, and its timing behind the EPC schedule', [
    'The large generator interconnection agreement in the data room is an unsigned draft. [1] The utility’s facilities study estimates network upgrades at $40 million, and the draft agreement leaves blank which party bears them. [2] [3] The sources and uses carry $12.0 million for interconnection, which covers the project’s own facilities but no network upgrades. [4]',
    'The facilities study gives an in-service date for the upgrades in month 24 from notice to proceed, while the EPC schedule assumes backfeed in month 19 and mechanical completion in month 21. [5] [6] The draft agreement does not permit energization before the upgrades are in service; the COD in the model is month 22. [3] [7]',
  ], [src('LGIA (draft).pdf', 'p. 1'), src('Facilities study.pdf', 'p. 17'), src('LGIA (draft).pdf', 'p. 44'), src('Sources and uses.pdf', 'p. 1'), src('Facilities study.pdf', 'p. 22'), src('EPC schedule.pdf', 'p. 7'), src('Financial model v14.xlsx', 'Inputs!F8')]),
  W(['lds', 'pcg'], 'Delay protection under the EPC contract is capped below the exposure and the guarantee is unsigned', [
    'The EPC contract caps delay liquidated damages at 10% of the $400 million contract price, $40 million, at a daily rate of $200,000. [1] The technical advisor estimates the cost of a six-month delay, in lost revenue and debt service during construction, at 15% of the contract price. [2] The contractor’s obligations are to be backed by a parent company guarantee, but the guarantee in the data room is an unsigned form with the guaranteed amount left blank. [3]',
    'At the agreed daily rate the cap is reached after 200 days ($40 million / $200,000 a day); the contract provides no liquidated damages for delay beyond that. [1]',
  ], [src('EPC contract.pdf', 'p. 88'), src('Technical advisor report.pdf', 'p. 63'), src('EPC parent guarantee (form).pdf', 'p. 1')]),
  W(['lockup', 'testperiod'], 'Distribution terms in the draft credit agreement differ from the signed term sheet', [
    'Draft 3 of the credit agreement sets the distribution lock-up at a DSCR of 1.25x, measured over the previous six months. [1] [2] The signed term sheet sets it at 1.30x over the previous twelve months. [3] Both terms govern when cash can be distributed to the sponsor.',
  ], [src('Credit agreement (draft 3).pdf', 'p. 142'), src('Credit agreement (draft 3).pdf', 'p. 143'), src('Term sheet (signed).pdf', 'p. 6')]),
  W(['battery', 'augment'], 'Battery performance is warranted for 10 years of an 18-year loan, with no augmentation budget', [
    'The battery supply agreement warrants capacity retention for 10 years from the commercial operation date, to 70% of nameplate. [1] The loan amortizes over 18 years. [2] The operating budget has no line for augmentation, and the model holds storage revenue flat at the year-10 level through maturity. [3] [4]',
    'Storage revenue in years 11 to 18, 11% of revenue in those years, is modeled on capacity beyond the warranty period with no augmentation cost. [4]',
  ], [src('Battery supply agreement.pdf', 'p. 22'), src('Term sheet (signed).pdf', 'p. 3'), src('Financial model v14.xlsx', 'Opex!E30'), src('Financial model v14.xlsx', 'Revenue!F40')]),
  W(['contingency'], 'Construction contingency is below the technical advisor’s range', [
    'The sources and uses carry a contingency of $16 million, 4% of the EPC price. [1] The technical advisor gives 6–8% for a project of this size and stage, $24 to $32 million. [2] The difference of $8 to $16 million is not funded elsewhere in the sources and uses. [1]',
  ], [src('Sources and uses.pdf', 'p. 1'), src('Technical advisor report.pdf', 'p. 71')]),
  W(['flip', 'adder'], 'Tax equity flip date and credit adder in the model differ from the tax documents', [
    'The model assumes the tax equity investor reaches its target return and flips in year 6. [1] The tax equity term sheet targets year 8. [2] The model also adds 10 points of investment tax credit for domestic content, lifting the credit from 30% to 40%. [3] The tax advisor’s memo covers the base credit and the energy community adder but not domestic content. [4]',
    'The model sizes the tax equity commitment of $300 million on both assumptions. [3] [1]',
  ], [src('Financial model v14.xlsx', 'TaxEquity!C12'), src('Tax equity term sheet.pdf', 'p. 2'), src('Financial model v14.xlsx', 'TaxEquity!C20'), src('Tax advisor memo.pdf', 'p. 3')]),
  W(['title', 'options'], 'Title exceptions and lease options expiring before financial close'),
];

const summary = [
  'Project Southridge is a 400 MW solar project with a 200 MW battery, owned by Southridge Solar Holdings LLC. The financing is a $500 million construction-to-term loan that converts at COD, expected in the third quarter of 2028, into an 18-year amortizing term loan sculpted to a 1.30x DSCR, alongside a tax equity commitment of $300 million. A 15-year power purchase agreement with the local utility covers 300 MW at $40/MWh; the battery earns capacity and merchant revenue.',
  'Four risks rate High. Debt is sized on an energy yield 75 kWh/kWp above the technical advisor’s figure, and the model has no P90 case. 25% of the capacity has no offtake but is modeled as contracted. The interconnection agreement is unsigned, $40 million of network upgrades are unallocated, and the utility’s timetable is five months behind the EPC schedule. Delay damages are capped at 10% of the EPC price against an estimated 15% exposure, and the parent guarantee is unsigned.',
];

/** the made-up deal's memo content, at scale */
export const scaleMemo = (withGroups = true) => memoContent({
  deal, firm: '[firm name]', today: '2026-11-18', findings: [...Object.values(F), ...closedF], questions: qs, checklist,
  summary, ratings, keyRisks: 8, ...(withGroups ? { groups } : {}),
});
