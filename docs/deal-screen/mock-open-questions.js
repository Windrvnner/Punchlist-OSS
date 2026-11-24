// The deal screen mock-up: the points the first screens left open (#888, step 3). The deal's ⋯ menu, Deal Details
// and Folders take the deal header's controls and Overview's Documents; the Findings tab holds the full list of
// findings; Tasks shows what Needs Input holds; Home opens past conversations from its own header; and the sidebar
// shows Archived at scale. Loads after mock-qa.js and before mock-screens.js, which calls these builders.

// the Findings list opens as a tab after the fixed ones, with the finding's flag
TAB_ICONS.findings = 'flag';
const FINDINGS_TAB = { kind: 'findings', label: 'Findings' };

// screens shown with the sidebar open and no pane
const FULL_SIDEBAR_SCREENS = ['dealmenu', 'details', 'folders', 'homepast', 'archscale'];

/** The page's stage, as mock-screens.js wraps every screen. */
const openQuestionStage = (content) => `<section class="stage"><div class="x-stage">${content}</div></section>`;

// ---- the deal's ⋯ menu, Deal Details and Folders ----

/** The deal's ⋯ menu: the deal header's controls, with Delete Deal… set apart, as the header's menu has it. */
function dealDetailsMenu() {
  const item = (label, meta = '', extraClass = '') => `<button type="button" role="menuitem" class="mi ${extraClass}">`
    + `${label}${meta ? `<span class="x-mmeta">${meta}</span>` : ''}</button>`;
  return '<div class="colmenu glass x-headmenu" role="menu" aria-label="Project Proseware">'
    + item('Run Diligence', 'Last run Nov 20')
    + item('Deal Memo…')
    + item('Deal Details…')
    + item('Folders…')
    + '<div class="msep"></div>'
    + item('Delete Deal…', '', 'ddel')
    + '</div>';
}

/** A labeled field of the New Deal form, filled in. */
function dealField(label, value) {
  return `<div><span class="lbl">${label}</span><input class="field" value="${value}" aria-label="${label}"></div>`;
}

/** Deal Details: the New Deal form's fields without its folders, plus Deal status. Each field saves as it changes. */
function dealDetailsDialog() {
  const status = '<div><span class="lbl">Deal Status</span><button type="button" class="field x-fieldpick"'
    + ' aria-haspopup="menu">Live</button></div>';
  return '<div class="scrim blur"><div class="dlg nddlg x-details" role="dialog" aria-label="Deal Details">'
    + '<div class="shead"><h2>Deal Details</h2><button type="button" class="x" aria-label="Close"'
    + ` title="Close (Esc)">${icon('close', 15)}</button></div>`
    + `<div class="ndtop">${dealField('Name', 'Project Proseware')}`
    + `${dealField('Counterparty', 'Contoso Wind Partners')}</div>`
    + `<div class="ndpicks">${dealField('Structure', 'Project finance')}${dealField('Sector', 'Renewables')}`
    + `${dealField('Technology', 'Offshore wind')}</div>`
    + `<div class="ndpicks">${status}</div></div></div>`;
}

// the deal's folders: label, path and how many of their files are indexed; 04 Legal is still being indexed
const DEAL_FOLDERS = [
  ['01 Corporate', 'D:\\Proseware VDR\\01 Corporate', '486 of 486'],
  ['02 Financial', 'D:\\Proseware VDR\\02 Financial', '1,214 of 1,214'],
  ['03 Commercial', 'D:\\Proseware VDR\\03 Commercial', '702 of 702'],
  ['04 Legal', 'D:\\Proseware VDR\\04 Legal', '38 of 52'],
  ['05 Technical', 'D:\\Proseware VDR\\05 Technical', '1,618 of 1,618'],
  ['06 Permits and environmental', 'D:\\Proseware VDR\\06 Permits and environmental', '734 of 734'],
  ['07 Insurance', 'D:\\Proseware VDR\\07 Insurance', '384 of 384'],
];

/** One of the deal's folders, as the Folders dialog lists it (folderRow.tsx, FolderRow). */
function folderRow([label, path, indexed]) {
  return `<div class="fdrow"><span class="fdicon">${icon('folder')}</span><span class="fdstack">`
    + `<span class="efwrap"><input type="text" class="ef fdname idle" value="${label}" aria-label="Label"></span>`
    + `<span class="p" title="${path}"><bdi>${path}</bdi></span></span>`
    + `<span class="cnt ix">${indexed} indexed</span>`
    + `<button type="button" class="x" title="Remove from this deal" aria-label="Remove ${label}">`
    + `${icon('close', 12)}</button></div>`;
}

