// @vitest-environment node
import { expect, it } from 'vitest';
import { attachFiles, followCopies } from '../../src/app/attachments';
import { DeleteDeal } from '../../src/app/commands/deals';
import { EditQuestionField } from '../../src/app/commands/questions';
import { convKey, type Scope } from '../../src/app/conversations';
import { fail } from '../../src/domain/result';
import { okd, syncAll, twoPcs } from './pcs';

const cases = [
  { timing: 'before', kind: 'deal' },
  { timing: 'after', kind: 'finding' },
] as const;

it.each(cases)('retries a $kind attachment that fails $timing recovery in its copied conversation (#745)', async ({
  timing, kind,
}) => {
  const { A, B, dealId, qid, fid } = await twoPcs();
  const stopFollowing = followCopies(B.store);
  const docs = B.store.services.docs;
  const originalAttach = docs.attach.bind(docs);
  const name = 'Lender consent.pdf';
  const selected = new File(['The consent applies following a change of control.'], name);
  const calls: { destination: string; name: string; words: string }[] = [];
  let releaseFailure!: () => void;
  const failure = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const scope: Scope = kind === 'deal' ? { kind, dealId } : { kind, dealId, findingId: fid };

  try {
    docs.attach = async (destination, file) => {
      calls.push({ destination, name: file.name, words: new TextDecoder().decode(file.bytes) });
      if (calls.length === 1) {
        if (timing === 'after') await failure;
        return fail({ kind: 'unreachable', message: 'Cannot reach files' });
      }
      return originalAttach(destination, file);
    };
    const findingId = scope.kind === 'finding' ? scope.findingId : undefined;
    await attachFiles(B.store, { dealId, conv: convKey(scope), findingId }, [selected]);
    const retry = () => B.store.get().ui.toasts.find((toast) =>
      toast.text.includes(name) && toast.action?.label === 'Retry');
    if (timing === 'before') await expect.poll(retry).toBeDefined();
    else await expect.poll(() => calls).toHaveLength(1);

    okd(await B.store.dispatch(EditQuestionField, {
      dealId, questionId: qid, field: 'text', value: 'Has the lender approved the transfer?',
    }));
    okd(await A.store.dispatch(DeleteDeal, { dealId, typedName: A.store.get().deals[dealId].name }));
    await syncAll(A, B);
    const recovered = () => Object.keys(B.store.get().deals).find((id) => id !== dealId);
    await expect.poll(recovered).toBeDefined();
    const copyId = recovered()!;
    await B.store.loadDeal(copyId, { gaps: false });
    const copyFinding = Object.values(B.store.get().findings).find((finding) => finding.dealId === copyId);
    const movedScope: Scope = kind === 'deal' ? { kind, dealId: copyId }
      : { kind, dealId: copyId, findingId: copyFinding!.id };

    B.store.ui({ route: { name: 'home' } });
    releaseFailure();
    await expect.poll(retry).toBeDefined();
    const notice = retry()!;
    notice.action!.run!();
    B.store.dismissToast(notice.id);
    await expect.poll(() => B.store.get().ui.attachments[0]?.state).toBe('done');
    const expectedFile = { name, words: await selected.text() };
    expect(calls).toEqual([{ destination: dealId, ...expectedFile }, { destination: copyId, ...expectedFile }]);
    expect(B.store.get().ui.attachments[0]).toMatchObject({
      dealId: copyId, conv: convKey(movedScope), name,
      findingId: movedScope.kind === 'finding' ? movedScope.findingId : undefined,
    });
  } finally {
    releaseFailure();
    stopFollowing();
  }
});
