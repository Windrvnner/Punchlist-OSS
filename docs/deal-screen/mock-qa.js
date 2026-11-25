// The deal screen mock-up: the Q&A tab, as a table in a wide pane or a one-column list, and an opened question.

// each question: number, submitted by, priority, workstream, question, response, status
const QUESTIONS = [
  [412, 'Lender A', 'High', 'Legal', 'Confirm the guarantee cap that applies at financial close.', '', 'Open'],
  [1, 'Lender A', 'High', 'Legal', 'Provide the executed revenue contract and all amendments.',
    'Provided in the data room, folder 05.', 'Closed'],
  [3, 'Lender B', 'Medium', 'Technical', 'Confirm the energy yield assumed in the base case and its source.',
    'See the updated technical advisor report.', 'Answered'],
  [433, 'Lender A', 'High', 'Legal', 'When will the grid connection permit be granted, and what conditions apply?', '',
    'Open'],
  [5, 'Lender B', 'Low', 'Commercial', 'Provide the offtaker’s position on the revenue contract.',
    'Confirmed: no change from the term sheet.', 'Answered'],
  [450, 'Model auditor', 'High', 'Financial', 'Reconcile the debt service reserve in the model with the term sheet.',
    '', 'Open'],
  [61, 'Insurance advisor', 'Medium', 'Insurance',
    'Confirm the deductible and the limit for the business interruption cover.',
    'Deductible of 60 days; limit of 18 months.', 'Answered'],
  [72, 'Lender A', 'Medium', 'Legal', 'Who holds the land rights, and when do they expire?',
    'Lease to 2061, held by the project company.', 'Closed'],
  [468, 'Technical advisor', 'High', 'Technical', 'Provide the water abstraction license renewal plan.', '', 'Open'],
  [97, 'Lender B', 'Medium', 'Financial', 'Confirm the debt sizing criteria and the sculpting method.',
    'Sized at 1.30x P50, sculpted to the DSCR.', 'Answered'],
  [87, 'Lender A', 'Low', 'Legal', 'Provide the guarantor’s latest credit rating.',
    'BBB+, stable, affirmed in September.', 'Answered'],
  [471, 'Lender B', 'High', 'Legal', 'Provide the hedging strategy letter.', '', 'Open'],
  [118, 'Lender A', 'Medium', 'Commercial', 'List all curtailment events in the last three years.',
    'Eleven events, schedule in folder 07.', 'Answered'],
  [480, 'Lender B', 'Medium', 'Environmental', 'Provide the latest environmental permit condition report.', '', 'Open'],
  [143, 'Insurance advisor', 'Low', 'Insurance', 'Provide the insurance advisor’s latest report.',
    'Final report uploaded on Oct 25.', 'Closed'],
  [492, 'Lender A', 'High', 'Legal', 'Confirm the board resolutions approving the financing are current.', '', 'Open'],
  [166, 'Technical advisor', 'Medium', 'Technical', 'Confirm the O&M contract covers the full debt tenor.',
    'Covers 20 years with two extensions.', 'Answered'],
  [180, 'Lender B', 'Low', 'Financial', 'Provide the audited accounts for the last three years.',
    'Uploaded to folder 02.', 'Closed'],
];
// questions by their place in QUESTIONS: those whose response is being drafted, and the one with a waiting draft
const DRAFTING_QUESTIONS = new Set([0, 5]);
const DRAFTED_QUESTION = 3;
const DRAFT_BADGE = '<span class="modebadge x-badge">Draft</span>';
// the one-column list shows the first 16 questions
const LIST_LENGTH = 16;

/** An opened question's header: its number and status, then Discuss, its place in the log, and its arrows. */
function questionCardHeader(number, status, position) {
  return `<div class="hd"><b>Q${number}</b>${pickButton(status)}<span class="end"><button class="btn sm">Discuss`
    + `</button><span class="pos">${position} of 2,184</span>${iconButton('chevup', 15, 'Previous')}`
    + `${iconButton('chev', 15, 'Next')}${iconButton('close', 14, 'Close')}</span></div>`;
}

function questionProperties(priority, submittedBy, date) {
  return `<div class="props"><span>${icon('tag', 14)}Legal</span><span>${icon('flag', 14)}${priority}</span>`
    + `<span>${icon('user', 14)}${submittedBy}</span><span>${icon('cal', 14)}${date}</span></div>`;
}

const questionColumn = (question) => `<div><div class="lb">Question</div><p class="qt">${question}</p></div>`;

const DRAFTED_CARD = `<div class="x-qcard">${questionCardHeader(433, 'Open', 4)}
${questionProperties('High', 'Lender A', 'Nov 14')}
<div class="cols">${questionColumn('When will the grid connection permit be granted, and what conditions apply?')}
<div><div class="lb">Response${DRAFT_BADGE}</div><div class="draft">`
  + `${cited('The grid operator expects to grant the permit by June 30.')}`
  + ` ${cited('It is conditional on two network upgrades, both funded under the connection agreement.')}</div>
${sourceChips(sourceChip('Grid operator letter (Oct 2).pdf', 'p. 2'), sourceChip('Connection agreement.pdf', 'p. 17'))}
<div class="acts2"><button class="btn sm pri">Use as Response</button></div></div></div></div>`;