/** Overview's other Documents rows, moved under the folders: the core documents and a deal sharing these files. */
function sharedDocumentRow(iconName, name, count, hoverText) {
  return `<div class="fdrow x-shared" title="${hoverText}"><span class="fdicon">${icon(iconName)}</span>`
    + `<span class="fdstack"><span class="x-sname">${name}</span></span><span class="cnt">${count}</span></div>`;
}

// the dialog's own drop area, as foldersParts.tsx draws it
const FOLDER_DROP_ZONE = `<div class="dropzone row">${icon('import')}<div>Drop folders here, or`
  + ' <button type="button" class="linkb">paste a path</button></div></div>';

/** Folders: the dialog the app already has, now also showing what Overview's Documents list showed. */
function foldersDialog() {
  const shared = sharedDocumentRow('stack', 'Core documents', '101 of 101 indexed', 'The firm’s own documents')
    + sharedDocumentRow('building', 'Also in Project Halyard', '2,031 files',
      'Project Halyard holds 2,031 of these files');
  return '<div class="scrim blur"><div class="dlg nddlg x-folders" role="dialog" aria-label="Folders">'
    + '<div class="shead"><h2>Folders on Project Proseware</h2><button type="button" class="x" aria-label="Close"'
    + ` title="Close (Esc)">${icon('close', 15)}</button></div><div class="fdbody"><div class="fdlist">`
    + `<div class="fdgroup">${DEAL_FOLDERS.map(folderRow).join('')}</div>`
    + `<div class="fdgroup x-sharedgrp">${shared}</div></div>${FOLDER_DROP_ZONE}</div>`
    + '<div class="acts"><button type="button" class="btn sm pri">Choose Folders…</button></div></div></div>';
}

// ---- the Findings list, as a tab ----

// the open findings of the first two workstreams, A to Z; those marked "May be out of date" come first in a group
const FINDING_GROUPS = [
  ['Commercial', 11, [
    ['Offtaker can terminate the revenue contract on a change in law', 'May be out of date'],
    ['Revenue contract covers less capacity than the base case assumes', 'Nov 21'],
    ['Curtailment compensation is capped at 2% a year', 'Nov 20'],
    ['Merchant tail price curve is above the advisor’s low case', 'Nov 20'],
    ['Offtaker credit support falls away after year five', 'Nov 19'],
    ['Indexation in the revenue contract lags the base case by a year', 'Nov 19'],
    ['Grid charges are passed through only above a threshold', 'Nov 18'],
    ['Revenue contract has no cure period for availability shortfalls', 'Nov 18'],
    ['Balancing costs are borne by the project, not the offtaker', 'Nov 17'],
    ['Delay damages are capped below one quarter of debt service', 'Nov 14'],
    ['Exclusivity clause limits a second offtake agreement', 'Nov 12'],
  ]],
  ['Compliance', 3, [
    ['Sanctions screening of the sponsor’s shareholders is not on file', 'Nov 20'],
    ['Anti-bribery policy predates the current group structure', 'Nov 17'],
    ['Know-your-customer pack for the hedging bank is incomplete', 'Nov 13'],
  ]],
];

/** A finding in the list: its stripe, its title, and its date; its group already names its workstream. */
function findingListRow([title, when]) {
  const stale = when === 'May be out of date';
  const meta = stale ? `<span class="x-stale">${when}</span>` : when;
  return `<div class="x-row x-frow"><span class="mk k-finding"></span><span class="t" title="${title}">${title}`
    + `<small>${meta}</small></span><span class="s"></span></div>`;
}

function findingGroup([workstream, count, findings]) {
  return `<div class="x-grp">${workstream}<span class="n">${count}</span></div>`
    + findings.map(findingListRow).join('');
}

// the Findings page's own controls: the status filter, Filter (Workstream and Reviewed), New Finding, and ⋯
// (Import…, Export… and Deleted…)
const FINDINGS_TOOLBAR = '<div class="x-qtools x-ftools"><div class="seg"><button class="on">Open'
  + '<span class="c"> 113</span></button><button>Closed<span class="c"> 21</span></button><button>All</button></div>'
  + `${iconButton('filter', 15, 'Filter')}<span class="x-qact"><button class="btn sm">${icon('plus', 13)}`
  + `New Finding</button>${iconButton('more', 16, 'More')}</span></div>`;

