// @vitest-environment node
// Filling gaps at deal size (docs/core-documents-design.md, part 4): the repo's 2,400-item checklist against a data room of
// a document for most subjects and none for some, on the stand-in model. What a check leaves open goes to the chat agent's
// own search, four items a run; this measures the extra runs and calls per item handed over, and shows that the deal's
// search calls (limits.checkSearchCalls) are the stop.
import { it, expect } from 'vitest';
import { setup, doc, val, deal, itemsIn, OK, isFillAsk, type Call } from './reviewKit';
import { dealList } from './dealList';

const { items: texts } = dealList();
const items = texts.map((text, i) => ({ id: `c${i + 1}`, text }));
// one document per subject, named as a data room names it, for every subject but those with no document at all
const MISSING = ['decommissioning plan', 'ALTA survey', 'water rights', 'NERC registration', 'major maintenance reserve'];
const subjects = [...new Set(texts.map((t) => /the (.+?)(?: has| is| may| runs| needs| was| does| survives| counterparty| co| matches| permit|$)/.exec(t)?.[1] ?? ''))].filter(Boolean);
const room = subjects.filter((s) => !MISSING.some((m) => s.includes(m))).map((s, i) => doc(i + 1, `${s}.pdf`, { rel: `${String(i % 12).padStart(2, '0')} Folder/${s}.pdf`, words: s.toLowerCase().split(/\W+/).filter(Boolean) }));
/** the standard model settles an item it is given its subject's document for, and asks for more otherwise */
const reply = (c: Call) => ({ items: itemsIn(c).map((it) => { const has = room.some((d) => it.text.includes(d.name.slice(0, -4)) && c.prompt.includes(`/${d.name}`)); return { id: it.tag, ...(has ? OK(c) : { result: 'more', need: 'the agreement itself' }) }; }) });

it('on the 2,400-item checklist every item a check leaves open goes to the chat agent once, four to a run, and the deal\'s search calls stop it', async () => {
  // the deal's search calls set high enough that nothing stops the handing over; the agent's search helper picks nothing, as when nothing is there
  const fill = (c: Call) => (c.system?.includes('You work in turns') ? { text: 'Nothing in the data room settles them.', sources: [] } : c.prompt.includes('Which of them should be read for this?') ? { read: [] } : { text: '', sources: [] });
  const s = setup(reply, { d1: room }, { checklist: () => ({ broad: items, product: [], sector: [] }), checkSearchCalls: 100_000, fill }); await deal(s.repo);
  const t = performance.now(); const r = val(await s.ai.firstPass('d1')); const ms = performance.now() - t;
  const turns = s.fillCalls.filter((c) => c.system?.includes('You work in turns'));
  const handed = turns.flatMap((c) => [...c.prompt.split('\n\n')[0].matchAll(/^\d+\. (.*?)(?: Still needed:.*)?$/gm)].map((m) => m[1]));
  const open = r.gaps.length + r.unsettled.length;
  expect(open).toBeGreaterThan(100);                                                         // a deal-sized number of gaps
  expect(new Set(handed).size).toBe(handed.length); expect(handed.length).toBe(open);      // every one handed over, none twice
  expect(turns.length).toBeLessThanOrEqual(Math.ceil(open / 4) + Math.ceil(items.length / 20));   // four to a run (a group's last run may hold fewer)
  expect(s.fillCalls.length / open).toBeLessThan(1);                                         // the agent's pick and turn: about half a call per item handed over, when it finds nothing
  expect(ms).toBeLessThan(180_000);                                                          // about a minute here, most of it the check itself; the budget leaves room for a busy machine
  // the deal's search calls spent: items past them are not handed over, and every item is still written as the check left it
  const few = items.slice(0, 400); const tight = setup(reply, { d1: room }, { checklist: () => ({ broad: few, product: [], sector: [] }), checkSearchCalls: 60, fill }); await deal(tight.repo);
  const r2 = val(await tight.ai.firstPass('d1')); const open2 = r2.gaps.length + r2.unsettled.length;
  const handed2 = tight.fillCalls.filter((c) => isFillAsk(c) && c.system?.includes('You work in turns')).length * 4;
  expect(open2).toBeGreaterThan(100); expect(handed2).toBeLessThan(open2 / 2);
  expect(val(await tight.ai.checklist('d1')).filter((x) => x.result === 'unchecked')).toEqual([]);
}, 300_000);
