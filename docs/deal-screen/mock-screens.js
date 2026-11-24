// The deal screen mock-up: builds the screen named in the page's hash, then places what depends on layout.

// below this width the Q&A table cuts its cells, so the pane shows the one-column list instead
const QA_TABLE_MIN = 560;
const qaTableFits = () => fittedPaneWidth(paneWidth('wide')) >= QA_TABLE_MIN;

const inPermitsChat = (turns, options = {}) => conversation(turns, { title: CONVERSATION_TITLES.permits, open: true,
  ...options });
const runningDiligenceTab = { ...DILIGENCE_TAB, progress: 0.5 };

// each screen with a pane: its conversation and its pane
const PANE_SCREENS = {
  running: () => [inPermitsChat([TURN_PERMITS, TURN_DILIGENCE_RUNNING]),
    pane(paneTabs([TASKS_TAB, runningDiligenceTab], 'tasks'), TASKS_LIST, paneWidth())],
  // in another conversation, Tasks still lists the question left running in the board resolutions conversation,
  // whose answer arrives there
  switch: () => [conversation([TURN_GUARANTEE_CAP],
    { title: CONVERSATION_TITLES.guarantee, open: true, top: true }),
    pane(paneTabs([TASKS_TAB, runningDiligenceTab], 'tasks'), TASKS_LIST, paneWidth())],
  report: () => [inPermitsChat([TURN_PERMITS, TURN_DILIGENCE_DONE]),
    pane(paneTabs([TASKS_TAB, DILIGENCE_TAB], 'diligence'), diligenceReport(false), paneWidth())],
  issue: () => [inPermitsChat([TURN_PERMITS, TURN_DILIGENCE_DONE, TURN_GUARANTEE_CAP]),
    pane(paneTabs([TASKS_TAB, DILIGENCE_TAB, FINDING_TAB], 'finding'), FINDING, paneWidth())],
  doc: () => [inPermitsChat([TURN_PERMITS, TURN_DILIGENCE_DONE, TURN_GUARANTEE_CAP]),
    pane(paneTabs([TASKS_TAB, DILIGENCE_TAB, DOCUMENT_TAB], 'document'), SOURCE_DOCUMENT, paneWidth('reading'))],
  busy: () => [inPermitsChat([TURN_PERMITS, TURN_DILIGENCE_DONE, TURN_RECHECK]),
    pane(paneTabs([{ ...TASKS_TAB, progress: 0.5 }, runningDiligenceTab], 'diligence'), diligenceReport(true),
      paneWidth())],
  issuebusy: () => [inPermitsChat([TURN_PERMITS, TURN_DILIGENCE_DONE, TURN_GUARANTEE_CAP]),
    pane(paneTabs([TASKS_TAB, DILIGENCE_TAB, { ...FINDING_TAB, progress: 0.7 }], 'finding'), FINDING_UPDATING,
      paneWidth())],
  qaitem: () => [inPermitsChat([TURN_GUARANTEE_CAP, TURN_COUNTERPARTY, TURN_DRAFT_RESPONSE]),
    qaPane(qaTableFits() ? qaTable('drafted') : qaOpenedQuestion('drafted'))],
  qaans: () => [inPermitsChat([TURN_PERMITS, TURN_GUARANTEE_CAP, TURN_COUNTERPARTY]),
    qaPane(qaTableFits() ? qaTable('answered') : qaOpenedQuestion('answered'))],
  taskrun: () => [inPermitsChat([TURN_PERMITS]),
    pane(paneTabs([{ ...TASKS_TAB, progress: 0.5 }, { ...TASK_TAB, progress: 0.55 }], 'task'), TASK_RUNNING,
      paneWidth())],
  taskdone: () => [inPermitsChat([TURN_PERMITS]),
    pane(paneTabs([TASKS_TAB, TASK_TAB], 'task'), TASK_DONE, paneWidth())],
  // Q&A gets the reading width the source viewer has, and the conversation stays open beside it
  qafocus: () => [inPermitsChat([TURN_PERMITS, TURN_GUARANTEE_CAP, TURN_COUNTERPARTY]),
    qaPane(qaList(), 'reading')],
  qafocusitem: () => [inPermitsChat([TURN_PERMITS, TURN_GUARANTEE_CAP, TURN_COUNTERPARTY]),
    qaPane(qaOpenedQuestion(hashParams.get('ans') ? 'answered' : 'drafted'), 'reading')],
  qa: () => [inPermitsChat([TURN_PERMITS, TURN_GUARANTEE_CAP, TURN_COUNTERPARTY]),
    qaPane(qaTableFits() ? qaTable() : qaList(), 'wide', 'drag')],
};

