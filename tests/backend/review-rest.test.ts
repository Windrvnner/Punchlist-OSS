// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { nodeDocuments } from '../../src/backend/documents';
import type { Converter } from '../../src/backend/convert';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { StandInService } from '../../src/backend/service';
import { nodeAi } from '../../src/backend/ai';
import { memRepo } from '../adapters/memRepo';
import { setup, doc, val, ask, deal, finding, listed, itemsIn, Mem, checkLines, type Call, OK, nth, affectedAs } from './reviewKit';
import type { DocRecord } from '../../src/backend/documents';

const made: string[] = []; afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-review-')); made.push(d); return d; };
const put = (root: string, rel: string, data: string | Uint8Array) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 10, 9, 0, 0, t++)).toISOString();
function pdf(text: string, pages = 1): Uint8Array {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) { const stream = `BT /F1 12 Tf 72 720 Td (${text}, page ${i + 1}) Tj ET`; objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let out = '%PDF-1.4\n'; const at: number[] = []; objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
const converter = (): Converter => Object.assign(async (file: string, outDir: string, outName: string) => { if (/Locked/.test(file)) throw new Error('password'); const out = path.join(outDir, outName); fs.writeFileSync(out, pdf(`converted from ${path.basename(file).replace(/[()]/g, '')}`, 3)); return out; }, { id: 'stand-in' });
function pc(root: string, name: string, svc = new StandInService()) {
  const sharedPath = path.join(root, 'shared'); const shared = nodeFolder(sharedPath), local = nodeFolder(path.join(root, `local-${name}`));
  const keeper = new StoreKeeper(svc, local, { clock, recheckMs: 0 }); const done: string[] = [];
  const docs = nodeDocuments({ shared, local, sharedPath, installId: name, keeper, clock, workPath: path.join(root, `work-${name}`), convert: converter(), folders: async () => [path.join(root, 'vdr')], onIndexed: (d) => done.push(d) });
  return { docs, svc, keeper, shared };
}
const folder = (p: string) => ({ path: p, label: 'Data room', files: 0, size: '', indexed: 0, reviewed: 0 });
const indexAll = async (x: ReturnType<typeof pc>, vdr: string) => { val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1'); return val(await x.docs.poll('d1')); };

// Each test here is a defect that was reproduced, then fixed, now asserting the behavior that fixes it.
describe('the document service on real folders', () => {
  it('indexing reviews nothing and says so: nothing is counted as reviewed, and the files left out or without text are named', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const blank = new TextEncoder().encode(new TextDecoder().decode(pdf('', 2)).replace(/\(, page \d\) Tj/g, (m) => ' '.repeat(m.length)));
    put(vdr, 'Credit Agreement.pdf', pdf('credit agreement', 3)); put(vdr, 'PPA executed.pdf', blank); put(vdr, 'Locked.docx', 'protected'); put(vdr, 'Broken.pdf', 'not a pdf');
    const a = pc(root, 'office'); const p = await indexAll(a, vdr);
    expect(p.folders[0]).toMatchObject({ files: 4, indexed: 4, reviewed: 0 }); expect(a.docs.records('d1').length).toBe(2); expect(a.svc.calls.length).toBe(0);
    expect(p.log).toEqual(['Indexed 2 files', '2 files could not be turned into pages and were not indexed: Broken.pdf, Locked.docx', '1 file has no readable text and can be found by name only: PPA executed.pdf']);
  });

  it('a file that is deleted or replaced by a new draft leaves the records, and the first pass sees that a document has gone', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr');
    put(vdr, 'Credit Agreement.pdf', pdf('credit agreement draft one margin', 3)); put(vdr, 'Side letter.pdf', pdf('side letter'));
    const a = pc(root, 'office'); await indexAll(a, vdr); const v1 = a.docs.records('d1').find((r) => r.name === 'Credit Agreement.pdf')!;
    a.docs.describe('d1', v1.docId, { summary: 'Credit agreement, first draft.', keywords: ['margin'] });
    put(vdr, 'Credit Agreement.pdf', pdf('credit agreement draft two margin changed', 4)); fs.rmSync(path.join(vdr, 'Side letter.pdf'));    // a new draft saved over the old one; another file withdrawn
    await indexAll(a, vdr); const recs = a.docs.records('d1');
    const wanted = await a.docs.wanted('d1', recs.map((r) => r.docId));
    expect(recs.map((r) => [r.name, r.pages, r.summary])).toEqual([['Credit Agreement.pdf', 4, undefined]]); expect(wanted.length).toBe(1);   // one credit agreement, the new draft; no side letter
    // with the real document service behind it, the first pass sees the document as gone: the finding that cites it is marked, and the item it satisfied is looked at again
    const svc = new StandInService((c) =>
      c.prompt.includes('Check each of these')
        ? JSON.stringify({ items: [{ id: 'k1', result: 'ok', where: [{ doc: nth(c, 1), page: 1 }] }] })
        : c.prompt.includes('core documents')
          ? '{"core": []}'
          : 'I cannot say',
    );
    const keeper = new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock }); const repo = memRepo(clock); const shared = new Mem();
    const root2 = tmp(); const vdr2 = path.join(root2, 'vdr'); put(vdr2, 'Side letter.pdf', pdf('side letter step-in rights')); const b = pc(root2, 'office'); await indexAll(b, vdr2);
    const ai = nodeAi({ service: svc, docs: b.docs, keeper, repo, shared, installId: 'office', clock, checklist: () => ({ broad: [{ id: 'k1', text: 'The side letter gives step-in rights' }], product: [], sector: [] }) });
    await deal(repo); await finding(repo, 'f_1', 'Side letter limits step-in', { sources: [{ doc: 'Side letter.pdf', loc: 'p. 1', docId: b.docs.records('d1')[0].docId }] });
    val(await ai.firstPass('d1')); const n = svc.calls.length; fs.rmSync(path.join(vdr2, 'Side letter.pdf')); put(vdr2, 'Other.pdf', pdf('canteen menu')); await indexAll(b, vdr2);
    const r = val(await ai.firstPass('d1')); const f = val(await repo.get('finding', 'f_1'))!.envelope.data as any;
    expect(r.marked).toEqual(['f_1']); expect(f).toMatchObject({ updated: true, updatedWhy: 'A document it cites is no longer in the data room' }); expect(checkLines(shared).filter((l) => l.item).map((l) => l.result)).toEqual(['ok', 'gap']); expect(r.gaps).toEqual([{ title: 'The side letter gives step-in rights' }]);
  });

  it('a binary Excel model (.xlsb) and an OpenDocument sheet (.ods) are spreadsheets: cells, not pages, and no conversion', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); put(vdr, 'Financial Model v12.xlsb', 'PK-not-really'); put(vdr, 'Model.ods', 'PK-not-really-2');
    const a = pc(root, 'office'); await indexAll(a, vdr);
    expect(a.docs.records('d1').map((r) => [r.name, r.pages, r.via])).toEqual([['Financial Model v12.xlsb', undefined, undefined], ['Model.ods', undefined, undefined]]);
  });
});

