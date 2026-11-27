# Linking checklist items, findings, and questions: what is left to build

This design links a deal's checklist items to the findings and Q&A questions that bear on them, and lets a person record a decision on an item, backed by sources (#2).

This file covers only the parts that are not built yet. The built parts are described in [architecture.md](architecture.md) ("Checklist items and links") and [decisions.md](decisions.md) ("Checklist"). Section and item numbers stay fixed, because code and test comments cite them. When all of #2 is built, this file and every link to it are removed.

## 1. Decisions

2. **A decision on an item is a record of its own.**
3. **What resolves an item.** Either of these can resolve an item:
   - The check of the documents.
   - A person, who must give at least one source: a document (the page is optional), a Q&A response, or a short note.

   A person can also mark an item not resolved, giving a reason.
4. **A check never overwrites a person's decision.** When the latest check disagrees, "The latest check disagrees" shows as a note under the decision.
5. **A changed or withdrawn response** puts any item that rests on it back to "to resolve" until a person confirms the item.
<!-- A new list starts here so that Markdown shows items 7 and 8 with their own numbers. -->
7. **A check from a conversation** reads the documents a person names first, and never drops them. It reads them in addition to everything else it reads.
8. **New documents that arrive after a person resolved an item** leave the item open, marked "New documents since this was resolved". Reviews run only **on demand**: **Review them** on the item, or **Review all** on the Checklist page. A person can also confirm the item themselves.

## 2. Rules

1. Only a person changes a record's state. The app and the model only mark and propose: for example, the backend puts an `updated` mark, with a reason, on an open finding.
2. The app never overstates what has been read, checked, reviewed, or resolved.
3. Identities are never guessed. Wording is compared only for an exact match, after the normalization in section 5.
4. Each thing has one name. A finding is named by its title; its id is never cited.
5. Nothing is lost silently. Tombstones (deleted records kept so they can be restored), Undo, and a person's choice between two versions make sure of it.
6. Citations are shown on hover and open in reading mode on click.
7. Every PC shows the same thing in the same order, once it has the same files.

## 3. The shared notes, check, and room files

Built: a copied install is detected and stops writing, and a document deleted from a deal folder leaves the deal even if the PC that first read it is no longer used. The rest of this section is not built.

Each PC writes three kinds of file for each deal: `docs-<pc>-<deal>-<nnnn>.jsonl` (the app's notes on the deal's documents), `checks-<pc>-<deal>-<nnnn>.jsonl` (check results, called the check log), and `rooms-<pc>-<deal>-<nnnn>.jsonl` (sets of documents present, section 7). These files hold notes about the documents, not the documents themselves. Records themselves are shared through the separate per-PC change files (`src/backend/logRepository.ts`).

- **Identity by content:** a line is known by the sha-256 of its exact text (`key`).
  - The same line seen twice, in a file and a conflict copy, counts once.
  - Two different lines never count as one, whatever their writer or number.
  - Nothing counts line positions or numbers.
- **Segments, read incrementally:**
  - Each writer's file is split into numbered segments (`-0001`, `-0002`, …) of about 1 MB, as the change files are.
  - A reader keeps, per file, the size it has read, its parsed lines, and the hash of the last line it read. Before reading on, it checks that the bytes ending at that size are still that line. If they are not, or the file shrank, it reads the whole file again.
  - A writer checks its own file against its local copy, and restores it if needed, before each append and at every sync.
- **Conflict copies** (the extra copies the sync folder makes when two PCs change one file) are read like the main file, whatever they are called ("-COMPUTER", " (1)", " - Copy"), segment number included. This is built for the current, unsegmented file names, and must keep working once files are segmented.
- **Local backup and restore:**
  - A writer appends a line to its local copy **first**, then to the shared file. If the local write fails, the whole write is refused.
  - At every sync, a writer whose shared file has lost lines that its local copy holds puts them back.
  - Restored lines keep their content, so their identity, and duplicates count once.
- **A complete listing** (data-room folders only, never attachments): each indexing run that lists a folder completely writes `listed: { folder, ids }`, the ids it found there. A PC's sighting of a document counts only while its latest complete listing of that folder holds it. This way, a PC whose copy of the folder is behind cannot bring back a withdrawn document by listing an old copy.
- These files are never compacted or rewritten.

## 4. Master checklist lists

