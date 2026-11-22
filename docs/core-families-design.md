# Core documents, part 2: complete families

Status: built, in `src/backend/related.ts` and step 5 of the core set (`core.ts`). This is part 2 of the [core-documents design](core-documents-design.md) (section "Parts"). It replaces that design's "Related documents" and "Series" bullets under "Families, complete", and reverses two of its series examples: change orders (which are amendments of their contract) and leases by parcel (which are separate instruments).

A family is an agreement together with the documents that belong to it, such as its drafts, schedules, exhibits, and amendments. The goals are these: families are complete wherever they can be found; everything stays searchable, and only the newest draft is core; a document that can't be told to be an earlier draft is included; and a run of monthly reports does not flood the set. A document whose agreement can't be told is left out of every family (it stays searchable and is ranked on its own). This differs from the "include it" rule for drafts, because a document placed under the wrong agreement misleads.

## What a mistake costs

Core status orders reading, breaks ranking ties, and decides which documents are described up front (the best 100 only, never family members). Every document stays searchable and every per-item search ranks the whole data room. So the rules below lean one way: when a name can't be read for sure, the document is left ordinary (ranked on its own) rather than folded into a series or placed under a guessed agreement. The two mistakes that matter are a distinct document folded away into a series, and a document placed under the wrong agreement. Both are what the design reviews looked for.

## Cases the rules must handle

The rules must not fold an agreement's numbered schedules into one series, and must cope with a far-away agreement, unknown abbreviations (Sch, Att., PCO-01, CO #12, Amdt), file order, amendments under amendments, closing-set numbers ("1.03", "Tab 2"), "Form of" exhibits, distinct instruments numbered alike (Phase 1, 2, 3 PPA; Estoppel Certificate - Landowner 1, 2, 3), quarterly series, reports named after an agreement ("O&M Monthly Report"), two projects in one room, bare-numbered documents ("Reliance Letter 1, 2, 3"), dated letters of credit, and 2,000 files in under a second. The rules below mostly leave a document ordinary when the evidence is thin, and the prototype passes all 34 test rooms.

## Reused, and what is new

These are reused as they are:
- `families.ts`: dated sibling folders as drafts; `folderDate` for a full date or a month in a name; `roomPath`.
- `blacklines.ts`: `isBlackline`; a blackline takes part through its clean draft (part 1) and is never a family or series member itself.
- Part 1's name folding (version marks, status words, download copies), its version marks as drafts, its synonyms library (`lists.synonyms`: "PPA Amendment No. 2" finds "Power Purchase Agreement", "Phase 2 PPA" is an agreement, "A&R" is amended and restated), its precedent-folder rule; `fold` (words.ts) for plurals.

These are new:
- One pure function, `docFamilies` in `related.ts`, giving each agreement's members, each member's agreements, and the series, on names and paths only, with no model. Input is sorted by path first, and which documents can be agreements is settled before anything is placed, so every PC gets the same answer in whatever order it scanned its files.
- Reading a quarter ("Q3 2024", "2024 Q3"), a half, a fiscal year, "11-2024" or a bare year in a name, to order a series; `folderDate` reads none of these.
- Four word lists in the control file (`src/control.ts`), beside `lists.synonyms`, so that new naming can be added without changing code:
  - `lists.relationWords`: schedule, sch, sched, exhibit, exh, ex, annex, annexure, appendix, app, attachment, att, amendment, amend, amdt, supplement, supp, supplemental indenture, side letter, joinder, waiver, novation, addendum, rider, change order, CO, PCO, variation, variation order, VO, signature page; and compounds on their own: omnibus amendment, deed of amendment, deed of variation, waiver and amendment, amendment agreement, supplemental agreement, deed of novation.
  - `lists.instrumentWords`: agreement, contract, lease, deed, guarantee, guaranty, policy, permit, licence, bond, opinion, easement, mortgage, indenture, debenture, charge, note, fee letter, letter of credit, confirmation, certificate of incorporation or formation, estoppel, consent, notice to proceed.
  - `lists.seriesWords`: report, minutes, log, statement, accounts, invoice, notice of borrowing, borrowing or drawdown request, RFI, letter, correspondence, return, certificate of insurance, newsletter, update, sheet, photo, drawing.
  - `lists.partWords`: phase, parcel, tract, lot, unit, site, block, WTG, turbine, HoldCo, project, plant, investor, title, register, account, pad, building, area, zone, trade, landowner, lender, bank, SPV.
