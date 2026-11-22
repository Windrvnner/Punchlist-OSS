// @vitest-environment node
import { expect, it } from 'vitest';
import { Store } from '../../src/app/store';
import { DeleteDeal } from '../../src/app/commands/deals';
import { DeleteQuestion, EditQuestionField, SetResponse } from '../../src/app/commands/questions';
import { LogRepository } from '../../src/backend/logRepository';
import type { Question } from '../../src/domain/model';
import type { Transaction } from '../../src/ports';
import { okd, syncAll, twoPcs, type PC } from './pcs';

function holdDeletes(pc: PC, questionId: string) {
  const transaction = pc.repo.transaction.bind(pc.repo);
  const held: { transaction: Transaction; release: () => void }[] = [];
  pc.repo.transaction = (asked: Transaction) => {
    if (!asked.deletes?.some((record) => record.kind === 'question' && record.id === questionId)) {
      return transaction(asked);
    }
    let release = () => {};
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    held.push({ transaction: asked, release });
    return waiting.then(() => transaction(asked));
  };
  return held;
}

interface Recovery {
  B: PC;
  copyId: string;
  copied: Question;
  transaction: (index?: number) => Transaction;
  release: (index?: number) => ReturnType<PC['store']['dispatch']>;
}

async function withHeldDelete(check: (world: Recovery) => Promise<void>, windows = 1) {
  const { A, B, dealId, qid } = await twoPcs();
  const held = holdDeletes(B, qid);
  const deleting: ReturnType<PC['store']['dispatch']>[] = [];
  try {
    okd(await B.store.dispatch(EditQuestionField, {
      dealId, questionId: qid, field: 'text', value: 'Unseen question on B',
    }));
    const stores = [B.store];
    if (windows === 2) {
      const other = new Store(B.store.services, [DeleteQuestion]);
      await other.boot();
      await other.loadDeal(dealId, { gaps: false });
      stores.push(other);
    }
    for (const store of stores) {
      deleting.push(store.dispatch(DeleteQuestion, { dealId, questionId: qid }, { quiet: true }));
    }
    await expect.poll(() => held.length).toBe(windows);
    okd(await A.store.dispatch(DeleteDeal, { dealId, typedName: A.store.get().deals[dealId].name }));
    await syncAll(A, B);
    const copy = () => Object.values(B.store.get().deals).find((deal) => deal.name.endsWith('(recovered)'));
    await expect.poll(copy).toBeDefined();
    const copyId = copy()!.id;
    await B.store.loadDeal(copyId, { gaps: false });
    const copied = Object.values(B.store.get().questions).find((question) => question.dealId === copyId)!;
    await check({
      B, copyId, copied,
      transaction: (index = 0) => held[index].transaction,
      release: (index = 0) => {
        held[index].release();
        return deleting[index];
      },
    });
  } finally {
    for (const pending of held) pending.release();
    await Promise.allSettled(deleting);
    await A.repo.close();
    await B.repo.close();
  }
}

it('refuses an old-window deletion after newer recovered wording was saved', async () => {
  await withHeldDelete(async ({ B, copyId, copied, release }) => {
    okd(await B.store.dispatch(EditQuestionField, {
      dealId: copyId, questionId: copied.id, field: 'text', value: 'New edit in the recovered copy',
    }));
    const before = await B.repo.audit(copied.id);
    const released = await release();
    const after = await B.repo.get('question', copied.id);
    expect(released.ok).toBe(false);
    expect(after.ok && after.value?.envelope.data).toMatchObject({ text: 'New edit in the recovered copy' });
    expect(okd(await B.repo.get('tombstone', copied.id)).value).toBeNull();
    expect(await B.repo.audit(copied.id)).toEqual(before);
    const listed = okd(await B.repo.list('question', copyId)).value;
    expect(listed.map((record: { id: string }) => record.id)).toContain(copied.id);
  });
});

