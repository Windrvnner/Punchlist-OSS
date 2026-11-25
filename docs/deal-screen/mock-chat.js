// The deal screen mock-up: the conversation, built up over the screens from its turns.

const CONVERSATION_TITLES = {
  permits: 'Permits and diligence',
  guarantee: 'Guarantee cap',
};

// marks where an answer's actions go; only the last answer in a conversation shows them
const ACTIONS_MARK = '<!--acts-->';

// the app's own answer actions (src/ui/answer.tsx): each names itself in the app's tooltip on hover
function answerAction(iconName, name) {
  return `<button type="button" class="ib" title="${name}" aria-label="${name}">${icon(iconName, 15)}</button>`;
}

const ANSWER_ACTIONS = '<div class="acts">' + answerAction('copy', 'Copy') + answerAction('addq', 'Add as question')
  + answerAction('addf', 'Add as finding') + '</div>';

/** The pill over a researched answer, with its step and document counts. */
function researchedPill(meta) {
  return `<div class="rsch-row"><button type="button" class="rsch-pill">${icon('check', 14)}Researched`
    + `<span class="rsch-m">· ${meta}</span>${icon('chev', 13)}</button></div>`;
}

const researched = (meta, ...chips) => `<div class="rsch">${researchedPill(meta)}${sourceChips(...chips)}</div>`;

const TURN_PERMITS = `<div class="me">Which permits are still open, and which ones block financial close?</div>
<div class="ai">${researched('4 steps · 9 documents',
  sourceChip('Permit register (Mar update).xlsx', 'Permits!B4'),
  sourceChip('Technical advisor report (final).pdf', 'p. 38'),
  sourceChip('Credit agreement (draft 6).pdf', 'p. 211'))}
<p>Four permits are still open. Two of them are conditions precedent to financial close.</p>
<p><b>Grid connection permit.</b> ${cited('The application was filed in January and a decision is expected in the'
  + ' second quarter.')} ${cited('The credit agreement makes it a condition precedent to the first drawdown.')}</p>
<p><b>Water abstraction license.</b> ${cited('The current license expires two years before the end of the debt'
  + ' tenor.')} The technical advisor flags the renewal as a risk, and it is also a condition precedent.</p>
<p>The building permit amendment and the aviation clearance are pending but do not block financial close.</p>`
  + `${ACTIONS_MARK}</div>`;

const ASK_DILIGENCE = '<div class="me">Run diligence on the data room against the master checklist.</div>';

const TURN_DILIGENCE_RUNNING = `${ASK_DILIGENCE}
<div class="ai"><p>Running diligence on 2,148 checklist items against 5,190 documents. Flagged items appear in the`
  + ` report as they are found.</p>
${taskCard('cklist', 'Diligence', '1,284 of 2,148 · 76 flagged', 0.6)}</div>`;

const TURN_DILIGENCE_DONE = `${ASK_DILIGENCE}
<div class="ai"><p>Diligence is complete. Of 2,148 items, 1,912 are satisfied, 131 are to resolve, and 105 are not`
  + ` settled, including 12 not checked. Of those to resolve, 84 are flagged and 47 are gaps.</p>
${taskCard('cklist', 'Diligence', 'Done · 131 to resolve')}</div>`;

const CAP_IN_DRAFT = cited('Draft 2 of the guarantee caps the guarantor’s liability at USD 25 million.');
const CAP_IN_TERM_SHEET = cited('The signed term sheet sets the cap at USD 40 million, stepping down after'
  + ' completion.');
const GUARANTEE_CHIP = sourceChip('Parent company guarantee (draft 2).pdf', 'p. 4');
const TERM_SHEET_CHIP = sourceChip('Term sheet (signed).pdf', 'p. 11');

const TURN_GUARANTEE_CAP = `<div class="me">Why is the guarantee cap lower than the term sheet?</div>
<div class="ai">${researched('3 steps · 4 documents', GUARANTEE_CHIP, TERM_SHEET_CHIP)}
<p>${CAP_IN_DRAFT} ${CAP_IN_TERM_SHEET} The draft has no step-down, so the gap is USD 15 million until completion.</p>`
  + `${ACTIONS_MARK}</div>`;

const TURN_COUNTERPARTY = `<div class="me">Has the counterparty answered anything on the guarantee?</div>
<div class="ai"><p>Not yet. ${cited('Q412 asks them to confirm the cap at financial close')} and has been open since`
  + ` Nov&nbsp;12. Q87 on the guarantor’s credit rating was answered on Oct&nbsp;30.</p>${ACTIONS_MARK}</div>`;

const TURN_DRAFT_RESPONSE = `<div class="me">Draft a response to Q433 from the documents.</div>
<div class="ai"><p>Drafted from the grid operator’s letter and the connection agreement. The draft is on Q433`
  + ` for review and is not sent until it is accepted.</p>${ACTIONS_MARK}</div>`;

const TURN_RECHECK = `<div class="me">Two new files arrived in 04 Legal. Check them against the checklist.</div>
<div class="ai"><p>Checking the checklist and findings against the 2 new files.`
  + ` The report updates as each item is checked.</p>
${taskCard('cklist', 'Diligence', '1,204 of 2,148', 0.56)}</div>`;

/** Puts the answer actions in place of the last mark only; earlier marks stay as empty comments. */
function withLastAnswerActions(html) {
  const index = html.lastIndexOf(ACTIONS_MARK);
  if (index < 0) return html;
  return html.slice(0, index) + ANSWER_ACTIONS + html.slice(index + ACTIONS_MARK.length);
}

/** A conversation of the given turns, with its header and composer. Options go to the header. */
function conversation(turns, options = {}) {
  const scrollClass = `x-scroll ${options.top ? 'x-top' : ''}`;
  return `<section class="x-conv">${conversationHeader(options.title, options)}<div class="${scrollClass}">`
    + `<div class="x-col"><div class="msgs">${withLastAnswerActions(turns.join(''))}</div></div></div>
  <div class="x-composer">${composer('Ask a follow-up…')}</div></section>`;
}