- Step 5 of the core set (`coreSet`, `families` input) completes the families; `coreOf` (ai.ts) gives a series' earlier members the newest one's place through `standIn`, as it does for drafts.

## Reading a name

Before anything else, a name is stripped of whatever does not say what the document is: its extension, version mark, status words ("Execution Version"), a download copy's "(1)", and a closing-set index in front ("1.03 ", "Tab 2 - ", "Doc 4 "). A dotted index keeps its first number as a hint, so "1.03 Exhibit B" goes with "1.01 Credit Agreement" in a numbered set. "&" between words is "and". Words after "form of" describe the form, not the agreement the document belongs to: "Exhibit C - Form of Consent and Agreement" is an exhibit of whatever agreement holds it, never of a consent and agreement because of its title.

## Which test comes first

Each document is tested in this order, and the first test that applies decides what it is:

1. A blackline: through its clean draft (as built).
2. A document of another project (part 1's precedent folders, and part 3): never core, and never in a family of this deal.
3. A related document: a name with a relation word used as one (below). This test comes before drafts and series, so a schedule never falls into a series. One with version marks ("Schedule 3 - Price v2", "v3") is also a draft: its newest draft is the one that comes in with the family.
4. A version mark (v3, rev A, draft 3): a draft (part 1); only the newest is core.
5. A series member (below).
6. Otherwise an ordinary document, ranked on its own.

## Related documents

A relation word is used as one when it is:
- followed by a number, letter, section or part: "Schedule 3", "Sch3", "Exhibit A-1", "Exhibit 10.1", "Schedule 1.1(a) Commitments", "Schedule Part B", "Schedule One", "Annex IV", "Amendment No. 2", "Amendment #2", "VO-01", "CO #12";
- after an ordinal: "First Amendment", "2nd Amendment", "Second Supplemental Indenture" (which belongs to an indenture);
- followed by to, of, re or under and a name: "Amendment to Lease - Parcel 001", "Side Letter re PPA", "Schedule 1 to the Security Agreement";
- "Amended and Restated" or "A&R" before a name;
- a whole part of the name on its own, or a compound: "Side Letter - Bank of Example", "Supplemental Agreement 1", "Joinder", "Signature Pages"; or
- after the name of an agreement found beside it ("PPA Amendment", "EPC Contract - Second Amendment"); this weak form counts only if that agreement's own name holds those words, and a word for a part (schedule, exhibit, annex, appendix, attachment) only after a library name ("ISDA Schedule"), so "Payment Schedule" beside a payment bond stays its own document. "CO" and "VO" count only with a space, "#" or "-" before their number ("CO #12", "VO-01"; "CO2" is carbon dioxide).

A name with a relation word used as one is never in a series. If its agreement is not found, or can't be told, it is an ordinary document. A relation word not used as one leaves the name ordinary: "Construction Schedule", "Payment Schedule", "Credit Support Annex".

**Which documents can be an agreement:** a name with an instrument word, or a library name when the name is not a periodic record ("O&M Monthly Report" is a report), and no relation word; or an amended and restated agreement; or a name ending in agreement, contract or deed whose relation word has no number after it ("Schedule of Rates Agreement", "Side Letter Agreement", "Amendment and Restatement Agreement" can hold their own schedules). Never a "Form of" document, a precedent or a blackline. So an amendment is never placed under another amendment, and "Form of Note.pdf" never takes "Exhibit E - Form of Note". An amended and restated agreement takes only documents that name it as such ("First Amendment to Amended and Restated Credit Agreement"); its own unnamed exhibits go to the original, and the two families come in together.

**Where to look:** the document's own folder; then, one level at a time, everything beneath each folder above it, folders beside it included ("03 EPC/02 Schedules/Schedule 1" finds "03 EPC/01 Contract/EPC Contract"), up to the data room's top. The first level with an agreement that fits decides, and nothing above it is looked at.

**Which fits:**
- Where the name says which agreement ("to the Credit Agreement"), only an agreement whose name, or the folders beneath the shared one, holds those words will do ("Example EPC Amendment No. 3" filed under another project's folder finds "Projects/Example Project LLC/EPC/EPC Contract"). Dates, relation words, numbers and parentheticals are not part of those words ("Amendment No. 1 to Credit Agreement dated 5 March 2024", "First Amendment to Credit Agreement (Lender Group)").
- An agreement that numbers the same thing differently is not it: "Amendment No. 2 - Parcel 3" never goes to "Lease Agreement - Parcel 2", and "Amendment No. 1 - Parcel 603" with no such lease goes nowhere.
- Of those that fit, the best shares most words with the document's name and its index hint; then with the names of the folders between them and the folder they share (that folder's own name is the same for all, so it does not count). Relation words, the words every agreement shares (agreement, contract, deed), the document's own number and dates are not counted.
- A tie, or nothing shared: the agreement whose own name is most covered by the document's name and all its folders, read as plain words ("EPC" covers all of "EPC Contract" and a quarter of "Parent Company Guarantee - EPC Contractor"; a folder named "Credit" points to "Credit Agreement").
- Nothing shared by name or folder: it goes to the one agreement in its own folder, if there is exactly one; with more than one there, or with the nearest agreements one folder up, it can't be told and is an ordinary document; further up, the search goes on, and only shared words will do.
- Numbered parts in one folder that don't name their agreement ("Schedules/Schedule 1 - Scope" to "Schedule 22") are one set: when two thirds or more of a set of three or more go to one agreement, the rest go there too, so a part's description never takes it elsewhere ("Schedule 6 - Performance Guarantees" stays with the EPC contract, not the parent company guarantee beside it). A part with a closing-set index is in no set, as the index already says whose it is.
- If two or three agreements still fit on shared words, the document belongs to each of their families. If more than three fit, it can't be told: it is an ordinary document, and the search stops. Agreements are counted by their whole names, dates included, so five dated letters of credit are five; drafts of one agreement count as one.

A document in more than one family comes in when any of them does, but never brings an agreement in by itself.

**The family** is an agreement and every document placed under it: one level, no chaining from one agreement to another, except an amended and restated agreement and its original, which come in together, the restated one first.
- When any draft of the agreement is core, every member comes in, each as its newest draft.
- When a member placed under one agreement only is core (an amendment in an item's top 3), its agreement and the rest of the family come in.
- Family members are not ranked into the best 100 and are not described up front; they are described the first time a check or question reads them, as part 1 already does for every core document beyond the best 100.

## Series

Only documents of a kind in `lists.seriesWords`, periodic or running records, make a series: three or more whose names are the same except for one period (any other number the same in all: "Q1 2025 Report - Solar 1" and "- Solar 2" are two assets, not two periods), in one folder ("Monthly Operating Report - March 2025", "Notice of Borrowing No. 7"), or one name in sibling folders whose names differ only by a period ("Daily Logs/Week 3/Site Log.pdf", "Reports/2025-03/Monthly Report.pdf"). A period is a date, month, quarter, half, fiscal year or year, or a running number: after No., #, Week, Day or Month, or in a record named daily, weekly, monthly, quarterly or annual. A library name in a report's name does not stop it ("PPA Quarterly Settlement Statement Q1 2025"). These are not a series:
- A name with a relation word (above), a version mark (part 1), or an instrument word or library name.
- A bare number that is not a running number ("Reliance Letter 1, 2, 3", "IE Report - Module Supplier 1, 2, 3", "Flash Test Report - Batch 07"), a number after a part word ("Title Commitment - Parcel 12", "WTG 07 Commissioning Report"), or a reference of five digits or more.
- Sibling folders that differ by a bare number ("Wind Farm 1", "Wind Farm 2"): each wind farm's reports are their own series.
- Two documents only: two cannot be told apart from two different documents, so both are kept.
- Anything else: "Estoppel Certificate - Landowner 1, 2, 3", "Queue Position Q123", and "FY24 Budget" stay separate documents.

A series takes one place in the core set, held by its newest member: by the date or period in its name or folder ("Q1 2025" after "Q4 2024"; "01-2025" after "12-2024"), else the highest number, else the path. Every member stays searchable and is read whenever the per-item search ranks it.

Monthly reports in dated folders under one name ("Monthly Reports/2025-03/Monthly Report.pdf") are already a draft family under `families.ts`; for the core set, the result is the same: the newest only. The app labels the earlier months as earlier drafts; that is filed separately as #432 and is not changed by this design.

## Prototype

The rooms are test fixtures in tests/backend/fixtures/familyRooms: `room` (a generated 1,431-file solar-plus-storage data room) and the hand-written rooms `c1` to `c7`, `a1` to `a6`, `p1` to `p5` and `x1` to `x16` (naming styles, abbreviations, deep and sideways folders, closing sets, two projects in one room, "Form of" exhibits, signature pages, agreements named with relation words, reports named after agreements, quarterly series, dated letters of credit, rooms of 2,000 to 5,000 files). `prototype.json` beside them holds what the reviewed prototype made of the hand-written rooms, and tests/backend/related.test.ts checks the built rules against it: every placement and series the prototype found holds. The built rules place a little more in two rooms: a "Leases" folder over three numbered leases now ties an unnamed amendment to all three (the prototype did not fold "Leases" to "lease"), and "PCG - Sponsor Parent" is an agreement because "PCG" is in the synonyms library.

On the generated room:
- EPC contract: 2 amendments, 22 numbered schedules, 13 exhibits and 48 change orders (85). Credit agreement: 2 amendments, the amended and restated agreement, 18 exhibits and 6 schedules (27). PPA: 2 amendments, a side letter and 8 exhibits (11). LGIA 7, module supply 6, battery supply 6, LLC agreement 3, REC agreement 2, O&M 2, ISDA 1, ECCA 1, and each of 15 lease amendments under its own parcel's lease. The tax-equity partnership's amended and restated LLC agreement is not placed under the project company's LLC agreement.
- 12 series holding 629 documents: letters, board minutes, site logs, IE monitoring reports, construction and operating reports, notices of borrowing, availability reports, audited accounts, tax returns, insurance certificates. Flash test reports by batch, survey sheets and drawing sheets stay separate documents (their numbers are not periods).
- No series holds a name with a relation word in any of the 34 rooms. Shuffling the input three ways gives identical results on each of the eleven rooms tried.
- Timing, as built: 2,000 to 5,000 files take 150 to 500 ms.

**Size.** On this room, complete families add about 170 documents to part 1's set (153 to 189 in its prototype), mostly the EPC contract's change orders and the credit agreement's exhibits. None of them is read up front.

**Known limits.** Each of these leaves documents ordinary and searchable rather than misplaced: attachments with nothing in common with any agreement and more than one agreement around them (two agreements in one folder with unnamed schedules; "Disclosure Schedules" beside a folder holding the credit agreement and others; a schedule in a folder named by an abbreviation the library lacks); a relation word inside a periodic report's name ("Exhibit 1 - Monthly Progress Report Jan 2025") keeps it out of a series; "Credit Support Annex" is not tied to its ISDA master agreement.

## Decision

Change orders and variation orders are amendments of their contract, so all 48 come in with the EPC contract.

## Changes to decisions

- [decisions.md](decisions.md) (core documents): this part's families are added.
- Line 173 (drafts): unchanged.

## Acceptance criteria

- No model call is made; the same paths give the same families and series on every PC, in any input order (tested by shuffling).
- On the generated room and the sample rooms, kept as test fixtures: every schedule, exhibit, annex, appendix, amendment, side letter, supplemental indenture, signature page and change order the prototype places is in that agreement's family and in no series; "Construction Schedule", "Payment Schedule" and "Credit Support Annex" are in none; each lease amendment is under its own parcel's lease and never another's; no amendment is under another amendment, except under an amended and restated agreement it names; no "Form of" document is an agreement; no document is in more than three families (counted by document, dated instruments apart); no unnamed attachment is placed with nothing linking it to its agreement except being the only one in its folder; the series above are found with the newest holding each, quarters and month-year read, reports named after an agreement included; no lease, easement, permit, consent, estoppel, numbered PPA, fee letter or charge is folded; no bare-numbered, part-numbered or two-member group is folded; no two assets' reports merge through numbered folders; no precedent is in a family of this deal.
- With the EPC contract core, its whole family is core; with only an amendment core, its agreement and family come in; a document in two families brings in neither.
- Working out families takes under one second at 2,000 files in every sample room.
