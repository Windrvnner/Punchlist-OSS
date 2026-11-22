// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { docFamilies, type DocFamilies } from '../../src/backend/related';
import { coreSet, type CoreDoc } from '../../src/backend/core';
import { control } from '../../src/control';
import expected from './fixtures/familyRooms/prototype.json';

// Complete families (docs/core-families-design.md). The sample rooms are the 34 the design was checked against; prototype.json
// holds what the prototype made of the hand-written ones (each placed document's agreements, each series' newest
// member and size).
const L = control.lists;
const filler = new Set([...L.searchFiller, ...L.indexFiller].map((w) => w.toLowerCase()));
const read = (paths: string[], skip?: Set<string>) => docFamilies({ docs: paths.map((p) => ({ docId: p, path: p })), skip, library: L.synonyms as string[][], filler, relation: L.relationWords, instrument: L.instrumentWords, series: L.seriesWords, part: L.partWords });
const room = async (name: string): Promise<string[]> => (await import(`./fixtures/familyRooms/${name}.ts`)).ROOM;
const last = (p: string) => p.split('/').pop()!;
/** each placed document's agreements, and each series as "newest|size" */
const seen = (f: DocFamilies) => ({ placed: new Map([...f.of].map(([d, a]) => [d, [...a].sort()])), series: f.series.map((s) => `${last(s[0])}|${s.length}`).sort() });

/** where the module places more than the prototype did, and why */
const MORE: Record<string, string[]> = {
  // a "Leases" folder over three numbered leases: the prototype did not fold "Leases" to "lease", so it saw nothing in common; the design ties it to all three
  x3: ['Real Estate/Leases/Amendment No. 1.pdf', 'Real Estate/Leases/Exhibit A - Legal Description.pdf'],
  // "PCG" is in the synonyms library (parent company guarantee), so "PCG - Sponsor Parent" is an agreement; the prototype's stand-in library lacked it
  x6: ['Offtake/PCG/Schedule 1 - Guaranteed Obligations.pdf'],
};

describe('complete families: the sample rooms', () => {
  for (const [name, want] of Object.entries(expected as Record<string, { placed: Record<string, string[]>; series: string[] }>)) {
    it(`${name}: places what the prototype placed, under the same agreements, and finds the same series`, async () => {
      const got = seen(read(await room(name)));
      // every placement of the prototype's holds (a draft of the same agreement may be added: drafts of one agreement each list its members)
      for (const [doc, parents] of Object.entries(want.placed)) for (const p of parents) expect(got.placed.get(doc), doc).toContain(p);
      for (const doc of got.placed.keys()) if (!want.placed[doc]) expect(MORE[name] ?? [], doc).toContain(doc);
      expect(got.series).toEqual(want.series);
    });
  }
});

