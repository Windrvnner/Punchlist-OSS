// The parts of a conversation's page: the trail at its top, what it is about, its exchanges, and what it says when
// what it was about is gone.
import type { ComponentChildren } from 'preact';
import { useAppState, useStore, fmtDate } from './hooks';
import type { Store } from '../app/store';
import { Icon } from './icons';
import { Ref } from './ref';
import { canAddToSources, fewDocuments } from '../app/citations';
import { ConflictView } from './conflict';
import { DocName } from './docName';
import { ResearchView, SourceChips } from './research';
import { closeDocument } from './nav';
import { Answer } from './answer';
import { retry, stopAnswer, type Scope } from '../app/conversations';
import { docKey, type Deal, type Question, type Source, type Tombstone } from '../domain/model';
import { addToSources } from '../app/attachments';
import { RestoreQuestion } from '../app/commands/questions';
import { RestoreFinding } from '../app/commands/findings';
import { dealHash, type Message } from '../app/state';
import { KeptAsk } from './findingAsk';
import { editDrafts } from '../app/findingDrafts';

const Sep = () => <span class="sep">›</span>;

/** The trail at the top of the page, from Home to here. `backToList`: the Checklist a document was opened from. */
export function Trail({ scope, deal, backToList }: {
  scope: Scope; deal: Deal | null | undefined; backToList?: string;
}) {
  const store = useStore();
  const state = useAppState();
  const question = scope.kind === 'question' ? state.questions[scope.questionId] : undefined;
  const backToChecklist = (e: MouseEvent) => {
    e.preventDefault();
    closeDocument(store);
  };
  return (
    <span class="back"><a href="#deals">Home</a>
      {deal && <><Sep /><a class="dn" href={`#${dealHash(state.prefs, deal.id)}`} title={deal.name}>{deal.name}</a></>}
      {scope.kind === 'question' && <><Sep /><a href={`#qa-${scope.dealId}`}>Q&amp;A</a>
        {question && <><Sep /><span class="here" aria-current="page">Q{question.n}</span></>}</>}
      {scope.kind === 'finding' && <><Sep /><a href={`#deal-${scope.dealId}`}>Findings</a></>}
      {scope.kind === 'all' && <><Sep /><span class="here" aria-current="page">All deals</span></>}
      {backToList && <><Sep /><a id="back-checklist" href={`#${backToList}`} onClick={backToChecklist}>Checklist</a></>}
    </span>
  );
}

/** Puts a deleted finding or question back. */
function restoreRecord(store: Store, gone: Tombstone) {
  const options = { idempotencyKey: 'restore-' + gone.id };
  if (gone.kind === 'finding') {
    void store.dispatch(RestoreFinding, { dealId: gone.dealId, findingId: gone.id }, options);
  } else {
    void store.dispatch(RestoreQuestion, { dealId: gone.dealId, questionId: gone.id }, options);
  }
}

function noLongerHere(scope: Scope) {
  if (scope.kind === 'finding') return 'That finding is no longer here.';
  if (scope.kind === 'question') return 'That question is no longer here.';
  return 'That deal is no longer here.';
}

/**
 * The page when what the conversation is about is not there: still `loading`, its deal failed to load, or it is
 * gone. A record that was deleted is still in the deal's Deleted list: the page says so and can put it back.
 */
export function NotHere({ scope, deal, loading, trail }: {
  scope: Scope; deal: Deal | null | undefined; loading: boolean; trail: ComponentChildren;
}) {
  const store = useStore();
  const state = useAppState();
  let body: ComponentChildren;
  if (loading) body = <div class="ph" style="margin-top:20px"><i /><i /><i /></div>;
  else if (deal && state.dealLoad[deal.id] === 'failed') {
    body = (
      <p class="loadfail">Couldn’t load this deal.{' '}
        <button type="button" class="tundo" onClick={() => void store.retryDeal(deal.id)}>Retry</button>
      </p>
    );
  } else body = <>
    <GoneLine scope={scope} deal={deal} restore={(gone) => restoreRecord(store, gone)} />
    {scope.kind === 'finding' && deal && <KeptAsk dealId={deal.id} findingId={scope.findingId}
      title={state.tombstones[scope.findingId]?.title ?? ''} />}
  </>;
  return <div class="chatwrap"><div class="chat"><div class="chathead">{trail}</div>{body}</div></div>;
}

/** What is gone, how to put it back if it was deleted, and the way back to its deal or Home. */
function GoneLine({ scope, deal, restore }: {
  scope: Scope; deal: Deal | null | undefined; restore: (gone: Tombstone) => void;
}) {
  const state = useAppState();
  const gone = scope.kind === 'finding' ? state.tombstones[scope.findingId]
    : scope.kind === 'question' ? state.tombstones[scope.questionId]
    : undefined;
  const deleted = gone && gone.kind !== 'deal' ? gone : null;
  const back = deleted && deal ? `back to ${deal.name}` : deal ? `Back to ${deal.name}` : 'Back to Home';
  return (
    <>
      <p class="emptyline" id="gone" style="margin-top:20px">
        {deleted ? <>
          {deleted.kind === 'finding' ? 'That finding was deleted.' : 'That question was deleted.'}{' '}
          <button type="button" class="linkb" id="gone-restore" onClick={() => restore(deleted)}>Restore it</button>
          {' or go '}
        </> : <>{noLongerHere(scope)}{' '}</>}
        <a class="linkb" href={deal ? `#${dealHash(state.prefs, deal.id)}` : '#deals'}>{back}</a>
      </p>
      {deleted?.kind === 'finding' && editDrafts.has(deleted.id) &&
        <p class="emptyline" id="gone-finding-edit" role="status">Unsaved finding edit kept.</p>}
    </>
  );
}