it('refuses the old deletion after a direct edit was put back as it was', async () => {
  await withHeldDelete(async ({ B, copyId, copied, release }) => {
    for (const value of ['An intervening edit', copied.text]) {
      okd(await B.store.dispatch(EditQuestionField, { dealId: copyId, questionId: copied.id, field: 'text', value }));
    }
    expect((await release()).ok).toBe(false);
    expect(okd(await B.repo.get('question', copied.id)).value.envelope.data.text).toBe(copied.text);
    expect(okd(await B.repo.get('tombstone', copied.id)).value).toBeNull();
  });
});

it('protects a response typed in the copy too', async () => {
  await withHeldDelete(async ({ B, copyId, copied, release }) => {
    okd(await B.store.dispatch(SetResponse, {
      dealId: copyId, questionId: copied.id, response: 'A newly typed answer',
    }));
    expect((await release()).ok).toBe(false);
    expect(okd(await B.repo.get('question', copied.id)).value.envelope.data.response).toBe('A newly typed answer');
    expect(okd(await B.repo.get('tombstone', copied.id)).value).toBeNull();
  });
});

it('does not replace a newer deletion snapshot in the copy', async () => {
  await withHeldDelete(async ({ B, copyId, copied, release }) => {
    okd(await B.store.dispatch(EditQuestionField, {
      dealId: copyId, questionId: copied.id, field: 'text', value: 'New text kept in Deleted',
    }));
    okd(await B.store.dispatch(DeleteQuestion, { dealId: copyId, questionId: copied.id }));
    const before = okd(await B.repo.get('tombstone', copied.id)).value;
    expect(before.envelope.data.snapshot.text).toBe('New text kept in Deleted');
    expect((await release()).ok).toBe(false);
    expect(okd(await B.repo.get('question', copied.id)).value).toBeNull();
    expect(okd(await B.repo.get('tombstone', copied.id)).value).toEqual(before);
  });
});

it('still forwards a deletion when the copy has no intervening edit', async () => {
  await withHeldDelete(async ({ B, copied, release }) => {
    expect((await release()).ok).toBe(true);
    expect(okd(await B.repo.get('question', copied.id)).value).toBeNull();
    expect(okd(await B.repo.get('tombstone', copied.id)).value.envelope.data.snapshot.text).toBe(copied.text);
  });
});

it('recognizes a real earlier forwarded deletion from its companion tombstone', async () => {
  await withHeldDelete(async ({ B, copied, release }) => {
    expect((await release(0)).ok).toBe(true);
    expect((await release(1)).ok).toBe(true);
    expect(okd(await B.repo.get('question', copied.id)).value).toBeNull();
    expect(okd(await B.repo.get('tombstone', copied.id)).value.envelope.data.snapshot.text).toBe(copied.text);
  }, 2);
});

it('keeps normal Delete and Undo through the copied ID', async () => {
  await withHeldDelete(async ({ B, copyId, copied, release }) => {
    const removed = okd(await B.store.dispatch(DeleteQuestion, { dealId: copyId, questionId: copied.id }));
    expect(okd(await B.repo.get('question', copied.id)).value).toBeNull();
    okd(await B.store.undo(removed.value.opId));
    expect(okd(await B.repo.get('question', copied.id)).value.envelope.data.text).toBe(copied.text);
    expect((await release()).ok).toBe(false);
    expect(okd(await B.repo.get('question', copied.id)).value.envelope.data.text).toBe(copied.text);
  });
});

it('retains the direct-edit protection after restarting the repository', async () => {
  await withHeldDelete(async ({ B, copyId, copied, transaction }) => {
    okd(await B.store.dispatch(EditQuestionField, {
      dealId: copyId, questionId: copied.id, field: 'text', value: 'New edit surviving restart',
    }));
    await B.repo.close();
    const repo = new LogRepository({ shared: B.shared, local: B.local, label: B.label, user: () => 'sroe' });
    try {
      await repo.ready();
      expect((await repo.transaction(transaction())).ok).toBe(false);
      expect(okd(await repo.get('question', copied.id)).value.envelope.data.text).toBe('New edit surviving restart');
      expect(okd(await repo.get('tombstone', copied.id)).value).toBeNull();
    } finally {
      await repo.close();
    }
  });
});
