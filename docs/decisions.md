# Decisions

This file lists the product decisions and standing rules in force. Each entry is one or two lines and cites the issue or pull request that holds its background; an entry that cites neither predates this file. [architecture.md](architecture.md) describes how the app does each thing, [design.md](design.md) describes how it looks, and the code and tests are the detailed specification.

To change a decision, replace its line; don't add history. See "Documentation and decisions" in [CLAUDE.md](../CLAUDE.md).

Many entries refer to the control file, `src/control.ts`, where a deployment sets the app's name, model service, and settings.

## Look and feel

- The app is glass, not flat, and every mock-up starts from glass. There is no generic AI look and there are no thin full-height lines on a left edge.
- The app uses one typeface, the computer's own interface font (Segoe UI on Windows), and sets headings apart by weight. It never uses Inter, Geist, or a display serif; the check is in design.md, under Type.
- Popups (dialogs, menus, popovers, search results, and the connection card) are glass, a little denser than the panes, over a backdrop. Behind a dialog the page is dimmed and blurred; behind a menu it is left as it is. The recipe is in design.md, under Popup glass.
- A click on the backdrop closes a menu but never a dialog. Search results and hover popups don't dim the page; the
  connection bar and tooltips stay solid; notices use popup glass.
- The app has dark and light themes. Every color is derived from three base colors in the control file (`colors.neutral`, `colors.accent`, and `colors.red`) and written nowhere else; icons use the text color. There is no amber, no green, and no separate AI blue, and the build stops when text would fall below WCAG AA contrast.
- Both themes are black and white: the accent is a gray of the neutral, light in dark and graphite in light. `colors.accent` colors only the highlight and mark on a document page (#873).
- Supported window sizes run from 1024×640 to 1536×864. Phone-sized windows and 400% zoom layouts are out of scope; ultrawide monitors are to be considered later, once everything else is settled (#5).
- There is no all-capitals text. Labels, column heads, buttons, menu items, value capsules, and dialog titles that aren't questions use Apple's title style; sentences, tooltips, body text, and meta lines stay in sentence case (see design.md, under Type).
- A heading has one row of controls under it, never two. A header that runs short of space drops words first, then turns buttons into icons.
- Controls that are clicked repeatedly keep a fixed width and position. Icon buttons sit centered with no padding; small ones are 28×28.
- Home's ask box, a deal page's ask box, and a conversation's composer are one composer, with the same sizes and controls, **Attach** included. It grows to seven full lines and then scrolls; the conversation ends 34px above it, and what was in view stays in view.
- In reading mode, the pane and composer use 22px glass. The thread keeps its place from the end when the composer
  resizes, and the pane shadow fades into the surrounding gaps (#437, #438, #442).
- Dropdown menus are sorted A to Z as a person reads them, with "No…", "None", and "— not in file —" last, and "All …" or an unset prompt first. Menus with an order of their own (statuses, priority, Deal status, model tiers, and a file's sheets and columns) keep that order, as do lists that aren't dropdowns.
- Everything works by keyboard alone. Escape closes; focus returns to whatever opened a dialog; Ctrl Z does what the visible notice's **Undo** does.
- There is no explainer or helper text on screen; explanations go in tooltips.
- Screen text never names a vendor. The service is called "Intelligence" (`names.service`) and model-written text is marked "AI" (`names.aiContent`); both names come from the control file.

## Pages and navigation

- Home is the ask composer alone ("Ask across your deals…"), with no deal list, count, or dashboard cards.
- The sidebar lists deals only, grouped by Deal status (Live, Monitoring, Pitch, and Closed; the Pitch group is headed "Pitches"). Groups fold and stay folded, and a group appears once it has a deal.
- Search is one field in the sidebar (Ctrl K). Its results are grouped as Deals, Findings, Checklist Items, Questions, and Documents, and an item opens on its deal's Checklist (#2).
- A Search question keeps the current deal's Q&A filters. From Home or a different deal it opens with All (#497).
- Choosing an open Checklist item in Search reveals its row again (#496).
- Keyboard selection in Search moves focus to the opened question or Checklist row (#498).
  When a question closes and its row is hidden by the active filter, focus returns to the Q&A filters.
- Search shows “No matches.” once it finishes reading My Deals and finds no results (#491).
- Search keeps the highlighted result when more records arrive, while that result is still listed (#501).
- A deal's pages are Overview, Findings, Checklist, and Q&A; **Settings** → **Deals Open On** picks which page opens first (Overview by default). No new tabs are added.
- The deal header holds Deal status and one ⋯ menu with **Check Again** (showing "Last checked [date]"), **Deal Memo…**, **Rename**, and, set apart, **Delete Deal…**.
- The counterparty sits alone at the top right of every deal page. Structure, Sector, and Technology appear on Overview only.
- Overview shows Findings, Checklist, and Q&A side by side. Each has a heading with "N in all" and one bar in up to three parts (open in red, in progress in the accent color, and done in gray), each part named on a leader line. Below them are Gaps in the Documents and Documents. There is no AI summary and there are no big numbers.
- Each heading and figure on Overview opens its page filtered to what it counts. The open part of the Checklist bar is "to resolve" (flagged items, gaps, and "finding deleted"); "not settled" is shown separately. Words that don't fit move to the part's hover text.
- Documents on Overview shows each folder's "N of M read", one Core documents row, and up to two deals, shown as "Also in Project X", that hold most of this deal's documents.
- The Findings page has **New Finding** as its one button and a ⋯ menu with **Import…**, **Export…**, and **Deleted…**; its filter menu holds Workstream and Reviewed. The list doesn't mark who raised a finding. It is grouped by workstream (A to Z, with "No workstream" last), and open findings marked "May be out of date" come first in each group.
- Finding and question pages use the slim rail (the sidebar folded to icons) and the queue strip.
- "Project " is added in front of a deal name that lacks it. A name that starts with that word in any capitalization, followed by anything other than a letter, accent, or digit, has the word rewritten as "Project" and the rest kept as typed; misspellings are not corrected. A deal's name keeps its spaces as typed; only the spaces at its ends go, and matching a name (a duplicate, the name typed to delete a deal) ignores how many spaces lie between words. Deals may share a name; they are told apart by counterparty, then by creation date, in the sidebar, Add Deal, search, and the confirmations and notices that name a deal, as "Project Kestrel (Wingtip)" (#27).
- Search and the sidebar keep the distinguishing words in shortened counterparty labels (#492).
  An ellipsis marks a shortened suffix after those words (#791).
  Search keeps the meaningful name after “Project” and the full question number or page range (#495).
- Search ellipsizes an oversized single counterparty word (#494) and keeps the start of right-to-left deal names (#490).
- Search uses the usual separator spacing after an ellipsized single-word counterparty (#790).
- The New Deal form has Name and Counterparty; Structure, Sector, and Technology pick lists; and Folders. × closes it, and there is no Cancel. **Create** stays unavailable until there is a name.
- Before a new deal is made, a duplicate check asks "Is this Project X?" when the folders' files, or the name and counterparty, match a team deal; nothing is refused.
- The folders hold a deal's data room when every document of the deal has a file among them with the same name (in any case) and size, and the smallest of those files is identical by content. Files in a precedents folder, and files attached in the app, are not counted. (#1018)
- Each deal has a Deleted list for findings and questions, showing who deleted each and when, with **Restore**. A deleted record reached by a link says so and offers **Restore**; a question being typed on a deleted finding's page stays there, with **Log Question** off (#340). A deleted question's number is never reused. An imported issues list can be removed from the Deleted list. **Remove** asks first, naming the findings it deletes, the marks it takes off, and the findings it keeps; the removal applies only to that list as approved, so any change to the deal's findings or marks since refuses it and asks again (#410).
- Notices stack, up to three at the top of the page, for 8 seconds each (paused on hover or focus), each with its own **Undo**, and only on the PC that acted.
- Unseen changes that another PC made to a deal deleted elsewhere are kept on that PC as "Project X (recovered)", with a notice that stays until closed and says who deleted the original; keeping or deleting the copy is that person's call. Details still open are in GitHub Issues.
- A record changed on two PCs, or deleted on one and changed on another, shows design B: the person picks a version, then confirms, and until then the record takes no edits. One record in two versions never blocks the others.
- A finding put back from Deleted on two PCs from the same deletion, then changed or deleted on one, stays as that PC has it, with nothing to choose (#401).
- A question's draft never conflicts with a person's change on another PC; both are kept. Two crossing drafts, or a delete alongside a draft, still require a choice.
- Settings (720px wide) has Account, Appearance, Deals Open On, Checklist, Default Model, and Keyboard, plus, in the desktop app, the Punchlist folder and Intelligence sign-in, with the app's version in the header. There is no Firm field, because the firm's name comes from the control file, and there are no job titles.
- Each thing has one name: "counterparty"; "finding" (not "issue"); "Deal status"; "Changed elsewhere", with **Keep Mine** and **Take Theirs**; "Q&A" for the page and "Q&A log" for the spreadsheet; "Remove" to take something off a list and "Delete" for a record; and "Data room" and "Folders". The app says **Retry Now** where it already retries and **Retry** elsewhere. An interrupted or undone action is named by its button. "Blocker" simply means something flagged. The duplicate confirmation says **Create Anyway**.
- To add deals, the sidebar's + opens **Add Deal**, whose button is **New Deal**; each deal listed there offers **Add** (tooltip "Add to my deals") or shows "In your deals". A sidebar deal's ⋯ menu offers **Remove from My Deals**, which asks first and has **Undo**.

## Q&A

- Every question follows one path: answer it from what the firm already has, then send what can't be resolved to the counterparty. A question created in the app is submitted by the firm.
- An open question appears in a panel at the top of the Q&A page, above the full table (design G).
- The panel header shows the number, the status, and the details as plain gray words with their icons, followed by the position, previous and next, **Delete**, **Discuss**, and **Close**, so that Delete is never next to Close. Details that don't fit go onto lines below it, at every window size.
- The Question and Response labels are gray, so the text under each is read first; each column's text sits under its own label.
- While the response is empty, a waiting draft stands in its place, labeled "Draft Response"; beside a response or typed text, the draft appears under the box.
- The table has no Draft column; when there is no response, a draft appears in the Response cell after the AI mark.
- Responded By and its date appear beside the Response label when filled, and only on hover or focus when empty.
- Changes from the Q&A log are marked in the row with Changed, Two Versions, and **Resolve**. While any such rows exist, Changed and Two Versions are also filters. A row in two versions has a 3px stripe, and its Response cell says only "Two versions". A changed cell shows the log's icon, with the old value in its tooltip, until the question is opened (option A).
- **Resolve** shows the app's version and the log's version side by side, with **Keep Selected** and **Merge Both Versions** (which writes an AI draft; **Draft Again** redoes it). A choice belongs to its own question. The app's version, if not kept, goes to Deleted; the log's version stays in the archived file.
- A merged response typed or edited in **Resolve** whose question is resolved elsewhere moves to the question's response box, unsaved and marked Changed elsewhere, until **Keep Mine** or **Take Theirs**. Unsaved text already in the box stays first, with the merge after it; there is no dialog to choose between them. An untouched AI merge is dropped (#939).
- The workstream filter is a filter button that opens the app's own menu: "All workstreams", the workstreams from A to Z, and "No workstream".
- The table shows two lines of each response. **More** picks the columns shown (Responded By and Response Date start hidden), which never changes what Export or the log carries. Status is left out while every row shown has the same status. The page returns as it was left, per deal.
- Scrolling down tucks the deal's header row away, and scrolling up brings it back. Column heads stay in place (#593).
- Priority is hidden when empty. Every editable value is a glass capsule; the specification is in design.md, under Editable values.
- A partly typed date stays in its field, marked "Not saved: Enter a real date", and is never saved; it is discarded when the question closes or the app restarts.
- **Discuss** opens the conversation; "Q&A" in the breadcrumb returns to the page with the same question open.
- A draft's card has **Check**, which asks the AI whether the answer addresses the question and replies "Answers it.", "Partly answers it.", or "Doesn't answer it.", with its reason. **Check**, **Use as Response**, and ✕ sit at the card's bottom right.
- A ready draft has one action, **Use as Response**, which marks the question Answered (or leaves it Closed if it was closed in the meantime). Closing a question never discards a draft, and a typed response stays as typed.
- A draft that can't be saved is retried five times with backoff, then shows as failed, with its text kept for **Retry** (#22).
- **Draft from Documents** is offered on any open question without a draft; when it would replace typed text, it asks for confirmation on the button and offers **Undo**. **Draft All** drafts only questions with no response. An accepted draft records the firm as the responder.
- A used draft, or a response taken from a conversation, keeps its label and sources only until a person changes its words.
- Drafting quotes, word for word and with credit, a response already given to a similar question, then adds what the documents say. The model sees earlier responses and questions only by their permanent ids, never their numbers, so a calendar quarter such as Q3 2027 stays in a draft, and a sentence naming an earlier response's id is dropped with the source only it cited (#286, #1105).
- A typed response, or one taken from a conversation, doesn't change the status; a person marks the question Answered.
- Emptying a response is announced in a notice with **Undo**.
- A response on a question linked to a finding marks that finding; a response on an unlinked question is checked once against the open findings.
- Import finds the table and its columns by the app's own rules and asks the model only when no question column is found. Nothing is imported until the person clicks **Import**, and the whole import is one Undo.
- Q&A and checklist imports keep an unused heading row as typed and mark it “Not used.” The preview stays on the
  last accepted table until another sheet or heading row is read (#380).
- **Undo Last Import…** in the Q&A page's ⋯ menu takes back this PC's last import after a confirmation, with no Undo after it, and leaves alone questions changed since the import.
- A responder column is read as the response's author.
- On import, real date cells are read as dates and plain numbers are not. An ambiguous date is settled by the row's other date, its neighbors, and the rule that no date is in the future; otherwise it is left blank and listed.
- Marking imported questions that have a response as Answered is optional and off by default.
- Merge, its preview, and Update Q&A Log find each row's question with one lookup, like an XLOOKUP: the question with the same number, exact text and sender (Submitted by), else the one with the exact text and sender; a row or question naming no sender matches any sender, the same sender first; a row that matches neither is a new question. Text is compared as the file holds it (below). Update Q&A Log also finds a question's row by the sender it last wrote there. The preview's counts come only from the import's own plan (#1080). Nothing is matched by similar words, but the preview suggests, for such a row, a question with the same words apart from capitals, spacing and punctuation; it is used only once the person accepts it. A row that matches a deleted question brings it back. "Will overwrite" is shown field by field first.
- The same list imported on two PCs makes one set of questions, with ids derived from the deal, number, party, and wording.
- Two questions with the same number are both kept and marked; a person renumbers one. Undo, Restore, and a kept
  version's Restore bring a deleted question back under its own number, even when another question holds it (#13, #116).
- Export has no finding or link columns and always carries every column of the log.
- Excel's cell limit (32,767 characters) is the most any one text can hold. At the limit a text box's outline turns red, typing stops, and its tooltip says why; text a model returns that runs longer is cut at a sentence and ends with a visible note.
- No person in the app is named in a prompt, export, spreadsheet, or the memo. An accepted AI draft exports as "AI draft, accepted on" a date, and findings export the date reviewed but not the reviewer. Who responded from outside the firm is kept.
- Each deal has one consolidated Q&A log, in the team's own folder and format; the app keeps no copy and never gates it. One file is one deal's Q&A log: a file another deal already uses as its log can't be imported into a second deal (#38).
- An import can make a spreadsheet the deal's log ("Make this the deal's Q&A log", checked for a file with two or more parties). If there is no log, the first update creates one in the app's layout, in a folder a person picks. A later party's file only adds and updates questions and is never written to.
- Updates add no columns and never write to a formula cell. To reply to one party, use Export filtered by Submitted By.
- **Update Q&A Log** brings every column up to date and first saves the old version to the folder's archive; it never deletes anything else. A log open elsewhere is retried every 30 seconds for 20 minutes; the notice names who has it open only when the lock file does.
- An edit made in the log wins over the app's value, exactly as written: a cell is compared character for character, so a "?" stays a "?". Only the file's own storage (line breaks kept as one "\n", an .xlsx keeps control characters exactly, through Excel's own "_xHHHH_" codes (#1149), and other formats keep their own storage) is allowed for. Matching a row to a question only picks the row and never changes text. Where both changed, the question is in two versions.
- A Q&A log cell is written exactly as given, in every format; a CSV cell that starts with =, +, - or @ gets no added character (#1107).
- An edit saved to the log just before an update moved the log is merged in. Where its row is unclear, the person places it, and what can't be merged stays in the archive. "Not fully merged" comes first in the notice, which stays until dismissed.

## Findings

- Findings have no codes and are named by title everywhere; no id is ever cited.
- A finding's page has Reviewed, status, edit, and delete in fixed places, and no suggested questions under it.
- An open finding that the documents may have overtaken is marked "May be out of date", with its reason and **Update from Documents**. The app never rewrites a finding by itself.
- Attaching a document to a finding already marked "May be out of date" for another reason than a response keeps that reason (#327).
- An update that replaces the finding's words clears Reviewed and keeps the earlier text under "Previous version".
- There is no separate "look again" button: new documents, Check again, or the finding's conversation do that.
- A finding's stripe is red while the finding is open and gray once it is closed, whoever raised it; it is not colored by severity.
- A closed finding that new documents call into question gets a dot and **Reopen**. There is no Keep closed and no bulk action.
- The first pass (a deal's first check against the checklist) raises a finding on one citation that opens; an item raises at most one finding.
- A check matches a problem to a finding by its checklist item, never by its title; a reworded item is a new item.
- Every issue that an outside advisor raises in a report in the data room is a finding, whether or not a checklist item covers it. An information memorandum is not swept for issues, and a note on the limits of the advisor's own work is not an issue.
- Title, workstream, and detail stay editable; a finding has no next step. The fast model fills in the
  workstream from the firm's list only, or leaves it blank.
- The workstreams are Technical, Legal, Commercial, Financial, Structure, Insurance, Tax, Regulatory & permits, Real estate, HR & benefits, IT & cyber, Antitrust & FDI, Compliance, and Environmental & social. A firm can set its own in `firm.workstreams`, and a record keeps a workstream that was taken off the list.
- An issues list (PDF, Word, or email) imports into Findings. Each point joins an existing finding it repeats, or becomes a new finding titled with the point's own words; points are compared with open and closed findings and shown under **Already Raised** (each with **Keep separate**) and **New Findings** before **Import**.
- A finding's page shows the checklist item that raised it, the questions asked about the finding or its item, and **Ask the Counterparty** while the finding is open and its item is turned on. The question is linked to both and takes the finding's workstream (#2).
- A file attached on a finding goes with the next message only, and joins the finding's sources through **Add to Sources**.
- Every source of a finding is within reach, listed by document with its places. A hover lists up to four documents; a longer list opens under the detail (flow A).

## Checklist

- Overview and Checklist count turned-off and not-yet-checked items the same way through one selector (#830).
- An abandoned first pass over fewer documents than the deal now holds is finished like any left round,
  not started afresh.
- The master checklist has four layers: general, structure, sector, and technology. There is always a general list.
- The Checklist page is a list grouped by list, section, and subsection, with the open item in a pane beside it and a
  filter for each status. The filters sit on the line of the list's first heading, with no label beside them; the
  seldom-used ones move into a menu when the row runs short of space.
- With no lists, the **Firm’s Checklist** dialog shows one 160px drop area, "Drop a checklist here, or choose a file…"; an import under way reopens as it was left.
- A deal has no "Add an item": the checklist stays based on the master checklist.
- **Turn Off Item** is in an item's ⋯ menu; a turned-off item stays in place, dimmed.
- A list can be pasted in or imported from any clearly laid-out file. The model reads it, every line is accounted for,
  and lines left out are listed with a checkbox to bring them in. A line brought in comes in exactly as written, its
  bullet or number included; every item's wording is kept exactly as the file gives it, and a line the model reads is
  stored as the line is written (its edge spaces aside), never as the model words it. Here accuracy comes before cost:
  the standard model reads the whole list in one call and names each line's kind by its number, and for a table the
  columns that hold the item, section and subsection, and the headings of section and subsection rows; when lines are
  left unplaced, the thorough model reads the whole list again and fills only those lines; a table is read by the
  first reading's columns, or by the thorough reading's when the first named none, and a line those columns cannot
  place stays listed. A cell's own text is never shortened, even where it holds " | ". A list the service refuses as
  too long, or answers with a reply cut off, is read in halves, down to one line (#1073).
- An item that joins two conditions becomes two items, and "(if applicable)" goes only on an item that may not apply to every deal.
- Findings is the worklist and the Checklist is the coverage record; nothing is opened or closed on the Checklist.
- An opened gap says what is needed and which documents were read, naming any that couldn't be read.
- A document opened from the Checklist opens in reading mode and returns to the same item.
- A "Satisfied" result should cite a source that opens. A result the model can't place should be left not settled,
  as should one whose documents have all left the deal. Citation enforcement when tiers share a model is tracked
  in #43.
- A question can be linked to a checklist item, and **Add All Unresolved to Q&A…** offers one for each gap or open finding that has none. Closing settled questions is offered (**Close This Question**) but never done by the app (#2).
- An item that is no longer in the current master checklist lists gets an icon, for information only (#2).
- Linking the Checklist, Findings, and Q&A follows docs/linking-design.md, which covers only what is not yet built (#2). The next step is letting a person mark a gap resolved, with its source and with Undo. The rest waits until it is requested.
- Each list in the master checklist is its own shared record. Bringing a list in adds its items to every deal that uses it and is not marked Closed. A deal's items are append-only; swapping a list asks first when items would be turned off.
- The Wording heading checkbox selects or clears every available suggestion, and each row keeps its own checkbox (#377).
- A rewording accepted when a list was brought in is offered again the next time.
- **Choose Columns** preselects a column only when its heading is a known name; otherwise the person picks it (#1018).
- In an open checklist import, a review that needs the model waits for a pending review request. The Duplicates line
  and footer show the latest retry failure, and a partial check keeps its pairs and checked removals (#378).
- **Add All Unresolved to Q&A…** keeps a chosen link with its exact question and point, and writes it only if both are unchanged at commit (#88).
- **Add All Unresolved to Q&A…** sizes its calls to the model's limits and retries quietly; whatever still fails is offered for Retry.
- Names of structures, sectors, and technologies stay at about 24 characters or fewer.

## Conversations

- Home asks “What would you like to know?” and shows example questions in its composer (#654).
- No conversation shows sample questions above its composer.
- Each question asked from an ask box starts a new conversation; follow-ups continue it.
- The composer takes no typed-word commands: everything typed is asked of the AI. A one-line box that starts with "/" offers `/add-unresolved` (**Add All Unresolved to Q&A…**), `/log-question` (**Log Question**), and `/new-deal` (**New Deal…**), the first two on a deal, and what follows the "/" narrows them. The AI can offer one of them, or opening a deal's page, as a button under its answer; nothing runs until a person presses it (#1054).
- Every chat shows AI text the same way: a finding's or question's text at the answer's size, with its sources as the answer's chips above it. The send button is a paper airplane pointing to the top right. Screen text says "AI", never "the model".
- A deal page's ask box is the conversation composer in place: it is one line at rest and pushes the page down when used (option A).
- **Past Conversations** in every composer opens a searchable list, set to This Deal or All Deals.
- A **Log Question** that can't be saved goes back at the head of its box with the chip on, ahead of anything typed while it was saving, with a blank line between; sending the box then logs that question alone and leaves the rest in the box. One the app keeps to retry stays with **Retry** instead (#955).
- There is no Conversations tab.
- One run of the chat agent, in a chat or in the checks' gap search, takes up to `limits.chatTurns` (25) turns, and one
  search run up to `limits.searchCalls` (15) calls. Both are inputs in the control file (`src/control.ts`) and are the
  only stops on a check's calls; its cost per deal is not otherwise bounded (#1066).
- Conversations are kept per person in the shared folder and follow the person between PCs. In the app, each person sees only their own; the files are readable by anyone with access to the folder, and no encryption is planned.
- Answers cite sources sentence by sentence with a dotted underline, without numbered markers (#636). While a finding is being edited, each citation shows as a tag of at most 30 characters after its sentence (#636). An answer can become a finding, a question, or a response.
- Cited phrases show the pointer cursor when they open a source. Hover-only citations keep the default cursor (#440).
- Source chips keep the cited location and tags whole. The name shortens to fit and appears in full on hover (#441).
- Chat is an agent with search, read, folder, and brief tools. Its answer may offer one action, which the app checks against the deals and the conversation before it shows the button, and checks that its deal still exists when it is pressed. A deal the answer names must be in the person's own list, by its exact name, which no other deal there has (#1054). The brief tool catches up on a deal with the deal brief, two AI paragraphs on its open findings (#1017). A folder read always covers the whole folder; reading more than `limits.folderDocs` documents asks first, and **Stop** answers from what was found.
- While chat works, it shows "Researching" with the full trace; once it has answered, it shows "Researched · N steps · N of M documents searched · time", never "read" (option D).
- Tool calls run inline by default; the hybrid and native modes are set by `models.toolCalls`.
- The chat's search gives its results a page at a time, ranked by one keyword scoring (BM25): documents `limits.docsPerCall` a page from the ranking, findings and Q&A `limits.searchPage` a page, or fewer when that many would hold more than half of what the kept conversation holds before it is compacted, each record whole and each Q&A row in full. The model asks for any page (#1102, #1091).
- A question asked across deals reaches only the person's own deals.
- A chat is one conversation on the model service; past its limit, it is compacted into an uploaded transcript.
- Each PC keeps its own word index of the data room; nothing is added to the shared folder.
- Documents open in reading mode beside the conversation, with page keys and zoom.
- Switching PDFs opens the cited page at the top and keeps the zoom (#447).
- In the browser demo, a PDF without a preview shows its title, page number, and a preview status (#443).
- Decided but not built: plain-symbol math, a named finding opening in a side pane, and answer actions as icons.
- A card under an answer suggests each open question the model proposes it addresses; every part's named question is
  kept and shown, each usable on its own, and only a person uses one (#1120).

## Deal memo

- The deal memo is a templated memo of Findings, Checklist, and Q&A: a one-page summary, the memo itself from page two, and an appendix.
- The memo's first-page checklist counts match Overview's, with turned-off items as "N turned off" (#1064).
- Risk at a glance ranks workstreams by weighted risk (High 9, Medium 3, Low 1), in at most 12 rows.
- Key risks lists every High risk, then the oldest Medium risks up to `memo.keyRisks`, A to Z within each severity.
- The memo keeps usable risk groups when other entries in the model's reply are malformed.
  Each open finding has one risk, on its own if the model left it out (#658).
- The memo limits a key risk write-up to two paragraphs and 200 words. If retries yield no usable write-up,
  it uses the findings' own cited words (#659).
- The memo reports facts only: no recommendation, mitigants, next steps, or judging words.
- A memo whose one-page summary can't be written fails with Retry and is not saved (#1065).
- **Deal Memo…** in the deal header's ⋯ menu asks where to save (Word or PDF), then makes the memo; there is no review step.
- The memo has no text in capitals, headings included.
- Risks are rated High, Medium, or Low, only in the memo, by the model against the control file's definitions. A finding keeps its rating until the finding changes, so two memos agree. The memo carries no AI mark, only one disclaimer at the end. High prints in red; Medium and Low print in the text color.
- When ratings are unresolved, the memo asks the model to say so and describe risks from the evidence. The first-page
  counts show the ratings and the number of unrated open findings (#661).
- The memo currently uses a built-in plain template; custom Word templates are planned. The memo is for internal use only.

## Documents and indexing

- A folder can be removed from a deal after a confirmation, with Undo, and restored later; new checks stop reading it, and existing citations still open.
- Punchlist reads linked data-room files in place. An empty folder is never taken as a deal folder. Each PC finds a deal's folders by itself where it can; otherwise it asks once, with **Locate…**.
- A document's id is the SHA-256 hash of its bytes, so identical copies are one document.
- The chat agent opens a document only by its tag, its whole path, or its whole file name (in any case); anything else is "Not found" (#1018).
- Indexing (building each PC's word index of the data room) asks no model and uploads nothing, and it resumes by itself once the data room is available again.
- A spreadsheet is read for its words whatever its size, after every other file; a .csv is read a piece at a time.
  One that cannot be read is named in the indexing log on every run and never recorded as having no text; it is read
  again by every later run and every 5-minute check of the folders (#427).
- Every cell of a spreadsheet is content, numbers and dates included, in its words and in the index (#1023).
- A successful read of a deal-folder document's words replaces a recorded empty word list for every PC (#1023).
- A deal whose word index file of the current version is missing has its folders read again at the next check, once
  (#1023).
- A PDF, or a document converted to one, any page of whose text cannot be read keeps its pages and is listed without
  words, named as not read on every run and read again by the next run and the next check of the folders, also after a
  restart; it is never recorded with no words or with only some pages' words (#1056).
- A deal's folders are checked for changes every 5 minutes.
- LibreOffice, bundled with the app, is the only document converter; a converted document that has tracked changes shows them as markup, and one with none is converted as it is.
- For tracked changes and blacklines, a Word file's own tracked changes are fact, and the clean draft is the source of truth for the deal's terms. A blackline is the model's reading: it never settles an item or closes a finding by itself. A control-file switch selects pipeline A (the default) or pipeline B. What a blackline was compared against is determined from its cover and name, never guessed (docs/other-project-documents-design.md).
- A blackline whose clean draft neither its cover nor its name finds stands alone and is read on its own; a file that only shares a word of its name never makes it unclear (#1018).
- An "A vs B" blackline pairs only when both names share their first index word: numbers and short tokens count, filler words and plural endings follow the index split, and names with no index word share none (#1224).
- A deleted or replaced document leaves the deal under the rules in architecture.md; nothing linked to it is deleted (#413).
- A folder that this person may not open doesn't stop indexing, and a check that couldn't read it says "Not complete".
- The app never deletes documents. Drafts of one agreement form a family: the newest is read first, and reading mode shows a draft's date and lists its family's drafts, any two of which can be compared. Versions in one folder count only with an explicit mark such as v3 or Rev A.
- A document-page error and its **Retry** use the paper text color. **Retry** is always underlined (#439).
- "Read" means given to the model in a check that came to a result.
- Core documents are worked out on each PC without a model; see docs/core-documents-design.md.
- When an agreement is core, its whole family is core too: schedules, exhibits, annexes, amendments, side letters, signature pages, and change orders, identified from names and paths only; see docs/core-families-design.md.
- Synonyms and abbreviations come from a library in the control file (`lists.synonyms`).
- Only documents that are read get a description, which is tried at most three times.
- Each call carries at most `limits.docsPerCall` documents (default 8, range 1 to 20).
- The app keeps at most 500 of its own files per person in the model service's file store and never touches other files.

## Storage and sharing between PCs

- For now, the app is designed around one person at a time on each deal, across any of their own PCs, syncing through
  a shared folder such as OneDrive. This is a design focus, not a restriction: new multi-person features wait for a
  coordination layer, such as a database backend, and nothing built now may block them (#834).
- Records are stored as change files in the team's shared folder, and each PC writes only its own. OneDrive
  provides automatic discovery and sync. The folder picker also accepts folders outside OneDrive (#111).
- A PC connects through the team folder's share link in the control file (`desktop.teamFolderLink`). On screen, the folder is called the "Punchlist folder", and its name defaults to Punchlist (`desktop.sharedFolder`).
- A deal shows for the people who created or added it; this organizes deals but doesn't restrict access. There are currently no per-deal walls and no encryption.
- When a record has changed on two PCs, both versions are kept and a person chooses; the app never picks.
- An import in progress (Q&A, an issues list, or the master checklist) is kept on its PC until it is done, replaced, or started over, so closing, reloading, or restarting loses nothing.
- The New Deal form is kept on its PC as it changes, folders still being read included, until the deal is created, so closing, reloading, or restarting loses nothing (#55, #113). Once Create is pressed, the form stays open until the deal is made or Create fails (#36).
- No design may lose or hide typed work. Every version not kept is listed under Deleted as "Superseded by" the person who chose, and can be restored.
- Text typed into a new finding (New finding or **Add as finding**) while **Create Finding** is saving goes to the finding made: its page opens in Edit with that text. A form that held only what was sent closes (#115).
- A form closed and opened again while its save is out shares one kept draft with it: the save settles that draft once when it lands, and the form on screen then closes only if nothing typed is kept, so the typing is in one place (#771).
- A save that lands after its deal was deleted elsewhere goes to the recovered copy, removed fields included, unless the copy changed those fields or the save left out a field it never saw; then it is refused. A save to a deleted deal's member, or after its recovered copy was deleted, is refused (#664, #222).
- A change that arrives before a change it builds on is held back without pausing the deal; one more than a day old is let go as a choice. A deal can't be deleted while such changes are on their way.
- The connection status card shows only when something is wrong. The avatar's dot is the accent color or red, and OneDrive being unavailable for 15 minutes produces one notice.
- A copied install is detected and stops writing. A build never changes a record written by a newer version.
- The app carries no compatibility code for builds or data from before its release; the schema version gate stays
  (#1119).
- A damaged undo journal (each PC's record of its actions, used for Undo and to recover interrupted work) is set aside, and its complete entries are still offered.
- **Discard** on an interrupted action asks first in the confirm dialog, naming the action (#1055).
- A deal's analysis is split between the PCs that have the deal open, in rounds (a round is one shared run of checks on the deal, split into pieces of work) that any PC can take over. A requested check that an abandoned round doesn't cover writes that round off.
- Two rounds of one kind open at once become the one with the lower id. A batch still running in the other counts
  for the kept round, unless a later check has begun (#795).
- The check line names who is working.
- A check waiting on the model service says so after 2 minutes and resumes by itself; a check waiting on a sign-in says that instead.
- Attachments are kept in the shared folder under their document's id. A file attached on Home is kept with the person's conversations.
- A deal's recovered copy keeps the deal's attached files, and files attached and not yet sent follow their conversation to the copy (#117).
- A message goes with all of its attached files or not at all: a file this PC can no longer send is named, its chip is marked, and nothing is sent (#671).
- A place, a folder name inside a folder, or an id that a shared record gives a document is used only if the file it
  makes stays inside its folder: the attachments folder, the deal folder as this PC has it (the deal's folder, or
  where it was located here, which is the root and is not checked further), a folder being compared, or the work
  folder. One that leads out of it is a file that is not there: it is not read, opened, listed, written, deleted or
  counted as a match (#1156).

## AI and models

- A model is used only for work that needs language understanding. Parsing, matching, numbering, dates and periods, sorting, counting, and formatting are done in code, including the selecting, matching, formatting, and checking around an AI feature's model call; a model sees questions and earlier responses by their permanent ids, never their numbers or other identifiers its prose could be confused with (#286, #1105).
- A model reply naming a question id it was not shown, or one that must name a question and names none, is a failed
  reply and is asked again (#1105).
- There are three tiers, Fast, Standard, and Thorough, named only by tier. The control file sets each tier's model and which ones people can pick. For automated checks, Thorough is a fallback
  after Standard fails twice.
- To manage cost, use the fast model for initial sorting and Standard for confirmation. Batch work to fit the
  service's limits and report items left unchecked.
- The first pass checks the documents against the checklist in batches; a run never stops to ask a person.
- Check again runs the fast model on everything, then the standard model to confirm what it flags and a sample of what passed, and offers **Check Again in Depth** when too much is overturned.
- Check again is always in the deal's ⋯ menu. On Overview, a Check again line shows only when a check is due (running, incomplete, or with items not yet checked), and offers **Check the N Left Out** when that applies. A check requested while the PC is out of sync starts once it is back in sync.
- The first pass and Check again search the word index item by item, and hand anything that would be a gap to the chat agent's search. A gap shows its search trail ("Searched for …").
- For new documents and responses, one fast call says what they affect, and only that is looked at.
- An unreadable reply is repaired or sent back once; a thin reply is sent back with what is wrong.
- Retryable model failures and empty replies are retried quietly, up to twice by default after 2 and 4 seconds.
  An unreachable service follows its own recovery path. Keep everything the person typed.
- A connector retries a busy or failing service up to twice, honoring Retry-After, before it reports the service
  unreachable (#1110).
- Every AI feature adapts to a reply that is cut off or a request that is too long, at limits the control file sets (#451 and #452 are still to do).
- A model reply may hold up to 32,000 tokens (`limits.outputTokens`): a temporary hold until real reply sizes are
  measured (#1079).
- For deal document analysis, send PDFs whole so the model can read the pages directly. Use extracted
  word counts to rank and select documents. Checklist import currently reads the PDF's text. Sending the original
  PDF for checklist import is planned (#118). If a service refuses a PDF as too large, the planned fallback is
  to send sections of up to 200 pages with a 10-page overlap (#119).
- The model service sits behind one connector interface, chosen by `models.service`.
- Intelligence sign-in is by API key or single sign-on, each turned on or off in the control file. Sign-in comes first; with nobody signed in, the app is read-only and keeps everything typed.
- North, custom model gateways, Azure OpenAI, Amazon Bedrock and Google Vertex AI offer single sign-on.
- A cloud service's saved sign-in holds while its service, address and sign-in fields stay the same; changing a model ID keeps everyone signed in (#1018).
- Live tests run through the Claude connector on Haiku 5.5 by default (with model routing only to test the full document pipeline), and only when asked for (`npm run e2e:live`, or `npm run ai:check` for one service).

## Testing and packaging

- For a release that needs a local ZIP, run the packaging command after the checks pass. It bundles the app,
  source, and docs without the model key.
- The standard checks use the real backend with stand-in model services. Run the opt-in live checks when requested.
- Two things are not to be checked: Windows High Contrast on Windows itself, and emoji in imported spreadsheets.
- Use test fixtures and stand-ins for routine verification.
- `npm run check:all` first proves LibreOffice converts a two-sheet workbook and then requires it: its LibreOffice
  tests fail rather than skip. A plain test run still skips them without LibreOffice (#85).
- The required GitHub checks (`check`, `desktop`, `desktop-windows`, and `browser (1)` to `browser (4)`) passing on a
  pull request's latest commit, with its adversarial review, gate its merge; a local `npm run check:all` is optional
  (#710, #718).
- Built work is shown with a short screen recording and single, distinctly named screenshots.
- Before building the installer, set the organization name, model provider, and other shared settings in
  `src/control.ts`. Each person signs in after installation.

## Working rules

[CLAUDE.md](../CLAUDE.md) covers how to work on the app: commits, checks, mock-ups, readable code, and asking before design decisions. Beyond it, these rules apply:

- The file is the source of truth. The app never changes, repairs, normalizes or reinterprets content handed to it; what it shows matches what the file's native app shows.
- Text a file holds or the model writes is stored, shown and written back as given, edge spaces and tabs included (#1215).
- That covers a model's answer, title, quote, reason, paragraphs, rewording, question wording and merged answer, a left-out line, a firm, a log's name and a file's name (#1215).
- A value a file gives is compared with the app's character for character: a name, a workstream, a response, a cell of a kept edit (#1215).
- A file response that differs from a drafted or quoted one only in spacing is stored as the file has it and keeps its origin and sources; other words make it a person's own, with none (#1215).
- A paragraph typed into a finding's detail is trimmed; the model's paragraphs beside it stay as written. A title, name or response typed in the app is trimmed, as are a lookup key, a structural token and the one-line text sent in a prompt (#1215).
- Keep friction low, with as few controls and steps as possible.
- The attribution check allows a `Co-authored-by` trailer naming exactly the repository's own coding-agent identity (set in `scripts/aiAttribution.mjs`) and refuses every other AI co-author trailer (#877).
- Never guess identities. Never cite finding codes.
- Deleting a finding or a question asks first ("Delete Q38?", with **Keep It** or **Delete**), as do removing a folder and a list swap that turns items off; each keeps its Undo.
- Close every gap as soon as it is found; fix confirmed Critical and Major issues rather than stopping to report them.
- Say how an ambiguous instruction is being read. Ask about a product decision before it is built.
- Each thing lives in one place: decisions here; bugs and Build list items (with their designs) as GitHub issues; review notes on pull requests; how the app works in the docs; the detailed contract in code comments and tests; and history in git. There are no Markdown review files or running logs.
- The README covers what the app is and does, screenshots of the real app, and how to install and use it; developer setup is in docs/development.md.
- A UI module names what it loads with a plain string and reads `import.meta` only as `import.meta.env`; the UI
  dependency check refuses any other import path, even one naming a UI module (#848).
- A field's input-method composition (active, held after a blur mid-candidate, and the wait after compositionend for a
  blur that Chromium fires after it) is screen state in `src/ui`, like focus; when a typed field saves is decided in
  `src/app` (#953, #997).
- A held field that receives composing input without a compositionstart stays held: its text shows Not saved until
  typing that is not composing in the focused field, Retry, or Take Theirs (#997).

## Deal screen

These decisions are for the rebuilt deal screen in [deal-screen-design.md](deal-screen-design.md) and are not built yet
(#881). Once built, they replace Deal status wherever it appears (Look and feel, Pages and navigation), **Past
Conversations** in every composer (Conversations), and **Keep It** in confirms (Working rules).
They also replace the deal header, Overview, the Findings page, and **Deals Open On** (Pages and navigation); the
Findings worklist beside the Checklist (Findings, Checklist); Overview's counts (Checklist); **Deal Memo…** in the ⋯
menu (Deal memo); and Check again's place and **Check the N Left Out** (Findings, AI and models).

- A deal shows its conversation on the left and, when opened, one pane on the right. The pane's tabs are Tasks, Diligence, and Q&A, always in that order, followed by any opened finding, document, or task, each with ×.
- The selected tab is 1.5 times as wide as each other tab, and the rest share the bar equally. A hairline separates unselected tabs, the selected tab sits raised, and tabs show no counts. An unselected tab too narrow for its name drops its icon before shortening the word. The Diligence tab uses the Checklist's icon.
- The sidebar folds to its slim rail while the pane is open and comes back when it closes. A sidebar pinned open stays, and the conversation narrows; the pane gives way only to keep the conversation at least 400px wide.
- The checklist is the starting point for diligence, and each item's result is a finding, whether satisfied, flagged,
  a gap, or not settled: the Diligence list and findings are one list, not two. A flagged result is closed on its
  finding (#888).
- A deal has no Deal status. The sidebar lists deals in one list, ordered by when the person last worked on each
  deal, and **Archive Deal** hides one.
- A deal's ⋯ menu offers **Archive Deal**, which asks first in the app's confirm dialog. Archived deals fold under **Archived**; a dot marks an archived deal whose data room changed, with its update line ("4 new files · 11:20 AM"). An archived deal's ⋯ menu offers **Unarchive Deal**.
- The conversation title in the breadcrumb is a button that opens the deal's past conversations. **Past Conversations** leaves the composer.
- The check of the data room against the checklist is called Diligence (**Run Diligence**, the Diligence tab), and the list of running and finished work is called Tasks. The Diligence tab shows the Checklist's own marks and groups.
- Tasks belong to the deal, not to a conversation: they keep running and stay in Tasks when the person switches conversations, and a task's result card stays in the conversation that started it (#875).
- Tasks are grouped as Needs Input, Running, and Completed. Each task is one row: an outline kind icon, its name, its count ("1,284 of 2,148" or "Step 3 of 5"), and, while it runs, a thin bar of the same width on every row. A round × stops it; a finished task opens from a round arrow. There are no time-remaining estimates (elapsed time may show), and an open-ended task's current file shows on hover.
- A task's card in the chat has a fixed width and the same bar, and opens the task with **Open**. A finished task keeps its reply box.
- Work in progress shows a small ring beside words naming the live step, never a spinner alone; on a tab, the ring sits beside the tab's name.
- An opened question sits in a card with its question, response, sources, links, and status, beside the conversation, never covering it. A draft response is marked with a **Draft** badge.
- A source document opens in the pane in reading mode's viewer, with page navigation and zoom and no passage highlighting.
- Confirm dialogs say **Cancel**, not **Keep It** (#867).
- The deal's name and counterparty in the breadcrumb are one button that opens **Deal Info**: name, counterparty,
  Structure, Sector, Technology, the folders line with **Edit**, and **Delete Deal**. **Deal Memo** is an icon button
  at the header's right (#888).
- Overview is retired: its counts are the Diligence and Q&A filters, its Documents list is in **Folders**, and
  indexing runs as a task (#888).
- **Run Diligence** sits at the end of the Diligence tab's filter row. Findings that no checklist item raised join
  the Diligence list under Flagged (#888).
- A deal opens on a new conversation, with the pane as the person last left it (#888).
- A question asked in a conversation is answered in that conversation, and anything it needs from the person is
  asked there. It appears in Tasks only once the person leaves the conversation while it runs, and stays there under
  Completed once it finishes. Diligence, imports, indexing, Deal Memo, and draft responses always run as tasks (#888).
- Needs Input holds drafts ready to review, items Diligence did not check ("N items not checked", **Run**), and
  questions left running that wait on the person ("Awaiting draft selection", **Answer**). Its buttons share one
  width (#888).
- Home's header holds **Past Conversations**, which lists every conversation with its deal's name (#888).
- Working on a deal means sending a message in it, starting a task on it, or changing its records, details, or
  folders. Archived lists deals whose data room changed first, newest change first, then the rest by when they were
  last worked on; a deal's dot and update line clear once it is opened. Archiving is kept on the person's own record
  of the deal (#888).
- Deleting a conversation, once allowed, leaves its tasks running, and its confirm says how many are running (#888).
- A conversation that receives a task's result moves to the top of Past Conversations, with a dot until it is
  opened (#888).
- Task steps, task notices, and status text are written in a neutral voice, with no first person (#888).

## Built, awaiting confirmation

These decisions are built and wait to be confirmed:

- In the Q&A panel, the response box and a draft each show up to four lines, then scroll.
- A draft that arrives while an empty response box has focus waits until the box loses focus.
- The Q&A toolbar gives way in steps when its filters don't fit (built with option A).
- Two versions and kept log edits share the update notice.
- Once two PCs' imports of one list have synced, the second PC's Undo of its import is refused.
- The recovered copy of a deal deleted elsewhere is built, including who sees it, what it holds, and its notice's wording (#220).
- Periodic records whose names differ only by a period are a series and take one place in the core set, their newest member's; every document stays searchable (docs/core-families-design.md).
- An issues list or an advisor report is read like the app's other documents: the model reads the whole file once and returns each issues-list point in the list's own words, never reworded, and each advisor-report issue with its place in the file. There is no paging and no stop rule (#1026).
- A document's word index and a search no longer drop a word or number for its length, and a Word file is indexed from
  its body and all its header, footer, footnote and endnote parts (#1025).
- The core set and a document's most-used words split text as the word index does and drop no word, letter or number
  for its length (#1147).
- The browser demo's word-comparing stand-ins use the words the search index keeps (one split, the control file's
  filler left out) and drop no word, letter or number for its length (#1220).
- A plain-text list (.txt, .text, .md) is read as a CSV file is: UTF-8, UTF-16 or Windows-1252, with or without a
  byte-order mark (#382).
