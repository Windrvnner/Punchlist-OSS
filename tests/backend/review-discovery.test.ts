// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { topWords, tokens } from '../../src/backend/words';
import { setup, doc, val, ask, deal, listed, sentNames, itemsIn, Mem, type Call, OK } from './reviewKit';
import type { DocRecord } from '../../src/backend/documents';

const pad = (n: number) => String(n).padStart(3, '0');
/** `n` unremarkable contracts, each a text PDF whose most-used words include "agreement" */
const filler = (n: number, from = 1000, name = (i: number) => `Easement agreement ${pad(i)}.pdf`, words = ['easement', 'agreement', 'landowner', 'grantor', 'grantee', 'land', 'cable', 'route']): DocRecord[] =>
  Array.from({ length: n }, (_, i) => doc(from + i, name(i), { rel: `05 Land/${name(i)}`, words }));

// Each test here is a defect that was reproduced, then fixed, now asserting the behavior that fixes it.
describe('discovery: file names', () => {
  it('a scan is found by its name however the name is written: hyphens, run-together words and short names all answer to the long form', async () => {
    const names = ['Power-Purchase-Agreement-executed.pdf', 'PowerPurchaseAgreement_signed.pdf', 'PPA (executed).pdf', 'O&M Agreement.pdf', 'Power Purchase Agreement executed.pdf'];
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const scan = doc(1, name, { rel: `09 Executed/${name}`, words: [] });                     // a signed copy: scanned, so no words
      const s = setup(() => ({ text: 'x', sources: [] }), { d1: [...filler(150), scan] });
      const q = name.startsWith('O&M') ? 'What does the O&M agreement say about availability?' : 'What is the tariff under the power purchase agreement (PPA)?';
      // a draft's pick lists the ranking
      val(await s.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: q }));
      const rows = listed(s.pickCalls[0] as Call); const at = rows.findIndex((r) => r.path.endsWith(name));
      out[name] = { question: q, shortlistSize: rows.length, placeInShortlist: at < 0 ? 'NOT IN THE 100 SHOWN TO THE FAST MODEL' : at + 1, sentToAnsweringModel: s.calls[0] ? sentNames(s.calls[0]).includes(name) : false };
    }
    for (const name of names) expect(out[name]).toMatchObject({ placeInShortlist: 1 });                                // first of 151 in every spelling
  });

  it('a plural finds its singular: "permits" finds "Permit", and the item is read against it and not made a gap', async () => {
    const esia = filler(150, 2000, (i) => `ESIA Chapter ${pad(i)}.pdf`, ['environmental', 'impact', 'assessment', 'habitat', 'noise', 'mitigation']).map((r) => ({ ...r, rel: `04 Environmental/ESIA/${r.name}` }));
    const permit = doc(1, 'Environmental Permit.pdf', { rel: '07 Permitting/Environmental Permit.pdf', words: [] });   // a scan of the permit itself
    const shared = new Mem();
    const s = setup((c) => ({ items: itemsIn(c).map((it) => (c.files.some((f) => /Permit/.test(f.name)) ? { id: it.tag, ...OK(c) } : { id: it.tag, result: 'more', need: 'the environmental permits' })) }), { d1: [...esia, permit] },
      { shared, installId: 'pc', checklist: () => ({ broad: [{ id: 'x1', text: 'The environmental permits are in place' }], product: [], sector: [] }), pick: (c) => ({ read: listed(c as Call).filter((r) => /Permit/.test(r.path)).map((r) => r.id) }) });   // a fast model that picks the permit whenever it is shown it
    await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
    const shownIn = s.pickCalls.map((c) => listed(c as Call).some((x) => x.path.endsWith('Environmental Permit.pdf')));
    expect(shownIn).toEqual([true]); expect(listed(s.pickCalls[0] as Call)[0].path).toBe('vdr/07 Permitting/Environmental Permit.pdf'); expect(r.gaps).toEqual([]); expect(sentNames(s.calls[0])).toEqual(['Environmental Permit.pdf']);
    // the control: the item says "permit", singular
    const s2 = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), { d1: [...esia, permit] }, { checklist: () => ({ broad: [{ id: 'x1', text: 'The environmental permit is in place' }], product: [], sector: [] }), pick: (c) => ({ read: listed(c as Call).filter((r) => /Permit/.test(r.path)).map((r) => r.id) }) });
    await deal(s2.repo); val(await s2.ai.firstPass('d1')); expect(listed(s2.pickCalls[0] as Call)[0].path).toBe('vdr/07 Permitting/Environmental Permit.pdf');
  });

  it('words in any alphabet are counted whole, and a name is split the same way wherever it is compared', () => {
    const es = 'El presente contrato de concesión se celebra entre la Sociedad Concesionaria y la Autoridad. La Sociedad Concesionaria se obliga a construir y operar la planta de conformidad con los términos del contrato. Las partes acuerdan que el plazo de la concesión será de veinticinco años contados desde la fecha de inicio. En caso de terminación anticipada por incumplimiento de la Sociedad Concesionaria, la Autoridad pagará el valor de terminación según el anexo. Los acreedores tendrán derecho de subrogación en los términos del acuerdo directo. '.repeat(20);
    const de = 'Der Darlehensnehmer verpflichtet sich, die Finanzkennzahlen einzuhalten. Die Kündigung des Stromabnahmevertrags durch den Abnehmer ist nur aus wichtigem Grund möglich. Die Sicherheiten werden zugunsten der Darlehensgeber bestellt und die Ausschüttungssperre gilt bis zur Erfüllung der Bedingungen. '.repeat(20);
    const ru = 'Настоящий кредитный договор заключён между заёмщиком и кредиторами. Заёмщик обязуется соблюдать финансовые ковенанты. '.repeat(20);
    expect(topWords(ru)).toEqual(expect.arrayContaining(['заёмщик', 'кредитный', 'договор']));         // Cyrillic is text, not a scan
    expect(topWords(es)).toEqual(expect.arrayContaining(['concesión', 'terminación', 'términos'])); expect(topWords(es)).not.toContain('concesi');   // an accent does not cut a word in two
    expect(topWords(de)).toEqual(expect.arrayContaining(['ausschüttungssperre']));
    // a name is split wherever it is split, and a short name with an ampersand is one word
    expect(tokens('Power-Purchase-Agreement_executed (v2).pdf')).toEqual(['power', 'purchase', 'agreement', 'executed', 'v2', 'pdf']); expect(tokens('PowerPurchaseAgreement')).toEqual(['power', 'purchase', 'agreement']);
    expect(tokens('PPAFinal O&M E & S IE P90 FY2023 Añadido')).toEqual(['ppa', 'final', 'om', 'es', 'ie', 'p90', 'fy2023', 'añadido']);
  });

});

describe('discovery: the core documents', () => {
  it('a library abbreviation in a file name answers to the long form a checklist item uses, and the document is core', async () => {
    const recs = { d1: [doc(1, 'PPA_final.pdf'), doc(2, 'Site photos.pdf'), doc(3, 'Board minutes.pdf')] };
    const s = setup(() => ({ text: 'x', sources: [] }), recs, { checklist: () => ({ broad: [{ id: 'c1', text: 'The power purchase agreement is signed' }], product: [], sector: [] }) });
    await deal(s.repo);
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Is the offtaker creditworthy?' }));
    expect((s.pickCalls[0].prompt.match(/^doc_[0-9a-f]{24} \*: .*$/gm) ?? []).map((l) => l.replace(/^doc_[0-9a-f]{24} \*: /, ''))).toEqual([expect.stringContaining('PPA_final.pdf')]);
  });
});
