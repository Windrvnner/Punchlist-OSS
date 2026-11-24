// The deal screen mock-up: the screen picked by the page's hash, and small parts shared by every screen.
// The scripts load in order and share their top-level names: mock-parts.js, mock-sidebar.js, mock-chat.js,
// mock-pane.js, mock-qa.js, then mock-screens.js, which builds the page.

const hashParams = new URLSearchParams(location.hash.slice(1));
const screen = hashParams.get('s') || 'empty';
document.documentElement.dataset.theme = hashParams.get('theme') || 'dark';
const windowWidth = innerWidth;
const narrowWindow = windowWidth <= 1180;

// the board resolutions task's short name, so it reads whole on its tab, its card and its row
const BOARD_TASK = 'Resolutions';
const sidebarWidth = narrowWindow ? 208 : 236;

/** An icon from icons.js as an SVG, at the given size and stroke width. */
function icon(name, size = 16, strokeWidth = 1.75) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `${ICONS[name] || ''}</svg>`;
}

// new icon for the mock-up: the pane toggle (a window with its right pane)
ICONS.panel = '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M14 4.5v15"/>';

/** A progress ring, filled to `progress` (0 to 1). */
function ring(progress, size = 16) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const circle = `<circle cx="8" cy="8" r="${radius}" fill="none"`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">`
    + `${circle} stroke="var(--bar-track)" stroke-width="2"/>`
    + `${circle} stroke="currentColor" stroke-width="2" stroke-linecap="round"`
    + ` stroke-dasharray="${circumference * progress} ${circumference}" transform="rotate(-90 8 8)"/></svg>`;
}

/** The composer, as on Home and in every conversation. */
function composer(placeholder) {
  return `<form class="askbox glass"><textarea rows="1" placeholder="${placeholder}"></textarea><div class="bar">
  <button type="button" class="scopebtn" title="Attach">${icon('clip', 13)}<span class="t">Attach</span></button>
  <button type="button" class="scopebtn mode" title="Answer mode">${icon('model', 13)}<span>Standard</span>`
    + `<span class="chev">${icon('chev', 13)}</span></button>
  <span class="needs" style="margin-left:auto"><button type="submit" class="send" title="Send">`
    + `${icon('send', 16)}</button></span></div></form>`;
}

// the live step's words shimmer while it runs
const shimmer = (words) => `<span class="x-shim">${words}</span>`;

// the live step's words give way to an ellipsis first, so the count and the time stay readable
function liveStep(words, meta) {
  return `<span class="x-live"><span class="lv">${shimmer(words)}</span><span class="mt">${meta}</span></span>`;
}

/** A source chip: a document's name and the place cited in it. */
function sourceChip(name, place) {
  return `<button type="button" class="rsch-chip">${icon('doc', 13)}<span class="docnm">${name}</span>`
    + `<em>${place}</em></button>`;
}

/** A cited sentence, underlined. */
const cited = (sentence) => `<span class="ref"><span class="rb">${sentence}</span></span>`;

/** A row of source chips. */
const sourceChips = (...chips) => `<div class="rsch-chips">${chips.join('')}</div>`;

// a task row or card: a kind tile, its name, a thin bar, then how far it has got
const kindTile = (iconName) => `<span class="x-tile">${icon(iconName, 14)}</span>`;
const progressBar = (share) => `<span class="x-pbar"><i style="width:${Math.round(share * 100)}%"></i></span>`;

/** A small round button with an icon, such as Stop on a running task. */
function roundButton(iconName, label) {
  return `<button type="button" class="x-circ" title="${label}" aria-label="${label}">${icon(iconName, 10, 2.6)}`
    + '</button>';
}

/** A task's name and count on one line; the hover text names what an open-ended task is reading. */
function taskTitle(name, meta, hoverText) {
  const title = hoverText ? ` title="${hoverText}"` : '';
  return `<span class="top"${title}><span class="nm">${name}</span><span class="ct">${meta}</span></span>`;
}

/** A row in Tasks. Options: `bar` (progress, only while running), `end` (its button), `hoverText`. */
function taskRow(iconName, name, meta, options = {}) {
  const bar = options.bar === undefined ? '' : progressBar(options.bar);
  return `<div class="x-prow">${kindTile(iconName)}<span class="tx">${taskTitle(name, meta, options.hoverText)}`
    + `${bar}</span><span class="tr">${options.end || ''}</span></div>`;
}

/** A task's card in the chat, which opens the task. */
function taskCard(iconName, name, meta, barShare, hoverText) {
  const bar = barShare === undefined ? '' : progressBar(barShare);
  return `<div class="x-card x-pcard">${kindTile(iconName)}<div class="k">${taskTitle(name, meta, hoverText)}`
    + `${bar}</div><button class="btn sm">Open</button></div>`;
}

/** A running mark: a ring and its words, as on a drafting question. */
function workingMark(progress, size, words) {
  return `<span class="x-work"><span class="x-ring">${ring(progress, size)}</span>${words}</span>`;
}

/** A status line with a ring above a list or a finding, while work on it runs. */
function statusLine(progress, words, meta) {
  return `<div class="x-status"><span class="x-ring">${ring(progress, 13)}</span>${liveStep(words, meta)}</div>`;
}

/** A small icon button in a header. */
function iconButton(iconName, size, title) {
  return `<button class="btn sm ico" title="${title}">${icon(iconName, size)}</button>`;
}

/** A pick button, such as a record's status, with its chevron. */
function pickButton(label) {
  return `<button class="btn sm hsel">${label}<span class="chev">${icon('chev', 13)}</span></button>`;
}