/** The question a conversation is about, at its top: its clash when it has one, else its text and its response. */
export function QuestionOpening({ question, onOpen }: { question: Question; onOpen: (src: Source) => void }) {
  const state = useAppState();
  const conflict = state.conflicts[question.id];
  if (conflict) {
    return <div class="opening"><div class="lbl">Q{question.n}</div><ConflictView conflict={conflict} /></div>;
  }
  const by = question.askedBy ? ` · ${question.askedBy}` : '';
  const received = question.received ? ` · ${fmtDate(question.received)}` : '';
  const hasDraft = question.draft?.status === 'found' && question.draft.text;
  return (
    <div class="opening"><div class="lbl">Q{question.n}{by}{received}</div>
      <p class="qtxt" role="heading" aria-level={1} style="white-space:pre-wrap">{question.text}</p>
      {(question.response || hasDraft) && <Response question={question} onOpen={onOpen} />}
    </div>
  );
}

/** The question's response, else the draft of one that was found; its first source opens on a click. */
function Response({ question, onOpen }: { question: Question; onOpen: (src: Source) => void }) {
  const answered = !!question.response;
  const sources = answered ? question.provenance?.sources : question.draft!.sources;
  const first = sources?.[0];
  return (
    <>
      <div class="lbl">{answered ? 'Response' : 'Draft response'}</div>
      {/* its sources as chips above the text, as under an answer, up to four documents */}
      {sources && fewDocuments(sources) && <SourceChips sources={sources} onOpen={onOpen} dealId={question.dealId} />}
      <p class="dtxt" style="white-space:pre-line">
        <Ref text={question.response || question.draft!.text}
          sources={answered ? sources ?? [] : question.draft!.sources}
          onOpen={first ? () => onOpen(first) : undefined} />
      </p>
    </>
  );
}

/** One exchange: what was asked, with any files sent with it, and the answer, or where it has got to. */
export function Exchange({ scope, mine, reply, waiting, onOpen, suggest }: {
  scope: Scope; mine: Message; reply: Message | undefined; waiting: string | undefined;
  onOpen: (src: Source, ask?: string) => void; suggest: string | undefined;
}) {
  const store = useStore();
  let answer: ComponentChildren;
  if (!reply || reply.state === 'pending') answer = <Pending reply={reply} waiting={waiting} />;
  else if (reply.state === 'failed') {
    answer = (
      <div class="ai failed" role="alert"><span>Couldn’t get an answer</span>
        <button type="button" class="tundo" onClick={() => void retry(store, scope, reply.id)}>Retry</button>
      </div>
    );
  } else answer = <Answer scope={scope} message={reply} asked={mine.text} onOpen={onOpen} suggest={suggest} />;
  return (
    <div><div class="me">{mine.text}</div>
      {mine.attached?.length ? <SentFiles scope={scope} files={mine.attached} /> : null}
      {answer}
    </div>
  );
}

/** The files sent with a question; under a finding, one that is not among its sources can be added to them. */
function SentFiles({ scope, files }: { scope: Scope; files: NonNullable<Message['attached']> }) {
  const store = useStore();
  const state = useAppState();
  const finding = scope.kind === 'finding' ? state.findings[scope.findingId] : null;
  return (
    <div class="matt">{files.map((file) => {
      return (
        <span class="chip att" key={docKey(file)}><Icon name="doc" size={12} /><DocName name={file.doc} />
          {finding && canAddToSources(finding, file) && <button type="button" class="addsrc" data-addsrc
            onClick={() => void addToSources(store, finding.dealId, finding.id, file)}>Add to Sources</button>}
        </span>
      );
    })}</div>
  );
}

/** An answer under way: the research as it goes, where the backend shows it, else three dots. */
function Pending({ reply, waiting }: { reply: Message | undefined; waiting: string | undefined }) {
  const store = useStore();
  const state = useAppState();
  if (reply && state.can.research) {
    const stop = state.can.stop ? { onStop: () => void stopAnswer(store, reply.id) } : {};
    return (
      <div class="ai pending rsching" role="status" aria-label={waiting ?? 'Researching'}>
        <ResearchView working since={reply.at} research={state.ui.researching[reply.id]} waiting={waiting} {...stop} />
      </div>
    );
  }
  return (
    <div class="ai pending" role="status" aria-label={waiting ?? 'Thinking'}>
      <span class="dots"><i /><i /><i /></span>{waiting && <span class="waitsi">{waiting}</span>}
    </div>
  );
}
