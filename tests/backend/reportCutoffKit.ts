import { cutOff } from '../../src/backend/limits';
import { stateOf, type ReportLine } from '../../src/backend/reports';
import type { Repository } from '../../src/ports';
import { checkLines, deal, doc, Mem, setup, val, type Call } from './reviewKit';

export const report = doc(832, 'Independent Engineer Report.pdf', { pages: 60 });
export const docId = report.docId;

export interface Row {
  title: string;
  workstream: string;
  body: string[];
  sources: { doc: string; page: number; quote: string }[];
}

export function row(title: string, page = 1): Row {
  return {
    title, workstream: 'Technical', body: [`The independent engineer reports that ${title}. [1]`],
    sources: [{ doc: docId, page, quote: title }],
  };
}

export function cutAfter(
  rows: object[], complete: number, fragment = '{"title":"The next observation stops', preface = '',
): never {
  const prefix = JSON.stringify(rows.slice(0, complete)).slice(1, -1);
  const text = `${preface}{"issues":[${prefix}${prefix ? ',' : ''}${fragment}`;
  throw cutOff('The reply reached the output limit', text);
}

export async function reader(reply: (call: Call, count: number) => string, use?: { shared: Mem; repo: Repository }) {
  const shared = use?.shared ?? new Mem();
  const s = setup(() => ({}), { d1: [report] }, { shared, installId: 'office', repo: use?.repo });
  if (!use) await deal(s.repo);
  const calls: Call[] = [];
  s.svc.reports = (call) => {
    if (!call.files.length) return JSON.stringify({ reports: [docId], unsure: [] });
    calls.push(call);
    return reply(call, calls.length);
  };
  return {
    ...s,
    shared,
    calls,
    state: () => {
      const lines: ReportLine[] = checkLines(shared).flatMap((line) => line.report ? [line.report] : []);
      return stateOf(lines);
    },
    async sweep() {
      val(await s.ai.firstPass('d1'));
      await s.ai.settled();
    },
  };
}

export function reportIssues() {
  const facilities = [
    'Alder Ridge', 'Beacon Fell', 'Brookmere', 'Cedar Bluff', 'Clifton Heath', 'Dunwich Moor', 'Elmgate',
    'Fairhaven', 'Gannet Bay', 'Hawthorn Point', 'Ivy Downs', 'Juniper Hill', 'Kestrel Vale', 'Longwater',
    'Maple Ford', 'Northfield', 'Oakmere', 'Pine Rigg', 'Quarry Bank', 'Redcliff',
  ];
  const equipment = ['storage system', 'main transformer', 'substation', 'switchgear', 'control system'];
  const observations = [
    'has no commissioning acceptance record', 'is excluded from the maintenance agreement',
    'has overdue factory-test documentation', 'has a warranty that expires before debt maturity',
    'has no spare parts allocation in the base case', 'falls outside the current replacement budget',
  ];
  return facilities.flatMap((site) => equipment.flatMap((asset) => observations.map((observation) =>
    `the ${site} ${asset} ${observation}`,
  ))).map((title, index) => row(title, 1 + Math.floor(index / 10)));
}
