// What the end-to-end tests of a data room that cannot be reached for a while share: a data room at deal scale,
// a model that finds every item satisfied, and ways to make the folder drop and come back.
import { expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, put, StandInService, type PcApp } from './kit';
import { isPickAsk, isPickForAsk, isDescribeAsk, isAffectsAsk, isVerifyAsk, isHearAsk, itemsIn, OK, type Call, nth } from '../backend/reviewKit';

export const N_ITEMS = 2000, N_DOCS = 120;
export const LIST = () => ({ broad: Array.from({ length: N_ITEMS }, (_, i) => ({ id: `b${i}`, text: `Agreement number ${i} is signed and dated` })), product: [], sector: [] });
/** a model that finds every item satisfied; `onCheck` is called before each reply on checklist items */
export function model(onCheck: () => void = () => {}) {
  return new StandInService((x) => {
    const c = x as Call;
    if (isDescribeAsk(c)) return JSON.stringify({ summary: 'An agreement.', keywords: ['agreement'] });
    if (isPickAsk(c) || isPickForAsk(c)) return 'I cannot say';
    const items = itemsIn(c);
    // each item is settled on its own agreement when the call has it, as a real model would cite it (a Check again starts from it)
    if (items.length) { onCheck(); const docs = [...c.prompt.matchAll(/^(doc_[0-9a-f]{24}): ([^\n]*)$/gm)]; return JSON.stringify({ items: items.map((it) => { const n = /Agreement number (\d+)/.exec(it.text)?.[1]; const d = n && c.prompt.includes('Add "where"') ? docs.find((m) => new RegExp(`Agreement ${n}\\.pdf`).test(m[2])) : undefined; return { id: it.tag, ...(d ? { result: 'ok', where: [{ doc: d[1], page: 1, quote: 'As the item requires.' }] } : OK(c)) }; }) }); }
    if (isAffectsAsk(c)) return JSON.stringify({ items: [], findings: [] });
    if (isHearAsk(c)) return JSON.stringify({ affected: [] });
    if (isVerifyAsk(c)) return JSON.stringify({ stands: true, why: '' });
    return JSON.stringify({ text: 'It is signed. [1]', sources: [{ doc: nth(c, 1), page: 1 }] });
  });
}
const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const roomFiles = Array.from({ length: N_DOCS }, (_, i) => {
  const rel = `Legal ${'ABCDEFGHIJKL'[i % 12]}/Agreement ${i}.pdf`;
  const bytes = fs.readFileSync(path.join(__dirname, '../fixtures/data-room-away/e2e', rel));
  return { rel, bytes };
});
export function room() {
  const root = tmp();
  roots.push(root);
  const vdr = path.join(root, 'vdr');
  for (const file of roomFiles) put(vdr, file.rel, file.bytes);
  return { root, vdr };
}
export const drop = (vdr: string) => fs.renameSync(vdr, `${vdr}-away`); export const back = (vdr: string) => fs.renameSync(`${vdr}-away`, vdr);
export const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
/** the deal's documents as this PC has them (the document service's own list, which the window does not call) */
export const recs = (A: PcApp, dealId: string) => (A.backend.docs as unknown as { records(d: string): { name: string; docId: string }[] }).records(dealId);
export const tally = async (A: PcApp, dealId: string) => val(await A.backend.ai.checklist!(dealId)).reduce((a: Record<string, number>, r) => { a[r.result] = (a[r.result] ?? 0) + 1; return a; }, {});
export const saidLeft = (A: PcApp) => fs.readdirSync(A.dirs.shared).filter((n) => n.startsWith('docs-')).some((n) => /"(left|cleared|missed|gone)"/.test(fs.readFileSync(path.join(A.dirs.shared, n), 'utf8')));

/** "Legal D" may not be listed, and nothing in it may be looked at, as for a person the data room's permissions keep out */
export function close() {
  const inside = (p: unknown, self: boolean) => typeof p === 'string' && p.split(path.sep).some((_, i, a) => a[i] === 'Legal D' && (self || i < a.length - 1));
  const no = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  // put in place by hand: a spy keeps every call and what it gave, more than a test's memory over a check of 2,000 items
  const held: [string, unknown][] = [];
  for (const name of ['readdirSync', 'statSync', 'openSync', 'readFileSync', 'createReadStream', 'existsSync'] as const) { const real = fs[name] as (...a: unknown[]) => unknown; held.push([name, real]); (fs as unknown as Record<string, unknown>)[name] = (p: unknown, ...r: unknown[]) => (inside(p, name === 'readdirSync') ? (name === 'existsSync' ? false : no()) : real(p, ...r)); }
  // the look at the deal's folders lists them without holding the app up
  const realList = fs.promises.readdir; (fs.promises as unknown as Record<string, unknown>).readdir = async (p: unknown, ...r: unknown[]) => { if (inside(p, true)) no(); return (realList as (...a: unknown[]) => unknown)(p, ...r); };
  return () => { for (const [name, real] of held) (fs as unknown as Record<string, unknown>)[name] = real; fs.promises.readdir = realList; };
}
