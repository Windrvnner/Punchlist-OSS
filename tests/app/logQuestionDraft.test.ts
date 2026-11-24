// @vitest-environment node
import { expect, it } from 'vitest';
import { CreateFinding } from '../../src/app/commands/findings';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { CreateQuestion } from '../../src/app/commands/questions';
import { logQuestionDraft } from '../../src/app/logQuestionDraft';
import { dealQuestions } from '../../src/app/state';
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
