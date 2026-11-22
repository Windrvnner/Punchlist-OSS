// @vitest-environment node
import { expect, it } from 'vitest';
import { DeleteDeal } from '../../src/app/commands/deals';
import { EditQuestionField } from '../../src/app/commands/questions';
import type { Question } from '../../src/domain/model';
import { okd, syncAll, twoPcs } from './pcs';

it.each(['after a read', 'directly'])('preserves a forwarded receipt when Discard follows %s (#565)', async (when) => {
  const { A, B, dealId, qid } = await twoPcs();
  try {
    okd(await B.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Unseen edit' }));
    const question = B.store.get().questions[qid];
    okd(await A.store.dispatch(DeleteDeal, { dealId, typedName: A.store.get().deals[dealId].name }));
    await syncAll(A, B);
    const copy = () => Object.values(B.store.get().deals).find((deal) => deal.name.endsWith('(recovered)'));
    await expect.poll(copy).toBeDefined();
    const copyId = copy()!.id;
    const at = B.store.services.clock.now();
    const id = B.store.services.ids.next('op');
    const input = { dealId, questionId: qid, response: 'Forwarded response' };
    const operation = { id, command: 'SetResponse', input, dealId, targets: [qid], state: 'pending', startedAt: at };
    const receipt = okd(await B.repo.transaction({ writes: [{ kind: 'op', id, data: operation, expectedRev: null }] }));
    const revision = receipt.value[id];
    const write = B.local.write.bind(B.local);
    let refused = false;
    B.local.write = (name, content) => {
      if (!refused && name.startsWith('pending-changes-') && content === '[]') {
        refused = true;
        throw new Error('Could not clear the local append marker');
      }
      write(name, content);
    };

    const appended = await B.repo.transaction({ writes: [
      { kind: 'question', id: qid, data: { ...question, response: input.response, updatedAt: at },
        expectedRev: question.rev },
      { kind: 'op', id, data: { ...operation, state: 'succeeded' }, expectedRev: revision },
    ] });
    expect(appended).toMatchObject({ ok: false, error: { kind: 'failed' } });
    const file = [...B.shared.files].find(([, content]) => content.includes(`"op":"${id}"`));
    expect(file?.[0]).toContain(copyId);
    if (when === 'after a read') {
      const before = B.local.read('ops.json');
      const observed = await B.repo.get('op', id);
      expect(observed.ok && observed.value?.envelope.data).toMatchObject({ state: 'succeeded' });
      expect(B.local.read('ops.json')).toBe(before);
    }
    const discarded = await B.repo.transaction({ writes: [
      { kind: 'op', id, data: { ...operation, state: 'discarded' }, expectedRev: revision },
    ] });
    expect(discarded).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    const saved = await B.repo.get('op', id);
    expect(saved.ok && saved.value?.envelope.data).toMatchObject({ state: 'succeeded' });
    const questions = await B.repo.list('question', copyId);
    expect(questions.ok && (questions.value[0].envelope.data as Question).response).toBe(input.response);
  } finally {
    await A.repo.close();
    await B.repo.close();
  }
});
