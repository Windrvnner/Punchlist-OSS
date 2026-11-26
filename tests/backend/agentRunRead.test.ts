import { describe, expect, it } from 'vitest';
import { AgentRun } from '../../src/backend/agentRun';
import type { AgentKit } from '../../src/backend/agentKit';

/** a run over one deal whose documents have these names, with only what the read tool uses */
function runOver(names: string[]) {
  const recs = names.map((name, i) => ({ docId: `d${i}`, name, pages: 1 }));
  const kit = { records: () => recs, where: (rec: { name: string }) => rec.name } as unknown as AgentKit;
  const question = { deals: ['deal'] } as never;
  const progress = { steps: [] } as never;
  return new AgentRun(kit, question, progress, 10_000);
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
