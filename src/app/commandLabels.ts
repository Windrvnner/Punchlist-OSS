/**
 * What each command is called on screen, in the words of the button or message that starts it, so an action that
 * was interrupted, or undone, is named the way the person met it. A command not listed shows its name split into
 * words.
 */
import type { State } from './state';

const LABELS: Record<string, string> = {
  AddDealItems: 'Add checklist items',
  RegroupDealItems: 'Group checklist items',
  AddFolders: 'Add folders',
  BringInList: 'Import a checklist',
  ApplyDraft: 'Draft response',
  ApplyReassessment: 'Update from documents',
  AttachDocumentToFinding: 'Attach',
  CreateDeal: 'New deal',
  CreateFinding: 'New finding',
  CreateQuestion: 'New question',
  SetQuestionsStatus: 'Close settled questions',
  CloseSettledQuestions: 'Close settled questions',
  AddUnresolved: 'Add all unresolved to Q&A',
  DeleteDeal: 'Delete deal',
  DeleteFinding: 'Delete finding',
  DeleteQuestion: 'Delete question',
  DiscardDraft: 'Discard',
  EditDeal: 'Deal details',
  EditFinding: 'Edit finding',
  EditQuestionField: 'Question',
  ImportIssuesList: 'Import an issues list',
  ImportQuestions: 'Import Q&A log',
  Reassess: 'Update from documents',
  RecordIndexingProgress: 'Indexing',
  RecoverDrafts: 'Draft response',
  RemoveFolder: 'Remove folder',
  RenumberQuestion: 'Question number',
  ChooseQaVersion: 'Resolve',
  ReopenConflict: 'Two versions',
  RestoreQaVersion: 'Resolve',
  RestoreQuestionSnapshots: 'Update Q&A log',
  TakeFromQaLog: 'Update Q&A log',
  RequestDraft: 'Draft response',
  ResolveConflict: 'Keep this version',
  RestoreFinding: 'Restore',
  RestoreList: 'Undo',
  RestoreFolder: 'Undo',
  RestoreFindingSnapshot: 'Undo',
  RestoreQuestion: 'Restore',
  RestoreVersion: 'Restore',
  RestoreQuestionSnapshot: 'Undo',
  RevertImport: 'Undo',
  RevertIssuesList: 'Undo',
  RemoveIssuesList: 'Remove an issues list',
  RestoreIssuesList: 'Undo',
  ReviewFinding: 'Review',
  SetFindingStatus: 'Mark closed or reopen',
  SetItemsOff: 'Turn off or on',
  SetDealMember: 'Add to my deals',
  SetQuestionStatus: 'Status',
  SetResponse: 'Response',
  Undo: 'Undo',
  UndoLastImport: 'Undo last import',
  UseAsResponse: 'Use as response',
};

const STATUS: Record<string, string> = { open: 'Open', answered: 'Answered', closed: 'Closed' };
/** some actions are named by what they were asked to do: a finding closed or reopened, a deal renamed or moved */
export function commandLabel(name: string, input?: unknown): string {
  const i = (input ?? {}) as { status?: string; name?: string; group?: string };
  if (name === 'SetFindingStatus' && i.status) return i.status === 'closed' ? 'Mark closed' : 'Reopen';
  if (name === 'SetQuestionStatus' && i.status) return `Status: ${STATUS[i.status] ?? i.status}`;
  if (name === 'EditDeal' && i.name !== undefined) return 'Rename deal';
  if (name === 'EditDeal' && i.group !== undefined) return 'Deal status';
  return LABELS[name] ?? name.replace(/([A-Z])/g, ' $1').trim();
}

/** Where an interrupted action was: the question or finding and its deal, so Retry says what it would write. */
export function commandPlace(s: Pick<State, 'deals' | 'questions' | 'findings'>, input: unknown): string {
  const i = (input ?? {}) as { dealId?: unknown; questionId?: unknown; findingId?: unknown };
  const d = typeof i.dealId === 'string' ? s.deals[i.dealId] : undefined;
  const q = typeof i.questionId === 'string' ? s.questions[i.questionId] : undefined;
  const f = typeof i.findingId === 'string' ? s.findings[i.findingId] : undefined;
  const what = q ? `Q${q.n}` : f ? `“${f.title}”` : '';
  return [what, d?.name].filter(Boolean).join(' on ');
}
