/**
 * A finding's links (linking design, sections 6 and 13; decisions, Checklist): the checklist item that raised it, the
 * questions asked about it or its item, and Ask the counterparty, with the Checklist pane's card.
 */
import { useContext, useEffect, useState } from 'preact/hooks';
import { askedAbout, findingAskTarget, type AskBlock } from '../app/asking';
import { findingItem } from '../app/state';
import { CreateQuestion } from '../app/commands/questions';
import type { Finding } from '../domain/model';
import { AskCard, AskedList, useLogQuestion } from './askCounterparty';
import { ReadOnlyContext } from './editField';
import { useAppState, useStore } from './hooks';
import { keptDrafts, isText } from './keptDrafts';
import { openChecklistItem } from './nav';

/** Questions half typed on a finding's page, kept across pages and a restart; Cancel or Log clear it. */
const askDrafts = keptDrafts('finding-ask', isText);
/** whether a question is being typed on a finding's page */
export const askKept = (findingId: string) => !!askDrafts.get(findingId);

const ASK_BLOCK_WORDS: Record<AskBlock, string> = {
  'closed-finding': 'This finding is closed',
  'off-item': 'Its checklist item is turned off',
};

/** The question being typed on a finding's page, kept as it is typed, and set aside or cleared. */
function useAskDraft(findingId: string) {
  const [asking, setAsking] = useState(() => !!askDrafts.get(findingId));
  const [text, setTextState] = useState(() => askDrafts.get(findingId) ?? '');
  const setText = (v: string) => {
    setTextState(v);
    if (v) askDrafts.set(findingId, v);
    else askDrafts.delete(findingId);
  };
  // set aside or done: the focus goes back to Ask the counterparty, or to the finding's status when Ask is not offered
  const stopAsking = () => {
    setAsking(false);
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a && a !== document.body) return;
      (document.getElementById('f-ask') ?? document.getElementById('f-status'))?.focus();
    });
  };
  // a logged question's text is let go once it lands, unless more was typed since
  const settle = () => {
    if (askDrafts.get(findingId)) return;
    setTextState('');
    stopAsking();
  };
  const out = useLogQuestion(askDrafts, findingId, (key) => askDrafts.delete(key), settle);
  return { asking, setAsking, text, setText, stopAsking, ...out, kept: !!askDrafts.get(findingId) };
}

/**
 * #340: a question being typed on a finding's page stays in sight when the finding is deleted, on the page that says
 * so, so the person can keep, copy or cancel it. Log says why not; Restore brings the finding back with it.
 */
export function KeptAsk({ dealId, findingId, title }: { dealId: string; findingId: string; title: string }) {
  const s = useAppState();
  const draft = useAskDraft(findingId);
  if (!draft.kept) return null;
  return (
    <div class="flinks">
      <AskCard ids="f-ask" cls="fask" counterparty={s.deals[dealId]?.counterparty ?? ''} linked={title}
        text={draft.text} onText={draft.setText} why="This finding was deleted" busy={draft.busy} onLog={() => {}}
        onCancel={draft.cancel} onEscape={() => {}} />
    </div>
  );
}

/** In the side pane beside a conversation (`pane`) it offers no Ask: the conversation's Add as question does that. */
export function FindingLinks({ dealId, f, pane }: { dealId: string; f: Finding; pane?: boolean }) {
  const store = useStore();
  const s = useAppState();
  const ro = useContext(ReadOnlyContext);
  const draft = useAskDraft(f.id);
  // the check's rows name the item of a finding written before findings named it: read once, as the Q&A page does
  const unread = s.checklists[dealId] === undefined;
  useEffect(() => {
    if (unread) void store.refreshChecklist(dealId);
  }, [dealId]);
  const item = findingItem(s, f);
  const asked = askedAbout(s, dealId, item?.id ?? null, f);
  const { block, links } = findingAskTarget(f, item);
  const why = ro || (block ? ASK_BLOCK_WORDS[block] : null);
  const offer = !pane && (!block || draft.kept);
  const log = async () => {
    if (draft.busy || !draft.text.trim() || why) return;
    const text = draft.text.trim();
    await draft.log(text, () => store.dispatch(CreateQuestion, { dealId, text, ...links },
      { idempotencyKey: 'f-q-' + f.id }));
  };
  // Escape sets the question aside only where Ask the counterparty can bring it back, as on the Checklist
  const setAside = () => {
    if (offer && !ro) draft.stopAsking();
  };
  const openItem = (e: MouseEvent, id: string) => {
    e.preventDefault();
    openChecklistItem(store, dealId, id);
  };
  return (
    <div class="flinks">
      {item && <>
        <div class="lbl">Checklist Item</div>
        <p class="dtxt" id="f-item">
          <a href={`#checklist-${dealId}`} onClick={(e) => openItem(e, item.id)}>{item.text}</a>
        </p>
      </>}
      {asked.length > 0 && <><div class="lbl">Asked</div><AskedList dealId={dealId} qs={asked} id="f-asked" /></>}
      {offer && !draft.asking && <span class="needs" title={ro ?? undefined}>
        <button type="button" class="btn sm" id="f-ask" disabled={!!ro} aria-description={ro ?? undefined}
          onClick={() => draft.setAsking(true)}>Ask the Counterparty</button>
      </span>}
      {draft.asking && !pane && <AskCard ids="f-ask" cls="fask" counterparty={s.deals[dealId]?.counterparty ?? ''}
        linked={f.title} text={draft.text} onText={draft.setText} why={why} busy={draft.busy} onLog={() => void log()}
        onCancel={draft.cancel} onEscape={setAside} />}
    </div>
  );
}