const FINDINGS_LIST = `${FINDINGS_TOOLBAR}${FINDING_GROUPS.map(findingGroup).join('')}`;

/** The Diligence tab, with Findings at the end of its filter row, which opens the Findings tab. */
function diligenceWithFindingsButton() {
  const button = `<button type="button" class="btn sm x-findbtn" title="Findings" aria-label="Findings">`
    + `${icon('flag', 13)}<span class="l">Findings</span></button>`;
  return diligenceReport(false).replace(`${REPORT_FILTERS}</div>`, `${REPORT_FILTERS}${button}</div>`);
}

// ---- Tasks: what Needs Input holds ----

const TURN_HEADROOM_ASK = '<div class="me">How much covenant headroom is there in the downside case?</div>';

const TURN_HEADROOM_NEEDS_INPUT = `${TURN_HEADROOM_ASK}
<div class="ai"><p>I’m checking that as a task. It’s in Tasks, and I’ll answer here when it’s done.</p>
${taskCard('logedit', 'Covenant headroom in the downside case', 'Needs input')}</div>`;

const REVIEW_BUTTON = (label) => `<button class="btn sm">${label}</button>`;

// Needs Input: drafts to review, a task's question to the person, and items Diligence left out
const NEEDS_INPUT_ROWS = [
  taskRow('sheet', 'Draft responses for open questions', '40 ready', { end: REVIEW_BUTTON('Review') }),
  taskRow('logedit', 'Covenant headroom in the downside case', 'Step 2 of 5',
    { end: REVIEW_BUTTON('Reply'), hoverText: 'Asks which model to use: Nov 3 or Nov 17' }),
  taskRow('cklist', 'Diligence', '', { end: REVIEW_BUTTON('Check the 12 Left Out') }),
];

const RUNNING_ROWS = [
  taskRow('folder', 'Indexing 04 Legal', '38 of 52 files', { bar: 0.73, end: STOP_BUTTON }),
  taskRow('memo', 'Deal Memo', 'Step 2 of 4', { bar: 0.4, end: STOP_BUTTON }),
];

// finished tasks, newest first; the list scrolls inside the pane
const COMPLETED_TASKS = [
  ['cklist', 'Diligence', '131 to resolve · Nov 20'],
  ['import', 'Q&amp;A Log Import', 'Matched 412 responses · Nov 19'],
  ['logedit', 'Lock-up ratio against the term sheet', 'Satisfied · Nov 17'],
  ['logedit', 'Offtaker position on the revenue contract', '2 sources · Nov 17'],
  ['folder', 'Indexing 05 Technical', '1,618 files · Nov 14'],
  ['import', 'Issues List Import', '37 findings · Nov 13'],
  ['import', 'Master Checklist Import', '2,148 items · Nov 12'],
  ['logedit', 'Insurance advisor report gaps', '2 findings · Nov 10'],
];

const NEEDS_INPUT_TASKS = `<div class="x-lbl">Needs Input</div><div class="x-tgroup">${NEEDS_INPUT_ROWS.join('')}</div>`
  + `<div class="x-lbl">Running</div><div class="x-tgroup">${RUNNING_ROWS.join('')}</div>`
  + '<div class="x-lbl">Completed</div><div class="x-tgroup">'
  + `${COMPLETED_TASKS.map(([kind, name, meta]) => taskRow(kind, name, meta, { end: OPEN_BUTTON })).join('')}</div>`;

// ---- Home's past conversations ----

// every conversation, newest first, with its deal; a dot before the time marks one whose task result arrived since it
// was last open
const HOME_PAST_CONVERSATIONS = [
  ['Today', 'Guarantee cap and covenants', 'Project Proseware', '4:12 PM',
    'Headroom is 0.08x at the tightest point, in the second year of operations.', true],
  ['Today', 'Deals with permits that block financial close', '', '3:40 PM',
    'Two deals have open permits that are conditions precedent: Proseware and Wingtip.'],
  ['Today', 'Board resolutions for the financing', 'Project Proseware', '2:12 PM',
    'The board approved draft 4 of the credit agreement, and draft 6 changes the facility size.'],
  ['Today', 'Turbine warranty against the O&amp;M contract', 'Project Halyard', '11:05 AM',
    'The warranty ends in year five, while the O&amp;M contract assumes it runs to year ten.'],
  ['Earlier this week', 'Hedge counterparties across the portfolio', '', 'Mon',
    'Four banks hedge across seven deals; one bank is on five of them.'],
  ['Earlier this week', 'Tax equity flip date', 'Project Wingtip', 'Mon',
    'The flip is expected in year nine under the base case.'],
  ['Older', 'Debt sizing and sculpting', 'Project Proseware', 'Nov 14',
    'Sized at 1.30x P50 and sculpted to the DSCR, as the term sheet sets.'],
];

