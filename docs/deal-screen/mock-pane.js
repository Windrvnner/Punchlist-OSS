// The deal screen mock-up: the pane and its tabs, Tasks, a task opened in the pane, the Diligence report, a finding,
// and a source document.

const TAB_ICONS = {
  tasks: 'stack', diligence: 'cklist', finding: 'flag', document: 'doc', qa: 'sheet', task: 'logedit',
};

// Tasks, Diligence and Q&A are always there, in that order; an opened item (a finding, a document, a task) follows them
const CORE_TABS = ['tasks', 'diligence', 'qa'];
const TASKS_TAB = { kind: 'tasks', label: 'Tasks', progress: true };
const DILIGENCE_TAB = { kind: 'diligence', label: 'Diligence' };
const QA_TAB = { kind: 'qa', label: 'Q&amp;A' };
const FINDING_TAB = { kind: 'finding', label: 'Guarantee cap is lower than the term sheet' };
const DOCUMENT_TAB = { kind: 'document', label: 'Parent company guarantee (draft 2).pdf' };
const TASK_TAB = { kind: 'task', label: BOARD_TASK };

/** The pane's tabs: the three core tabs (or the given versions of them), then the opened items. */
function paneTabs(given, selectedKind) {
  const core = [TASKS_TAB, DILIGENCE_TAB, QA_TAB].map((tab) => given.find((each) => each.kind === tab.kind) || tab);
  const opened = given.filter((tab) => !CORE_TABS.includes(tab.kind));
  return [...core, ...opened].map((tab) => ({ ...tab, selected: tab.kind === selectedKind }));
}

// a tab with running work shows a ring in place of its icon; `progress: true` is a ring at 60%
function tabIcon(tab, size) {
  if (!tab.progress) return icon(TAB_ICONS[tab.kind], size);
  return `<span class="x-ring">${ring(tab.progress === true ? 0.6 : tab.progress, size)}</span>`;
}

function tabHtml(tab) {
  const close = tab.selected && !CORE_TABS.includes(tab.kind) ? `<span class="x">${icon('close', 12, 2)}</span>` : '';
  return `<span class="x-stab ${tab.selected ? 'on' : ''}" title="${tab.label}"><span class="ic">${tabIcon(tab, 13)}`
    + `</span><span class="l">${tab.label}</span>${close}</span>`;
}

// the selected tab is 1.5 times as wide as each other tab, and the rest share the bar equally
function tabBar(tabs) {
  const columns = tabs.map((tab) => (tab.selected ? 'minmax(0,1.5fr)' : 'minmax(0,1fr)')).join(' ');
  return `<div class="x-strip"><div class="trk x-even" style="grid-template-columns:${columns}">`
    + `${tabs.map(tabHtml).join('')}</div></div>`;
}

// with the sidebar pinned open, the pane gives way so the conversation keeps at least 400px
function fittedPaneWidth(width) {
  if (sidebarFolded) return width;
  return Math.min(width, windowWidth - 16 - sidebarWidth - 16 - 400);
}

/** The pane's width: about half the room, or `wide` for Q&A, or `reading` for a document. */
function paneWidth(kind) {
  // the pane keeps its width when the sidebar is hidden, so the conversation gets the room
  const room = windowWidth - 48 - sidebarWidth;
  if (kind === 'wide') return Math.round(room - (narrowWindow ? 280 : 380));
  if (kind === 'reading') return Math.round(room * 0.6);
  return Math.round(room * (narrowWindow ? 0.56 : 0.52));
}

/** The pane with its tabs and body; `grip` marks a pane that has been dragged wider. */
function pane(tabs, body, width, grip = '') {
  return `<section class="x-pane glass pane" style="--pw:${fittedPaneWidth(width)}px"><i class="x-grip ${grip}"></i>`
    + `<div class="inner">${tabBar(tabs)}<div class="x-pbody">${body}</div></div></section>`;
}

// Tasks: grouped by state, one line of what each is doing or found
const STOP_BUTTON = roundButton('close', 'Stop');
const OPEN_BUTTON = roundButton('chevr', 'Open');
const TASKS_LIST = `<div class="x-lbl">Needs Input</div>
<div class="x-tgroup">${taskRow('sheet', 'Draft responses for open questions', '40 ready',
    { end: '<button class="btn sm">Review</button>' })}</div>
<div class="x-lbl">Running</div>
<div class="x-tgroup">${taskRow('cklist', 'Diligence', '1,284 of 2,148', { bar: 0.6, end: STOP_BUTTON })}
${taskRow('logedit', BOARD_TASK, 'Step 3 of 5',
    { bar: 0.5, end: STOP_BUTTON, hoverText: 'Reading Credit agreement (draft 6).pdf' })}
${taskRow('folder', 'Indexing 04 Legal', '38 of 52 files', { bar: 0.73, end: STOP_BUTTON })}</div>
<div class="x-lbl">Completed</div>
<div class="x-tgroup">${taskRow('import', 'Q&amp;A Log Import', 'Matched 412 responses · 1h', { end: OPEN_BUTTON })}
${taskRow('logedit', 'Lock-up ratio against the term sheet', 'Satisfied · 3h', { end: OPEN_BUTTON })}</div>`;

