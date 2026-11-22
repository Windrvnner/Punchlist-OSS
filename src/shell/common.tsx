/**
 * What both shells set up the same way: the commands the Store runs, the theme, and mounting the app. The browser demo
 * (main.tsx) and the desktop app (desktop.tsx) differ only in the services they give the Store.
 */
import { installPopups } from '../ui/popups';
import { render } from 'preact';
import type { Store } from '../app/store';
import { registry } from '../app/commands/undo';
import { CreateDeal, AddFolders, RemoveFolder, RestoreFolder, DeleteDeal, EditDeal, RecordIndexingProgress } from '../app/commands/deals';
import { AddUnresolved } from '../app/commands/addUnresolved';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetQuestionsStatus, SetResponse, DeleteQuestion, RestoreQuestion, UseAsResponse, RenumberQuestion } from '../app/commands/questions';
import { CreateFinding, EditFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment, AttachDocumentToFinding } from '../app/commands/findings';
import { ImportQuestions, RevertImport, UndoLastImport } from '../app/commands/importQuestions';
import { ImportIssuesList, RevertIssuesList, RemoveIssuesList, RestoreIssuesList } from '../app/commands/issuesList';
import { KeepQaLog, SetQaLogFolder, RecordQaLogExport, RestoreQaLogs, ChooseQaVersion, RestoreQaVersion, TakeFromQaLog, RestoreQuestionSnapshots } from '../app/commands/qaLogs';
import { RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot } from '../app/commands/drafts';
import { ResolveConflict, ReopenConflict } from '../app/commands/conflicts';
import { RestoreVersion } from '../app/commands/keptVersions';
import { AddDealItems, SetItemsOff, RegroupDealItems, BringInList, RestoreList } from '../app/commands/checklist';
import { SetDealMember } from '../app/commands/members';
import { pickUpIndexing } from '../app/indexing';
import { lookForFolders } from '../app/relink';
import { watchFolders } from '../app/folderWatch';
import { App } from '../ui/app';
import '../styles.css';
import '../ui/ui.css';

export const COMMANDS = [CreateDeal, AddFolders, RemoveFolder, RestoreFolder, DeleteDeal, EditDeal, EditFinding, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus, SetQuestionsStatus, AddUnresolved, SetResponse, DeleteQuestion, RestoreQuestion, RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot, CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment, AttachDocumentToFinding, UseAsResponse, ImportQuestions, RevertImport, UndoLastImport, ImportIssuesList, RevertIssuesList, RemoveIssuesList, RestoreIssuesList, ResolveConflict, ReopenConflict, RestoreVersion, RenumberQuestion, AddDealItems, SetItemsOff, RegroupDealItems, BringInList, RestoreList, SetDealMember, KeepQaLog, SetQaLogFolder, RecordQaLogExport, RestoreQaLogs, ChooseQaVersion, RestoreQaVersion, TakeFromQaLog, RestoreQuestionSnapshots];
for (const c of COMMANDS) registry.set(c.name, c);

/** Theme, focus refresh, mount, and start: the same in both shells once the Store is made. */
export function run(store: Store) {
  // Appearance: the person's choice, or Windows' when they chose to match it. The themes themselves are the tokens in styles.css.
  const sysLight = matchMedia('(prefers-color-scheme: light)');
  // written only when it changes: it runs on every change to the store, and writing even the same value restyles the
  // whole page, which with 2,000 questions on screen took about 120ms a save
  const applyTheme = () => { const t = store.get().prefs.theme; const want = t === 'system' ? (sysLight.matches ? 'light' : 'dark') : t; if (document.documentElement.dataset.theme !== want) document.documentElement.dataset.theme = want; };
  applyTheme(); sysLight.addEventListener('change', applyTheme); store.subscribe(applyTheme);
  // the store rotates while the window is in the background: ask again when the person comes back
  window.addEventListener('focus', () => { store.touchCached(); void store.refreshSync(); });
  // a window closing stops counting as alive at once, so one opened next does not wait on its drafts
  window.addEventListener('pagehide', () => store.closing());

  store.watchSignIn();     // read-only while nobody is signed in to Intelligence (desktop)
  render(<App store={store} />, document.getElementById('root')!);
  installPopups();         // menus and popovers in the top layer, in popup glass over their backdrop (popups.ts)
  pickUpIndexing(store);   // unfinished indexing is picked up again once the app has started, by a later start too if this one cannot connect
  lookForFolders(store);   // deal folders not where their deals record them are looked for quietly, then said
  watchFolders(store);     // documents added to a data room after it was indexed are read: the folders are listed now and then, and when a deal opens
  void store.boot();
}
