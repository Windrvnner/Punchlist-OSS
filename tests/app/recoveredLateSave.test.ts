// @vitest-environment node
// A save prepared before recovery must not overwrite a later edit made in the copy.
import { expect, it } from 'vitest';
import { DeleteDeal } from '../../src/app/commands/deals';
import { DiscardDraft } from '../../src/app/commands/drafts';
import { EditQuestionField } from '../../src/app/commands/questions';
import { LogRepository } from '../../src/backend/logRepository';
import { firstMember, memberId, type Question } from '../../src/domain/model';
import type { Transaction } from '../../src/ports';
import { okd, syncAll, twoPcs, type PC } from './pcs';
import { dealQuestions } from '../../src/app/state';

async function recoveredQuestion(initial: Partial<Question> = {}, afterPlanned: Partial<Question> = {}) {
  const { A, B, dealId, qid } = await twoPcs();
  okd(await B.store.dispatch(EditQuestionField, {
    dealId, questionId: qid, field: 'text', value: 'Unseen question edited on B',
  }));
  const saved = B.store.get().questions[qid];
  if (Object.keys(initial).length) {
    okd(await B.repo.transaction({
      writes: [{ kind: 'question', id: qid, data: { ...saved, ...initial }, expectedRev: saved.rev }],
    }));
  }
  const loaded = await B.repo.get('question', qid);
  if (!loaded.ok || !loaded.value) throw new Error('The original question must exist');
  const question = { ...(loaded.value.envelope.data as Question), rev: loaded.value.rev };
  // Each transaction is based on the original question, before recovery, even when released after the copy is edited.
  const lateTransaction = (changes: Partial<Question>): Transaction => ({
      writes: [{
        kind: 'question', id: qid, data: { ...question, ...changes }, expectedRev: question.rev,
      }],
  });
  const lateWrite = (changes: Partial<Question>) => B.repo.transaction(lateTransaction(changes));
  if (Object.keys(afterPlanned).length) {
    // A change saved here after the late save was prepared, as an AI draft arriving: the late save does not know it.
    okd(await B.repo.transaction({
      writes: [{ kind: 'question', id: qid, data: { ...question, ...afterPlanned }, expectedRev: question.rev }],
    }));
  }
  // A late save that leaves a field out, as Discard Draft does: the key is absent, never set to undefined.
  const lateWithout = (field: keyof Question) => {
    const rest: Record<string, unknown> = { ...question };
    delete rest[field];
    return B.repo.transaction({ writes: [{ kind: 'question', id: qid, data: rest, expectedRev: question.rev }] });
  };
  okd(await A.store.dispatch(DeleteDeal, {
    dealId, typedName: A.store.get().deals[dealId].name,
  }));
  await syncAll(A, B);
  const copy = () => Object.values(B.store.get().deals).find((deal) => deal.name.endsWith('(recovered)'));
  await expect.poll(copy).toBeDefined();
  const copyId = copy()!.id;
  await B.store.loadDeal(copyId, { gaps: false });
  const copied = Object.values(B.store.get().questions)
    .find((candidate) => candidate.dealId === copyId && candidate.n === question.n)!;
  expect(copied.text).toBe('Unseen question edited on B');
  return { A, B, copyId, copied, lateWrite, lateWithout, lateTransaction };
}

async function withRecoveredQuestion(
  check: (world: Awaited<ReturnType<typeof recoveredQuestion>>) => Promise<void>, initial: Partial<Question> = {},
  afterPlanned: Partial<Question> = {},
) {
  const world = await recoveredQuestion(initial, afterPlanned);
  try {
    await check(world);
  } finally {
    await world.A.repo.close();
    await world.B.repo.close();
  }
}

async function restartRepository(pc: PC) {
  await pc.repo.close();
  const repo = new LogRepository({ shared: pc.shared, local: pc.local, label: pc.label, user: () => 'jdoe' });
  await repo.ready();
  return repo;
}

