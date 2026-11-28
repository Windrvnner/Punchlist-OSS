// @vitest-environment node
import { expect, it } from 'vitest';
import { cutOff } from '../../src/backend/limits';
import { stateOf, type ReportLine } from '../../src/backend/reports';
import type { Repository } from '../../src/ports';
import { checkLines, deal, doc, Mem, setup, val, type Call } from './reviewKit';

const report = doc(832, 'Independent Engineer Report.pdf', { pages: 60 });
const docId = report.docId;

interface Row {
  title: string;
  workstream: string;
  body: string[];
  sources: { doc: string; page: number; quote: string }[];
}

function row(title: string, page = 1): Row {
  return {
    title, workstream: 'Technical', body: [`The independent engineer reports that ${title}. [1]`],
    sources: [{ doc: docId, page, quote: title }],
  };
}

function cutAfter(
  rows: object[], complete: number, fragment = '{"title":"The next observation stops', preface = '',
): never {
  const prefix = JSON.stringify(rows.slice(0, complete)).slice(1, -1);
  const text = `${preface}{"issues":[${prefix}${prefix ? ',' : ''}${fragment}`;
  throw cutOff('The reply reached the output limit', text);
}

async function reader(reply: (call: Call, count: number) => string, use?: { shared: Mem; repo: Repository }) {
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

function reportIssues() {
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

it('keeps the complete rows in a 600-issue report across two cutoffs (#1212)', async () => {
  const rows = reportIssues();
  const s = await reader((_call, attempt) => {
    const remaining = rows.slice((attempt - 1) * 200);
    if (attempt === 1) cutAfter(remaining, 200, undefined, 'Here are the issues in the report:\n');
    if (attempt === 2) {
      cutAfter(remaining, 200, `{"title":"spare cable routing","sources":[{"doc":"${docId}","page":41},`);
    }
    return JSON.stringify({ issues: remaining });
  });
  try {
    await s.sweep();
    expect(s.calls).toHaveLength(3);
    expect(s.calls.every((call) => call.files[0].text === s.calls[0].files[0].text)).toBe(true);
    expect(s.calls[1].prompt).toContain('remaining issues');
    expect(s.calls[1].prompt).toContain(rows[199].title);
    expect(s.calls[2].prompt).toContain(rows[399].title);
    const findings = val(await s.repo.list('finding', 'd1')).map(({ envelope }) => envelope.data) as Row[];
    expect(findings.map((finding) => finding.title).sort()).toEqual(rows.map(({ title }) => title).sort());
    expect(s.state().read.get(docId)?.issues).toHaveLength(600);
    expect(s.state().tries('read', docId)).toBe(2);
  } finally {
    await s.ai.close();
  }
});
