// @vitest-environment node
// Filling gaps at deal size (docs/core-documents-design.md, part 4): the repo's 2,400-item checklist against a data room of
// a document for most subjects and none for some, on the stand-in model. What a check leaves open goes to the chat agent's
// own search, four items a run; this measures the extra runs and calls per item handed over.
import { it, expect } from 'vitest';
import { setup, doc, val, deal, itemsIn, OK, type Call } from './reviewKit';
import { dealList } from './dealList';

const { items: texts } = dealList();
const items = texts.map((text, i) => ({ id: `c${i + 1}`, text }));
// one document per subject, named as a data room names it, for every subject but those with no document at all
const MISSING = ['decommissioning plan', 'ALTA survey', 'water rights', 'NERC registration', 'major maintenance reserve'];
const subjects = [...new Set(texts.map((t) => /the (.+?)(?: has| is| may| runs| needs| was| does| survives| counterparty| co| matches| permit|$)/.exec(t)?.[1] ?? ''))].filter(Boolean);
const room = subjects.filter((s) => !MISSING.some((m) => s.includes(m))).map((s, i) => doc(i + 1, `${s}.pdf`, { rel: `${String(i % 12).padStart(2, '0')} Folder/${s}.pdf`, words: s.toLowerCase().split(/\W+/).filter(Boolean) }));
/** the standard model settles an item it is given its subject's document for, and asks for more otherwise */
const reply = (c: Call) => ({ items: itemsIn(c).map((it) => { const has = room.some((d) => it.text.includes(d.name.slice(0, -4)) && c.prompt.includes(`/${d.name}`)); return { id: it.tag, ...(has ? OK(c) : { result: 'more', need: 'the agreement itself' }) }; }) });

it('on the 2,400-item checklist every item a check leaves open goes to the chat agent once, four a run,'
  + ' each run stopping at limits.chatTurns, with no cap on the deal\'s calls', async () => {
  // the agent's search helper finds nothing in a page it reads, as when nothing is there; the agent would search on
  // every turn until its last, so each run stops only at limits.chatTurns (set to 3 here)
  const isTurn = (c: Call) => !!c.system?.includes('You work in turns');
  const turnOf = (c: Call) => +(/This is turn (\d+) of/.exec(c.prompt)?.[1] ?? 1);
  const searchOn = (c: Call) => ({ tool: 'search', what: 'documents', query: `agreement ${turnOf(c)}` });
  const lastTurn = (c: Call) => c.prompt.includes('It is your last');
  const fill = (c: Call) => (isTurn(c)
    ? (lastTurn(c) ? { text: 'Nothing settles them.', sources: [] } : searchOn(c))
    : c.prompt.includes('Which of them should be read for this?') ? { read: [] } : { text: '', sources: [] });
  const s = setup((c) => (isTurn(c) ? fill(c) : reply(c)), { d1: room }, {
    checklist: () => ({ broad: items, product: [], sector: [] }), turns: 3, fill,
  });
  await deal(s.repo);
  const t = performance.now(); const r = val(await s.ai.firstPass('d1')); const ms = performance.now() - t;
  // a run's first turn carries its items
  const firsts = s.fillCalls.filter(isTurn);
  const turns = [...s.fillCalls, ...s.calls].filter(isTurn);
  const listedIn = (c: Call) => [...c.prompt.split('\n\n')[0].matchAll(/^- (.*?)(?: Still needed:.*)?$/gm)];
  const handed = firsts.flatMap((c) => listedIn(c).map((m) => m[1]));
  const open = r.gaps.length + r.unsettled.length;
  expect(open).toBeGreaterThan(100);                                                         // a deal-sized number of gaps
  expect(new Set(handed).size).toBe(handed.length); expect(handed.length).toBe(open);      // every one handed over, none twice
  // four to a run (a group's last run may hold fewer)
  expect(firsts.length).toBeLessThanOrEqual(Math.ceil(open / 4) + Math.ceil(items.length / 20));
  // runs go on to limits.chatTurns and no further
  expect(Math.max(...turns.map(turnOf))).toBe(3);
  // a few calls per item handed over, at three turns a run
  expect(s.fillCalls.length / open).toBeLessThan(4);
  // no per-deal allowance stops it: the check and its filler together run well past a thousand calls
  expect(s.all.length).toBeGreaterThan(1000);
  expect(ms).toBeLessThan(180_000);                                                          // about a minute here, most of it the check itself; the budget leaves room for a busy machine
}, 300_000);