/** Replay older records without a forwarding field; only the fixture's raw log changes. */
function removeForwardingField(pc: PC, field: 'recoveredFrom' | 'recoveredReceipt') {
  for (const folder of [pc.shared, pc.local]) {
    for (const [name, text] of folder.files) {
      if (!name.startsWith('changes-')) continue;
      const lines = text.trimEnd().split('\n').map((line) => JSON.parse(line));
      for (const line of lines) for (const record of line.recs) delete record[field];
      folder.write(name, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    }
  }
}

it('keeps a newer recovered question when an old-window save arrives', async () => {
  await withRecoveredQuestion(async ({ B, copyId, copied, lateWrite }) => {
    okd(await B.store.dispatch(EditQuestionField, {
      dealId: copyId, questionId: copied.id, field: 'text', value: 'New edit in the recovered copy',
    }));
    const before = await B.repo.get('question', copied.id);
    expect(before.ok && before.value?.envelope.data).toMatchObject({ text: 'New edit in the recovered copy' });

    const released = await lateWrite({ text: 'Old-window text' });
    const after = await B.repo.get('question', copied.id);
    expect.soft(after.ok && after.value?.envelope.data).toMatchObject({ text: 'New edit in the recovered copy' });
    expect.soft(released.ok, 'the stale save must be refused rather than replace the newer copied text').toBe(false);
    expect(after.ok && after.value?.conflict).toBeUndefined();
  });
});

it('takes a late response without replacing newer question wording in the recovered copy', async () => {
  await withRecoveredQuestion(async ({ B, copyId, copied, lateWrite }) => {
    okd(await B.store.dispatch(EditQuestionField, {
      dealId: copyId, questionId: copied.id, field: 'text', value: 'New edit in the recovered copy',
    }));
    okd(await lateWrite({ response: 'Reply from the older window' }));
    const after = await B.repo.get('question', copied.id);
    expect(after.ok && after.value?.envelope.data).toMatchObject({
      text: 'New edit in the recovered copy', response: 'Reply from the older window',
    });
    expect(after.ok && after.value?.conflict).toBeUndefined();
  });
});

it('takes sequential forwarded saves of the same field after the copy already exists', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateWrite }) => {
    okd(await lateWrite({ response: 'First forwarded reply' }));
    okd(await lateWrite({ response: 'Second forwarded reply' }));
    const after = await B.repo.get('question', copied.id);
    expect(after.ok && after.value?.envelope.data).toMatchObject({ response: 'Second forwarded reply' });
    expect(after.ok && after.value?.conflict).toBeUndefined();
  });
});

it('refuses an overlapping stale save after a direct edit was changed back', async () => {
  await withRecoveredQuestion(async ({ B, copyId, copied, lateWrite }) => {
    for (const value of ['Direct edit in the copy', copied.text]) {
      okd(await B.store.dispatch(EditQuestionField, {
        dealId: copyId, questionId: copied.id, field: 'text', value,
      }));
    }
    const released = await lateWrite({ text: 'Old-window text' });
    const after = await B.repo.get('question', copied.id);
    expect.soft(after.ok && after.value?.envelope.data).toMatchObject({ text: copied.text });
    expect(released.ok).toBe(false);
  });
});

it('recognizes sequential forwarded saves after restarting the repository', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateWrite, lateTransaction }) => {
    okd(await lateWrite({ response: 'First forwarded reply' }));
    const restarted = await restartRepository(B);
    try {
      okd(await restarted.transaction(lateTransaction({ response: 'Second forwarded reply' })));
      const after = await restarted.get('question', copied.id);
      expect(after.ok && after.value?.envelope.data).toMatchObject({ response: 'Second forwarded reply' });
      expect(after.ok && after.value?.conflict).toBeUndefined();
    } finally {
      await restarted.close();
    }
  });
});

it('protects an older copied record whose update has no routing provenance', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateWrite, lateTransaction }) => {
    okd(await lateWrite({ response: 'An older saved reply with unknown origin' }));
    await B.repo.close();
    removeForwardingField(B, 'recoveredFrom');
    const restarted = await restartRepository(B);
    try {
      const released = await restarted.transaction(lateTransaction({ response: 'Old-window reply' }));
      const after = await restarted.get('question', copied.id);
      expect.soft(after.ok && after.value?.envelope.data).toMatchObject({
        response: 'An older saved reply with unknown origin',
      });
      expect(released.ok).toBe(false);
    } finally {
      await restarted.close();
    }
  });
});