describe('complete families: what the design promises', () => {
  it('the generated room: EPC contract 85, credit agreement 27, PPA 11, each lease amendment under its own parcel\'s lease', async () => {
    const f = read(await room('room'));
    const size = (re: RegExp) => [...f.members].filter(([a]) => re.test(a)).map(([, m]) => m.length);
    expect(size(/EPC Contract \(execution version\)/)).toEqual([85]);
    expect(size(/Credit Agreement\/Credit Agreement \(conformed\)/)).toEqual([27]);
    expect(new Set(size(/PPA\/.*Power Purchase Agreement/))).toEqual(new Set([11]));
    for (const [doc, a] of f.of) if (/Amendment to Lease - Parcel (\d+)/.test(doc)) expect(a.map(last)).toEqual([`Lease Agreement - Parcel ${/Parcel (\d+)/.exec(doc)![1]}.pdf`]);
  });
  it('a relation word not used as one leaves the name ordinary; no related document is in a series; no "Form of" document is an agreement', async () => {
    for (const name of Object.keys(expected)) {
      const paths = await room(name); const f = read(paths); const series = new Set(f.series.flat());
      for (const d of paths) if (/(?:^|\/)(?:Construction Schedule|Payment Schedule|Credit Support Annex)\.[a-z]+$/.test(d)) { expect(f.of.has(d), d).toBe(false); expect(series.has(d), d).toBe(false); }
      for (const d of f.of.keys()) expect(series.has(d), d).toBe(false);
      for (const a of f.members.keys()) expect(/\bform of\b/i.test(last(a)), a).toBe(false);
      for (const [d, a] of f.of) expect(new Set(a.map((x) => last(x).replace(/\s+v\d+(?=\.)/i, ''))).size, d).toBeLessThanOrEqual(3);
    }
  });
  it('change orders and proposed change orders come in with their contract', () => {
    const f = read(['EPC/EPC Contract.pdf', 'EPC/Change Orders/CO #12 - Fencing.pdf', 'EPC/Change Orders/Change Order 3.pdf', 'EPC/PCO-01.pdf', 'Finance/Credit Agreement.pdf']);
    expect(f.members.get('EPC/EPC Contract.pdf')?.slice().sort()).toEqual(['EPC/Change Orders/CO #12 - Fencing.pdf', 'EPC/Change Orders/Change Order 3.pdf', 'EPC/PCO-01.pdf']);
  });
  // UK names other parties use, kept on purpose like 'licence'
  it('annexures, variations, variation orders and deeds of variation come in with their contract', () => {
    const agreement = 'EPC/EPC Contract.pdf';
    const related = [
      'EPC/Annexure 1.pdf', 'EPC/VO-01.pdf', 'EPC/Variation Order 02.pdf', 'Deed of Variation 1.pdf', 'Variation 1.pdf',
    ];
    const families = read([agreement, ...related]);
    expect(families.members.get(agreement)?.slice().sort()).toEqual(related.slice().sort());
  });
  it('numbered EPC schedules are a family, never a series (the bug this part fixes)', () => {
    const paths = ['EPC/EPC Contract.pdf', ...Array.from({ length: 22 }, (_, i) => `EPC/Schedules/Schedule ${i + 1}.pdf`)];
    const f = read(paths);
    expect(f.series).toEqual([]); expect(f.members.get('EPC/EPC Contract.pdf')).toHaveLength(22);
  });
  it('a blackline or a precedent is in no family and no series, and is never an agreement', () => {
    const f = read(['PPA/Power Purchase Agreement.pdf', 'PPA/Power Purchase Agreement (blackline).pdf', 'PPA/Exhibit A.pdf', 'Precedents/Power Purchase Agreement.pdf', 'Precedents/Exhibit B to Power Purchase Agreement.pdf', 'PPA/PPA vs Other Deal.pdf'], new Set(['PPA/PPA vs Other Deal.pdf']));
    expect(f.members.get('PPA/Power Purchase Agreement.pdf')).toEqual(['PPA/Exhibit A.pdf']);
    expect([...f.members.keys()]).toEqual(['PPA/Power Purchase Agreement.pdf']); expect(f.of.size).toBe(1);
  });
  it('a member under the drafts of one agreement is under that agreement alone', () => {
    const f = read(['PPA/Power Purchase Agreement v1.pdf', 'PPA/Power Purchase Agreement v2.pdf', 'PPA/Schedule 1 - Pricing.pdf', 'PPA/Schedule 2 - Metering.pdf']);
    expect(f.of.get('PPA/Schedule 1 - Pricing.pdf')).toHaveLength(2); expect(f.alone.has('PPA/Schedule 1 - Pricing.pdf')).toBe(true);
  });
  it('a series varies by a period only: each asset\'s reports stay apart', () => {
    const solar = read(['Ops/Q1 2025 Quarterly Report - Solar 1.pdf', 'Ops/Q1 2025 Quarterly Report - Solar 2.pdf', 'Ops/Q1 2025 Quarterly Report - Solar 3.pdf']);
    expect(solar.series).toEqual([]);
    const wind = read(['Jan', 'Feb', 'Mar'].flatMap((m) => [1, 2].map((n) => `Ops/Monthly Report ${m} 2025 - Wind Farm ${n}.pdf`)));
    expect(wind.series.map((s) => s.map(last)).sort()).toEqual([['Monthly Report Mar 2025 - Wind Farm 1.pdf', 'Monthly Report Feb 2025 - Wind Farm 1.pdf', 'Monthly Report Jan 2025 - Wind Farm 1.pdf'], ['Monthly Report Mar 2025 - Wind Farm 2.pdf', 'Monthly Report Feb 2025 - Wind Farm 2.pdf', 'Monthly Report Jan 2025 - Wind Farm 2.pdf']]);
  });
  it('"Construction Schedule", "Payment Schedule" and "Credit Support Annex" stay ordinary beside an agreement sharing their words; "ISDA Schedule" joins its master agreement', () => {
    const f = read(['EPC/Construction Agreement.pdf', 'EPC/Construction Schedule.pdf', 'EPC/Payment Bond.pdf', 'EPC/Payment Schedule.pdf', 'Hedge/Credit Support Deed.pdf', 'Hedge/Credit Support Annex.pdf', 'Hedge/ISDA Master Agreement.pdf', 'Hedge/ISDA Schedule.pdf']);
    expect([...f.of.keys()]).toEqual(['Hedge/ISDA Schedule.pdf']);
  });
  it('a blackline blacklines.ts knows is never an agreement', () => {
    const f = read(['Offtake/Offtake Agreement - redlined.pdf', 'Offtake/Exhibit A - Delivery Point.pdf', 'Offtake/Exhibit B - Pricing.pdf']);
    expect(f.members.size).toBe(0);
  });
  it('"CO2" is no change order; "CO #12" is', () => {
    const f = read(['Environmental/Environmental Permit.pdf', 'Environmental/CO2 Emissions Report.pdf', 'Environmental/CO #12.pdf']);
    expect([...f.of.keys()]).toEqual(['Environmental/CO #12.pdf']);
  });
  it('stays under a second with 2,000 agreements and 3,000 attachments that fit none of them', () => {
    const paths = [...Array.from({ length: 2000 }, (_, i) => `Contracts/Vendor ${i}/Services Agreement ${i}.pdf`), ...Array.from({ length: 3000 }, (_, i) => `Correspondence/Item ${i}/Attachment ${i % 7}.pdf`)];
    read(paths.slice(0, 50)); const t0 = performance.now(); read(paths); expect(performance.now() - t0).toBeLessThan(1000);
  });
  it('two projects\' contracts of one name are two agreements: a member tied between them is under neither alone', () => {
    const f = read(['Projects/Relecloud/EPC/EPC Contract.pdf', 'Projects/Relecloud/EPC/Schedule 1 - Scope.pdf', 'Projects/Southridge/EPC/EPC Contract.pdf', 'Projects/Southridge/EPC/Schedule 1 - Scope.pdf', 'Projects/Amendment No. 1 to EPC Contract.pdf']);
    expect(f.of.get('Projects/Amendment No. 1 to EPC Contract.pdf')).toHaveLength(2); expect(f.alone.has('Projects/Amendment No. 1 to EPC Contract.pdf')).toBe(false);
    expect(f.alone.has('Projects/Relecloud/EPC/Schedule 1 - Scope.pdf')).toBe(true);
  });
  it('undated monthly records of several assets stay apart; a running number after the record\'s word is a period', () => {
    expect(read([1, 2, 3].map((n) => `Rep/Monthly Report - Solar ${n}.pdf`)).series).toEqual([]);
    expect(read([1, 2, 3].map((n) => `Rep/Wind Farm ${n} Monthly Reports/Report.pdf`)).series).toEqual([]);
    expect(read([1, 2, 3].map((n) => `Rep/Monthly Report ${n}.pdf`)).series.map((s) => last(s[0]))).toEqual(['Monthly Report 3.pdf']);
  });
  it('a company\'s "Co" is no change order', () => {
    const f = read(['Corporate/LLC Agreement of Relecloud OpCo.pdf', 'Corporate/Relecloud Co 2 - Officer Certificate.pdf', 'G/Contoso Co. Guarantee.pdf', 'G/Schedule 1.pdf']);
    expect([...f.of.keys()]).toEqual(['G/Schedule 1.pdf']);
    expect(read(['Jan', 'Feb', 'Mar', 'Apr'].map((m) => `R/Contoso Co Monthly Report ${m} 2025.pdf`)).series).toHaveLength(1);
  });
  it('the newest is the latest month, also with no year or a two-digit one', () => {
    expect(read(['August', 'September', 'October'].map((m) => `R/FY2025 Reports/Monthly Report ${m}.pdf`)).series.map((s) => last(s[0]))).toEqual(['Monthly Report October.pdf']);
    expect(read(['Nov 24', 'Dec 24', 'Jan 25', 'Feb 25'].map((m) => `R/Monthly Report ${m}.pdf`)).series.map((s) => last(s[0]))).toEqual(['Monthly Report Feb 25.pdf']);
  });
  it('an executed copy and drafts in sibling stage folders are one agreement', () => {
    const f = read(['EPC/Executed/EPC Contract.pdf', 'EPC/Drafts/2024-09-10/EPC Contract.docx', 'EPC/Schedule 1 to EPC Contract.pdf']);
    expect(f.of.get('EPC/Schedule 1 to EPC Contract.pdf')).toHaveLength(2); expect(f.alone.has('EPC/Schedule 1 to EPC Contract.pdf')).toBe(true);
  });
  it('a change order written "Co" first in its name is one; "Co" after a name is a company', () => {
    const f = read(['EPC/EPC Contract.pdf', 'EPC/Co 12 - Fence.pdf', 'EPC/Co. 13 - Gate.pdf', 'EPC/Change Orders/co 1.pdf', 'EPC/EPC Co 14 - Gate.pdf', 'EPC/Contoso Co 2 - Officer Certificate.pdf']);
    expect([...f.of.keys()].sort()).toEqual(['EPC/Change Orders/co 1.pdf', 'EPC/Co 12 - Fence.pdf', 'EPC/Co. 13 - Gate.pdf', 'EPC/EPC Co 14 - Gate.pdf']);
  });
  it('a two-digit number after a month is a day unless the series reads as month and year', () => {
    expect(read(['May 31', 'Jun 10', 'Jun 11'].map((m) => `R/2025/Daily Report ${m}.pdf`)).series.map((s) => last(s[0]))).toEqual(['Daily Report Jun 11.pdf']);
    expect(read(['May-24-2025', 'May-25-2025', 'Jun-02-2025'].map((m) => `R/Daily Report ${m}.pdf`)).series.map((s) => last(s[0]))).toEqual(['Daily Report Jun-02-2025.pdf']);
  });
  it('three years of monthly reports, and a mix of two- and four-digit years, end on the latest month', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const long = read([...[22, 23, 24].flatMap((y) => months.map((m) => `R/Monthly Report ${m} ${y}.pdf`)), ...['Jan', 'Feb', 'Mar'].map((m) => `R/Monthly Report ${m} 25.pdf`)]);
    expect(long.series.map((s) => last(s[0]))).toEqual(['Monthly Report Mar 25.pdf']);
    expect(read(['Nov 2024', 'Dec 24', 'Jan 25', 'Feb 25'].map((m) => `R/Monthly Report ${m}.pdf`)).series[0].map(last)).toEqual(['Monthly Report Feb 25.pdf', 'Monthly Report Jan 25.pdf', 'Monthly Report Dec 24.pdf', 'Monthly Report Nov 2024.pdf']);
  });
  it('"P1", "P2" are plants, not periods', () => {
    expect(read([1, 2, 3].map((n) => `R/Monthly Report - P${n}.pdf`)).series).toEqual([]);
  });
  it('"Issue 7", "Period 7" and "P07" are running numbers', () => {
    for (const w of ['Issue ', 'Period ', 'P0']) expect(read([7, 8, 9].map((n) => `R/Monthly Report ${w}${n}.pdf`)).series, w).toHaveLength(1);
  });
  it('gives the same answer in any input order', async () => {
    for (const name of ['room', 'c1', 'a1', 'x1', 'x12']) {
      const paths = await room(name); const want = seen(read(paths));
      let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let n = 0; n < 3; n++) {
        const a = [...paths]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        expect(seen(read(a))).toEqual(want);
      }
    }
  });
  it('takes under a second for each room of 2,000 files or more', async () => {
    for (const name of ['c5', 'c6', 'p1', 'p2', 'p3', 'p4', 'p5', 'x8', 'x9', 'x10', 'x11']) {
      const paths = await room(name); expect(paths.length).toBeGreaterThanOrEqual(2000);
      read(paths.slice(0, 50));   // warm up
      const t0 = performance.now(); read(paths); expect(performance.now() - t0, name).toBeLessThan(1000);
    }
  }, 60_000);
});