const ANSWERED_CARD = `<div class="x-qcard">${questionCardHeader(87, 'Answered', 11)}
${questionProperties('Low', 'Lender A', 'Oct 21')}
<div class="cols">${questionColumn('Provide the guarantor’s latest credit rating.')}
<div><div class="lb">Response<span class="sub">${icon('user', 14)}Contoso Wind Partners</span>`
  + `<span class="sub">${icon('cal', 14)}Oct 30</span></div><div class="resp">BBB+, stable outlook, affirmed in`
  + ` September. The rating letter is in folder 02.</div>
${sourceChips(sourceChip('Rating letter (Sep 12).pdf', 'p. 1'))}</div></div></div>`;

/** The checklist item and finding a question is linked to, under its card. */
function questionLinks(checklistItem, finding) {
  return `<div class="x-lbl">Checklist Item</div><div><span class="lnk">${checklistItem}</span></div>`
    + `<div class="x-lbl">Finding</div><div><span class="lnk">${finding}</span></div>`;
}

const withLinks = (card, links) => card.replace(/<\/div>$/, `${links}</div>`);
const DRAFTED_CARD_WITH_LINKS = withLinks(DRAFTED_CARD,
  questionLinks('4.2 Grid connection permit is granted', 'Grid connection permit is not yet granted'));
const ANSWERED_CARD_WITH_LINKS = withLinks(ANSWERED_CARD,
  questionLinks('2.7 Parent company guarantee matches the term sheet', 'Guarantee cap is lower than the term sheet'));

/** The opened question: `answered` shows Q87 and anything else shows the draft on Q433. */
const openedCard = (opened) => (opened === 'answered' ? ANSWERED_CARD_WITH_LINKS : DRAFTED_CARD_WITH_LINKS);

const STATUS_FILTER = '<div class="seg"><button>Open<span class="c"> 728</span></button><button>Answered'
  + '<span class="c"> 1,090</span></button><button>Closed<span class="c"> 366</span></button>'
  + '<button class="on">All</button></div>';
const STATUS_PICK = `<button class="btn sm x-statepick">All<span class="chev">${icon('chev', 13)}</span></button>`;

/** The Q&A toolbar; the narrow list folds the status filter into one All button. */
function qaToolbar(opened, narrow) {
  const draftAllClass = `btn sm ${opened ? '' : 'pri'}`;
  return `<div class="x-qtools">${narrow ? STATUS_PICK : STATUS_FILTER}${iconButton('filter', 15, 'Filter')}`
    + `<span class="x-qact"><button class="${draftAllClass}">Draft All Open</button>`
    + `<button class="btn sm wide">Add Question</button>${iconButton('more', 16, 'More')}</span></div>\n  `;
}

function tableResponse(question, index) {
  if (DRAFTING_QUESTIONS.has(index)) return workingMark(0.45, 13, shimmer('Drafting'));
  if (index === DRAFTED_QUESTION) return `${DRAFT_BADGE} The grid operator expects to grant it by June 30.`;
  return question[5] || '<span class="x-none">—</span>';
}

function tableRow(question, index, selectedIndex) {
  const [number, submittedBy, priority, , text, , status] = question;
  return `<div class="x-tr ${index === selectedIndex ? 'on' : ''}"><span class="n">Q${number}</span>`
    + `<span class="p">${priority}</span><span class="ws">${submittedBy}</span><span class="q">${text}</span>`
    + `<span class="r">${tableResponse(question, index)}</span><span class="st">${status}</span></div>`;
}

const TABLE_HEAD = '<div class="x-th"><span class="n">#</span><span class="p">Priority</span>'
  + '<span class="ws">Submitted By</span><span>Question</span><span class="r">Response</span><span>Status</span></div>';

/** Q&A as a table, with an opened question (`drafted` or `answered`) above it, if any. */
function qaTable(opened) {
  const selectedIndex = { drafted: DRAFTED_QUESTION, answered: 10 }[opened] ?? -1;
  const rows = QUESTIONS.map((question, index) => tableRow(question, index, selectedIndex)).join('');
  return `${qaToolbar(opened, false)}${opened ? openedCard(opened) : ''}`
    + `<div class="x-table">${TABLE_HEAD}${rows}</div>`;
}

// the response state rides on the meta line, so the status column says Open, as the table does
function listResponseState(index) {
  const nowrap = (html) => `<span class="x-state">${html}</span>`;
  if (DRAFTING_QUESTIONS.has(index)) {
    return nowrap(`<span class="w"><span class="x-ring">${ring(0.45, 12)}</span>${shimmer('Drafting')}</span>`);
  }
  if (index === DRAFTED_QUESTION) return nowrap(DRAFT_BADGE);
  return '';
}

function listRow([number, submittedBy, priority, workstream, text, , status], index) {
  const meta = `${submittedBy} ·&nbsp;${workstream} ·&nbsp;${priority}${listResponseState(index)}`;
  return `<div class="x-lrow"><span class="n">Q${number}</span><span class="q">${text}<small>${meta}</small></span>`
    + `<span class="st">${status}</span></div>`;
}

/** Q&A as a one-column list, for a pane too narrow for the table. */
function qaList() {
  const rows = QUESTIONS.slice(0, LIST_LENGTH).map(listRow).join('');
  return `${qaToolbar(undefined, true)}<div class="x-qlist">${rows}</div>`;
}

/** One question opened in its card, in place of the list. */
const qaOpenedQuestion = (opened) => `<div class="x-qitem">${openedCard(opened)}</div>`;
