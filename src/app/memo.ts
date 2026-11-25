/**
 * Making the deal memo: one press, nothing marked by hand. The backend gives the model-written
 * parts (a summary, a rating of each open finding, and the findings grouped into risks, the key ones written up); the rest is taken from the records as they stand when it
 * is made (domain/memo), laid out (domain/memoDoc) and made into Word or PDF through LibreOffice. The save dialog opens
 * first, where the person picks Word or PDF, so canceling it costs nothing; then the deal's button spins while the memo
 * is made and written. Nothing is changed by it.
 */
import type { Store } from './store';
import { dealFindings, dealQuestions, itemStanding, FIRM, type State } from './state';
import { memoContent, type MemoItem, type Rating } from '../domain/memo';
import { memoDocument } from '../domain/memoDoc';
import { safeFileName } from '../domain/importExport';
import { localYmd } from '../domain/model';
import { AI_LABEL, SERVICE, control } from '../control';
import { ok, fail, type Failure, type Result } from '../domain/result';

const RANK: Record<string, number> = { broad: 0, product: 1, sector: 2, technology: 3, deal: 4 };
/** The checklist as the memo counts it: each row under the list it comes from (the first of its lists, general first, as the Checklist page groups it), standing as the Overview counts it. */
export function memoItems(s: State, dealId: string): MemoItem[] | null {
  const rows = s.checklists[dealId]; if (!Array.isArray(rows) || !rows.length) return null;
  return rows.map((r) => {
    const it = s.items[r.id]; const from = it ? [...it.from].sort((a, b) => RANK[a.layer] - RANK[b.layer])[0] : undefined;
    const list = !from ? 'Other' : from.layer === 'broad' ? 'General' : from.layer === 'deal' ? 'Added on this deal' : from.value;
    const st = itemStanding(s, dealId, r);
    return { text: r.text, list, kind: st.kind === 'gone' ? 'finding' : st.kind, ...(r.need ? { need: r.need } : {}) };   // a deleted finding's item still counts as to resolve, as on the Overview
  });
}

const WORD = { label: 'Word document', ext: 'docx' };
const PDF = { label: 'PDF', ext: 'pdf' };
type MemoWrite = { id: string; bytes: Uint8Array; name: string; kind: typeof WORD };

async function writeMemo(store: Store, memo: MemoWrite): Promise<Result<'saved'>> {
  try {
    return await store.services.fs.writePicked!(memo.id, memo.bytes);
  } catch {
    return fail({ kind: 'failed', message: 'Couldn’t save the file' });
  }
}