function homePastRow([group, title, deal, when, preview, updated], index) {
  const startsGroup = index === 0 || HOME_PAST_CONVERSATIONS[index - 1][0] !== group;
  const dealTag = deal ? `<span class="pa">${deal}</span>` : '';
  const dot = updated ? '<i class="x-upd" title="New result"></i>' : '';
  return `${startsGroup ? `<div class="pg">${group}</div>` : ''}<a href="#" class="prow ${index === 0 ? 'on' : ''}">`
    + `<span class="pt">${title}</span><span class="pm">${dealTag}${dot}${when}</span>`
    + `<span class="pp">${preview}</span></a>`;
}

/** Past conversations on Home: every deal's and Home's own, so the list has no This Deal choice. */
function homePastList() {
  return '<div class="pastpop down x-homepast" role="dialog" aria-label="Past conversations"><div class="ptop">'
    + `<label class="psearch">${icon('search', 14)}<input placeholder="Search past conversations"></label></div>`
    + `<div class="plist">${HOME_PAST_CONVERSATIONS.map(homePastRow).join('')}</div></div>`;
}

/** Home: its header holds only the history button, then the composer centered, as on an empty deal. */
function homeScreen() {
  return '<section class="x-conv"><div class="x-head"><div class="x-trail"><b>Home</b><span class="sep">›</span>'
    + `${historyButton('')}</div></div><div class="x-empty"><div class="center">`
    + '<h1 class="ttl">What would you like to know?</h1>'
    + `${composer('Which permits are still open on Project Wingtip?')}</div></div></section>`;
}

// ---- Archived at scale ----

const MORE_DEALS = ['Project Proseware', 'Project Halyard', 'Project Wingtip', 'Project Kestrel', 'Project Bowline',
  'Project Capstan', 'Project Mizzen', 'Project Lanyard', 'Project Bosun', 'Project Gunwale', 'Project Spinnaker',
  'Project Topsail', 'Project Ketch', 'Project Yawl', 'Project Sloop', 'Project Schooner', 'Project Clipper',
  'Project Galleon', 'Project Frigate', 'Project Corvette', 'Project Brigantine', 'Project Windlass',
  'Project Bollard', 'Project Cleat', 'Project Davit', 'Project Fairlead', 'Project Hawser', 'Project Jib'];

// changed deals first, newest change first, then the rest by when the person last worked on them
const MORE_ARCHIVED = [['Project Tern', '4 new files · 11:20 AM'], ['Project Osprey', '2 new files · Yesterday'],
  ['Project Trey', ''], ['Project Lapwing', ''], ['Project Plover', ''], ['Project Avocet', ''],
  ['Project Dunlin', ''], ['Project Curlew', ''], ['Project Godwit', ''], ['Project Sanderling', ''],
  ['Project Whimbrel', ''], ['Project Turnstone', '']];

/** Fills the sidebar with 28 deals and 12 archived ones, Archived open, scrolled to its end. */
function fillSidebarAtScale() {
  const plainRow = (name) => `<div class="drow"><a href="#" class="dealrow"><span class="dn1">${name}</span></a></div>`;
  document.querySelector('.rail .x-deals').innerHTML = MORE_DEALS.map(plainRow).join('');
  const head = `<button type="button" class="grp-h"><span class="tri open">${icon('chevr', 12)}</span>Archived`
    + `<span class="cnt">${MORE_ARCHIVED.length}</span></button>`;
  document.querySelector('.rail .x-archgrp').innerHTML = head + MORE_ARCHIVED.map(archivedRow).join('');
  // Home stays in place and only the deals scroll; a few of the deals above Archived stay in view
  document.querySelector('.rail').classList.add('x-scale');
  const list = document.createElement('div');
  list.className = 'x-dealscroll';
  list.append(document.querySelector('.rail .x-deals'), document.querySelector('.rail .x-archgrp'));
  document.querySelector('.rail nav').append(list);
  list.scrollTop = document.querySelector('.rail .x-archgrp').offsetTop - list.offsetTop - 110;
}

