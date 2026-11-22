// @vitest-environment node
// Documents that arrive in a data room after the deal was indexed, end to end on the composed backend with real
// folders and the stand-in model: a check finds them, opening a deal finds them, and the timer finds them.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, put, pdf, pcApp, newDeal, until, StandInService } from './kit';
import { isPickAsk, isPickForAsk, isDescribeAsk, isAffectsAsk, itemsIn } from '../backend/reviewKit';
import { watchFolders, freshen, FOLDER_CHECK } from '../../src/app/folderWatch';
import { AddFolders } from '../../src/app/commands/deals';
import type { nodeAi } from '../../src/backend/ai';

const LIST = () => ({ broad: [], product: [{ id: 'p1', text: 'The term sheet is signed' }], sector: [{ id: 's1', text: 'The financial model has been audited' }] });
// an item is satisfied only when the document it needs was sent; otherwise it is a gap
/** model calls the checks made, and a switch that makes the checks' calls fail as an unreachable service would */
const seen = { calls: 0, down: false };
function model() {
  return new StandInService((c) => {
    seen.calls++;
    const ref = (name: string) => new RegExp(`^(D\\d+): (?:.*/)?${name.replace(/[()]/g, '\\$&')}`, 'm').exec(c.prompt)?.[1];
    if (isDescribeAsk(c as any)) return JSON.stringify({ summary: 'A document.', keywords: [] });
    if (isPickAsk(c as any) || isPickForAsk(c as any)) return JSON.stringify({ read: [1, 2, 3, 4] });
    if (isAffectsAsk(c as any)) return JSON.stringify({ items: [...c.prompt.matchAll(/^(I\d+):/gm)].map((m) => m[1]), findings: [] });
    const items = itemsIn(c as any);
    if (items.length && seen.down) {
      throw Object.assign(new Error('The service could not be reached'), { code: 'unreachable' });
    }
    if (items.length) return JSON.stringify({ items: items.map((it) => {
      const need = /signed/.test(it.text) ? 'Term sheet (signed).pdf' : 'Model audit report.pdf'; const d = ref(need);
      return d ? (c.prompt.includes('Add "where"') ? { id: it.tag, result: 'ok', where: [{ doc: d, page: 1, quote: 'x' }] } : { id: it.tag, result: 'ok' }) : { id: it.tag, result: 'more', need };
    }) });
    return JSON.stringify({ text: 'Nothing.', sources: [] });
  });
}
const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function dataRoom() {
  const root = tmp(); roots.push(root); const vdr = path.join(root, 'vdr');
  put(vdr, '01 Finance/Term sheet (signed).pdf', pdf('term sheet signed', 2));
  for (let i = 0; i < 40; i++) put(vdr, `09 Misc/Note ${i}.pdf`, pdf(`note number ${i}`));
  return { root, vdr };
}
const rowsOf = async (pc: any, dealId: string) => Object.fromEntries(((await pc.backend.ai.checklist(dealId)) as any).value.map((r: any) => [r.id, r.result]));
/** a new deal, indexed, with its record saying so */
async function indexed(pc: any, name: string, vdr: string) { const id = await newDeal(pc, name, vdr); await until('the deal to be ready', () => pc.store.get().deals[id].stage === 'ready'); return id; }
const has = (pc: any, dealId: string, name: string) => (pc.backend.docs as any).records(dealId).some((r: any) => r.name === name);

