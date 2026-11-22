// The stand-in for reading an issues list: a text file's numbered lines are its points, a line that does not start
// with a number carries the point above it on, and a point repeats a finding or an earlier point as the stand-in
// duplicate check pairs checklist items.
import { describe, it, expect } from 'vitest';
import { mockAi, mockDocuments } from '../../src/adapters/mocks';

const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
async function read(text: string, findings: { id: string; title: string; text: string }[] = []) {
  const opts = { latency: [0, 0] as [number, number] };
  const doc = val(await mockDocuments(opts).attach('d1', { name: 'list.txt', bytes: new TextEncoder().encode(text) }));
  return mockAi(opts).issuesList!({ dealId: 'd1', doc, findings, workstreams: ['Legal', 'Financial'] });
}

describe('the stand-in issues list reader', () => {
  it('reads numbered points, joins a point’s next line, and finds what each repeats', async () => {
    const out = val(await read('Sponsor counsel comments\n1. Debt service reserve letter of credit issuer rating\n   must be A- or better.\n2) Change of control definition omits fund vehicles\n3\tDebt service reserve letter of credit issuer rating must be A- or better.', [{ id: 'f1', title: 'Change of control definition omits the sponsor fund vehicles', text: '' }]));
    expect(out.points.map((p) => [p.n, p.same])).toEqual([['1', undefined], ['2', { finding: 'f1' }], ['3', { point: 0 }]]);
    expect(out.points[0].text).toBe('Debt service reserve letter of credit issuer rating must be A- or better.');
    expect(out.points[0].workstream).toBe('Financial');
  });
  it('a file with no numbered lines is no issues list', async () => {
    const r = await read('Nothing numbered here.'); expect(r.ok).toBe(false);
  });
});