Built: one record per list, and everything in this section except the two points below.

- **Bringing in an older file** (judged by its date) asks first: "This list is older than the one <name> brought in on <date> · Bring it in anyway". The import does not pass the file's date yet.
- **After a person chooses between two versions of a list,** the screen names, deal by deal, the items that the set-aside version added and the chosen one does not hold. It offers to turn them off, with Undo, but only items that nobody has decided on or asked about. Each offered item starts checked, except an item that a person reworded at import or turned on again, which starts unchecked. Items it turns off get the same mark as items a list swap (picking another list for a deal's structure, sector, or technology) turns off (`offBySwap`), so a later bring-in that holds them turns them back on.

## 5. A deal's items

Built (see [architecture.md](architecture.md)): the item record, its wording, ids, and order; who adds items and when; turning items off and on (**Turn Off Item** and **Turn On**); the icon ("Other"); and **Add Them** ("On opening a deal"). Not built:

- **An addition writes only ids that have no record,** and names any existing item that is turned off: "2 of these are already on the checklist, turned off · Turn them on". One exception: a bring-in turns back on an item that a list swap or a choice between versions turned off (`offBySwap`, section 4). At present, only a swap sets that mark.
- **Re-creating an item is bookkeeping.** A PC whose copy of the deal is behind can add an item that another PC already holds (through a bring-in or **Add Them**), writing it afresh with no base version. In `Combined.state`, such a version folds into a concurrent head when its content equals the content the item was first created with, so it never puts a person's turning the item off into two versions (#19). At present, a write with no base never folds (`bookkeepingGivesWay`).
- **Undo of an addition turns off** only the items that this operation created and that nothing else also created (a twin created on another PC keeps the item on; Undo finds it among the record's tips). It skips, and names, any item that has a decision, a question, or a finding.
- **`onBy`:** every write of `off`, including its Undo, sets `onBy` to a fresh token: the id of that operation. An old token is never used again.
- Turning an item on asks the backend to check it.
- Each check line carries the `onBy` it was made under. A row counts only the lines whose `onBy` is among the item's present ones. If there are none, the row reads "Turned on again · not checked since" and counts as Not checked.
- **Decisions and questions on an item that is off:**
  - No decision is offered on an item that is off.
  - A decision or question written on another PC before the turn-off reached that PC stays on its item.
  - The item stays listed in its place, dimmed and marked "Turned off", and under the **Turned Off** filter, with its decisions and questions shown ("Decided by <name>, <date>"), the same on every PC.

## 6. Links between items, questions, and findings

Built: a question's item (`linkedItem`); a finding's item (`itemId`); matching a finding by its item, never by its title; treating a reworded item as a new item; and **Flagged**. Not built:

- **Ask for another item…** moves a question's link to an item the person picks by name, with Undo. It lets an answered question serve the reworded item that replaced its own.
- **An item with a finding is not checked into another.** Once an item's check line names a finding, live or deleted, the first pass and **Check Again** leave the item alone; a closed one is looked at only as a closed finding.
- **When the item's own line is missing** (its finding was written by another PC mid-run, or the app stopped between writing the finding and the line), the finding raised on the item decides what happens:
  - **Open** (or in two versions): the finding is named, and nothing new is raised (`finding: <id>`).
  - **Closed:** a closed finding never takes a new problem. A new finding is raised, naming the earlier one: "Raised before as "<title>", closed by <name> on <date>".
  - **Deleted**: a person said it is not a finding, so none is raised again.
- **A gap that becomes a finding:** the responses to questions asked for the finding's item are given to Reassess. At present, Reassess is given only the finding's own questions.

## 7. The decision (kind `decision`)

```
Decision {
  id         'g_' + itemId
  dealId, itemId
  verdict    'resolved' | 'not'
  sources    for 'resolved', one or more, kept sorted (kind, then docId or questionId, then loc):
               { kind: 'doc', docId, loc?, quote? }  |  { kind: 'response', questionId }  |  { kind: 'note', text }
  reason     for 'not'
  responses  { [questionId]: text }   the linked and cited questions' responses, normalized, as the form showed them
  confirmed  n                         raised by every Still resolved: one more than the highest in the record's history
  episode    n                         raised each time the decision becomes 'resolved' from nothing or from 'not': one more than the highest in its history
  -- bookkeeping --
  room       the hash of the set of documents present, as the form showed it (below)
  saw        [lineKey]                 every "may change" line shown and confirmed in this episode: the previous version's saw plus what this form listed
  rev, createdAt, updatedAt
}
```

- **`room`:**
  - The sha-256 of the sorted ids of the documents present when the form was drawn. A document is present when it is located and not gone, judged by the sightings of section 3.
  - The set itself is written once per deal and distinct set, as a line `room: { hash, ids }` in the writer's rooms file, under the rules of section 3. Equal sets are stored once.
  - For a deal with 2,000 documents and 50 deliveries, the sets come to about 3 MB in all, written once, not once per decision.
  - "Present when decided" means membership of that set. It does not depend on line positions, rollbacks, or copied installs. A document that was gone then and is present now is new.
  - A decision whose room line has not reached this PC reads "Waiting for this decision's documents to reach this PC" and counts as to resolve.
- **The fingerprint** is the first 16 hex digits of the sha-256 of `content()`, leaving out the bookkeeping fields. `confirmed` and `episode` are content, not bookkeeping.
- **Equal versions** are merged in `Combined.state`, by a per-kind function in `versions.ts`, so the app and the backend read the same thing:
  - `room`: the version whose set is smaller or not a superset (the cautious side, where more documents are new). When neither set holds the other, the first PC that needs it writes the intersection as a new room line.
  - `saw`: the intersection.
- **Keep my decision** is not stored on the decision. It writes a `kept: { item, line }` line in the check log, which every PC reads and which never clashes with an edit of the decision.
- **Writing a decision** removes any tombstone with its id in the same write. The **Deleted** page does not list a decision tombstone whose id is live.
- **Equal creates are not merged.** A late identical create from a third PC stands beside a later edit as two versions, and a person chooses between them. Otherwise a Clear or an Undo made before the twin arrived would wipe that twin without notice.

### Comparing responses

- Whitespace is trimmed and collapsed. Any other change counts.
- When a response is taken from a draft or a conversation, its provenance keeps `aiText: sha-256(norm(text))`. The response becomes a person's (`origin: 'human'`) only once its normalized text differs from that.

## 8. Who may decide

A person decides on an item in these ways:

- **Mark resolved** needs at least one source:
  - **A document,** picked by name, with its folder shown so that two files with the same name can be told apart. The page or cell and a quote are optional.
  - **A response,** picked from the deal's questions by number and first words, with the item's linked questions first. The question must have a response and must not be closed internally, and the response must be a person's (section 7). Picking it does not change the question's link.
  - **A note,** typed by the person.
  - **Use this place**, offered with a result from a check or a conversation, fills in a document source.
- **Mark not resolved** requires a reason.
- **Clear my decision** removes the decision.
- **None of these is offered** on an item that is off, or on a row that is Flagged with an open finding.
- **Every form carries the reading it was drawn from:**
  - The decision's fingerprint
  - `room`
  - The responses it showed
  - The doubt lines it listed

  `checklist()` returns that reading with each row. The first **Mark resolved** on a row with no decision takes the reading from the row.
- **The command writes that reading,** not the files as they are when the button is pressed:
  - **If the decision changed while the form was open** (its fingerprint differs), the write is refused: "<name> changed this decision while you had it open". The form then shows the new decision.
  - **If a response changed while the form was open,** the write is refused in the same way.
  - **If documents arrived while the form was open,** the command writes anyway and says "1 more document arrived while this was open", and those documents stay new.
- **A new version that is not a Still resolved** (another source, **Cite another place**, or **Use this place**) keeps the previous `room`, widened only by the documents covered by "no change" lines for the previous fingerprint. Documents that are pending or doubted stay new.

## 9. The check log's lines for an item

- **Every line about an item records `after`:** the keys of all the item's present lines its writer had read (every line that no other line it had read was after).
- **The present lines** of an item are the lines no other line is after, as with versions in the change log.
  - One present line: that is the item's result.
  - Several, from PCs that had not read each other, with the same result: that result.
  - With different results: "Checks on two PCs disagree", read as the most cautious (section 10, step 7, or a note under a decision).
- **Check lines** also carry the decision fingerprints and the `onBy` the checking PC had.
- **Nothing is ordered by line number or clock.** `n` stays only for lines written before this design is built, and those lines are read as they are now.

## 10. What an item shows (first match wins)

1. **Not loaded:** nothing is shown until all of these are loaded:
   - Items, decisions, questions, findings, and tombstones
   - The list from the master checklist
   - The deal's `checklist()` result

   For each decided row, that result gives the fingerprint it read, its new documents, the state of each document source, the doubts, and the conversation results, all from one reading of the files. It is refreshed after every decision write.
2. **Flagged** (built): an open finding, or one in two versions, names the item (section 6). The finding shows, whatever the decision; a decision is shown beneath it ("Your decision of <date> stands beside the open finding "<title>"").
3. **Two versions** of the item, its decision, a linked question, or a question cited as a source: "Two versions of … · Choose".
4. **A `resolved` decision that holds** (10.1): "Resolved by <name>, <date>", with its sources. The row also shows:
   - "Reviewed against <documents> on <date>: no change (AI)", when those documents were reviewed.
   - A note when a present check line carrying this fingerprint found the item not met and a document is cited: "The latest check disagrees: on <date> it did not find this met: <need>", with **Keep my decision** (which writes a `kept` line, section 7) and **Clear my decision**. A check line that has a `kept` line is not shown again.
5. **A `resolved` decision that does not hold:** "Needs a look", with every reason that applies, by name:
   - A cited document has left the data room
   - Waiting for <document> to reach this PC
   - The response on Q38 was withdrawn, or has changed, or Q38 was deleted
   - A response has come in, or changed, on Q41
   - New documents since this was resolved: <names> · **Review them**
   - A review found <document> may change this: <why> (10.1)
   - Waiting for this decision's documents to reach this PC (section 7)

   It offers these actions:
   - **Still resolved** lists every document, doubt, and response it confirms, and writes `confirmed + 1`, the form's `room` and responses, and `saw` = the previous `saw` plus the doubts it listed.
   - **Mark resolved** with another source.
   - **Mark not resolved**.
   - **Ask the Counterparty**.
   - **Cite another place**, when a cited document has gone.
6. **A `not` decision:** "Not resolved · <reason> · <name>, <date>". Two further things can show:
   - A response that came in or changed on a linked question, with its **Mark resolved**.
   - A note when a check line carrying this fingerprint found the item met: "The latest check disagrees: it found this met", with its places, **Use this place**, and **Keep my decision**.
7. **No decision** (built, except `onBy`, "Turned on again", and checks that disagree): the check's result for the present `onBy`, which is one of these:
   - A finding that a person has closed: "Raised "<finding title>" · closed by <name>", which counts as Resolved by a person
   - A finding that was deleted: Finding deleted, "Its finding was deleted", still to resolve
   - Satisfied
   - Not settled
   - Not checked
   - Gap, with its linked responses and **Mark resolved**, or "Q38 asked", or the need and **Ask the Counterparty**
   - "Turned on again · not checked since"

   When the item's present check lines (section 9) are two or more from PCs that had not read each other, with different results, the row reads the most cautious (finding, then gap, then not settled, then satisfied) and says "Checks on two PCs disagree", with both.

**Disagreeing checks never sit above a person's decision.** Under a decision (steps 4 to 6), "Checks on two PCs disagree" shows only as a note beneath it, and never changes the step.

### 10.1 When a resolved decision holds

A resolved decision holds when all of these are true:
- Every document source is **present**: it has a location line and is not gone.
- Each response source's question exists, and its response equals `responses`.
- Every linked question's present response equals `responses`.
- Every **new** document (present now and not present when decided, section 7) is covered by a "no change" line for the **present fingerprint**.
- **No doubt stands.** A "may change" review line counts when both hold:
  - it is for a version of this decision in the **present episode**;
  - the present version's `saw` does not hold it.

  As a result:
  - A doubt is not limited to new documents.
  - A doubt written on another PC that the person was never shown stands until a person acts again.
  - A doubt that a person was shown and confirmed past never returns within the episode, whatever is written after.
  - A Clear, or a `not`, ends the episode, and a later **Mark resolved** starts a new one.

## 11. Reviews, on demand

- **Review them** (on the item) and **Review all** (on the Checklist page) run on this PC, in the deal's turn. They can be stopped, and they give way to the first pass.
- **Nothing runs by itself.** An item with unreviewed new documents reads "New documents since this was resolved" and counts as to resolve.
- **Reviews are grouped by document, across items:**
  - **The pairs:** a review covers only (item, document) pairs where the document is new for that item.
  - **One call:** each call to the standard model holds up to 8 of those documents and at most 120 pairs. The items in the call come with their basis **as text**: the response, the note, and the quote of each cited place, capped at about 2,000 characters per item. A cited page's text is never extracted ([decisions.md](decisions.md), "AI and models"), and a cited document is never sent as a file here.
  - **The reply is compact:** for each item (by its id), one verdict per document in the order listed, for example `"i_3f9c…": "N N M N"`. A `why` is given only for M (may change) and U (unsure). U counts as M.
  - **Reading the reply:** each complete item is written as it arrives. A pair left out, or a reply that cannot be read, writes nothing for that pair.
  - There is no fast pass.
- **Estimate,** shown before **Review all** runs: "about N calls", worked out from the pairs. For 40 new documents and 150 decided items, that is 6,000 pairs: 5 document groups × 10 calls of 120 pairs = **about 50 calls**.
- **The line:** one per call and item, in the check log: `review: { item, fp, docs: [...], verdicts: "NNMN", why: { [doc]: text } }`.
- **Documents this PC cannot open** are left out and named on the row ("<document> has not reached this PC"). The rest are reviewed.
- **Claims:**
  - Before a call, the PC writes `reviewing: { pairs, until }`, one hour ahead. A call that ends, a pair left out of a reply, and a stopped run write `released: { pairs }`.
  - Another PC skips pairs claimed and not yet past `until`, with a 10-minute margin for clock differences, and says "<PC name> is reviewing 3 of these (until <time>)". It reviews the rest.

## 12. Counts: a partition of the items that are on

Each item that is on falls into exactly one bucket, and its bucket depends only on the step that section 10 reaches. Built: the rows for steps 2 and 7 (except "turned on again" and checks that disagree), the headline, and "N turned off".

| Step | Bucket |
|---|---|
| 2: open finding, or one in two versions | **Flagged** |
| 3: two versions of the item's `off` | **To resolve** (the item counts as on) |
| 3: two versions of anything else | **To resolve** when the step below it would give Satisfied or Resolved by a person; otherwise the bucket of the step below |
| 4 | **Resolved by a person** |
| 5, 6 | **To resolve** |
| 7: closed finding | **Resolved by a person** |
| 7: deleted finding | **Finding deleted** (counts as to resolve) |
| 7: Satisfied | **Satisfied** |
| 7: Not settled | **Not settled** |
| 7: Not checked, or turned on again | **Not checked** |
| 7: Gap | **To resolve** |
| 7: Checks disagree | the bucket of the most cautious result |

**Headline:** "N to resolve" = To resolve + Flagged + Finding deleted. "Not settled" is shown apart.

These notes are shown on their own lines and are not buckets:
- "N turned off" (naming how many have an open finding)
- "N where the latest check disagrees"
- "N where checks disagree"

A test checks that every combination lands in exactly one bucket.

## 13. Actions

Built: **Ask the Counterparty**, from a gap and from a finding; **Close This Question**; **Add All Unresolved to Q&A**; and Undo that checks every record. Not built:

- **Changing a response:** withdrawing, replacing, or editing a response, or deleting a question, never touches a decision. Step 5 says why the decision no longer holds.
- **Batches** (Close them, **Add All Unresolved to Q&A**, and bringing in the list):
  - Each batch is one entry in the undo journal, holding its children: their kind, id, expected state, and inverse.
  - The inverse of a decision change is the previous version's id.
  - The entry is written in one write, and pruned by batch and by age, never inside a batch younger than a day.
  - **Undo All** undoes each child that has not changed since, and names any that has.
- **Bringing in the list is one batch,** with the list version and every deal's items (section 4). Adding items for one deal (creating it, changing a layer, or **Add Them**) is one operation.
- **Review all writes check-log lines, not records,** so it has no Undo.
- **Offered close-out** is also offered on Resolved-by-a-person rows that come from a person's decision, and becomes a journal batch.
- **Add All Unresolved to Q&A:** items marked not resolved with no linked question join the candidates, and it becomes a journal batch.

## 14. A check from a conversation

**What it reads:**
- The named documents, read first and never dropped
- The documents that the row's latest result read, and its places
- A full ordinary pick, in as many calls as that takes

**Before it runs:** the item and the named documents are confirmed by name, with their folder. The cap is twice the width, and the confirmation states it and the cost. If a named document is not indexed, or cannot be opened on this PC, nothing runs and the person is told which document it is.

**Combining calls:** the result is "met" only when some call gives a place and no call raises a finding. Otherwise the weakest result is taken, and each call's result is listed.

**Where the result goes:**
- It is written as a `talk` line in the check log, which `outcomes()` does not read as a result.
- `checklist()` returns the latest one beside the row.
- `progress` does not count its documents as read.
- It never replaces the row's result.
- When the item is met, it offers **Mark resolved** with **Use this place**.

## 15. The two-versions screen

The screen follows mock-up B: nothing is picked in advance, and the button names the choice. Every content field is listed by name, with each source shown with its page and quote:
- **A decision:** Decision · Sources · Reason · Responses seen · Times confirmed
- **An item:** Turned off
- **A deal:** its usual fields, and the items that came only from the set-aside version's structure, sector, or technology (each item's `from` names the layer's value)

A test checks that, for every kind, two versions that differ in any one content field show a difference.

## 16. Other parts

- **Export:** the items with their state, and decisions with their sources. Turned-off items are listed separately.
- **Wording:**
  - The terms: Satisfied · Resolved by a person · Resolved by <name> · Not resolved · Needs a look · New documents since this was resolved · Review them · Review all · Still resolved · Mark resolved · Mark not resolved · Clear my decision · Keep my decision · Use this place · Cite another place · Ask the Counterparty · Ask for another item · Turn Off Item · Turn On · Turned off (row) and Turned Off (filter) · Turned on again · Add Them · The latest check disagrees · Checks on two PCs disagree · Checked in a conversation.
  - The history kind `resolved` (a choice between versions) is renamed `chosen`.
  - The repository's refusal names the record.
- **The kinds `item`, `decision`, and `firmList` are handled everywhere,** from one table of kinds. They must be covered in:
  - The repository's clash kinds and `sync().clashes`
  - The Kv build's prefixes
  - `RecordKind`
  - `current` and `ReopenConflict`
  - The change log's "gone" kinds
  - The store's buckets, `blockedBy`, and `Conflict.kind`
  - `state.ts`
  - Undo's buckets

  This is tested with two PCs whose first decision clashes on both repositories.
- **Schema:** everything ships at schema 1.
- **Owed marks** (not built yet):
  - The owed line records the finding's version ids at the time.
  - A mark is paid by writing it, unless a version descended from those holds a person's Reassess, or a person's own mark or clear of `updated`. Then it is recorded as paid without writing.
  - This is judged on the versions, not on times across two files. Other edits do not settle it.
  - The `paid` line records how: `written` or `reassessed`.

## 17. Tests

- **End-to-end tests:**
  - **What they run:** the app's store on the real backend, put together by the same function the Windows shell uses, with real files in a data-room folder, two PCs sharing one sync folder, a stand-in model, and closing and reopening the app.
  - **What they cover:** create a deal, index it, run the first pass; findings and the checklist; asking a question and recording a response; the mark; sync, two versions, and the choice; Undo; a restart.
  - **Every link feature in this design gets a scenario there** before it counts as built.
  - With a Claude API key, the same run can also use a real model, as a check that real replies take the shape the backend reads.
- **Specific tests, each with an end-to-end scenario where it touches the pipeline:**
  - Incremental reading notices a file whose last read line has changed, and reads it again whole.
  - A closed finding never takes a new problem.
  - Disagreeing checks never sit above a person's decision.
  - Attachments are present while their file is in the shared folder, whatever happens to the PC that attached them.
- **Also tested:** bookkeeping-only heads fold for `decision`, as they do for the built kinds; every combination lands in one bucket (section 12); every content field shows a difference (section 15); and the kinds table (section 16).

## 18. Needed in the current code before linking

- Section 3 for the notes and check files: identity by content, segments, incremental reading, and the local copy and restore.
- Section 9: check lines with `after`.
- Section 6: a check line names the existing finding.
- Owed marks (section 16).
- Complete listings (section 3).

## 19. Least certain parts

- **Review cost** grows with pairs: about 50 calls for 40 new documents across 150 decided items.
- **`room` sets** are written once per distinct set. A deal whose documents change many times between decisions writes one set per change: about 56 KB each at 2,000 documents.