it('keeps a draft discarded in the copy absent after restart and a stale draft save', async () => {
  const draft = { status: 'found' as const, text: 'Original draft', sources: [], forWording: 'wording' };
  await withRecoveredQuestion(async ({ B, copyId, copied, lateTransaction }) => {
    okd(await B.store.dispatch(DiscardDraft, { dealId: copyId, questionId: copied.id }));
    const restarted = await restartRepository(B);
    try {
      const before = okd(await restarted.get('question', copied.id));
      expect(before.value.envelope.data).not.toHaveProperty('draft');
      const released = await restarted.transaction(lateTransaction({ draft: { ...draft, text: 'Old-window draft' } }));
      const after = okd(await restarted.get('question', copied.id));
      expect.soft(after.value.envelope.data).not.toHaveProperty('draft');
      expect(released.ok).toBe(false);
    } finally {
      await restarted.close();
    }
  }, { draft });
});

const lateDraft = { status: 'found' as const, text: 'AI response to discard', sources: [], forWording: 'wording' };

async function editRecoveredWording(pc: PC, copied: Question, wording: string[]) {
  for (const text of wording) {
    okd(await pc.store.dispatch(EditQuestionField, {
      dealId: copied.dealId, questionId: copied.id, field: 'text', value: text,
    }));
  }
}

const recoveredWording = [
  'Provide the executed guarantee and the security schedule.',
  'Provide the executed guarantee and the final schedule of secured obligations.',
];

it('uses the returned revision for a second forwarded save that removes a draft (#774)', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateTransaction }) => {
    await editRecoveredWording(B, copied, recoveredWording);
    const first = lateTransaction({ response: 'The signed guarantee is available in the security package.' });
    const write = first.writes[0];
    const revision = okd(await B.repo.transaction(first)).value[write.id];
    expect(revision).toBeGreaterThan(Number(write.expectedRev));
    const { draft: _draft, ...withoutDraft } = write.data as Question;
    write.expectedRev = revision;
    write.data = withoutDraft;

    expect(await B.repo.transaction(first)).toMatchObject({ ok: true });
    const saved = okd(await B.repo.get('question', copied.id)).value.envelope.data;
    expect(saved).not.toHaveProperty('draft');
    expect(saved).toMatchObject({ response: withoutDraft.response, text: recoveredWording[1] });
  }, { draft: lateDraft });
});

it('restores a draft after a forwarded removal and a repository restart (#774)', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateWithout, lateTransaction }) => {
    await editRecoveredWording(B, copied, recoveredWording);
    const restore = lateTransaction({});
    const write = restore.writes[0];
    const revision = okd(await lateWithout('draft')).value[write.id];
    expect(revision).toBeGreaterThan(Number(write.expectedRev));
    write.expectedRev = revision;
    const restarted = await restartRepository(B);
    try {
      expect(await restarted.transaction(restore)).toMatchObject({ ok: true });
      const saved = okd(await restarted.get('question', copied.id)).value.envelope.data;
      expect(saved).toMatchObject({ draft: lateDraft, text: recoveredWording[1] });
    } finally {
      await restarted.close();
    }
  }, { draft: lateDraft });
});

it('refuses a second save whose revision could name the original or the copy (#774)', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateTransaction }) => {
    const first = lateTransaction({ response: 'The historical statements have been reconciled.' });
    const putBack = lateTransaction({});
    const write = putBack.writes[0];
    const revision = okd(await B.repo.transaction(first)).value[write.id];
    expect(revision).toBe(write.expectedRev);

    expect(await B.repo.transaction(putBack)).toMatchObject({ ok: false });
    const saved = okd(await B.repo.get('question', copied.id)).value.envelope.data;
    expect(saved).toMatchObject({ response: 'The historical statements have been reconciled.' });
  });
});