/** Ask where to save the memo, then make it there. `writing` receives the converted bytes before the picked write. */
export async function makeMemo(
  store: Store,
  dealId: string,
  working: () => void = () => {},
  writing: (memo: MemoWrite) => void = () => {},
): Promise<Result<'saved' | 'canceled'>> {
  const { ai, sheets, fs } = store.services;
  const at = store.get().deals[dealId]; if (!at) return fail({ kind: 'notFound', message: 'Deal not found' });
  if (!ai.memo) return fail({ kind: 'failed', message: 'The deal memo cannot be made here' });
  const name = safeFileName(`${at.name} deal memo`);
  // the dialog first: nothing is asked of the model until the person has said where it goes
  const two = sheets.document && fs.pickSave && fs.writePicked;
  const pick = two ? await fs.pickSave!(name, [WORD, PDF]) : null;
  if (pick && !pick.ok) return pick;
  if (pick && !pick.value) return ok('canceled');
  working();
  await Promise.all([store.loadDeal(dealId, { gaps: false }), store.refreshChecklist(dealId)]);
  const got = await ai.memo(dealId); if (!got.ok) return got;
  const s = store.get(); const deal = s.deals[dealId]; if (!deal) return fail({ kind: 'notFound', message: 'Deal not found' });   // deleted meanwhile
  const findings = dealFindings(s, dealId); const open = new Set(findings.filter((f) => f.status === 'open').map((f) => f.id));
  const ratings: Record<string, Rating> = Object.fromEntries(Object.entries(got.value.ratings).filter(([id]) => open.has(id)));
  const content = memoContent({
    deal, firm: FIRM, today: localYmd(store.services.clock.now()), findings,
    questions: dealQuestions(s, dealId), checklist: memoItems(s, dealId),
    summary: got.value.summary, ratings, keyRisks: control.memo.keyRisks, ...(got.value.risks ? { groups: got.value.risks } : {}),
  });
  const fodt = memoDocument(content, AI_LABEL);
  // without LibreOffice (the browser stand-in) the memo is saved as the OpenDocument text it was laid out as
  if (!sheets.document) return fs.save(`${name}.fodt`, new TextEncoder().encode(fodt), 'application/vnd.oasis.opendocument.text');
  const made = await sheets.document(fodt); if (!made.ok) return made;
  if (pick?.value) {
    const { id, ext } = pick.value;
    const kind = ext === 'pdf' ? PDF : WORD;
    const memo = { id, bytes: kind === PDF ? made.value.pdf : made.value.docx, name, kind };
    writing(memo);
    return writeMemo(store, memo);
  }
  return fs.save(`${name}.docx`, made.value.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

function memoSaved(store: Store, file?: string) {
  const { openPicked } = store.services.fs;
  const open = file && openPicked ? {
    label: 'Open',
    run: () => void openPicked(file).then((result) => {
      if (!result.ok) store.toast(result.error.message);
    }),
  } : undefined;
  store.toast('Deal memo saved', open);
}

type PendingMemo = { memo: MemoWrite; error: Failure };
const pendingMemos = new WeakMap<Store, PendingMemo[]>();

async function chooseMemoDestination(store: Store, memo: MemoWrite): Promise<Result<MemoWrite | null>> {
  try {
    const picked = await store.services.fs.pickSave!(memo.name, [memo.kind]);
    if (!picked.ok) return picked;
    return ok(picked.value ? { ...memo, id: picked.value.id } : null);
  } catch {
    return fail({ kind: 'failed', message: 'Couldn’t choose where to save the memo' });
  }
}

/** A changed destination needs a new choice. The already converted memo survives even if that dialog is canceled. */
async function retryMemoWrite(store: Store, pending: PendingMemo): Promise<PendingMemo | null> {
  let { memo } = pending;
  if (pending.error.kind === 'conflict') {
    const chosen = await chooseMemoDestination(store, memo);
    if (!chosen.ok) return { memo, error: { kind: 'conflict', message: chosen.error.message } };
    if (!chosen.value) return pending;
    memo = chosen.value;
  }
  const saved = await writeMemo(store, memo);
  if (!saved.ok) return { memo, error: saved.error };
  memoSaved(store, memo.id);
  return null;
}

/** Show one notice at a time so identical notices cannot replace other pending memo saves (#656). */
function showPendingMemo(store: Store, queue: PendingMemo[]) {
  const next = queue[0];
  if (!next) {
    pendingMemos.delete(store);
    return;
  }
  let retrying = false;
  const retry = async () => {
    if (retrying) return;
    retrying = true;
    store.dismissToast(notice);
    const pending = await retryMemoWrite(store, next);
    if (pending) queue[0] = pending;
    else queue.shift();
    showPendingMemo(store, queue);
  };
  const label = next.error.kind === 'conflict' ? 'Save As…' : 'Retry';
  const action = { label, run: () => void retry() };
  const notice = store.toast(next.error.message, action, { glyph: 'warn', sticky: 'stays' });
  const stopWatching = store.subscribe(() => {
    if (store.get().ui.toasts.some((toast) => toast.id === notice)) return;
    stopWatching();
    if (retrying) return;
    queue.shift();
    showPendingMemo(store, queue);
  });
}

function memoNotSaved(store: Store, memo: MemoWrite, error: Failure) {
  const queue = pendingMemos.get(store);
  const pending = { memo, error };
  if (queue) {
    queue.push(pending);
    return;
  }
  const first = [pending];
  pendingMemos.set(store, first);
  showPendingMemo(store, first);
}

const pressed = new Set<string>();   // deals whose memo is under way, from the press (the dialog included) to the notice
/** Show progress from the save dialog through the first write, one memo at a time per deal. */
export async function runMemo(store: Store, dealId: string): Promise<void> {
  if (pressed.has(dealId)) return;
  pressed.add(dealId);
  const attempt: { memo?: MemoWrite } = {};
  let result: Result<'saved' | 'canceled'>;
  try {
    const working = () => store.ui((ui) => ({ memoBusy: [...ui.memoBusy, dealId] }));
    result = await makeMemo(store, dealId, working, (memo) => { attempt.memo = memo; });
  } catch {
    result = fail({ kind: 'failed', message: 'Couldn’t make the deal memo' });
  } finally {
    pressed.delete(dealId);
    store.ui((ui) => ({ memoBusy: ui.memoBusy.filter((id) => id !== dealId) }));
  }
  if (result.ok) {
    if (result.value === 'saved') memoSaved(store, attempt.memo?.id);
    return;
  }
  if (attempt.memo) {
    memoNotSaved(store, attempt.memo, result.error);
    return;
  }
  const retry = { label: 'Retry', run: () => void runMemo(store, dealId) };
  const message = result.error.kind === 'unreachable' ? `Couldn’t make the deal memo: ${SERVICE} could not be reached`
    : 'Couldn’t make the deal memo';
  store.toast(message, retry);
}