// ---- the screens, and what is placed once they are on the page ----

const OPEN_QUESTION_SCREENS = {
  dealmenu: () => sidebar() + openQuestionStage(conversation([TURN_PERMITS], { title: CONVERSATION_TITLES.permits })),
  details: () => OPEN_QUESTION_SCREENS.dealmenu(),
  folders: () => OPEN_QUESTION_SCREENS.dealmenu(),
  reportfindings: () => slimRail() + openQuestionStage(inPermitsChat([TURN_PERMITS, TURN_DILIGENCE_DONE])
    + pane(paneTabs([TASKS_TAB, DILIGENCE_TAB], 'diligence'), diligenceWithFindingsButton(), paneWidth())),
  findings: () => slimRail() + openQuestionStage(inPermitsChat([TURN_PERMITS, TURN_DILIGENCE_DONE])
    + pane(paneTabs([TASKS_TAB, DILIGENCE_TAB, FINDINGS_TAB], 'findings'), FINDINGS_LIST, paneWidth())),
  needsinput: () => slimRail() + openQuestionStage(conversation([TURN_GUARANTEE_CAP, TURN_HEADROOM_NEEDS_INPUT],
    { title: 'Guarantee cap and covenants', open: true })
    + pane(paneTabs([TASKS_TAB], 'tasks'), NEEDS_INPUT_TASKS, paneWidth())),
  homepast: () => sidebar() + openQuestionStage(homeScreen()),
  archscale: () => sidebar() + openQuestionStage(homeScreen()),
};

/** Opens the deal's ⋯ menu under its button, right-aligned to it, as the deal header's menu opens. */
function openDealDetailsMenu() {
  const button = document.querySelector('.x-acts .btn[title="More"]');
  button.classList.add('on');
  document.body.insertAdjacentHTML('beforeend', dealDetailsMenu());
  const anchor = button.getBoundingClientRect();
  const menu = document.querySelector('.x-headmenu');
  Object.assign(menu.style, { left: `${anchor.right - menu.offsetWidth}px`, top: `${anchor.bottom + 6}px` });
}

/** Home's past conversations open under the history button, as wide as the composer. */
function openHomePastList() {
  const button = document.querySelector('.x-hist');
  button.classList.add('on');
  document.querySelector('.x-empty').classList.add('x-dim');
  document.body.insertAdjacentHTML('beforeend', homePastList());
  const composerBox = document.querySelector('.x-empty .askbox').getBoundingClientRect();
  const anchor = button.getBoundingClientRect();
  Object.assign(document.querySelector('.x-homepast').style, { position: 'fixed', left: `${composerBox.left}px`,
    width: `${composerBox.width}px`, top: `${anchor.bottom + 8}px`, right: 'auto', bottom: 'auto' });
}

/** Marks Home as the open page in the sidebar. */
function selectHomeInSidebar() {
  for (const row of document.querySelectorAll('.rail .dealrow.on')) row.classList.remove('on');
  document.querySelector('.rail nav > a').classList.add('on');
}

/** Folders, scrolled as far as it goes with a whole folder row at the top, so the rows under the folders show. */
function showFoldersDialog() {
  document.body.insertAdjacentHTML('beforeend', foldersDialog());
  const body = document.querySelector('.x-folders .fdbody');
  const needed = body.scrollHeight - body.clientHeight;
  const rows = [...body.querySelectorAll('.fdgroup:first-child .fdrow')];
  const tops = rows.map((row) => row.offsetTop - rows[0].offsetTop).filter((top) => top <= needed);
  body.scrollTop = Math.max(...tops);
}

/** Called by mock-screens.js once the screen is on the page. */
function placeOpenQuestionScreens() {
  if (['homepast', 'archscale'].includes(screen)) selectHomeInSidebar();
  if (screen === 'dealmenu') openDealDetailsMenu();
  if (screen === 'details') document.body.insertAdjacentHTML('beforeend', dealDetailsDialog());
  if (screen === 'folders') showFoldersDialog();
  if (screen === 'homepast') openHomePastList();
  if (screen === 'archscale') fillSidebarAtScale();
}