it('refuses a forwarded receipt after a newer save in the copy (#774)', async () => {
  await withRecoveredQuestion(async ({ B, copied, copyId, lateTransaction }) => {
    const first = lateTransaction({ response: 'The draft covenant certificate is available.' });
    const putBack = lateTransaction({});
    const write = putBack.writes[0];
    write.expectedRev = okd(await B.repo.transaction(first)).value[write.id];
    const newer = 'The signed covenant certificate has replaced the draft.';
    const current = okd(await B.repo.get('question', copied.id)).value;
    const data = { ...current.envelope.data, dealId: copyId, response: newer };
    okd(await B.repo.transaction({ writes: [{ kind: 'question', id: copied.id, data, expectedRev: current.rev }] }));

    expect(await B.repo.transaction(putBack)).toMatchObject({ ok: false });
    const saved = okd(await B.repo.get('question', copied.id)).value.envelope.data;
    expect(saved).toMatchObject({ response: newer, draft: lateDraft });
  }, { draft: lateDraft });
});

it('preserves a direct edit already in the copy when a follow-up uses the forwarded receipt (#774)', async () => {
  await withRecoveredQuestion(async ({ B, copied, copyId, lateTransaction }) => {
    const newer = 'Provide the executed guarantee and its schedule of secured obligations.';
    okd(await B.store.dispatch(EditQuestionField, {
      dealId: copyId, questionId: copied.id, field: 'text', value: newer,
    }));
    const first = lateTransaction({ response: 'A draft is available in the security package.' });
    const putBack = lateTransaction({});
    const write = putBack.writes[0];
    const revision = okd(await B.repo.transaction(first)).value[write.id];
    expect(revision).not.toBe(write.expectedRev);
    write.expectedRev = revision;

    expect(await B.repo.transaction(putBack)).toMatchObject({ ok: true });
    const saved = okd(await B.repo.get('question', copied.id)).value.envelope.data;
    expect(saved).toMatchObject({ text: newer, response: '' });
  });
});

it('rejects a receipt that also names an earlier original revision with unseen work (#774)', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateTransaction }) => {
    const response = 'The executed guarantee is in the closing binder.';
    const first = lateTransaction({ response, draft: lateDraft });
    const stale = lateTransaction({ text: 'Provide the executed guarantee and its security schedule.' });
    const oldRevision = Number(stale.writes[0].expectedRev);
    first.writes[0].expectedRev = oldRevision + 1;
    const revision = okd(await B.repo.transaction(first)).value[first.writes[0].id];
    expect(revision).toBe(oldRevision);

    expect(await B.repo.transaction(stale)).toMatchObject({ ok: false });
    const saved = okd(await B.repo.get('question', copied.id)).value.envelope.data;
    expect(saved).toMatchObject({ response, draft: lateDraft });
  }, {}, { draft: lateDraft });
});

it.each([1, 2])('accepts an original save after a legacy receipt and %i unrelated edits (#774)', async (count) => {
  await withRecoveredQuestion(async ({ B, copied, lateWrite, lateTransaction }) => {
    const response = 'The signed covenant certificate is in the closing binder.';
    const receipt = okd(await lateWrite({ response: 'The draft covenant certificate is in the data room.' }));
    const next = lateTransaction({ response });
    expect(receipt.value[next.writes[0].id]).not.toBe(next.writes[0].expectedRev);
    await editRecoveredWording(B, copied, recoveredWording.slice(-count));
    await B.repo.close();
    removeForwardingField(B, 'recoveredReceipt');
    const restarted = await restartRepository(B);
    try {
      expect(await restarted.transaction(next)).toMatchObject({ ok: true });
      const saved = okd(await restarted.get('question', copied.id)).value.envelope.data;
      expect(saved).toMatchObject({ text: recoveredWording[1], response, draft: lateDraft });
    } finally {
      await restarted.close();
    }
  }, { draft: lateDraft });
});

it('removes a draft from the recovered copy when a late Discard Draft arrives (#664)', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateWithout }) => {
    expect(copied.draft?.text).toBe('AI response to discard');
    okd(await lateWithout('draft'));
    const after = okd(await B.repo.get('question', copied.id));
    expect(after.value.envelope.data).not.toHaveProperty('draft');
    expect(after.value.envelope.data).toMatchObject({ text: 'Unseen question edited on B' });
    expect(after.value.conflict).toBeUndefined();
  }, { draft: lateDraft });
});

