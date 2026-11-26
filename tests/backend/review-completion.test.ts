// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  setup,
  doc,
  val,
  ask,
  deal,
  finding,
  question,
  sentNames,
  itemsIn,
  thingsIn,
  Mem,
  checkLines,
  type Call,
  OK,
  nth,
} from './reviewKit';
import type { DocRecord } from '../../src/backend/documents';
import { tokenHolder } from '../../src/backend/signInToken';

const FA = doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'borrower', 'lender'] });
const TS = doc(2, 'Term sheet.pdf', { pages: 12, words: ['term', 'sheet', 'margin'] });
const IM = doc(3, 'Information memorandum.pdf', { words: ['project', 'capacity', 'sponsor'] });
const room = () => ({ d1: [FA, TS, IM] });
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, text: `Checklist point ${i + 1} about the credit agreement` }));
const list = (n: number) => () => ({ broad: items(n), product: [], sector: [] });
const okAll = (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) });

// Each test here is a defect that was reproduced, then fixed, now asserting the behavior that fixes it.
describe('what is recorded and shown as checked', () => {
  it('a first pass in which no reply could be used does not write "everything checked"', async () => {
    const shared = new Mem(); const s = setup(() => 'I am sorry, I cannot help with that.', room(), { shared, installId: 'pc', checklist: list(25) }); await deal(s.repo);
    const r = val(await s.ai.firstPass('d1')); const checked = val(await s.ai.checked('d1')); const gaps = val(await s.ai.gaps('d1'));
    const lines = checkLines(shared);
    expect(r.unsettled.length).toBe(25); expect(checked.at).toBeNull(); expect(gaps).toEqual([]); expect(lines.find((l) => l.full)).toBeUndefined();
    // nothing was read to a result, so nothing counts as read; and only the first attempt at each batch was sent back to be put right
    expect(val(await s.ai.progress('d1'))).toEqual({ folders: [{ folder: 'vdr', files: 3, read: 0, core: 1, coreRead: 0 }], checklist: { items: 25, satisfied: 0, findings: 0, gaps: 0, unsettled: 25 } });
    expect(s.usage.find((u) => u.run === 'firstPass')!.calls.filter((l) => l.kind === 'check' || (l.kind === 'fix' && l.model !== 'fast')).map((l) => `${l.kind}/${l.model} x${l.calls}`).sort()).toEqual(['check/standard x4', 'check/thorough x2', 'fix/standard x2']);
    // and when a later run settles them all, it is written then
    const t = setup(okAll, room(), { shared, installId: 'pc', repo: s.repo, checklist: list(25) }); expect(val(await t.ai.firstPass('d1')).unsettled).toEqual([]); expect(val(await t.ai.checked('d1')).at).not.toBeNull();
  });

  it('"Check everything" with nothing to check is refused, and with every reply unusable says what it could not check and does not move the date', async () => {
    const none = setup(() => 'x', room(), {}); await deal(none.repo);                                   // no checklist at all
    const a = await none.ai.checkAll({ dealId: 'd1' });
    expect(!a.ok && a.error).toEqual({ kind: 'rejected', message: 'There is nothing to check yet: this deal has no checklist items and no open findings' }); expect(val(await none.ai.checked('d1')).at).toBeNull(); expect(none.all.length).toBe(0);

    const bad = setup(() => 'Sorry?', room(), { checklist: list(25), verify: () => 'Sorry?' }); await deal(bad.repo); await finding(bad.repo, 'f_1', 'Margin differs', { sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] });
    const b = val(await bad.ai.checkAll({ dealId: 'd1' })); const b2 = val(await bad.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(b).toMatchObject({ at: null, items: 25, findings: 1, toReassess: 0, newFindings: 0, offerDeep: false, unchecked: { items: 25, findings: 1 } }); expect(b2).toMatchObject({ at: null, unchecked: { items: 25, findings: 1 } }); expect(val(await bad.ai.checked('d1')).at).toBeNull();
  });

  it('documents that cannot be found on this PC are not read: no model is asked without them, nothing is recorded as satisfied against them, and an answer says so', async () => {
    const shared = new Mem();
    const s = setup(
      (c) => (c.prompt.includes('Check each of these') ? okAll(c) : { text: 'The margin is 2.25%.', sources: [] }),
      room(),
      { shared, installId: 'pc', checklist: list(3), wanted: async () => [] },
    ); // as when the deal's folder is not at that path on this PC, or the files were replaced
    await deal(s.repo); const r = val(await s.ai.firstPass('d1')); const lines = checkLines(shared).filter((l) => l.item);
    expect(s.calls.length).toBe(0); expect(s.pickForCalls.length).toBe(0); expect(r.unsettled.length).toBe(3); expect(lines.every((l) => l.result === 'unsettled' && l.docs.length === 0)).toBe(true); expect(val(await s.ai.checked('d1')).at).toBeNull();
    const a = await s.ai.answer(ask('What is the margin in the credit agreement?'));
    // the chat agent's main session is told, and answers with nothing to cite: no document reached a model
    expect(a.ok && a.value.sources).toEqual([]); expect(s.calls.map((c) => c.files.length)).toEqual([0]); expect(s.calls[0].prompt).toContain('Documents: The documents for this could not be opened on this PC.');
    // a finding whose documents cannot be opened is not asked about with nothing to read: it is reported as not checked
    await finding(s.repo, 'f_1', 'Margin differs', { sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] }); const ca = val(await s.ai.checkAll({ dealId: 'd1' }));
    expect(s.verifyCalls.length).toBe(0); expect(ca).toMatchObject({ at: null, unchecked: { items: 3, findings: 1 } });
    // some can be opened and some cannot: only those that can are read, cited and recorded
    const part = setup(
      (c) =>
        c.prompt.includes('Check each of these')
          ? okAll(c)
          : { text: 'The term sheet agrees. [1]', sources: [{ doc: nth(c, 1), page: 3 }] },
      room(),
      {
        shared: new Mem(),
        installId: 'pc',
        checklist: list(1),
        pick: (c) => ({ read: [1, 2, 3].map((k) => nth(c as Call, k)) }),
        wanted: async (_d, ids) =>
          [TS]
            .filter((x) => ids.includes(x.docId))
            .map((x) => ({ docId: x.docId, name: x.name, read: () => new TextEncoder().encode(x.name) })),
      },
    );
    await deal(part.repo); const b = val(await part.ai.answer(ask('What is the margin?'))); expect(sentNames(part.calls[0])).toEqual(['Term sheet.pdf']); expect(b.sources.map((x) => x.doc)).toEqual(['Term sheet.pdf']); expect(b.read).toEqual({ docs: 1, of: 3 });
    val(await part.ai.firstPass('d1')); expect(val(await part.ai.progress('d1')).folders).toEqual([{ folder: 'vdr', files: 3, read: 1, core: 1, coreRead: 0 }]);
  });

  it('a copy of a document is counted where it sits, and the document only once, at its first place', async () => {
    const A = doc(1, 'Credit Agreement.pdf', { copies: [{ folder: 'vdr', rel: 'old/FA.pdf', name: 'FA.pdf' }, { folder: 'reports', rel: 'FA copy.pdf', name: 'FA copy.pdf' }] });
    const s = setup(() => 'x', { d1: [A, TS] }, {}); await deal(s.repo);
    expect(val(await s.ai.progress('d1')).folders).toEqual([{ folder: 'vdr', files: 2, read: 0, core: 2, coreRead: 0, copies: 1 }, { folder: 'reports', files: 0, read: 0, core: 0, coreRead: 0, copies: 1 }]);
  });

  it('a first run that was cut short, then more documents: what the cut-short run settled is set against the documents as they are now', async () => {
    const shared = new Mem(); const recs: Record<string, DocRecord[]> = room(); let down = false; let n = 0;
    const LIST = { broad: [{ id: 'g1', text: 'A decommissioning bond is in place' }, { id: 'g2', text: 'The margin is as in the term sheet' }], product: [], sector: [] };
    const s = setup((c) => { if (down && itemsIn(c).some((it) => it.text.includes('margin'))) { const e: any = new Error('ECONNREFUSED'); e.code = 'unreachable'; throw e; } n++;
      return { items: itemsIn(c).map((it) => (it.text.includes('decommissioning') ? (c.files.some((f) => f.name.includes('Decommissioning')) ? { id: it.tag, ...OK(c) } : { id: it.tag, result: 'more', need: 'decommissioning bond' }) : { id: it.tag, ...OK(c) })) }; },
      recs, { shared, installId: 'pc', checklist: () => LIST, batch: 1 });
    await deal(s.repo); down = true; const first = await s.ai.firstPass('d1'); expect(first.ok).toBe(false);                 // item g1 settled as a gap, then the service went away
    recs.d1.push(doc(9, 'Decommissioning bond.pdf', { rel: '08 Security/Decommissioning bond.pdf', words: ['decommissioning', 'bond', 'surety'] }));   // the second folder arrives
    down = false; const second = val(await s.ai.firstPass('d1')); const third = val(await s.ai.firstPass('d1'));
    expect(second.gaps).toEqual([]); expect(third.gaps).toEqual([]); expect(checkLines(shared).filter((l) => l.item === 'g1').map((l) => l.result)).toEqual(['gap', 'ok']); expect(val(await s.ai.checked('d1')).at).not.toBeNull();
    const calls = s.all.length; val(await s.ai.firstPass('d1')); expect(s.all.length).toBe(calls);                                              // and with nothing changed, nothing more is asked
  });

  it('when the fast model says a new document touches a finding, the check that follows is given that document, and the reason on the mark names it', async () => {
    const recs: Record<string, DocRecord[]> = room(); const LIST = { broad: [{ id: 'k1', text: 'The margin is as in the term sheet' }], product: [], sector: [] };
    const s = setup(okAll, recs, { checklist: () => LIST, verify: (c) => ({ stands: c.files.some((f) => f.name.includes('Notice')), why: 'x' }).stands ? { stands: false, why: 'the offtaker has terminated' } : (c.model === 'fast' ? { stands: true, why: 'nothing new' } : { stands: true, why: 'nothing new' }),
      affects: () => ({ affected: ['f_1'] }) });
    await deal(s.repo); await finding(s.repo, 'f_1', 'Revenue contract covers less capacity than the base case assumes', { body: ['The offtake contract covers part of the capacity only. [1]'], sources: [{ doc: IM.name, loc: 'p. 2', docId: IM.docId }] });
    val(await s.ai.firstPass('d1'));
    recs.d1.push(doc(11, 'Capacity study.pdf', { words: ['capacity', 'base', 'case'] }), doc(12, 'Revenue forecast.pdf', { words: ['revenue', 'capacity'] }), doc(13, 'Offtake pricing note.pdf', { words: ['offtake', 'contract'] }), doc(14, 'Notice March 14.pdf', { words: [] }));   // the last is a scanned termination notice
    const r = val(await s.ai.firstPass('d1'));
    expect(s.verifyCalls.map((c) => c.model)).toEqual(['fast', 'standard']); expect(sentNames(s.verifyCalls[0])).toContain('Notice March 14.pdf'); expect(r.marked).toEqual(['f_1']);   // the model named the finding and no document: the arrival that words cannot place goes first
    // and when the model names the document, that is the one the check is given and the one the reason names, however little its words say
    const s2 = setup(okAll, recs, { checklist: () => LIST, verify: () => ({ stands: false, why: 'terminated' }), affects: () => ({ affected: [`f_1 ${doc(14, '').docId}`] }) });
    recs.d1 = [FA, TS, IM]; await deal(s2.repo); await finding(s2.repo, 'f_1', 'Revenue contract covers less capacity than the base case assumes', { body: ['The offtake contract covers part of the capacity only. [1]'], sources: [{ doc: IM.name, loc: 'p. 2', docId: IM.docId }] });
    val(await s2.ai.firstPass('d1')); recs.d1.push(doc(11, 'Capacity study.pdf', { words: ['capacity', 'base', 'case'] }), doc(14, 'Notice March 14.pdf', { words: [] }));
    val(await s2.ai.firstPass('d1')); const f = val(await s2.repo.get('finding', 'f_1'))!.envelope.data as any;
    expect(s2.affectCalls[0].prompt).toContain(`${doc(11, '').docId}: vdr/Capacity study.pdf — words: capacity, base, case\n${doc(14, '').docId}: vdr/Notice March 14.pdf\n`); expect(sentNames(s2.verifyCalls[0])).toContain('Notice March 14.pdf'); expect(f.updatedWhy).toBe('Notice March 14.pdf arrived');
    // the document the model names is the one, even when another arrival has no words to go by
    const s3 = setup(okAll, recs, { checklist: () => LIST, verify: () => ({ stands: false, why: 'superseded' }), affects: () => ({ affected: [`f_1 ${doc(11, '').docId}`] }) });
    recs.d1 = [FA, TS, IM]; await deal(s3.repo); await finding(s3.repo, 'f_1', 'Revenue contract covers less capacity than the base case assumes', { sources: [{ doc: IM.name, loc: 'p. 2', docId: IM.docId }] });
    val(await s3.ai.firstPass('d1')); recs.d1.push(doc(11, 'Capacity study.pdf', { words: ['capacity', 'base', 'case'] }), doc(14, 'Notice March 14.pdf', { words: [] })); val(await s3.ai.firstPass('d1'));
    expect((val(await s3.repo.get('finding', 'f_1'))!.envelope.data as any).updatedWhy).toBe('Capacity study.pdf arrived'); expect(sentNames(s3.verifyCalls[0])).not.toContain('Notice March 14.pdf');
  });

  it('a PC signed out while looking at responses lets go of the look after the cap, so another PC can look', async () => {
    const shared = new Mem();
    const hears = () => ({ affected: ['F1 q_7'] });
    const s = setup(() => 'x', room(), { shared, installId: 'pc', timing: { giveUp: 50 }, hears });
    await deal(s.repo); await finding(s.repo, 'f_1', 'Margin differs between the credit agreement and the term sheet', { sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] });
    await question(s.repo, 'q_7', 7, 'What margin was agreed?', 'The margin was corrected to 2.25% in the signed credit agreement.');
    const signedOut = tokenHolder({}); const answer = s.svc.script;
    s.svc.script = async (c) => { await signedOut.get(); return answer(c); };          // as North does: every call waits on the sign-in
    await s.ai.responses('d1');
    const mine = checkLines(shared); const claimed = mine.flatMap((l) => l.claim?.keys ?? []); const released = mine.flatMap((l) => l.release?.keys ?? []);
    expect(claimed).toContain('hear'); expect(released).toContain('hear');
  });

  it('a response is not recorded as looked at when the look failed or there was nothing to look at, and it is set against a finding raised later', async () => {
    const shared = new Mem();
    const hears = () => ({ affected: ['F1 q_7'] });
    const s = setup(() => 'x', room(), { shared, installId: 'pc', hears, verify: () => 'I cannot say.' });
    await deal(s.repo); await finding(s.repo, 'f_1', 'Margin differs between the credit agreement and the term sheet', { sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] });
    await question(s.repo, 'q_7', 7, 'What margin was agreed?', 'The margin was corrected to 2.25% in the signed credit agreement.');
    const r = val(await s.ai.responses('d1')); const again = val(await s.ai.responses('d1'));
    expect(r).toEqual({ heard: ['q_7'], marked: [] }); expect(again.heard).toEqual(['q_7']); expect(s.hearCalls.length).toBe(2); expect(checkLines(shared).filter((l) => l.heard).every((l) => !l.heard.against.includes('f_1'))).toBe(true);   // tried again, since no model gave an answer on the finding
    // no open finding yet: the response is recorded as heard with no model asked; a finding raised afterwards never meets it
    const sh2 = new Mem();
    const settles = () => ({ stands: false, why: 'the response settles it' });
    const t = setup(() => 'x', room(), { shared: sh2, installId: 'pc', hears, verify: settles });
    await deal(t.repo); await question(t.repo, 'q_7', 7, 'What margin was agreed?', 'The margin was corrected to 2.25% in the signed credit agreement.');
    const r1 = val(await t.ai.responses('d1')); await finding(t.repo, 'f_1', 'Margin differs between the credit agreement and the term sheet', { sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] });
    const r2 = val(await t.ai.responses('d1'));
    expect(r1).toEqual({ heard: [], marked: [] }); expect(t.hearCalls.length).toBe(1); expect(r2).toEqual({ heard: ['q_7'], marked: ['f_1'] });   // nothing was asked until there was a finding to set it against
  });

  // what matters most is often said in one place only, such as a one-page letter refusing a permit
  it('a finding stands on a single page that opens, at the first call', async () => {
    const s = setup(
      (c) => ({
        items: itemsIn(c).map((it) => ({
          id: it.tag,
          result: 'finding',
          title: 'The use permit was refused',
          workstream: 'Legal',
          body: ['The county denied the conditional use permit. [1]'],
          next: 'Ask the sponsor for the appeal.',
          sources: [{ doc: nth(c, 1), page: 1, quote: 'denied the conditional use permit' }],
        })),
      }),
      room(),
      { checklist: list(1) },
    );
    await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
    expect(r.written.length).toBe(1); expect(r.unsettled).toEqual([]); expect(s.calls.length).toBe(1);
    const f = val(await s.repo.get('finding', r.written[0])) as { envelope: { data: { sources: { loc: string }[]; body: string[] } } };
    expect(f.envelope.data.sources.map((x) => x.loc)).toEqual(['p. 1']); expect(f.envelope.data.body).toEqual(['The county denied the conditional use permit. [1]']);
  });

  it('the same page cited twice is one source, with one marker', async () => {
    const s = setup(
      (c) => ({
        items: itemsIn(c).map((it) => ({
          id: it.tag,
          result: 'finding',
          title: 'Margin looks high',
          workstream: 'Legal',
          body: ['It is high. [1][2]', 'Set in the margin clause. [2]'],
          next: '',
          sources: [
            { doc: nth(c, 1), page: 3 },
            { doc: nth(c, 1), page: 3, quote: 'margin' },
          ],
        })),
      }),
      room(),
      { checklist: list(1) },
    );
    await deal(s.repo); const r = val(await s.ai.firstPass('d1')); expect(r.written.length).toBe(1);
    const f = val(await s.repo.get('finding', r.written[0])) as { envelope: { data: { sources: { loc: string; quote?: string }[]; body: string[] } } };
    expect(f.envelope.data.sources).toMatchObject([{ loc: 'p. 3', quote: 'margin' }]); expect(f.envelope.data.sources.length).toBe(1);
    expect(f.envelope.data.body).toEqual(['It is high. [1]', 'Set in the margin clause. [1]']);
  });

  it('a cell written two ways is one source, and a quote of only spaces gives way to a real one', async () => {
    const MODEL = doc(77, 'Credit agreement model.xlsx', { words: ['facility', 'agreement'] });
    const s = setup(
      (c) => {
        const m = /^(doc_[0-9a-f]{24}): [^\n]*Credit agreement model\.xlsx/m.exec(c.prompt)?.[1] ?? nth(c, 1);
        return {
          items: itemsIn(c).map((it) => ({
            id: it.tag,
            result: 'finding',
            title: 'Sizing differs',
            workstream: 'Financial',
            body: ['A. [1] B. [2] C. [3]', 'D. [4] [5]'],
            next: '',
            sources: [
              { doc: m, cell: 'Debt!$B$2', quote: '   ' },
              { doc: m, cell: 'debt!b2', quote: '1.20x' },
              { doc: m, cell: 'Debt!B2' },
              { doc: m, cell: 'Debt!C3' },
              { doc: m, sheet: 'Debt', cell: 'C3' },
            ],
          })),
        };
      },
      { d1: [MODEL] },
      { checklist: list(1) },
    );
    await deal(s.repo); const r = val(await s.ai.firstPass('d1')); expect(r.written.length).toBe(1);
    const f = val(await s.repo.get('finding', r.written[0])) as { envelope: { data: { sources: { loc: string; quote?: string }[]; body: string[] } } };
    expect(f.envelope.data.sources.map((x) => [x.loc, x.quote])).toEqual([['Debt!$B$2', '1.20x'], ['Debt!C3', undefined]]); expect(f.envelope.data.body).toEqual(['A. [1] B. [1] C. [1]', 'D. [2]']);
  });

  it('a finding with no citation that opens is sent back, and is not raised', async () => {
    const s = setup(
      (c) => ({
        items: itemsIn(c).map((it) => ({
          id: it.tag,
          result: 'finding',
          title: 'Margin looks high',
          workstream: 'Legal',
          body: ['It is high. [1]'],
          next: '',
          sources: [{ doc: nth(c, 1), page: 999 }],
        })),
      }),
      room(),
      { checklist: list(1) },
    );
    await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
    expect(r.written).toEqual([]); expect(r.unsettled).toEqual(['c1']); expect(s.calls[1].prompt).toContain('it needs at least one citation naming a document you were given');
  });

  it('the spot check: a sampled result the standard model could not read is not counted as agreement', async () => {
    const mk = async (second: (c: Call) => unknown) => {
      let phase = 0; const shared = new Mem(); const s = setup((c) => (phase === 0 || c.model === 'fast' ? okAll(c) : second(c)), room(), { shared, installId: 'pc', checklist: list(10) }); await deal(s.repo); val(await s.ai.firstPass('d1')); phase = 1; return { ...s, shared }; };
    const latest = (shared: Mem) => { const m = new Map<string, string>(); for (const l of checkLines(shared)) if (l.item) m.set(l.item, l.result); return [...m.values()].reduce((acc: Record<string, number>, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {}); };
    // the standard model, looking at the sample of five, raises a finding on one of them
    const a = await mk((c) => ({
      items: itemsIn(c).map((it, i) =>
        i === 0
          ? {
              id: it.tag,
              result: 'finding',
              title: `Problem with ${it.text}`,
              workstream: 'Legal',
              body: ['Bad. [1] Worse. [2]'],
              next: '',
              sources: [
                { doc: nth(c, 1), page: 1 },
                { doc: nth(c, 1), page: 2 },
              ],
            }
          : { id: it.tag, ...OK(c) },
      ),
    }));
    const ra = val(await a.ai.checkAll({ dealId: 'd1' })); expect(ra.sample).toEqual({ size: 5, overturned: 1 }); expect(ra.offerDeep).toBe(false);          // one in five is not more than one in five: the rule as it was set
    // the standard model's replies on the sample cannot be read at all
    const b = await mk(() => 'Sorry?'); const was = val(await b.ai.checked('d1')).at; const rb = val(await b.ai.checkAll({ dealId: 'd1' }));
    expect(rb.sample).toEqual({ size: 0, overturned: 0 }); expect(rb.unchecked).toEqual({ items: 5, findings: 0 }); expect(rb.at).toBeNull(); expect(val(await b.ai.checked('d1')).at).toBe(was); expect(latest(b.shared)).toEqual({ ok: 5, unsettled: 5 });
  });
});

