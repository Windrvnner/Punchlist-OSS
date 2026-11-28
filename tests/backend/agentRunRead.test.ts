import { describe, expect, it } from 'vitest';
import { AgentRun } from '../../src/backend/agentRun';
import type { AgentKit } from '../../src/backend/agentKit';

/** a run over one deal whose documents have these names, with only what the read tool uses */
function runOver(names: string[], pairs: [string, string][] = []) {
  const recs = names.map((name, i) => ({ docId: `d${i}`, name, pages: 1 }));
  const cleanDrafts = new Map(pairs.map(([blackline, clean]) => [
    recs.find(({ name }) => name === blackline)!.docId,
    recs.find(({ name }) => name === clean)!,
  ]));
  const kit = {
    records: () => recs, where: (rec: { name: string }) => `VDR/Legal/${rec.name}`, cleanDrafts: () => cleanDrafts,
  } as unknown as AgentKit;
  const question = { deals: ['deal'] } as never;
  const progress = { steps: [] } as never;
  return new AgentRun(kit, question, progress, { width: 8, searchPage: 25, chars: 375_000, limit: 750_000 });
}

describe('the read tool finds a document by the name it has', () => {
  it('finds a document whose own name starts and ends with a bracket', () => {
    const run = runOver(['[Draft] SPA.docx', '[Draft]']);
    expect(run.read(['[Draft]'], 5)).toContain('attached');
    expect(run.whole.map((s) => s.rec.name)).toEqual(['[Draft]']);
  });

  it('still takes off a quote or bracket the model wrapped around a name', () => {
    const run = runOver(['SPA.docx']);
    run.read(['"SPA.docx"'], 5);
    expect(run.whole.map((s) => s.rec.name)).toEqual(['SPA.docx']);
  });

  it('says which name it did not find, without the wrapping', () => {
    expect(runOver(['SPA.docx']).read(['[Lease.pdf]'], 5)).toContain('Not found: Lease.pdf');
  });
});

const ordinary = [
  'Senior Credit Agreement.pdf', 'Land Lease.pdf', 'EPC Scope Schedule.pdf', 'Insurance Schedule.pdf',
  'Financial Model Audit.pdf', 'Grid Connection Agreement.pdf', 'Environmental Permit.pdf',
  'Operations and Maintenance Agreement.pdf',
];
const spa: [string, string] = ['SPA - blackline v3 vs v2.pdf', 'SPA v3 clean.pdf'];
const storage: [string, string] = [
  'Storage Services Agreement - blackline v4 vs v3.pdf', 'Storage Services Agreement v4.pdf',
];
const direct: [string, string] = ['Direct Agreement - blackline v2 vs v1.pdf', 'Direct Agreement v2.pdf'];

describe('the read tool keeps blacklines with their clean draft (#1213)', () => {
  it('names a deferred blackline and opens its pair only on the next read', () => {
    const first = ordinary.slice(0, 7);
    const run = runOver([...first, ...spa], [spa]);
    const citations = spa.map((doc, index) => ({ doc, dealId: 'deal', docId: `d${7 + index}`, loc: 'p. 1' }));
    const result = run.read([...first, spa[0]], 8);
    expect(run.whole.map(({ rec }) => rec.name)).toEqual(first);
    expect(result).toContain(`VDR/Legal/${spa[0]}`);
    expect([...run.touched].map(({ rec }) => rec.name)).toEqual(first);
    expect(run.idsOf(citations)).toEqual(['?', '?']);

    const again = run.read([`VDR/Legal/${spa[0]}`], 8);
    expect(run.whole.map(({ rec }) => rec.name)).toEqual([spa[1], spa[0]]);
    expect(again).toContain('attached');
    expect(run.idsOf(citations)).toEqual(['d7', 'd8']);
    expect([...run.touched].map(({ rec }) => rec.name)).toEqual([...first, spa[1], spa[0]]);
  });

  it('names each deferred request in a twelve-document read with three blacklines', () => {
    const picked = [
      ordinary[0], spa[0], ordinary[1], ordinary[2], storage[0], ordinary[3],
      ordinary[4], direct[0], direct[1], ordinary[5], ordinary[6], ordinary[7],
    ];
    const run = runOver([...new Set([...ordinary, ...spa, ...storage, ...direct])], [spa, storage, direct]);
    const result = run.read(picked, 8);
    const sent = [ordinary[0], spa[1], spa[0], ordinary[1], ordinary[2], storage[1], storage[0], ordinary[3]];
    expect(run.whole.map(({ rec }) => rec.name)).toEqual(sent);
    expect([...run.touched].map(({ rec }) => rec.name)).toEqual(sent);
    expect(run.opened.map(({ rec }) => rec.name)).toEqual(sent);
    expect(run.steps.map(({ text }) => text)).toEqual(sent.map((name) => `Reviewed ${name}`));
    for (const name of picked.slice(6)) expect(result).toContain(`VDR/Legal/${name}`);
  });

  it('does not defer a clean draft already attached alongside its blackline', () => {
    const run = runOver([...spa, ...ordinary], [spa]);
    const result = run.read([spa[0], ...ordinary, spa[1]], 8);
    expect(result).toContain(`VDR/Legal/${ordinary[6]}`);
    expect(result).not.toContain(`VDR/Legal/${spa[1]}`);
    expect(run.whole.map(({ rec }) => rec.name)).toEqual([spa[1], spa[0], ...ordinary.slice(0, 6)]);
  });
});