// a task opened in the pane: the ask, then each step as a collapsed tool row, as research views show them
const taskReplyBox = `<div class="steer">${composer('Reply to this task…')}</div>`;

/** One step of a task; the live step shows a ring and shimmering words. */
function taskStep(iconName, text, count, live = false) {
  const mark = live ? `<span class="x-ring">${ring(0.5, 13)}</span>` : icon(iconName, 14);
  return `<div class="x-tool ${live ? 'live' : ''}"><span class="ti">${mark}</span>`
    + `<span class="tt">${live ? shimmer(text) : text}</span>${count ? `<span class="tc">${count}</span>` : ''}`
    + `<span class="tv">${icon('chev', 13)}</span></div>`;
}

const TASK_HEADING = `<h2>${BOARD_TASK}</h2>`;
const TASK_ASK = '<div class="me">Check whether the board resolutions approving the financing are current.</div>';
const TASK_STEPS_SO_FAR = `<p class="nar">Locating the board resolutions, then comparing them with the latest credit`
  + ` agreement.</p>
${taskStep('search', 'Searched 04 Legal for board resolutions', '7 files')}
<p class="nar">Two resolutions approve the financing, dated January 18 and March 4. The March resolution`
  + ` supersedes the January resolution.</p>
${taskStep('doc', 'Read Board resolution (Mar 4).pdf', 'p. 2')}`;

const TASK_RUNNING = `<div class="x-tv"><div class="sc">${TASK_HEADING}
${TASK_ASK}${TASK_STEPS_SO_FAR}
<p class="nar">The March resolution approves draft 4. Comparing draft 6 with draft 4.</p>
${taskStep('doc', 'Reading Credit agreement (draft 6).pdf', '', true)}
<div class="x-spin">2m 14s · step 3 of 5</div>
</div>${taskReplyBox}</div>`;

const TASK_DONE = `<div class="x-tv"><div class="sc">${TASK_HEADING}
${TASK_ASK}${taskStep('search', 'Searched and read 4 documents', '5 steps')}
<p>${cited('The March resolution approves the credit agreement in its draft 4 form.')}`
  + ` ${cited('Draft 6 raises the facility to USD 310 million and adds a second hedging bank.')}`
  + ` The board has to approve the current draft before signing.</p>
${sourceChips(sourceChip('Board resolution (Mar 4).pdf', 'p. 2'), sourceChip('Credit agreement (draft 6).pdf', 'p. 9'))}
<div class="acts2"><button class="btn sm">Open Finding</button><button class="btn sm">Ask the Counterparty</button>`
  + `</div>
</div>${taskReplyBox}</div>`;

// the Diligence report's items; only flagged items and gaps are listed
const REPORT_ITEMS = [
  ['Guarantee cap is lower than the term sheet', 'Problem'],
  ['Certificate of incorporation, with all amendments', 'Not Found'],
  ['Board resolutions approving the financing are out of date', 'Problem'],
  ['Authorized signatories list predates the last board change', 'Problem'],
  ['Lock-up ratio differs from the term sheet', 'Problem'],
  ['Debt service reserve sized at three months, not six', 'Problem'],
  ['Hedging strategy letter', 'Not Found'],
  ['Intercreditor agreement waterfall omits the O&M reserve', 'Problem'],
  ['Direct agreement with the offtaker', 'Not Found'],
  ['Mandatory prepayment triggers differ between drafts', 'Problem'],
  ['Grid connection permit is not yet granted', 'Problem'],
  ['Water abstraction license ends before the debt tenor', 'Problem'],
  ['Environmental permit condition report', 'Not Found'],
  ['Aviation clearance', 'Not Found'],
  ['Contracted capacity is below the base case', 'Problem'],
  ['Curtailment compensation is capped at 2% a year', 'Problem'],
];
// the questions asked about an item, by its place in REPORT_ITEMS
const ASKED_ABOUT_ITEM = { 0: 'Q412 Open', 3: 'Q496 Open' };

