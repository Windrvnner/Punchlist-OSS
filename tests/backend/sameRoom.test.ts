// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { nodeDocuments, docIdFor, hashBytes, type DocRecord } from '../../src/backend/documents';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { StandInService } from '../../src/backend/service';
import { plainName, sampleOf, matchesIn, likely, confirm, sharedDocs, apart, SAMPLE } from '../../src/backend/sameRoom';

const made: string[] = []; afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-same-')); made.push(d); return d; };
const put = (root: string, rel: string, data: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const rec = (name: string, size: number, hash = `h-${name}`): DocRecord => ({ docId: docIdFor(hash), hash, name, folder: 'F', rel: name, size });

describe('matching a data room by its files', () => {
  it('compares names without case, spacing, punctuation or a copy number', () => {
    expect(plainName('01 Legal/Credit Agreement (1).pdf')).toBe(plainName('credit_agreement.pdf'));
    expect(plainName('Model - Copy.xlsx')).toBe(plainName('Model.xlsx'));
    expect(plainName('Credit Agreement.pdf')).not.toBe(plainName('Credit Agreement.docx'));
  });
  it('takes the same fixed sample, spread over the whole room, whatever order the files come in', () => {
    const files = Array.from({ length: 5000 }, (_, i) => ({ rel: `f/${String(i).padStart(5, '0')}.pdf`, size: i }));
    const a = sampleOf(files), b = sampleOf([...files].reverse());
    expect(a).toHaveLength(SAMPLE); expect(a).toEqual(b);
    expect(a[0].rel).toBe('f/00000.pdf'); expect(a[SAMPLE - 1].size).toBeGreaterThan(4900);
  });
  it('matches sizes within 2%, and each document to one file at most', () => {
    const m = matchesIn([{ rel: 'a.pdf', size: 1000 }, { rel: 'A.pdf', size: 1000 }, { rel: 'b.pdf', size: 1100 }], [rec('a.pdf', 1015), rec('b.pdf', 1000)]);
    expect(m.map((x) => x.file.rel)).toEqual(['a.pdf']);
  });
  it('a deal is likely only when most of the sample, and at least three files, match', () => {
    const sample = Array.from({ length: 10 }, (_, i) => ({ rel: `d${i}.pdf`, size: 100 + i }));
    const recs = (n: number) => sample.slice(0, n).map((f) => rec(f.rel, f.size));
    expect(likely(sample, [{ dealId: 'd_half', recs: recs(5) }, { dealId: 'd_most', recs: recs(7) }, { dealId: 'd_all', recs: recs(10) }]).map((d) => d.dealId)).toEqual(['d_all', 'd_most']);
    expect(likely(sample.slice(0, 2), [{ dealId: 'd_two', recs: recs(2) }]).map((d) => d.dealId)).toEqual(['d_two']);   // a room of two files, both there
  });
  it('each new folder must match on its own: a folder one deal shares does not carry another data room', () => {
    const room = (root: string, n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ rel: `${root}/${tag} ${i}.pdf`, size: 1000 + i, root }));
    const roomA = room('A', 20, 'Lamna'), prec = room('P', 100, 'Precedent'), roomB = room('B', 40, 'Datum');
    const dealA = { dealId: 'd_a', recs: [...roomA, ...prec].map((f) => rec(f.rel, f.size)) };
    expect(likely([...roomB, ...prec], [dealA])).toEqual([]);                                    // 100 of 140 match, but none of Datum's, a quarter or more of them
    expect(likely([...roomA, ...prec], [dealA]).map((d) => d.dealId)).toEqual(['d_a']);           // the same two folders again
    expect(likely([...room('B', 2, 'Datum'), ...prec], [dealA]).map((d) => d.dealId)).toEqual(['d_a']);   // two files are too few to judge a folder by
    expect(likely([...room('B', 30, 'Datum'), ...prec], [dealA]).map((d) => d.dealId)).toEqual(['d_a']);  // under a quarter of the sample: not judged on its own, so asked about
  });
  it('a deal’s data room added again with a small folder of the team’s own is still found', () => {
    const room = (root: string, n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ rel: `${root}/${tag} ${i}.pdf`, size: 1000 + i, root }));
    const roomA = room('A', 60, 'Lamna'), prec = room('P', 100, 'Precedent');
    const dealA = { dealId: 'd_a', recs: [...roomA, ...prec].map((f) => rec(f.rel, f.size)) };
    expect(likely([...roomA, ...room('W', 15, 'Our working file')], [dealA]).map((d) => d.dealId)).toEqual(['d_a']);   // 15 of 75: a fifth
  });
  it('documents three or more deals hold are left out of both sides', () => {
    const prec = Array.from({ length: 100 }, (_, i) => rec(`Precedent ${i}.pdf`, 500 + i));
    const deals = Array.from({ length: 30 }, (_, k) => ({ dealId: `d_${k}`, recs: [...prec, ...Array.from({ length: 10 }, (_, i) => rec(`Deal ${k} doc ${i}.pdf`, 900 + i))] }));
    expect(sharedDocs(deals).map((r) => r.name).sort()).toEqual(prec.map((r) => r.name).sort());
    const files = [...prec.map((r) => ({ rel: `X/${r.name}`, size: r.size })), { rel: 'X/Own.pdf', size: 1 }];
    expect(apart(files, sharedDocs(deals)).map((f) => f.rel)).toEqual(['X/Own.pdf']);
  });
  it('confirms by fingerprinting the smallest exact-size matches, and needs most of them identical', () => {
    const files = [{ rel: 'a', size: 30 }, { rel: 'b', size: 10 }, { rel: 'c', size: 20 }, { rel: 'd', size: 1000 }];
    const matched = files.map((file) => ({ file, rec: rec(file.rel, file.size === 1000 ? 1010 : file.size) }));
    const printed: string[] = [];
    const hit = confirm('d_x', 4, matched, (f) => { printed.push(f.rel); return `h-${f.rel}`; });
    expect(printed).toEqual(['b', 'c', 'a']);                                                  // smallest first; the 2%-off file is never fingerprinted
    expect(hit).toEqual({ dealId: 'd_x', files: 4, matched: 4, printed: 3, same: 3 });
    expect(confirm('d_x', 4, matched, (f) => (f.rel === 'b' ? 'h-b' : 'other'))).toBeNull();   // one of three identical: not the same room
    expect(confirm('d_x', 4, matched, () => null)).toBeNull();                                  // nothing could be read: nothing is claimed
  });
});