describe('complete families in the core set', () => {
  const library = [['EPC', 'EPC contract'], ['PPA', 'power purchase agreement']];
  const docs: CoreDoc[] = ['Build/EPC Contract.pdf', 'Build/Schedule 1 - Scope.pdf', 'Build/Schedule 2 - Price.pdf', 'Build/First Amendment.pdf', 'Offtake/PPA.pdf', 'Offtake/Appendix 1.pdf', 'Offtake/Side Letter re PPA.pdf', 'Misc/Exhibit B.pdf']
    .map((p) => ({ docId: p, path: p }));
  const families: Pick<DocFamilies, 'members' | 'alone'> = {
    members: new Map([['Build/EPC Contract.pdf', ['Build/Schedule 1 - Scope.pdf', 'Build/Schedule 2 - Price.pdf', 'Build/First Amendment.pdf']], ['Offtake/PPA.pdf', ['Offtake/Appendix 1.pdf', 'Offtake/Side Letter re PPA.pdf', 'Misc/Exhibit B.pdf']], ['Misc/Other Agreement.pdf', ['Misc/Exhibit B.pdf']]]),
    alone: new Set(['Build/Schedule 1 - Scope.pdf', 'Build/Schedule 2 - Price.pdf', 'Build/First Amendment.pdf', 'Offtake/Appendix 1.pdf', 'Offtake/Side Letter re PPA.pdf']),
  };
  const run = (text: string) => coreSet({ docs, items: [{ id: 'i1', text }], library, filler: new Set(['the', 'of', 'to', 'pdf']), ask: new Set(), families });
  it('with the EPC contract core, its whole family is core, after the items\' picks and never among the best', () => {
    const s = run('The EPC contract is in force');
    expect(s.ids).toEqual(expect.arrayContaining(['Build/EPC Contract.pdf', 'Build/Schedule 1 - Scope.pdf', 'Build/Schedule 2 - Price.pdf', 'Build/First Amendment.pdf']));
    expect(s.ids.slice(0, s.best)).not.toContain('Build/Schedule 2 - Price.pdf');
  });
  it('with only a member core, its agreement and family come in; a document in two families brings in neither', () => {
    const s = run('Side letter fees');
    expect(s.ids).toEqual(expect.arrayContaining(['Offtake/Side Letter re PPA.pdf', 'Offtake/PPA.pdf', 'Offtake/Appendix 1.pdf', 'Misc/Exhibit B.pdf']));
    const t = coreSet({ docs, items: [{ id: 'i1', text: 'Exhibit B' }], library, filler: new Set(['the', 'pdf']), ask: new Set(), families });
    expect(t.ids).toContain('Misc/Exhibit B.pdf'); expect(t.ids).not.toContain('Offtake/PPA.pdf');
  });
});
