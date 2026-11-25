// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { nodeDocuments, docIdFor, hashBytes, type DocRecord } from '../../src/backend/documents';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { StandInService } from '../../src/backend/service';
import { matchesIn, sameRoomAs, countedFiles } from '../../src/backend/sameRoom';

const made: string[] = []; afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-same-')); made.push(d); return d; };
const put = (root: string, rel: string, data: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const rec = (name: string, size: number, hash = `h-${name}`): DocRecord => ({ docId: docIdFor(hash), hash, name, folder: 'F', rel: name, size });

describe('matching a data room by its files', () => {
  const files = (n: number, tag: string, root = 'VDR') =>
    Array.from({ length: n }, (_, i) => ({ room: `${root}/${tag} ${i}.pdf`, size: 1000 + i }));
  const nameOf = (f: { room: string }) => f.room.split('/').pop()!;
  const recsOf = (list: { room: string; size: number }[]) => list.map((f) => rec(nameOf(f), f.size));
  const sameHash = (f: { room: string }) => `h-${nameOf(f)}`;

  it('matches a file by its exact name, in any case, and its exact size; each document to one file at most', () => {
    const found = [{ room: 'X/a.pdf', size: 1000 }, { room: 'Y/A.PDF', size: 1000 }, { room: 'X/b.pdf', size: 1001 },
      { room: 'X/c (1).pdf', size: 5 }];
    const m = matchesIn(found, [rec('a.pdf', 1000), rec('b.pdf', 1000), rec('c.pdf', 5)]);
    expect(m.map((x) => x.file.room)).toEqual(['X/a.pdf']);
  });
  it('a deal holds the room when more than half of its files match and the smallest match is identical', () => {
    const room = files(10, 'Doc');
    expect(sameRoomAs('d', room, recsOf(room.slice(0, 6)), sameHash)).toEqual({ dealId: 'd', files: 10, matched: 6 });
    // half is not more than half
    expect(sameRoomAs('d', room, recsOf(room.slice(0, 5)), sameHash)).toBeNull();
    // the same names and sizes with other contents, or nothing that could be read: nothing is claimed
    expect(sameRoomAs('d', room, recsOf(room), () => 'other')).toBeNull();
    expect(sameRoomAs('d', room, recsOf(room), () => null)).toBeNull();
    const read: string[] = [];
    sameRoomAs('d', room, recsOf(room), (f) => {
      read.push(f.room);
      return sameHash(f);
    });
    expect(read).toEqual(['VDR/Doc 0.pdf']);   // one file read: the smallest match
  });
  it('finds a data room that three or more deals already hold', () => {
    const room = files(2000, 'Doc');
    const dealIds = ['d_1', 'd_2', 'd_3', 'd_4'];
    expect(dealIds.map((dealId) => sameRoomAs(dealId, room, recsOf(room), sameHash)?.dealId)).toEqual(dealIds);
  });
  it('leaves out files in a precedents folder on both sides, however many deals read them', () => {
    const prec = files(100, 'Form', 'VDR/12. Precedents');
    const own = files(8, 'Own');
    const precRecs = prec.map((f) => ({ ...rec(nameOf(f), f.size), rel: `Precedents/${nameOf(f)}` }));
    const dealRecs = [...recsOf(own), ...precRecs];
    expect(countedFiles([...prec, ...own]).map((f) => f.room)).toEqual(own.map((f) => f.room));
    expect(sameRoomAs('d', countedFiles([...prec, ...files(8, 'New')]), dealRecs, sameHash)).toBeNull();
    expect(matchesIn(prec, dealRecs)).toEqual([]);   // the deal's precedents are not counted either
    const again = sameRoomAs('d', countedFiles([...prec, ...own]), dealRecs, sameHash);
    expect(again).toEqual({ dealId: 'd', files: 8, matched: 8 });
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

  it('finds the deal whose data room a second export holds, in renamed folders', async () => {
    const { root, vdr, docs } = setup(); await index(docs, vdr);
    const again = path.join(root, 'export 2');
    for (let i = 0; i < 40; i++) put(again, `Folder ${i % 3}/Document ${i}.csv`, `contents of document ${i}`);
    put(again, 'New/Late arrival.csv', 'not in the first deal');
    const r = await docs.sameRoom!([again], ['d_one', 'd_none']);
    expect(r.ok && r.value).toEqual([{ dealId: 'd_one', files: 41, matched: 40 }]);
    const bytesHash = (file: string) => hashBytes(fs.readFileSync(file));
    const first = bytesHash(path.join(vdr, '00 Section/Document 0.csv'));
    expect(bytesHash(path.join(again, 'Folder 0/Document 0.csv'))).toBe(first);
  });
  it('finds the deal when its data room is added again with a small folder of the team’s own', async () => {
    const { root, vdr, docs } = setup(); await index(docs, vdr);
    const work = path.join(root, 'Our working files'); for (let i = 0; i < 10; i++) put(work, `Draft ${i}.csv`, `draft ${i}`);
    const r = await docs.sameRoom!([vdr, work], ['d_one']);
    expect(r.ok && r.value).toEqual([{ dealId: 'd_one', files: 50, matched: 40 }]);
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
    expect(r.ok && r.value).toEqual([{ dealId: 'd_7', files: 8, matched: 8 }]);
    void vdr;
  }, 60_000);
});