/** The pane on its Q&A tab; a pane dragged wider shows its grip. */
function qaPane(body, widthKind = 'wide', grip = widthKind === 'reading' ? 'drag' : '') {
  return pane(paneTabs([TASKS_TAB, DILIGENCE_TAB, QA_TAB], 'qa'), body, paneWidth(widthKind), grip);
}

function emptyDeal() {
  return `<section class="x-conv">${conversationHeader('', { toggle: true })}<div class="x-empty"><div class="center">`
    + '<h1 class="ttl">What would you like to know?</h1>'
    + `${composer('Which permits are still open on Project Proseware?')}</div></div></section>`;
}

function screenHtml() {
  if (screen in OPEN_QUESTION_SCREENS) return OPEN_QUESTION_SCREENS[screen]();
  if (screen === 'empty') return sidebar() + stage(emptyDeal());
  if (screen === 'active') {
    return sidebar() + stage(conversation([TURN_PERMITS], { title: CONVERSATION_TITLES.permits }));
  }
  const [chat, paneHtml] = PANE_SCREENS[screen]();
  return (sidebarFolded ? slimRail() : sidebar()) + stage(`${chat}${paneHtml}`);
}

document.getElementById('root').innerHTML = `<div id="app" class="x ${sidebarFolded ? 'slim' : ''}">${screenHtml()}`
  + '</div>';
document.body.insertAdjacentHTML('beforeend', dealMenu() + archivedNotice() + archiveConfirm());

// the deal menu opens under its ⋯, as addDeal.tsx places it
function placeDealMenu() {
  for (const menu of document.querySelectorAll('.x-dealmenu')) {
    const button = document.querySelector('.dmore.open').getBoundingClientRect();
    Object.assign(menu.style, { left: `${button.right - 180}px`, top: `${button.bottom + 6}px` });
  }
}

// a cut unselected tab drops its icon before its word; a live step whose count wraps drops its separator
function markCutTabsAndWrappedSteps() {
  for (const tab of document.querySelectorAll('.trk.x-even .x-stab')) {
    const label = tab.querySelector('.l');
    if (label && label.scrollWidth > label.clientWidth) tab.classList.add('tight');
  }
  for (const step of document.querySelectorAll('.x-live')) {
    const [words, meta] = step.children;
    if (meta.offsetTop > words.offsetTop) step.classList.add('wrapped');
  }
}

// `tip=1` shows the last answer action's tooltip above it
function showAnswerActionTooltip() {
  const buttons = document.querySelectorAll('.acts .ib');
  const button = buttons[buttons.length - 1];
  if (!button) return;
  const anchor = button.getBoundingClientRect();
  const tooltip = document.createElement('div');
  tooltip.className = 'tip';
  tooltip.textContent = button.title;
  document.body.appendChild(tooltip);
  const size = tooltip.getBoundingClientRect();
  const left = Math.max(12, Math.min(anchor.left, innerWidth - size.width - 12));
  Object.assign(tooltip.style, { left: `${left}px`, top: `${anchor.top - size.height - 8}px` });
}

// Past Conversations is lifted out of the header so its glass blurs the page, and fits the room above the composer
// ending on a whole conversation, as pastList.tsx fitToRoom does
function placePastConversations(list) {
  const button = document.querySelector('.x-hist').getBoundingClientRect();
  // the list starts at the conversation's text column, so no line of it shows beside the list, and the conversation
  // behind is dimmed while the list is open
  const column = document.querySelector('.x-conv .x-col').getBoundingClientRect();
  const left = column.left - 12;
  document.querySelector('.x-conv .x-scroll').classList.add('x-dim');
  document.body.appendChild(list);
  const width = Math.min(column.width + 24, innerWidth - left - 16);
  Object.assign(list.style, { position: 'fixed', left: `${left}px`, width: `${width}px`,
    top: `${button.bottom + 8}px`, right: 'auto', bottom: 'auto' });
  const rows = list.querySelector('.plist');
  const composerTop = document.querySelector('.x-conv .askbox').getBoundingClientRect().top;
  const room = composerTop - 8 - (button.bottom + 8) - list.querySelector('.ptop').offsetHeight;
  let fit = 0;
  for (const row of rows.children) {
    const end = row.offsetTop - rows.offsetTop + row.offsetHeight;
    if (end + 8 <= room && row.classList.contains('prow')) fit = end;
  }
  Object.assign(rows.style, { height: `${fit + 8}px`, flex: 'none', overflow: 'hidden' });
}

placeDealMenu();
// a conversation opens at its end, unless it is short enough to start at the top
for (const scroller of document.querySelectorAll('.x-scroll:not(.x-top)')) scroller.scrollTop = scroller.scrollHeight;
markCutTabsAndWrappedSteps();
if (hashParams.get('tip')) showAnswerActionTooltip();
for (const list of document.querySelectorAll('.pastpop')) placePastConversations(list);
placeOpenQuestionScreens();
