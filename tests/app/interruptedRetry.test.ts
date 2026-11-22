import { describe, expect, it, vi } from 'vitest';
import { CreateQuestion, SetResponse } from '../../src/app/commands/questions';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, SetFindingStatus } from '../../src/app/commands/findings';
import { AddDealItems, SetItemsOff } from '../../src/app/commands/checklist';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { ALIVE_MS } from '../../src/app/store';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { Operation } from '../../src/domain/model';
import {
  copyRecoveryDisk, holdRecoveryWrite, operationWrite, recoveryApp, recoveryDeal,
  type RecoveryApp,
} from './recoveryKit';

async function interruptedResponse() {
  const app = recoveryApp();
  const dealId = await recoveryDeal(app);
  await app.store.dispatch(CreateQuestion, { dealId, text: 'Confirm the executed agreement.' });
  const questionId = Object.keys(app.store.get().questions)[0];
  const hold = holdRecoveryWrite(app, (transaction) => operationWrite(transaction, 'SetResponse', 'succeeded'));
  const saving = app.store.dispatch(SetResponse, { dealId, questionId, response: 'The agreement is executed.' });
  await hold.entered;
  const saved = copyRecoveryDisk(app.saved);
  hold.release();
  await saving;
  app.store.closing();
  await app.repo.close();
  return { saved, dealId, questionId };
}

async function restartWithoutOpening(saved: RecoveryApp['saved']) {
  const next = recoveryApp(saved);
  await next.store.boot();
  expect(next.store.get().dealLoad).toEqual({});
  return next;
}

async function interruptedCreation() {
  const app = recoveryApp();
  const dealId = await recoveryDeal(app);
  const hold = holdRecoveryWrite(app, (transaction) => operationWrite(transaction, 'CreateQuestion', 'succeeded'));
  const saving = app.store.dispatch(CreateQuestion, { dealId, text: 'Request the executed waiver.' });
  await hold.entered;
  const saved = copyRecoveryDisk(app.saved);
  hold.release();
  await saving;
  app.store.closing();
  await app.repo.close();
  return { saved, dealId };
}

function refuseJournalWrites(app: RecoveryApp) {
  const write = app.saved.local.write.bind(app.saved.local);
  app.saved.local.write = (name, content) => {
    if (name === 'ops.json') throw new Error('Journal locked');
    write(name, content);
  };
  return () => { app.saved.local.write = write; };
}

function interruptQuestionRetry(app: RecoveryApp, when: string) {
  const original = app.repo.transaction.bind(app.repo);
  app.repo.transaction = async (transaction) => {
    if (operationWrite(transaction, 'CreateQuestion', 'failed')) {
      return { ok: false, error: { kind: 'storageFull', message: 'The disk is full' } };
    }
    if (!operationWrite(transaction, 'CreateQuestion', 'succeeded')) return original(transaction);
    if (when !== 'before commit') {
      const restore = when === 'after commit with a blocked journal' ? refuseJournalWrites(app) : null;
      try {
        expect(await original(transaction)).toMatchObject({ ok: true });
      } finally {
        restore?.();
      }
    }
    throw new Error('Interrupted connection');
  };
  return () => { app.repo.transaction = original; };
}

