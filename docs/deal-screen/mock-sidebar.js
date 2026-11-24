// The deal screen mock-up: the sidebar and its deal list, the slim rail, the archive menu, dialog and notice, the
// conversation header, and the past conversations list.

// deals in the order the person last worked on them; archived deals are hidden under Archived, whose dot shows that
// one of them has new files
const archivedShown = hashParams.get('arch') === '1';
const dealMenuShown = hashParams.get('menu') === '1';
const unarchiveMenuShown = hashParams.get('umenu') === '1';
const DEALS = ['Project Proseware', 'Project Halyard', 'Project Trey', 'Project Wingtip', 'Project Kestrel'];
const ARCHIVED_DEALS = [['Project Tern', '4 new files · 11:20 AM'], ['Project Lapwing', ''], ['Project Plover', '']];
const MENU_ROW_STYLE = ' style="padding-right:34px;background:var(--card-hover)"';
const moreButton = () => `<button type="button" class="dmore open" title="More" aria-label="More">${icon('more', 15)}`
  + '</button>';

function dealRow(name, index) {
  const menuOpen = dealMenuShown && name === 'Project Trey';
  const rowClass = `dealrow ${index === 0 ? 'on' : ''}`;
  return `<div class="drow"><a href="#" class="${rowClass}"${menuOpen ? MENU_ROW_STYLE : ''}>`
    + `<span class="dn1">${name}</span></a>${menuOpen ? moreButton() : ''}</div>`;
}

/** An archived deal; one with news shows its update line and a dot. */
function archivedRow([name, news]) {
  const menuOpen = unarchiveMenuShown && name === 'Project Tern';
  const updateLine = news ? `<span class="dtw">${news}</span>` : '';
  if (menuOpen) {
    return `<div class="drow"><a href="#" class="dealrow x-arch"${MENU_ROW_STYLE}><span class="dn1">${name}</span>`
      + `${updateLine}</a>${moreButton()}</div>`;
  }
  const dot = news ? '<i class="x-upd"></i>' : '';
  return `<div class="drow"><a href="#" class="dealrow x-arch"><span class="dn1">${name}</span>${updateLine}${dot}</a>`
    + '</div>';
}

function dealList() {
  const shown = archivedShown ? DEALS.filter((deal) => deal !== 'Project Trey') : DEALS;
  const archived = archivedShown
    ? [ARCHIVED_DEALS[0], ['Project Trey', ''], ...ARCHIVED_DEALS.slice(1)]
    : ARCHIVED_DEALS;
  const groupDot = archivedShown ? '' : '<i class="x-upd"></i>';
  const groupHead = '<button type="button" class="grp-h" title="New files in Project Tern">'
    + `<span class="tri ${archivedShown ? 'open' : ''}">${icon('chevr', 12)}</span>Archived`
    + `<span class="cnt">${groupDot}${archived.length}</span></button>`;
  const archivedRows = archivedShown ? archived.map(archivedRow).join('') : '';
  return `<div class="x-deals">${shown.map(dealRow).join('')}</div>`
    + `<div class="x-archgrp">${groupHead}${archivedRows}</div>`;
}

function dealMenu() {
  if (!dealMenuShown && !unarchiveMenuShown) return '';
  const firstItem = unarchiveMenuShown ? 'Unarchive Deal' : 'Archive Deal';
  const items = [firstItem, 'Remove from My Deals'].map((item) => `<button type="button" class="mi">${item}</button>`);
  return `<div class="colmenu glass railmenu x-dealmenu" role="menu">${items.join('')}</div>`;
}

function archiveConfirm() {
  if (hashParams.get('confirm') !== '1') return '';
  return '<div class="scrim blur"><div class="dlg sdlg dddlg uldlg" role="dialog" aria-label="Archive Project Trey?">'
    + '<div class="shead"><h2>Archive Project Trey?</h2>'
    + `<button type="button" class="x" aria-label="Close" title="Close (Esc)">${icon('close', 15)}</button></div>`
    + '<div class="xfoot"><span class="grow"></span><button type="button" class="btn sm">Cancel</button>'
    + '<button type="button" class="btn sm pri" title="It moves to Archived; nothing is deleted">Archive</button>'
    + '</div></div></div>';
}

function archivedNotice() {
  if (hashParams.get('toast') !== '1') return '';
  return `<div class="notices"><div class="toasts"><div class="toast"><span class="tg">${icon('check', 16)}</span>`
    + '<span class="ttext"><b class="ttitle">Archived Project Trey</b></span>'
    + '<button type="button" class="tundo">Undo</button>'
    + `<button type="button" class="tclose" aria-label="Dismiss">${icon('close', 13)}</button></div></div></div>`;
}