// the Checklist page's own rows and marks: a flagged item's stripe, a gap's dashed ring (checklist.tsx, Row)
function reportRow([title, result], index) {
  const mark = result === 'Problem' ? 'finding' : 'gap';
  return `<div class="x-row"><span class="mk k-${mark}"></span><span class="t" title="${title}">${title}</span>`
    + `<span class="s">${ASKED_ABOUT_ITEM[index] ?? ''}</span></div>`;
}

const REPORT_FILTERS = '<div class="seg"><button class="on">All<span class="c"> 2,148</span></button>'
  + '<button>Flagged<span class="c"> 84</span></button><button>Gaps<span class="c"> 47</span></button>'
  + '<button>Not Settled<span class="c"> 105</span></button>'
  + '<button>Satisfied<span class="c"> 1,912</span></button></div>';

/** The Diligence report; `rechecking` shows the re-check running above it. */
function diligenceReport(rechecking) {
  const rowsOf = (isFlagged) => REPORT_ITEMS.map((item, index) => [item, index])
    .filter(([item]) => (item[1] === 'Problem') === isFlagged)
    .map(([item, index]) => reportRow(item, index))
    .join('');
  const rows = `<div class="x-grp">Flagged<span class="n">84</span></div>${rowsOf(true)}`
    + `<div class="x-grp">Gaps<span class="n">47</span></div>${rowsOf(false)}`;
  const status = rechecking ? statusLine(0.5, 'Checking the checklist and findings', '1,204 of 2,148 · 3m') : '';
  return `<div class="x-rhead">${REPORT_FILTERS}</div>${status}${rows}`;
}

const FINDING = `<div class="x-issue"><div class="top"><span class="m">Corporate and Authority · Finding</span>`
  + `<span class="end">${pickButton('Open')}${iconButton('more', 16, 'More')}</span></div>
<h2>Guarantee cap is lower than the term sheet</h2>
${sourceChips(GUARANTEE_CHIP, TERM_SHEET_CHIP)}
<p>${CAP_IN_DRAFT} ${CAP_IN_TERM_SHEET}</p>
<div class="x-lbl">Checklist Item</div>`
  + '<div><span class="lnk">2.7 Parent company guarantee matches the term sheet</span>'
  + `</div>
<div class="x-lbl">Questions<span class="n">2</span></div>
<div class="x-q"><b>Q412</b><span>Confirm the guarantee cap that applies at financial close.</span>`
  + `<span class="s">Open</span></div>
<div class="x-q"><b>Q87</b><span>Provide the guarantor’s latest credit rating.</span>`
  + `<span class="s">Answered</span></div>
<button class="btn sm">Ask the Counterparty</button></div>`;

// while a finding updates from new files, its status shows above its text, which is marked busy
const FINDING_UPDATING = FINDING
  .replace('</h2>', `</h2>${statusLine(0.7, 'Reading Parent company guarantee (draft 3).pdf', 'file 1 of 2 · 1m')}`)
  .replace('<p>', '<p class="busy">');

// reading mode's viewer in the pane: the page, the citation bar, and the page and zoom stack
function stackButton(title, label, iconName, size) {
  return `<button title="${title}" aria-label="${label}">${icon(iconName, size)}</button>`;
}

const SOURCE_DOCUMENT = '<div class="x-docstage wide"><article class="x-page x-pdf"><img src="guarantee-p4.png"'
  + ' alt="Parent company guarantee (draft 2).pdf, page 4"></article></div>\n'
  + `<div class="x-docnav"><button title="Previous citation">${icon('prev', 16)}</button><span class="nm">`
  + '<b>Parent company guarantee (draft 2).pdf</b><span>p. 4</span><span>Citation 1 of 2</span></span>'
  + stackButton('Next citation', 'Next citation', 'next', 16)
  + `<button class="cls" title="Close document" aria-label="Close document">${icon('close', 15)}</button></div>\n`
  + '<div class="pgstack x-pgstack" role="group" aria-label="Page and zoom">'
  + stackButton('Previous page · Page Up', 'Previous page', 'chevup', 15)
  + stackButton('Next page · Page Down · 19 pages', 'Next page', 'chev', 15)
  + '<i class="pgrule"></i>'
  + stackButton('Zoom in · Ctrl +', 'Zoom in', 'plus', 13)
  + stackButton('Zoom out · Ctrl −', 'Zoom out', 'minus', 13)
  + '<button class="zoomv off" title="Actual size · Ctrl 0" aria-label="Actual size">100%</button></div>';
