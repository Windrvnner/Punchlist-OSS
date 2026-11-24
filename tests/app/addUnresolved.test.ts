// @vitest-environment node
import { expect, it } from 'vitest';
import {
  narrowUnresolved, prepareUnresolved, retryUnresolved, selectUnresolved, submitUnresolved,
} from '../../src/app/addUnresolved';
import { CreateQuestion } from '../../src/app/commands/questions';
import { itemId } from '../../src/domain/checklist';
import { ok } from '../../src/domain/result';
import type { ChecklistRow } from '../../src/ports';
import { setup, type Call, val } from '../backend/reviewKit';
import { ITEMS } from '../fixtures/pastedList';
import { deal, make } from './importKit';

const tags = /^([bcdfghjkmnpqrstvwxz]{3}): \[(?:gap|finding)\] (.+)$/gm;
const questionFor = (what: string) => `Please provide the evidence for this checklist point: ${what}`;
const reply = (call: Call) => [...call.prompt.matchAll(tags)].map(([, id, what]) => ({ id, text: questionFor(what) }));

async function fixture(answer: (call: Call) => { items: ReturnType<typeof reply> }) {
  const { store } = make();
  const dealId = await deal(store);
  const rows = ITEMS.map(({ t }): ChecklistRow => ({ id: itemId(dealId, t), text: t, result: 'gap', docs: [] }));
  const model = setup(answer, {});
  store.services.ai.checklist = async () => ok(rows);
  store.services.ai.phrase = model.ai.phrase!.bind(model.ai);
  expect(rows.length).toBeGreaterThan(100);
  return { store, dealId, rows, model };
}

async function previewOf({ store, dealId }: Awaited<ReturnType<typeof fixture>>) {
  const counts: number[] = [];
  const signal = new AbortController().signal;
  const preview = val((await prepareUnresolved(store, dealId, { count: (count) => counts.push(count), signal }))!);
  return { preview, counts };
}

it('quietly retries a transient model failure and adds every question to its checklist item', async () => {
  const calls: string[][] = [];
  const env = await fixture((call) => {
    const items = reply(call);
    calls.push(items.map((item) => item.text));
    if (calls.length === 1) throw new Error('The model did not answer this time');
    return { items };
  });
  const { store, dealId, rows } = env;
  const { preview, counts } = await previewOf(env);
  expect(counts).toEqual([rows.length]);
  expect(calls[1]).toEqual(calls[0]);
  expect(preview.out).toEqual([]);
  expect(preview.points.map(({ itemId, text }) => [itemId, text])).toEqual(
    rows.map((row) => [row.id, questionFor(row.text)]),
  );
  expect(Object.values(store.get().questions)).toEqual([]);
  expect(await submitUnresolved(store, dealId, preview)).toEqual({ kind: 'added' });
  expect(Object.values(store.get().questions).map((q) => [q.linkedItem?.id, q.text])).toEqual(
    rows.map((row) => [row.id, questionFor(row.text)]),
  );
});

it('retries only the missing question and keeps the selected link, unchecked point, and drafted words', async () => {
  const missing = questionFor(ITEMS[4].t);
  const requested: string[][] = [];
  let available = false;
  const env = await fixture((call) => {
    const items = reply(call);
    requested.push(items.map((item) => item.text));
    return { items: items.filter((item) => available || item.text !== missing) };
  });
  const { store, dealId, rows } = env;
  const existingText = `Can you confirm the following: ${rows[1].text}?`;
  val(await store.dispatch(CreateQuestion, { dealId, text: existingText }));
  const existing = Object.values(store.get().questions)[0];
  const { preview } = await previewOf(env);
  expect(preview.out.map((p) => p.itemId)).toEqual([rows[4].id]);
  expect(requested.filter((texts) => texts.includes(missing)).length).toBeGreaterThan(1);
  expect(preview.links.map(({ point, q }) => [point.itemId, q.id])).toEqual([[rows[1].id, existing.id]]);
  const off = new Set([preview.points[1].key, preview.points[2].key]);
  const linked = new Set([existing.id]);
  const old = selectUnresolved(preview, off, linked);
  expect(await retryUnresolved(store, dealId, preview.out)).toBeUndefined();
  expect(selectUnresolved(preview, off, linked)).toEqual(old);
  available = true;
  const update = await retryUnresolved(store, dealId, preview.out);
  const ready = update?.(preview);
  expect(requested.at(-1)).toEqual([missing]);
  expect(ready?.out).toEqual([]);
  expect(ready?.points[4].text).toBe(missing);
  const selected = selectUnresolved(ready ?? null, off, linked);
  expect(selected.links).toEqual(old.links);
  expect(selected.points.filter((p) => p.text !== missing)).toEqual(old.points);
  expect(await submitUnresolved(store, dealId, selected)).toEqual({ kind: 'added' });
  const questions = Object.values(store.get().questions);
  expect(questions).toHaveLength(rows.length - 1);
  expect(questions.find((q) => q.id === existing.id)).toMatchObject({
    text: existingText, linkedItem: { id: rows[1].id },
  });
  expect(questions.some((q) => q.linkedItem?.id === rows[2].id)).toBe(false);
});

it('writes nothing if a selected gap settles after the preview and narrows the still-open preview', async () => {
  const env = await fixture((call) => ({ items: reply(call) }));
  const { store, dealId, rows } = env;
  const { preview } = await previewOf(env);
  const settled = rows[0];
  rows[0] = { ...settled, result: 'satisfied' };
  const result = await submitUnresolved(store, dealId, preview);
  expect(result).toMatchObject({ kind: 'changed', count: 1 });
  if (result.kind !== 'changed') throw new Error('Expected the stale preview to be refused');
  expect(Object.values(store.get().questions)).toEqual([]);
  expect(narrowUnresolved(preview, result.keys)?.points).toEqual(preview.points.slice(1));
});