describe('other', () => {
  it('a chat answer is told it holds a handful of the data room, and how many it read comes back with it', async () => {
    const many = Array.from({ length: 400 }, (_, i) => doc(100 + i, `Contract ${String(i).padStart(3, '0')}.pdf`, { words: ['contract', 'supplier', 'price', 'control'] }));
    const s = setup(() => ({ text: 'None of the contracts in the data room contains a change of control clause.', sources: [] }), { d1: many }, { pick: () => ({ read: [1, 2, 3, 4, 5, 6, 7, 8] }) });
    const a = val(await s.ai.answer(ask('Does any contract in the data room contain a change of control clause?')));
    expect(s.calls[0].files.length).toBe(8); expect(a.read).toEqual({ docs: 8, of: 400 });
    expect(s.calls[0].prompt).toContain('These are 8 of the 400 documents in the data room: the ones chosen as likeliest to bear on this. You have not seen the others, so do not say what the data room as a whole does or does not contain; say what these documents show.');
  });

  it('two PCs whose clocks differ: the later result wins on both, whatever the clocks say', async () => {
    const shared = new Mem(); const repo = memRepo(clock); const recs: Record<string, DocRecord[]> = { d1: [doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'margin'] })] };
    const LIST = () => ({ broad: [{ id: 'k1', text: 'A decommissioning bond is in place' }], product: [], sector: [] });
    let u = 0; const ahead = () => new Date(Date.UTC(2026, 10, 10, 9, 5, 0, u++)).toISOString(); let w = 0; const behind = () => new Date(Date.UTC(2026, 10, 10, 9, 0, 0, w++)).toISOString();   // the second PC's clock is five minutes behind the first's
    const office = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, result: 'more', need: 'decommissioning bond' })) }), recs, { shared, installId: 'office', repo, clock: ahead, checklist: LIST, pick: () => ({ read: [1] }) }); await deal(repo);
    const r1 = val(await office.ai.firstPass('d1'));                                                          // office: a gap
    recs.d1.push(doc(2, 'Decommissioning bond.pdf', { words: ['decommissioning', 'bond'] }));                // the bond arrives; home, later in real time, follows it through and finds the item satisfied
    const home = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), recs, { shared, installId: 'home', repo, clock: behind, checklist: LIST, affects: (c) => affectedAs(c, 'C1'), pick: () => ({ read: [1, 2] }) });
    const r2 = val(await home.ai.firstPass('d1'));
    expect(r2.gaps).toEqual([]); expect(val(await home.ai.gaps('d1'))).toEqual([]); expect(val(await office.ai.gaps('d1'))).toEqual([]);
    expect(checkLines(shared).filter((l) => l.item).map((l) => [l.at.slice(11, 16), l.result, l.n > 0])).toEqual([['09:05', 'gap', true], ['09:00', 'ok', true]]);   // written later, stamped earlier, and still the later one
  });

  it('"Check again" pressed while the first pass is starting: the two share one round, and no finding is written twice', async () => {
    const recs = { d1: [doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'margin'] })] };
    const s = setup(
      (c) => ({
        items: itemsIn(c).map((it) => ({
          id: it.tag,
          result: 'finding',
          title: `Problem: ${it.text}`,
          workstream: 'Legal',
          body: ['A. [1] B. [2]'],
          next: '',
          sources: [
            { doc: nth(c, 1), page: 1 },
            { doc: nth(c, 1), page: 2 },
          ],
        })),
      }),
      recs,
      {
        checklist: () => ({
          broad: [
            { id: 'k1', text: 'The margin in the credit agreement is as agreed' },
            { id: 'k2', text: 'The credit agreement has a lock-up' },
          ],
          product: [],
          sector: [],
        }),
      },
    );
    await deal(s.repo);
    const [a, b] = await Promise.all([s.ai.firstPass('d1'), s.ai.checkAll({ dealId: 'd1' })]);
    const titles = val(await s.repo.list('finding', 'd1')).map((l) => (l.envelope.data as any).title).sort();
    // whichever started its round first, the other joined it (a first pass joins a round of any kind; a check waits behind a first pass and then runs): each finding once
    expect(titles.length).toBe(2); expect(new Set(titles).size).toBe(2); expect(val(a).written.length).toBeLessThanOrEqual(2); expect(val(b).newFindings).toBeLessThanOrEqual(2);
  });

  it('a finding another PC wrote while this run was under way is not written a second time', async () => {
    const recs = { d1: [doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'margin'] })] }; let other: Promise<unknown> | null = null;
    const s = setup(
      (c) => {
        other ??= finding(s.repo, 'f_other', 'Margin looks high', { itemId: 'k1' });
        return {
          items: itemsIn(c).map((it) => ({
            id: it.tag,
            result: 'finding',
            title: 'Margin looks high',
            workstream: 'Legal',
            body: ['A. [1] B. [2]'],
            next: '',
            sources: [
              { doc: nth(c, 1), page: 1 },
              { doc: nth(c, 1), page: 2 },
            ],
          })),
        };
      },
      recs,
      {
        checklist: () => ({
          broad: [{ id: 'k1', text: 'The margin in the credit agreement is as agreed' }],
          product: [],
          sector: [],
        }),
      },
    );
    await deal(s.repo);
    const r = val(await s.ai.firstPass('d1')); await other;
    expect(r.written).toEqual([]); expect(val(await s.repo.list('finding', 'd1')).map((l) => l.id)).toEqual(['f_other']);        // the item is recorded as a finding; the finding is the one already there
  });

  it('one document that cannot be sent costs only itself a failed try at being described', async () => {
    const recs: Record<string, DocRecord[]> = { d1: [doc(1, 'Too large.pdf', { words: ['facility'] }), doc(2, 'Credit Agreement.pdf', { words: ['facility'] }), doc(3, 'Term sheet.pdf', { words: ['term'] }), doc(4, 'Information memorandum.pdf', { words: ['information'] })] };
    const tries = new Map<string, number>(); let now = Date.UTC(2026, 10, 10, 9, 0, 0); const at = () => new Date(now += 1).toISOString();
    const s = setup(() => ({ text: 'x', sources: [] }), recs, { describes: true, clock: at, pick: () => ({ read: [] }),
      wanted: async (d, ids) => recs[d].filter((r) => ids.includes(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => { if (r.name === 'Too large.pdf') throw new Error('413 too large'); return new TextEncoder().encode(r.name); } })) });
    for (let round = 0; round < 3; round++) { val(await s.ai.answer(ask(`Round ${round}`))); await s.ai.described('d1'); recs.d1 = [...recs.d1, doc(50 + round, `New file ${round}.pdf`, { words: [] })]; now += 10 * 60_000; }   // the data room changes: the core documents are chosen again
    recs.d1 = recs.d1.filter((r) => r.name !== 'Too large.pdf'); now += 24 * 3600_000;                       // the file that could not be sent is taken out of the data room, and a day passes
    val(await s.ai.answer(ask('Once more'))); await s.ai.described('d1');
    const described = recs.d1.filter((r) => r.summary).map((r) => r.name); expect(described).toEqual(expect.arrayContaining(['Credit Agreement.pdf', 'Information memorandum.pdf', 'Term sheet.pdf'])); expect(s.describeCalls.some((c) => c.prompt.includes('Too large'))).toBe(false);
  });

  it('a large folder arriving is put to the fast model a hundred documents at a time, not in one prompt too long to answer', async () => {
    const recs: Record<string, DocRecord[]> = { d1: [doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement'] })] };
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, text: `Checklist point ${i} about the credit agreement and its covenants and undertakings` }));
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), recs, { checklist: () => ({ broad: items, product: [], sector: [] }), affects: () => ({ affected: [] }) }); await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    for (let i = 0; i < 2000; i++) recs.d1.push(doc(1000 + i, `Document ${i}.pdf`, { rel: `10 New folder/Sub ${i % 40}/Document ${i}.pdf`, words: ['agreement', 'borrower', 'lender', 'facility', 'clause', 'schedule', 'notice', 'party', 'security', 'project', 'company', 'date'] }));
    val(await s.ai.firstPass('d1'));
    expect(s.affectCalls.length).toBe(20); expect(Math.max(...s.affectCalls.map((c) => c.prompt.length))).toBeLessThan(40_000); expect(s.affectCalls[19].prompt).toContain(`${doc(2999, '').docId}: vdr/10 New folder/Sub 39/Document 1999.pdf`);
  });

  it('one cited document that cannot be sent does not stop the follow-through: the run ends, and is not repeated', async () => {
    const recs: Record<string, DocRecord[]> = { d1: [doc(1, 'Credit Agreement.docx', { words: ['facility', 'agreement', 'margin'] }), doc(2, 'Term sheet.pdf', { words: ['term', 'sheet'] })] };
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), recs, {
      checklist: () => ({ broad: [{ id: 'k1', text: 'The term sheet is signed' }], product: [], sector: [] }),
      affects: (c) => affectedAs(c, 'F1'),
      pick: (c) => ({
        read: listed(c as Call)
          .filter((r) => /Term sheet/.test(r.path))
          .map((r) => r.id),
      }),
      wanted: async (d, ids) =>
        recs[d]
          .filter((r) => ids.includes(r.docId))
          .map((r) => ({
            docId: r.docId,
            name: r.name,
            read: () => {
              if (/docx$/.test(r.name)) throw new Error('indexed with a different converter than this PC has');
              return new TextEncoder().encode(r.name);
            },
          })),
    });
    await deal(s.repo); await finding(s.repo, 'f_1', 'Margin differs', { sources: [{ doc: 'Credit Agreement.docx', loc: 'p. 2', docId: recs.d1[0].docId }] });
    val(await s.ai.firstPass('d1')); recs.d1.push(doc(3, 'Amendment letter.pdf', { words: ['amendment', 'margin'] }));
    const runs = []; for (let i = 0; i < 3; i++) { const r = await s.ai.firstPass('d1'); runs.push(r.ok ? 'ok' : `${r.error.kind}: ${r.error.message}`); }
    expect(runs).toEqual(['ok', 'ok', 'ok']); expect(s.affectCalls.length).toBe(1);
  });

  it('which documents are core is worked out the same on every PC and after a restart, and no model is asked', async () => {
    const recs: Record<string, DocRecord[]> = {}; const repo = memRepo(clock); const shared = new Mem();
    for (let d = 0; d < 12; d++) { recs[`d${d}`] = [doc(d * 10 + 1, `Credit Agreement ${d}.pdf`, { words: ['facility', 'agreement'] }), doc(d * 10 + 2, `Notes ${d}.pdf`, { words: ['notes'] })]; await deal(repo, `d${d}`, `Project ${d}`); }
    const start = (installId = 'office') => setup(() => ({ text: 'x', sources: [] }), recs, { repo, shared, installId, pick: () => ({ read: [1] }) });
    const starred = (c: { prompt: string }) =>
      (c.prompt.match(/^doc_[0-9a-f]{24} \*: .*$/gm) ?? []).map((l) => l.replace(/^doc_[0-9a-f]{24} \*: /, ''));
    // a draft's pick lists the ranking, core documents starred
    const draft = (x: ReturnType<typeof start>) =>
      x.ai.draft({ dealId: 'd0', questionId: 'q_1', questionText: 'Is there a lock-up?' });
    const a = start(); val(await draft(a));
    const b = start(); val(await draft(b));   // the app is started again
    const home = start('home'); val(await draft(home));
    // the credit agreement answers to a library group, the notes to nothing: the same on each start and each PC
    expect(starred(a.pickCalls[0]).some((p) => p.includes('Credit Agreement'))).toBe(true); expect(starred(a.pickCalls[0]).some((p) => p.includes('Notes'))).toBe(false);
    expect(starred(b.pickCalls[0])).toEqual(starred(a.pickCalls[0])); expect(starred(home.pickCalls[0])).toEqual(starred(a.pickCalls[0]));
    expect([...a.all, ...b.all, ...home.all].some((c) => c.prompt.includes('Which are the core documents'))).toBe(false);
  });
});