describe('documents added to a data room after it was indexed', () => {
  it('Check again reads them first: the gap they fill is satisfied, a document removed is gone, and the deal’s counts follow', async () => {
    const { root, vdr } = dataRoom(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await indexed(A, 'Proseware', vdr);
    const s1 = Object.entries(await rowsOf(A, dealId)).find(([, v]) => v !== 'satisfied'); expect(s1).toBeTruthy();   // the audit is a gap
    put(vdr, '01 Finance/Model audit report.pdf', pdf('the financial model has been audited', 4));            // the sponsor uploads it
    fs.rmSync(path.join(vdr, '09 Misc/Note 3.pdf')); fs.rmSync(path.join(vdr, '09 Misc/Note 4.pdf'));          // and withdraws two notes
    await A.store.checkEverything(dealId); await A.backend.idle();
    expect(has(A, dealId, 'Model audit report.pdf')).toBe(true); expect(has(A, dealId, 'Note 3.pdf')).toBe(false);
    expect(Object.values(await rowsOf(A, dealId)).every((v) => v === 'satisfied')).toBe(true);
    expect(A.store.get().checks[dealId]?.at).toBeTruthy();
    await until('the deal’s counts', () => A.store.get().deals[dealId].folders[0].files === 40);
    expect(A.store.get().deals[dealId].stage).toBe('ready');
    await A.backend.close();
  }, 120000);

  it('opening the deal reads them, after a restart too; and the timer reads them with the deal not open', async () => {
    const { root, vdr } = dataRoom(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await indexed(A, 'Proseware', vdr); await A.backend.close();
    put(vdr, '01 Finance/Model audit report.pdf', pdf('the financial model has been audited', 4));
    const was = FOLDER_CHECK.every; FOLDER_CHECK.every = 60 * 60_000;
    const B = await pcApp(root, 'Office', { service: model(), checklist: LIST }); const stop = watchFolders(B.store);
    try {
      expect(has(B, dealId, 'Model audit report.pdf')).toBe(false);
      B.store.ui({ route: { name: 'overview', dealId } } as any);                                                 // the deal is opened
      await until('the new document', () => has(B, dealId, 'Model audit report.pdf'));
      await until('the deal’s counts', () => B.store.get().deals[dealId].folders[0].files === 42); await B.backend.idle();
      await until('the first pass to look at it', async () => Object.values(await rowsOf(B, dealId)).every((v) => v === 'satisfied'));
      stop(); B.store.ui({ route: { name: 'home' } } as any);
      FOLDER_CHECK.every = 300; const again = watchFolders(B.store);
      put(vdr, '02 Legal/Side letter.pdf', pdf('side letter', 1));
      try { await until('the timer to find it', () => has(B, dealId, 'Side letter.pdf')); } finally { again(); }
    } finally { FOLDER_CHECK.every = was; stop(); await B.backend.idle(); await B.backend.close(); }
  }, 120000);

  it('a folder added to the deal while a look is ending is not marked as indexed; a run that never ends holds a check up for checkFolderWait only', async () => {
    const { root, vdr } = dataRoom(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await indexed(A, 'Proseware', vdr); await A.backend.idle();
    const other = path.join(root, 'other'); put(other, 'x.pdf', pdf('other doc')); put(vdr, '01 Finance/New.pdf', pdf('new doc'));
    const docs: any = A.store.services.docs; const realPoll = docs.poll; let fired = false;
    docs.poll = async (id: string) => { const p = await realPoll(id); if (p.ok && p.value.done && !fired) { fired = true; await A.store.dispatch(AddFolders, { dealId, folders: [{ path: other, label: 'Other', files: 0, size: '' }] } as any); } return p; };
    try { await freshen(A.store, dealId); } finally { docs.poll = realPoll; }
    expect(fired).toBe(true); expect(A.store.get().deals[dealId].stage).toBe('indexing');      // watchIndexing writes it once the new folder is read
    await A.backend.idle(); await A.backend.close();
  }, 120000);

  it('a run that never ends holds a check up for checkFolderWait only', async () => {
    const { root, vdr } = dataRoom(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await indexed(A, 'Proseware', vdr); await A.backend.idle();
    const docs: any = A.store.services.docs; const realF = docs.freshen, realPoll = docs.poll, was = FOLDER_CHECK.checkWait; FOLDER_CHECK.checkWait = 1500;
    docs.freshen = async () => ({ ok: true, value: 'running' });
    docs.poll = async (id: string) => { const p = await realPoll(id); return p.ok ? { ok: true, value: { ...p.value, done: false } } : p; };   // a run stuck on a network read
    try {
      const t0 = Date.now(); await A.store.checkEverything(dealId);
      expect(Date.now() - t0).toBeLessThan(30000); expect(A.store.get().checks[dealId]?.busy).toBeFalsy(); expect(A.store.get().checks[dealId]?.at).toBeTruthy();
    } finally { docs.freshen = realF; docs.poll = realPoll; FOLDER_CHECK.checkWait = was; await A.backend.idle(); await A.backend.close(); }
  }, 120000);

  it('Check again that finds a new document reads it once: its first pass waits for the check and then has nothing to ask', async () => {
    const { root, vdr } = dataRoom(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await indexed(A, 'Proseware', vdr);
    const ai: any = A.backend.ai; const real = ai.firstPass; const log: string[] = []; ai.firstPass = (id: string) => { log.push('first pass'); const at = seen.calls; return real(id).then((r: unknown) => { log.push(`its calls: ${seen.calls - at}`); return r; }); };
    const check = ai.checkAll; ai.checkAll = async (i: any) => { log.push('check'); const r = await check(i); log.push('check ended'); return r; };
    try {
      put(vdr, '01 Finance/Model audit report.pdf', pdf('the financial model has been audited', 4));
      await A.store.checkEverything(dealId); await A.backend.idle();
      expect(has(A, dealId, 'Model audit report.pdf')).toBe(true);
      expect(log).toEqual(['check', 'first pass', 'check ended', 'its calls: 0']);       // the first pass starts as the check ends (its own wrapper is inside this one), and asks nothing
      expect(Object.values(await rowsOf(A, dealId)).every((v) => v === 'satisfied')).toBe(true);
    } finally { ai.firstPass = real; ai.checkAll = check; await A.backend.idle(); await A.backend.close(); }
  }, 120000);

  it('Check again that does not finish, or a "Check the N left out" that is refused, leaves the new document to its first pass', async () => {
    const { root, vdr } = dataRoom();
    const A = await pcApp(root, 'Office', { service: model(), checklist: LIST, timing: { giveUp: 100 } });
    const dealId = await indexed(A, 'Proseware', vdr);
    const ai = A.backend.ai as ReturnType<typeof nodeAi>;
    const check = ai.checkAll;
    try {
      // the service drops for the whole check; the first pass after it, with the service back, settles the gap
      put(vdr, '01 Finance/Model audit report.pdf', pdf('the financial model has been audited', 4));
      let interrupted: Awaited<ReturnType<typeof check>> | undefined;
      ai.checkAll = async (input) => {
        seen.down = true;
        try {
          interrupted = await check(input);
          return interrupted;
        } finally { seen.down = false; }
      };
      await A.store.checkEverything(dealId);
      ai.checkAll = check;
      expect(interrupted).toMatchObject({
        ok: false,
        error: {
          kind: 'rejected',
          message: expect.stringMatching(/can’t be reached\. The check resumes once .* is back\./),
        },
      });
      await A.backend.idle();
      await until('the first pass to settle it', async () => Object.values(await rowsOf(A, dealId)).every((v) => v === 'satisfied'));
      // "Check the N left out" is refused once documents changed; the new document still gets its first pass
      const rows = await rowsOf(A, dealId); expect(Object.values(rows).every((v) => v === 'satisfied')).toBe(true);
      fs.rmSync(path.join(vdr, '01 Finance/Model audit report.pdf'));
      await A.store.checkEverything(dealId); await A.backend.idle();                                             // the gap is back
      expect(Object.values(await rowsOf(A, dealId)).some((v) => v !== 'satisfied')).toBe(true);
      put(vdr, '02 Legal/Audit/Model audit report v2.pdf', pdf('the financial model has been audited again', 4));
      let passes = 0; const real = ai.firstPass; ai.firstPass = (id: string) => { passes++; return real(id); };
      try { await A.store.checkEverything(dealId, false, true); await A.backend.idle(); } finally { ai.firstPass = real; }
      expect(passes).toBe(1); expect(has(A, dealId, 'Model audit report v2.pdf')).toBe(true);
    } finally { ai.checkAll = check; seen.down = false; await A.backend.idle(); await A.backend.close(); }
  }, 120000);

  it('an app closed before the check ends runs the first pass it owes when it opens again', async () => {
    const { root, vdr } = dataRoom(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await indexed(A, 'Proseware', vdr);
    const itemIds = Object.keys(await rowsOf(A, dealId));
    expect(itemIds).toHaveLength(2);
    put(vdr, '01 Finance/Model audit report.pdf', pdf('the financial model has been audited', 4));
    await A.backend.docs.freshen!(dealId, { quietUntil: Date.now() + 60_000 });                                // a look for a check, and then the window closes
    await until('the new indexing pass to finish', async () => {
      const progress = await A.backend.docs.poll(dealId);
      return progress.ok && progress.value.done;
    });
    expect(has(A, dealId, 'Model audit report.pdf')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(A.dirs.local, 'owed.json'), 'utf8'))).toContain(dealId);
    await A.backend.close();
    const B = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    try {
      await B.backend.idle();
      const rows = await rowsOf(B, dealId);
      expect(itemIds.map((id) => rows[id])).toEqual(['satisfied', 'satisfied']);
    } finally {
      await B.backend.close();
    }
  }, 120000);

  it('a run that never ends on one deal holds up no other deal’s look; counts a look could not write are put right by the next', async () => {
    const root = tmp(); roots.push(root); const one = path.join(root, 'one'), two = path.join(root, 'two');
    for (let i = 0; i < 5; i++) { put(one, `a${i}.pdf`, pdf(`a ${i}`)); put(two, `b${i}.pdf`, pdf(`b ${i}`)); }
    const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const d1 = await indexed(A, 'One', one), d2 = await indexed(A, 'Two', two); await A.backend.idle();
    const docs: any = A.store.services.docs; const realPoll = docs.poll; const was = { ...FOLDER_CHECK };
    // deal One's run never ends, as far as this PC can tell
    docs.poll = async (id: string) => { const p = await realPoll(id); return id === d1 && p.ok ? { ok: true, value: { ...p.value, done: false } } : p; };
    FOLDER_CHECK.every = 300; const stop = watchFolders(A.store);
    try {
      put(one, 'a-new.pdf', pdf('a new')); await until('One’s new file', () => has(A, d1, 'a-new.pdf'));
      put(two, 'b-new.pdf', pdf('b new')); await until('Two’s new file, though One’s run is still followed', () => has(A, d2, 'b-new.pdf'));
      await until('Two’s counts', () => A.store.get().deals[d2].folders[0].files === 6);
      // One's counts could not be written while its run seemed endless; once polls answer again, the next look writes them though nothing changed
      expect(A.store.get().deals[d1].folders[0].files).toBe(5);
      docs.poll = realPoll; FOLDER_CHECK.stuck = 200;
      await until('One’s counts', () => A.store.get().deals[d1].folders[0].files === 6);
    } finally { stop(); docs.poll = realPoll; Object.assign(FOLDER_CHECK, was); await A.backend.idle(); await A.backend.close(); }
  }, 120000);
});