describe('sameRoom on real folders', () => {
  // spreadsheets, since they index with no converter
  function setup() {
    const root = tmp(); const sharedPath = path.join(root, 'shared'); const vdr = path.join(root, 'vdr');
    for (let i = 0; i < 40; i++) put(vdr, `0${i % 4} Section/Document ${i}.csv`, `contents of document ${i}`);
    const keeper = new StoreKeeper(new StandInService(), nodeFolder(path.join(root, 'local')), { limit: 500, clock: () => new Date().toISOString(), recheckMs: 0 });
    const docs = nodeDocuments({ shared: nodeFolder(sharedPath), local: nodeFolder(path.join(root, 'local')), sharedPath, installId: 'pc1', keeper, folders: async () => [vdr] });
    return { root, vdr, docs };
  }
  const index = async (docs: ReturnType<typeof setup>['docs'], vdr: string) => { await docs.index('d_one', [{ path: vdr, label: 'VDR', files: 40, size: '', indexed: 0, reviewed: 0 }]); await docs.settled('d_one'); };

  it('finds the deal whose data room a second export holds, renamed folders and copy numbers and all', async () => {
    const { root, vdr, docs } = setup(); await index(docs, vdr);
    const again = path.join(root, 'export 2');
    for (let i = 0; i < 40; i++) put(again, `Folder ${i % 3}/document ${i} (1).csv`, `contents of document ${i}`);
    put(again, 'New/Late arrival.csv', 'not in the first deal');
    const r = await docs.sameRoom!([again], ['d_one', 'd_none']);
    expect(r.ok && r.value).toEqual([{ dealId: 'd_one', files: 41, matched: 40, printed: 5, same: 5 }]);
    expect(hashBytes(fs.readFileSync(path.join(again, 'Folder 0/document 0 (1).csv')))).toBe(hashBytes(fs.readFileSync(path.join(vdr, '00 Section/Document 0.csv'))));
  });
  it('finds the deal when its data room is added again with a small folder of the team’s own', async () => {
    const { root, vdr, docs } = setup(); await index(docs, vdr);
    const work = path.join(root, 'Our working files'); for (let i = 0; i < 10; i++) put(work, `Draft ${i}.csv`, `draft ${i}`);
    const r = await docs.sameRoom!([vdr, work], ['d_one']);
    expect(r.ok && r.value).toEqual([{ dealId: 'd_one', files: 50, matched: 40, printed: 5, same: 5 }]);
  });
  it('says nothing for another data room, or one whose files share names and sizes but not contents', async () => {
    const { root, vdr, docs } = setup(); await index(docs, vdr);
    const other = path.join(root, 'other'); for (let i = 0; i < 40; i++) put(other, `Report ${i}.csv`, `contents of document ${i}`);
    const lookalike = path.join(root, 'lookalike'); for (let i = 0; i < 40; i++) put(lookalike, `Document ${i}.csv`, `CONTENTS OF DOCUMENT ${i}`);
    for (const p of [other, lookalike, path.join(root, 'missing')]) { const r = await docs.sameRoom!([p], ['d_one']); expect(r.ok && r.value).toEqual([]); }
  });

  it('a precedents folder dozens of deals read never makes a deal look like another (shared folders, PR review)', async () => {
    const { root, vdr, docs } = setup();
    const prec = path.join(root, 'Precedents'); for (let i = 0; i < 60; i++) put(prec, `Form ${i}.csv`, `precedent ${i}`);
    for (let k = 0; k < 30; k++) {
      const own = path.join(root, `room ${k}`); for (let i = 0; i < 8; i++) put(own, `Deal ${k} document ${i}.csv`, `deal ${k} contents ${i}`);
      await docs.index(`d_${k}`, [own, prec].map((p) => ({ path: p, label: path.basename(p), files: 0, size: '', indexed: 0, reviewed: 0 }))); await docs.settled(`d_${k}`);
    }
    const ids = Array.from({ length: 30 }, (_, k) => `d_${k}`);
    // a new deal's own room with the shared precedents: no deal is like it
    const fresh = path.join(root, 'fresh'); for (let i = 0; i < 8; i++) put(fresh, `New ${i}.csv`, `new ${i}`);
    let r = await docs.sameRoom!([fresh, prec], ids); expect(r.ok && r.value).toEqual([]);
    // the precedents copied inside the new data room: still nothing
    for (let i = 0; i < 60; i++) put(fresh, `Precedents/Form ${i}.csv`, `precedent ${i}`);
    r = await docs.sameRoom!([fresh], ids); expect(r.ok && r.value).toEqual([]);
    // deal 7's own room again, with the precedents: deal 7, counted on its own files
    r = await docs.sameRoom!([path.join(root, 'room 7'), prec], ids);
    expect(r.ok && r.value).toEqual([{ dealId: 'd_7', files: 8, matched: 8, printed: 5, same: 5 }]);
    void vdr;
  }, 60_000);
});