it('refuses a late Discard Draft when the draft changed in the recovered copy (#664)', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateWithout }) => {
    const edited = { ...lateDraft, text: 'Draft changed in the copy' };
    okd(await B.repo.transaction({
      writes: [{ kind: 'question', id: copied.id, data: { ...copied, draft: edited }, expectedRev: copied.rev }],
    }));
    const released = await lateWithout('draft');
    const after = okd(await B.repo.get('question', copied.id));
    expect.soft(after.value.envelope.data).toMatchObject({ draft: edited });
    expect(released.ok).toBe(false);
  }, { draft: lateDraft });
});

it('applies a late Discard Draft without undoing other edits made in the recovered copy (#664)', async () => {
  await withRecoveredQuestion(async ({ B, copyId, copied, lateWithout }) => {
    okd(await B.store.dispatch(EditQuestionField, {
      dealId: copyId, questionId: copied.id, field: 'text', value: 'New edit in the recovered copy',
    }));
    okd(await lateWithout('draft'));
    const after = okd(await B.repo.get('question', copied.id));
    expect(after.value.envelope.data).not.toHaveProperty('draft');
    expect(after.value.envelope.data).toMatchObject({ text: 'New edit in the recovered copy' });
  }, { draft: lateDraft });
});

it('refuses a member write that lands after its deal was deleted on another PC (#222)', async () => {
  const { A, B, dealId } = await twoPcs();
  try {
    const id = memberId(dealId, 'sroe');
    const member = firstMember(dealId, 'sroe', '2026-11-12T09:00:00.000Z');
    okd(await A.store.dispatch(DeleteDeal, { dealId, typedName: A.store.get().deals[dealId].name }));
    await syncAll(A, B);
    const released = await B.repo.transaction({
      writes: [{ kind: 'member', id, data: member, expectedRev: null }],
      index: { dealId: '_', add: [{ kind: 'member', id }] },
    });
    expect(released.ok).toBe(false);
    await syncAll(A, B);
    for (const pc of [A, B]) expect(okd(await pc.repo.get('member', id)).value).toBeNull();
  } finally {
    await A.repo.close();
    await B.repo.close();
  }
});

it('refuses late saves once the recovered copy itself was deleted (#222)', async () => {
  await withRecoveredQuestion(async ({ B, copyId, copied, lateWrite }) => {
    okd(await B.store.dispatch(DeleteDeal, { dealId: copyId, typedName: B.store.get().deals[copyId].name }));
    expect((await lateWrite({ response: 'Typed before the copy was deleted' })).ok).toBe(false);
    expect(okd(await B.repo.get('question', copied.id)).value).toBeNull();
  });
});

it('refuses a new record for a deleted deal once its recovered copy was deleted (#222)', async () => {
  await withRecoveredQuestion(async ({ B, copyId, lateTransaction }) => {
    const original = lateTransaction({}).writes[0].data as Question;
    okd(await B.store.dispatch(DeleteDeal, { dealId: copyId, typedName: B.store.get().deals[copyId].name }));
    const id = 'q_01HPRBFXXXXXXXXXXXTLATE0001';
    const released = await B.repo.transaction({
      writes: [{ kind: 'question', id, data: { ...original, id, n: original.n + 1, rev: 0 }, expectedRev: null }],
      index: { dealId: original.dealId, add: [{ kind: 'question', id }] },
    });
    expect(released.ok).toBe(false);
    expect(okd(await B.repo.get('question', id)).value).toBeNull();
    expect(dealQuestions(B.store.get(), copyId)).toHaveLength(0);
  });
});

it('keeps a draft that arrived after a late save was prepared (#664)', async () => {
  await withRecoveredQuestion(async ({ B, copied, lateWrite }) => {
    const released = await lateWrite({ response: 'Reply typed before the draft arrived' });
    const after = okd(await B.repo.get('question', copied.id));
    expect.soft(after.value.envelope.data).toMatchObject({ draft: lateDraft });
    expect(released.ok, 'a stale save that omits the newer draft is refused, not applied as a discard').toBe(false);
  }, {}, { draft: lateDraft });
});