describe('cost', () => {
  it('items that say "more" share their second looks: one question to the fast model for five of them, and a call to the standard model for four', async () => {
    const many = Array.from({ length: 300 }, (_, i) => doc(100 + i, `Report ${String(i).padStart(3, '0')}.pdf`, { words: ['report', 'facility', 'agreement', 'checklist', 'point'] }));
    const seenOnce = new Set<string>();
    const s = setup(
      (c) => ({
        items: itemsIn(c).map((it) => {
          const first = !seenOnce.has(it.text);
          seenOnce.add(it.text);
          return first
            ? { id: it.tag, result: 'more', need: `the report on point ${it.text.split(' ')[2]}` }
            : { id: it.tag, ...OK(c) };
        }),
      }),
      { d1: [FA, TS, IM, ...many] },
      {
        checklist: list(40),
        pick: (c) => ({ read: [1, 2, 3].map((k) => nth(c as Call, k)) }),
        pickFor: (c, n) => ({
          read: Object.fromEntries(
            // every item wants two documents of its own
            thingsIn(c as Call).map((t, i) => [
              t,
              [n * 10 + i * 2 + 1, n * 10 + i * 2 + 2].map((k) => nth(c as Call, k)),
            ]),
          ),
        }),
      },
    );
    await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
    expect(s.pickCalls.length).toBe(2); expect(s.pickForCalls.length).toBe(8); expect(s.calls.length).toBe(2 + 10); expect(r.gaps).toEqual([]); expect(r.unsettled).toEqual([]);
    expect(Math.max(...s.calls.map((c) => c.files.length))).toBeLessThanOrEqual(8);                                                                  // and no call is given more than a handful
  });
});