function sidebar() {
  const hideButton = '<button type="button" class="btn sm ico x-sidetog" title="Hide sidebar"'
    + ` aria-label="Hide sidebar">${icon('panel', 15)}</button>`;
  const addButton = '<button type="button" class="plus" title="Add deal" aria-label="Add deal">'
    + `${icon('plus')}</button>`;
  return `<aside class="rail glass pane"><div class="brand"><span class="mark">${icon('mark')}</span>`
    + `${hideButton}${addButton}</div>
  <div class="rsearch">${icon('search', 14, 2)}<input placeholder="Search"><kbd>Ctrl K</kbd></div>
  <nav><a href="#">Home</a>${dealList()}</nav>
  <div class="me"><button type="button" class="merow"><span class="avatar">J</span><span>jdoe</span>`
    + `<span class="gear">${icon('gear', 15)}</span></button></div></aside>`;
}

/** The sidebar folded to its slim rail of round buttons. */
function slimRail() {
  const railButton = (iconName, label, extraClass = '') => `<button class="railx${extraClass}" title="${label}"`
    + ` aria-label="${label}">${icon(iconName, 15)}</button>`;
  return '<aside class="rail glass pane x-slim">'
    + railButton('panel', 'Show sidebar', ' x-sidetog')
    + railButton('plus', 'Add deal')
    + railButton('home', 'Home')
    + railButton('search', 'Search (Ctrl K)')
    + '<div class="sp"></div>'
    + railButton('gear', 'Settings')
    + '</aside>';
}

// the conversation title in the breadcrumb opens this deal's past conversations
const pastConversationsShown = hashParams.get('past') === '1';
const PAST_CONVERSATIONS = [
  ['Today', 'Permits and diligence', '3:04 PM',
    'Four permits are still open. Two of them are conditions precedent to financial close.'],
  ['Today', 'Board resolutions for the financing', '2:12 PM',
    'The board approved draft 4 of the credit agreement, and draft 6 changes the facility size.'],
  ['Earlier this week', 'Lock-up ratio against the term sheet', 'Mon',
    'The model’s 1.15x lock-up test matches the term sheet.'],
  ['Earlier this week', 'Offtaker position on the revenue contract', 'Mon',
    'The offtaker confirmed no change from the term sheet in its response to Q5.'],
  ['Earlier this week', 'Insurance advisor report gaps', 'Sun',
    'The report leaves out business interruption cover for the grid connection.'],
  ['Older', 'Debt sizing and sculpting', 'Nov 14',
    'Sized at 1.30x P50 and sculpted to the DSCR, as the term sheet sets.'],
  ['Older', 'Hedging strategy letter', 'Nov 6',
    'The letter hedges 75% of the floating rate for the first seven years.'],
];

function pastConversationRow([group, title, when, preview], index) {
  const startsGroup = index === 0 || PAST_CONVERSATIONS[index - 1][0] !== group;
  return `${startsGroup ? `<div class="pg">${group}</div>` : ''}<a href="#" class="prow ${index === 0 ? 'on' : ''}">`
    + `<span class="pt">${title}</span><span class="pm">${when}</span><span class="pp">${preview}</span></a>`;
}

function pastConversationsList() {
  const rows = PAST_CONVERSATIONS.map(pastConversationRow).join('');
  return '<div class="pastpop down" role="dialog" aria-label="Past conversations"><div class="ptop">'
    + `<label class="psearch">${icon('search', 14)}<input placeholder="Search past conversations"></label>`
    + '<div class="pseg"><button type="button" class="on">This Deal</button><button type="button">All Deals</button>'
    + `</div></div><div class="plist">${rows}</div></div>`;
}

// the conversation's title is the history button, shaped like the composer's controls; it opens Past Conversations
function historyButton(title) {
  const label = title || 'Past Conversations';
  return `<button type="button" class="x-hist ${pastConversationsShown ? 'on' : ''}" title="Past conversations"`
    + ` aria-haspopup="dialog" aria-expanded="${pastConversationsShown}">${icon('clock', 13)}`
    + `<span class="t">${label}</span><span class="chev">${icon('chev', 13)}</span></button>`;
}

/** The pane's show or hide button, with a dot when work runs in a hidden pane. */
function paneToggle(options) {
  const label = options.open ? 'Hide pane' : 'Show pane';
  return `<button class="btn sm ico x-toggle ${options.open ? 'on' : ''}" title="${label}" aria-label="${label}">`
    + `${icon('panel', 15)}${options.dot ? '<i class="dot"></i>' : ''}</button>`;
}

/** The conversation's header: the breadcrumb with its history button, then More and the pane toggle. */
function conversationHeader(title, options = {}) {
  const toggle = options.toggle === false ? '' : paneToggle(options);
  return '<div class="x-head"><div class="x-trail"><b>Project Proseware</b><span class="sep">›</span>'
    + `${historyButton(title)}</div>${pastConversationsShown ? pastConversationsList() : ''}
  <div class="x-acts">${iconButton('more', 16, 'More')}${toggle}</div></div>`;
}