describe('Retry of interrupted work from Home', () => {
  it('loads the question before retrying and saves the original answer once', async () => {
    const { saved, dealId, questionId } = await interruptedResponse();
    const next = await restartWithoutOpening(saved);
    const pending = next.store.interruptedOps().find((operation) => operation.command === 'SetResponse')!;
    expect(pending).toBeDefined();
    expect((await next.store.retryOp(pending.id))?.ok).toBe(true);
    await next.store.loadDeal(dealId, { gaps: false });
    expect(next.store.get().questions[questionId].response).toBe('The agreement is executed.');
    expect(next.store.interruptedOps()).toEqual([]);
    await next.store.loadAudit(questionId);
    expect(next.store.get().audit[questionId].filter((entry) => entry.kind === 'response')).toHaveLength(1);
    await next.repo.close();
  });

  it('keeps a recoverable operation if the retry stops before its pending write', async () => {
    const { saved, dealId } = await interruptedResponse();
    const next = recoveryApp(saved);
    await next.store.boot();
    await next.store.loadDeal(dealId, { gaps: false });
    const pending = next.store.interruptedOps()[0];
    const hold = holdRecoveryWrite(next, (transaction) => operationWrite(transaction, 'SetResponse', 'pending'));
    const retrying = next.store.retryOp(pending.id);
    await hold.entered;
    const crashed = copyRecoveryDisk(next.saved);
    hold.release();
    await retrying;
    next.store.closing();
    await next.repo.close();
    const again = await restartWithoutOpening(crashed);
    expect(again.store.interruptedOps().map((operation) => operation.command)).toEqual(['SetResponse']);
    await again.repo.close();
  });

  it('the failed handoff notice retries the original creation exactly once', async () => {
    const { saved, dealId } = await interruptedCreation();
    const next = recoveryApp(saved);
    await next.store.boot();
    const original = next.repo.transaction.bind(next.repo);
    next.repo.transaction = async (transaction) => {
      if (operationWrite(transaction, 'CreateQuestion', 'pending')) {
        return { ok: false, error: { kind: 'unreachable', message: 'Journal unavailable' } };
      }
      return original(transaction);
    };
    expect((await next.store.retryOp(next.store.interruptedOps()[0].id))?.ok).toBe(false);
    expect(next.store.interruptedOps()).toHaveLength(1);
    const retry = next.store.get().ui.toasts.find((notice) => notice.text === 'Couldn’t save ·')!.action!;
    next.repo.transaction = original;
    retry.run!();
    retry.run!();
    await vi.waitFor(() => expect(Object.values(next.store.get().questions)).toHaveLength(1));
    expect(next.store.interruptedOps()).toEqual([]);
    const restarted = recoveryApp(copyRecoveryDisk(next.saved));
    await restarted.store.boot();
    await restarted.store.loadDeal(dealId, { gaps: false });
    expect(Object.values(restarted.store.get().questions)).toHaveLength(1);
    expect(restarted.store.interruptedOps()).toEqual([]);
    await next.repo.close();
    await restarted.repo.close();
  });

  it('keeps an interrupted write available after a refused Retry and Discard (#565)', async () => {
    const { saved } = await interruptedCreation();
    const next = await restartWithoutOpening(saved);
    const [pending] = next.store.interruptedOps();
    const original = next.repo.transaction.bind(next.repo);
    next.repo.transaction = async (transaction) => {
      const refused = ['succeeded', 'discarded'].some((state) => operationWrite(transaction, 'CreateQuestion', state));
      if (refused) return { ok: false, error: { kind: 'storageFull', message: 'The disk is full' } };
      return original(transaction);
    };
    const retry = await next.store.retryOp(pending.id);
    expect(retry).toMatchObject({ ok: false, error: { kind: 'storageFull' } });
    expect(next.store.get().ops[pending.id].state).toBe('interrupted');
    await next.store.discardOp(pending.id);
    expect(next.store.get().ops[pending.id].state).toBe('interrupted');
    const journal = await next.repo.get('op', pending.id);
    expect(journal.ok && journal.value?.envelope.data).toMatchObject({ state: 'pending' });

    next.repo.transaction = original;
    await next.store.discardOp(pending.id);
    expect(next.store.interruptedOps()).toEqual([]);
    const restarted = await restartWithoutOpening(copyRecoveryDisk(next.saved));
    expect(restarted.store.interruptedOps()).toEqual([]);
    await next.repo.close();
    await restarted.repo.close();
  });

  it('keeps Retry and Discard when the record conflicts and the journal cannot settle it (#565)', async () => {
    const { saved, dealId } = await interruptedCreation();
    const next = await restartWithoutOpening(saved);
    const [pending] = next.store.interruptedOps();
    const original = next.repo.transaction.bind(next.repo);
    next.repo.transaction = async (transaction) => {
      if (operationWrite(transaction, 'CreateQuestion', 'succeeded')) {
        return { ok: false, error: { kind: 'conflict', message: 'Changed elsewhere' } };
      }
      if (operationWrite(transaction, 'CreateQuestion', 'failed')) {
        return { ok: false, error: { kind: 'storageFull', message: 'The disk is full' } };
      }
      return original(transaction);
    };
    expect(await next.store.retryOp(pending.id)).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(next.store.get().ops[pending.id].state).toBe('interrupted');
    const journal = await next.repo.get('op', pending.id);
    expect(journal.ok && journal.value?.envelope.data).toMatchObject({ state: 'pending' });

    next.repo.transaction = original;
    expect(await next.store.retryOp(pending.id)).toMatchObject({ ok: true });
    await next.store.loadDeal(dealId, { gaps: false });
    expect(Object.values(next.store.get().questions).map((question) => question.text))
      .toEqual(['Request the executed waiver.']);
    expect(next.store.interruptedOps()).toEqual([]);
    await next.repo.close();
  });

  it('uses the recorded failure when its acknowledgment is lost (#565)', async () => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    const write = app.repo.transaction.bind(app.repo);
    app.repo.transaction = async (transaction) => {
      if (operationWrite(transaction, 'CreateQuestion', 'succeeded')) {
        return { ok: false, error: { kind: 'conflict', message: 'Changed elsewhere' } };
      }
      const result = await write(transaction);
      if (operationWrite(transaction, 'CreateQuestion', 'failed')) {
        expect(result).toMatchObject({ ok: true });
        throw new Error('Lost acknowledgment');
      }
      return result;
    };
    try {
      expect(await app.store.dispatch(CreateQuestion, { dealId, text: 'Confirm the waiver.' }))
        .toMatchObject({ ok: false });
      const op = Object.values(app.store.get().ops).find((operation) => operation.command === 'CreateQuestion')!;
      expect(await app.repo.get('op', op.id)).toMatchObject({
        ok: true, value: { envelope: { data: { state: 'failed' } } },
      });
      expect(op.state).toBe('failed');
    } finally {
      app.store.closing();
      await app.repo.close();
    }
  });

  it('provides recovery in the original window if a new write cannot settle as failed (#565)', async () => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    const original = app.repo.transaction.bind(app.repo);
    app.repo.transaction = async (transaction) => {
      if (operationWrite(transaction, 'CreateQuestion', 'succeeded')) {
        return { ok: false, error: { kind: 'conflict', message: 'Changed elsewhere' } };
      }
      if (operationWrite(transaction, 'CreateQuestion', 'failed')) {
        return { ok: false, error: { kind: 'storageFull', message: 'The disk is full' } };
      }
      return original(transaction);
    };
    const result = await app.store.dispatch(CreateQuestion, { dealId, text: 'Request the waiver.' });
    expect(result).toMatchObject({ ok: false });
    const [operation] = app.store.interruptedOps();
    expect(operation).toMatchObject({ state: 'interrupted', input: { text: 'Request the waiver.' } });
    app.repo.transaction = original;
    await app.store.discardOp(operation.id);
    expect(app.store.interruptedOps()).toEqual([]);
    await app.repo.close();
  });

  it.each([
    'before commit', 'after commit', 'after commit with a blocked journal',
  ])('reconciles a Retry that throws %s (#565)', async (when) => {
    const { saved, dealId } = await interruptedCreation();
    const next = await restartWithoutOpening(saved);
    const [pending] = next.store.interruptedOps();
    const committed = when !== 'before commit';
    const restore = interruptQuestionRetry(next, when);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await next.store.retryOp(pending.id)).toMatchObject({ ok: false });
    } finally {
      logged.mockRestore();
      restore();
    }
    expect(next.store.get().ops[pending.id].state).toBe(committed ? 'succeeded' : 'interrupted');
    if (!committed) expect(await next.store.retryOp(pending.id)).toMatchObject({ ok: true });
    await next.store.loadDeal(dealId, { gaps: false });
    const questions = await next.repo.list('question', dealId);
    expect(questions.ok && questions.value.map(({ envelope }) => envelope.data))
      .toMatchObject([{ text: 'Request the executed waiver.' }]);
    expect(next.store.interruptedOps()).toEqual([]);
    await next.repo.close();
  });

  it.each([
    'no proof', 'legacy proof', 'other operation’s proof',
  ])('retries a new question while an unrelated deal file is locked with %s (#565)', async (proof) => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    await app.store.dispatch(CreateDeal, { name: 'Unrelated deal', folders: [] });
    const unrelatedId = Object.keys(app.store.get().deals).find((id) => id !== dealId)!;
    await app.store.dispatch(CreateQuestion, { dealId: unrelatedId, text: 'An unrelated question.' });
    const locked = [...app.saved.shared.files.keys()].find((name) => name.includes(unrelatedId))!;
    expect(locked).toBeDefined();
    if (proof !== 'no proof') {
      const append = app.saved.shared.append.bind(app.saved.shared);
      app.saved.shared.append = (name, text) => {
        if (name === locked) throw new Error('Unrelated deal cannot be written');
        append(name, text);
      };
      expect(await app.store.dispatch(CreateQuestion, { dealId: unrelatedId, text: 'An unrelated failed write.' }))
        .toMatchObject({ ok: false });
      app.saved.shared.append = append;
    }
    const hold = holdRecoveryWrite(app, (transaction) => operationWrite(transaction, 'CreateQuestion', 'succeeded'));
    const writing = app.store.dispatch(CreateQuestion, { dealId, text: 'Recover this question.' });
    await hold.entered;
    const saved = copyRecoveryDisk(app.saved);
    hold.release();
    await writing;
    await app.repo.close();

    if (proof !== 'no proof') {
      const sidecar = `pending-changes-${app.repo.id}.json`;
      const entries: { file: string; text: string }[] = JSON.parse(saved.local.read(sidecar)!);
      expect(entries).toMatchObject([{ file: locked }]);
      const compact = JSON.parse(entries[0].text);
      expect(compact).toMatchObject({ proof: 1, op: expect.any(String) });
      if (proof === 'legacy proof') {
        delete compact.op;
        entries[0].text = JSON.stringify(compact);
        saved.local.write(sidecar, JSON.stringify(entries));
      }
    }
    const read = saved.shared.read.bind(saved.shared);
    saved.shared.read = (name) => {
      if (name === locked) throw new Error('Unrelated deal is locked');
      return read(name);
    };
    const next = await restartWithoutOpening(saved);
    expect(await next.repo.list('question', unrelatedId)).toMatchObject({ ok: false });
    const operation = next.store.interruptedOps().find((entry) => entry.dealId === dealId)!;
    expect(await next.store.retryOp(operation.id)).toMatchObject({ ok: true });
    const texts = Object.values(next.store.get().questions).map((question) => question.text);
    expect(texts).toEqual(['Recover this question.']);
    await next.repo.close();
  });

  it('checks a settled receipt before discarding a notice from another window (#565)', async () => {
    const { saved } = await interruptedCreation();
    const next = await restartWithoutOpening(saved);
    const [pending] = next.store.interruptedOps();
    const peer = await restartWithoutOpening(saved);
    expect(await peer.store.retryOp(pending.id)).toMatchObject({ ok: true });
    expect(next.store.get().ops[pending.id].state).toBe('interrupted');
    await next.store.discardOp(pending.id);
    const journal = await next.repo.get('op', pending.id);
    expect(journal.ok && journal.value?.envelope.data).toMatchObject({ state: 'succeeded' });
    expect(next.store.interruptedOps()).toEqual([]);
    await next.repo.close();
    await peer.repo.close();
  });

  it.each(['Retry', 'Discard'])('keeps the receipt after %s follows an uncertain append (#565)', async (action) => {
    const { saved, dealId } = await interruptedCreation();
    const next = await restartWithoutOpening(saved);
    const [pending] = next.store.interruptedOps();
    const write = saved.local.write.bind(saved.local);
    let refused = false;
    saved.local.write = (name, content) => {
      if (!refused && name.startsWith('pending-changes-') && content === '[]') {
        refused = true;
        throw new Error('Could not clear the local append marker');
      }
      write(name, content);
    };

    expect(await next.store.retryOp(pending.id)).toMatchObject({ ok: false, error: { kind: 'failed' } });
    if (action === 'Retry') await next.store.retryOp(pending.id);
    else await next.store.discardOp(pending.id);
    expect(refused).toBe(true);
    expect(next.store.get().ops[pending.id].state).toBe('succeeded');
    expect(next.store.interruptedOps()).toEqual([]);
    const written = await next.repo.list('question', dealId);
    expect(written.ok && written.value).toHaveLength(1);
    await next.repo.close();
  });

  it('stops tracking a write after Retry confirms it already landed (#565)', async () => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    const write = app.saved.local.write.bind(app.saved.local);
    app.saved.local.write = (name, text) => {
      if (name.startsWith('pending-changes-') && text === '[]') throw new Error('Could not clear the append marker');
      if (name === 'ops.json' && text.includes('"state":"failed"')) throw new Error('Journal locked');
      write(name, text);
    };
    const marks = vi.spyOn(app.store.services.local, 'write');
    vi.useFakeTimers();
    try {
      expect(await app.store.dispatch(CreateQuestion, { dealId, text: 'Confirm waiver.' }, { quiet: true }))
        .toMatchObject({ ok: false });
      const op = Object.values(app.store.get().ops).find((operation) => operation.command === 'CreateQuestion')!;
      app.saved.local.write = write;
      await app.repo.sync();
      expect(await app.store.retryOp(op.id)).toMatchObject({ ok: true });
      expect(app.store.get().ops[op.id].state).toBe('succeeded');
      expect(await app.repo.list('question', dealId)).toMatchObject({ ok: true, value: [{ kind: 'question' }] });
      marks.mockClear();
      await vi.advanceTimersByTimeAsync(ALIVE_MS + 1);
      expect(marks.mock.calls.map(([key]) => key)).not.toContain('alive');
    } finally {
      app.saved.local.write = write;
      app.store.closing();
      await app.repo.close();
      marks.mockRestore();
      vi.useRealTimers();
    }
  });

  it('refuses to discard with a cached revision when reading the journal fails (#565)', async () => {
    const { saved } = await interruptedCreation();
    const next = await restartWithoutOpening(saved);
    const [pending] = next.store.interruptedOps();
    const peer = await restartWithoutOpening(saved);
    expect(await peer.store.retryOp(pending.id)).toMatchObject({ ok: true });
    const read = saved.local.read.bind(saved.local);
    saved.local.read = (name) => {
      if (name === 'ops.json') throw new Error('Journal temporarily locked for reads');
      return read(name);
    };
    await next.store.discardOp(pending.id);
    expect(next.store.get().ops[pending.id].state).toBe('interrupted');
    saved.local.read = read;
    expect(await next.repo.get('op', pending.id)).toMatchObject({
      ok: true, value: { envelope: { data: { state: 'succeeded' } } },
    });
    await next.store.discardOp(pending.id);
    expect(next.store.interruptedOps()).toEqual([]);
    await next.repo.close();
    await peer.repo.close();
  });

  it('can discard a failed operation while the other window is still open (#565)', async () => {
    const { saved } = await interruptedCreation();
    const next = await restartWithoutOpening(saved);
    const [pending] = next.store.interruptedOps();
    const peer = await restartWithoutOpening(saved);
    peer.store.services.local = next.store.services.local;
    const transaction = peer.repo.transaction.bind(peer.repo);
    peer.repo.transaction = (change) => operationWrite(change, 'CreateQuestion', 'succeeded')
      ? Promise.resolve({ ok: false, error: { kind: 'conflict', message: 'Changed elsewhere' } })
      : transaction(change);
    expect(await peer.store.retryOp(pending.id)).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    await next.store.discardOp(pending.id);
    expect(next.store.interruptedOps()).toEqual([]);
    await next.repo.close();
    await peer.repo.close();
  });

  it('keeps a completed import’s correlation through pruning until metadata completion is acknowledged', async () => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    const rows = (text: string) => prepareImport([[text]], suggestMapping(['Question'])).rows;
    const imported = await app.store.dispatch(ImportQuestions, {
      dealId, mode: 'append', rows: rows('Original import'),
    }, { idempotencyKey: 'qa-import:retained' });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error('Import failed');
    await app.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rows('Later import') });
    for (let number = 0; number < 260; number++) {
      await app.store.dispatch(CreateQuestion, { dealId, text: `Later question ${number}` }, { quiet: true });
    }
    await vi.waitFor(() => expect(Object.keys(app.store.get().ops).length).toBeLessThan(251));
    const retained = await app.repo.get('op', imported.value.opId);
    if (!retained.ok || !retained.value) throw new Error('The retained operation was pruned');
    expect(Operation.parse(retained.value.envelope.data).idempotencyKey).toBe('qa-import:retained');
    expect(await app.store.releaseImport('qa-import:retained')).toBe(true);
    const released = await app.repo.get('op', imported.value.opId);
    if (!released.ok || !released.value) throw new Error('The acknowledged operation could not be read');
    expect(Operation.parse(released.value.envelope.data).idempotencyKey).toBeUndefined();
    await app.repo.close();
  });

  it.each(['finding', 'item'] as const)('loads %s records before retrying their retained choices', async (kind) => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    await app.store.dispatch(CreateFinding, {
      dealId, title: 'Missing agreement', workstream: 'Legal', body: ['Not provided.'],
    });
    await app.store.dispatch(AddDealItems, {
      dealId, items: [{ text: 'Confirm agreement', from: [{ layer: 'deal' }] }],
    });
    const findingId = Object.keys(app.store.get().findings)[0];
    const itemId = Object.keys(app.store.get().items)[0];
    const command = kind === 'finding' ? SetFindingStatus : SetItemsOff;
    const input = kind === 'finding'
      ? { dealId, findingId, status: 'closed', note: 'Reviewed the signed waiver.' }
      : { dealId, off: [itemId] };
    const hold = holdRecoveryWrite(app, (transaction) => operationWrite(transaction, command.name, 'succeeded'));
    const saving = app.store.dispatch(command as typeof SetItemsOff, input as { dealId: string; off: string[] });
    await hold.entered;
    const saved = copyRecoveryDisk(app.saved);
    hold.release();
    await saving;
    app.store.closing();
    await app.repo.close();
    const next = await restartWithoutOpening(saved);
    const pending = next.store.interruptedOps().find((operation) => operation.command === command.name)!;
    expect((await next.store.retryOp(pending.id))?.ok).toBe(true);
    await next.store.loadDeal(dealId, { gaps: false });
    expect(kind === 'finding' ? next.store.get().findings[findingId].status : next.store.get().items[itemId].off)
      .toBe(kind === 'finding' ? 'closed' : true);
    await next.repo.close();
  });
});
