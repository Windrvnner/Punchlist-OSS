// @vitest-environment node
import { expect, it } from 'vitest';
import { CreateFinding } from '../../src/app/commands/findings';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { CreateQuestion } from '../../src/app/commands/questions';
import { logQuestionDraft, questionDraftAt, questionLogKey } from '../../src/app/logQuestionDraft';
import { dealQuestions } from '../../src/app/state';
import { itemId } from '../../src/domain/checklist';
import { recoveredId, recoveredIds, remap } from '../../src/domain/recovered';
import { scaleMemoInput } from '../fixtures/memoScale';
import { ITEMS } from '../fixtures/pastedList';
import { deal, make, sheet } from './importKit';

/** Questions about each site's checklist in a solar portfolio. */
function portfolioLog() {
  const regions = ['Northern', 'Southern', 'Eastern', 'Western'];
  const sites = ['Valley', 'Ridge', 'Plateau', 'Lake', 'Plains'];
  const questions = regions.flatMap((region) => sites.flatMap((site) => ITEMS.map((item) =>
    [`Please provide evidence for ${region} ${site} on this point: ${item.t}.`, item.s])));
  return sheet('Question,Workstream', questions.slice(0, 2000));
}

it('lands the original log and keeps a replacement with the same words until it too is logged', async () => {
  const { store } = make();
  const dealId = await deal(store);
  const rows = portfolioLog();
  const imported = await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows });
  expect(imported.ok).toBe(true);
  expect(dealQuestions(store.get(), dealId)).toHaveLength(2000);
  const titles = ['Lock-up ratio differs from the term sheet', 'Distribution test uses two calculation periods'];
  for (const title of titles) await store.dispatch(CreateFinding, { dealId, title, workstream: 'Financial' });
  const [first, second] = titles.map((title) => Object.values(store.get().findings).find((f) => f.title === title)!.id);
  const text = 'Please confirm the calculation in the executed agreement.';
  let kept: { text: string; findingId: string } | undefined = { text, findingId: first };
  const draft = { read: () => kept?.text, forget: () => { kept = undefined; } };
  const log = (findingId: string) => store.dispatch(CreateQuestion, { dealId, text, linkedFinding: findingId });
  let cancelled = false;
  const pending = logQuestionDraft(text, draft, () => log(first), () => cancelled);
  cancelled = true;
  draft.forget();
  kept = { text, findingId: second };
  expect(await pending).toBe(false);
  expect(kept).toEqual({ text, findingId: second });
  const logged = () => dealQuestions(store.get(), dealId).filter((q) => q.text === text).map((q) => q.linkedFinding);
  expect(logged()).toEqual([first]);
  expect(await logQuestionDraft(text, draft, () => log(second), () => false)).toBe(true);
  expect(kept).toBeUndefined();
  expect(logged()).toEqual([first, second]);
});

function recoveredChecklist() {
  const dealId = scaleMemoInput.deal.id;
  const copyId = recoveredId(dealId, 'office');
  const items = portfolioLog().map(({ text }) => ({
    kind: 'item' as const, id: itemId(dealId, text), versions: [{ text }],
  }));
  const ids = recoveredIds(dealId, copyId, items);
  expect(ids.size).toBe(2001);
  const move = (key: string) => remap(key.split(':'), ids).join(':');
  return { dealId, copyId, items, ids, move };
}

it('finds the pending save of only the recovered checklist item, including after a second recovery', () => {
  const { dealId, copyId, items, ids, move } = recoveredChecklist();
  const item = items[1400].id;
  const other = items[400].id;
  const sent = `ask:${dealId}:${item}`;
  const saving = new Set([sent]);
  const copied = `${copyId}:${ids.get(item)}`;
  expect(questionLogKey(copied, saving, move)).toBe(sent);
  const neighbor = `${copyId}:${ids.get(other)}`;
  expect(questionLogKey(neighbor, saving, move)).toBe('ask:' + neighbor);
  const next = recoveredId(copyId, 'laptop');
  ids.set(copyId, next);
  const nextItem = itemId(next, items[1400].versions[0].text);
  const copiedAgain = `${next}:${nextItem}`;
  ids.set(ids.get(item)!, nextItem);
  expect(questionLogKey(copiedAgain, saving, move)).toBe(sent);
  saving.delete(sent);
  expect(questionLogKey(copiedAgain, saving, move)).toBe('ask:' + copiedAgain);
});

it.each(['untouched', 'edited', 'cancelled'])('settles a twice-recovered %s draft at its current key', async (how) => {
  const { dealId, copyId, items, ids, move } = recoveredChecklist();
  const item = items[1400];
  const text = item.versions[0].text;
  const original = `${dealId}:${item.id}`;
  const texts = new Map([[original, text]]);
  const [first, second] = scaleMemoInput.findings;
  const targets = new Map([[original, first.id]]);
  const draft = questionDraftAt(original, move, texts, (key) => {
    texts.delete(key);
    targets.delete(key);
  });
  const logged = logQuestionDraft(text, draft, async () => ({ ok: true }), () => how === 'cancelled');
  const next = recoveredId(copyId, 'laptop');
  ids.set(copyId, next);
  const nextItem = itemId(next, text);
  ids.set(ids.get(item.id)!, nextItem);
  const latest = `${next}:${nextItem}`;
  const words = how === 'edited' ? text + ' Please identify the source document.' : text;
  texts.delete(original);
  texts.set(latest, words);
  targets.delete(original);
  const target = how === 'cancelled' ? second.id : first.id;
  targets.set(latest, target);
  expect(await logged).toBe(how !== 'cancelled');
  expect(texts.get(latest)).toBe(how === 'untouched' ? undefined : words);
  expect(targets.get(latest)).toBe(how === 'untouched' ? undefined : target);
});
