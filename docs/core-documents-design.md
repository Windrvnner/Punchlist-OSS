# Core documents: design in parts

Status: all four parts are built, except the store of item keywords by wording (see "Item keywords"), which is not built yet. This design replaces how core documents are chosen (see "Core documents" in [decisions.md](decisions.md)).

## What core documents do, and what they do not

Core documents are a deal's most important documents. They are marked `*` whenever the fast model picks documents for a check, a question, or a folder read. They also break ties in the keyword ranking (`ranked`, ai.ts:739), and the fast model reads them once up front for a summary and search terms (`describeSoon`). They do not limit what a check can read: every checklist item's search and pick ranks every document in the data room (`ranked` over `o.docs.records`, ai.ts:741; `headed` takes the top `limits.shortlist` of that ranking), so the cap of 100 never kept a document from a check. Coverage comes from the per-item search. The core set is the deal's map of what matters, and it sets the order in which things are read.

The design has these goals:
- Cut token use while giving complete coverage, with no artificial cap.
- Rank from the signals the app already has (keywords, folders, and names), not from the model.
- Keep keywords for each checklist item.
- Make families complete.
- Keep a library of synonyms and abbreviations.
- Make only the newest draft core.
- When it cannot be told whether a document is an earlier draft, include it.
- Read a redline (blackline) against another project, but never use it as a main source.

## Reused, and what is new

These are reused as they are:
- `families.ts`: drafts in sibling dated folders, newest first; `draftsInOrder` and the `earlier` map.
- `blacklines.ts`: a blackline by name or by its cover page (`cover`, kept at indexing), its clean draft, standalone ones.
- `sameRoom.ts`: documents other deals hold by content.
- The checks' search agent (`searchFor`; decisions.md line 207): the fast model's searches per item, each item's trail of its latest 8 searches on its result, and "a gap already searched for on the same documents and wording is not searched again".
- Checklist items' `section` and `subsection` headings (src/domain/checklist.ts:124-127).
- The word index (`wordIndex.ts`) and `scores`; a document with no readable text (a scan) is already marked at indexing (`words: []`, documents.ts:49).
- The word lists in the control file, `src/control.ts` (`lists.searchFiller`, `lists.indexFiller`).
- `describeSoon` with its claims across PCs, and the describe-on-read it already does (ai.ts:918).
- The core line in the shared check log, and `RoundDef.core`, which a shared check keeps for its whole run.

These are new:
- Working out the core set with no model (below), replacing `askCore`, `limits.coreDocs`, and `limits.corePage`.
- Versions in one folder recognized as drafts (an addition to `families.ts`).
- Related documents of an agreement.
- Documents of another project (precedents, and blacklines against another project), never a main source.
- The synonyms and abbreviations library (`lists.synonyms`).
- Item keywords kept by wording, from the search agent's replies.
- Learning the deal's short names from paths with no model, in place of the removed core calls as the source of candidates (`shortFor`, ai.ts:674, is reused for the letter check).

## The core set

Each PC works out the core set with no model, from signals that every PC has alike: each document's name, folder path, and most-used words (`words`, in the shared document lines); each item's wording, headings, and kept searches; the library; and the deal's short names. It does not use this PC's full-text index or summaries, which differ between PCs and change as documents are described. So every PC gets the same set without writing it down, and the set does not feed on itself. (A document in a folder that this person may not open is left out of their set and gives its place to no other document.) The set rests mostly on names and paths: the most-used words are 30 single words, and a scan has none (documents.ts:49). That is enough, because the set does not gate what a check reads. The set is worked out when a check or first pass starts, or on demand when a question or folder read needs it and none is worked out yet. It is kept for that run (`RoundDef.core`) and worked out again at the run's end, so it does not shift from batch to batch.

**Scoring words.** A word in the file's name counts 10, in its folder path 3, and among its most-used words 1, each weighted by how rare it is among the documents. On the item side, an item's subject terms are its words that fewer than half the checklist's items use and that are not on the control file's list of checklist ask words (`lists.askWords`: executed, copy, provided, party, default, term, lenders, consent and the like). Before an item has kept searches, its section and subsection headings count as subject terms at full weight, and an item with no subject term falls back to its headings. A library group scores as the best of its group match and the member's own words, never instead of them. A blackline (a document that shows the changes from one document to another) whose clean draft is known counts through its clean draft and takes no place of its own.

1. **Per item.** Each checklist item that is on is matched against every document. An item whose subject terms match no document's name or path adds nothing. Otherwise its top 3 are core. Ties are broken by fewest relation words in the name (below), then, among names that hold the item's subject phrase, the shortest name, then newest by version mark, then path. An earlier draft gives its place to its family's newest; members of one series (below) take one place between them, held by the newest; the next document takes any freed place.
2. **Best 100.** Documents are ranked by reciprocal-rank fusion over the items (each item gives 1/(rank + 10) to its top 10), and the best 100 are core, filled up again after drafts and series give way. Hubs and documents of another project are not ranked here.
3. **Hubs.** A hub is a document named as an index, tracker, request list, or Q&A file, or one that (with at least 50 items that name anything) is in the top 3 of more than 20% of them across most sections while fewer than half of those items name it. A hub is core once, takes no item's place in (1), is not in the best 100, and is not marked `*`.
4. **Families, complete:**
   - Drafts: documents in dated sibling folders (`families.ts`, unchanged) and, new in this design, versions in one folder, whose names are the same once an explicit version mark is taken off: v3, v.3, version 3, draft 3, rev 3, Rev A. A number in brackets ("(1)", often a download copy) and a date are not version marks. The highest mark is the newest. A file of the same name with no mark beside marked ones cannot be told to be an earlier draft, so it is core too. Only the newest draft is core.
   - Series: names that are the same except for a number or a date, in one folder (monthly reports, change orders, notices, survey sheets, leases by parcel, audited accounts by year). A series is neither drafts nor related documents; it takes one place as above and its members stay searchable.
   - Related documents: before comparing, a name loses its version mark, status words (execution version, executed, signed, conformed, final, clean), dates and brackets, and library members count as their group. A file in the same folder or the one beneath, whose name holds a core document's name as a whole phrase together with a relation word (amendment, amended, restated, schedule, exhibit, annex, appendix, side letter, joinder, waiver, supplement, novation, assignment), is related, and so is the other way round: a core amendment brings its base agreement. A series is never related; related documents do not bring in their own.
5. **No checklist yet.** Each library group is taken as an item and matched against names and paths; (1) to (4) then run as above. No model call is made, which leaves one less failure path.

Punchlist identifies and reviews third-party reports in a separate pass. Reports can also qualify as core documents
under the standard rules above.

The set is ordered with (2) first, then the rest of (1) by their best rank, then family members newest first, then by path.

## Documents of another project

Part 3 is built; its design is in [other-project-documents-design.md](other-project-documents-design.md). A document is another project's when every place it is in runs through a precedents folder. From its cover and name, with no guessing at names, a blackline is classed as compared against this deal's own earlier draft, against another project's document, or against a document that is not known. Another project's documents, and blacklines not shown to be against this deal's own draft, are read but never a main source, never core, and take at most two places ahead of this deal's own documents in a ranking.

## Synonyms and abbreviations library

The library is `lists.synonyms` in the control file (`src/control.ts`), beside its word lists. Like every value in the control file, it is part of the app's build, so changing it means building the app again (control.ts:6: "Changing a value means rebuilding"). The control file's validator checks these rules:
- A group is a list of names for one thing. A phrase is matched only as a whole phrase, in names, paths, and checklist wording, never as loose words.
- An abbreviation (capitals, two letters or more) is matched only in names, paths, and checklist wording, where case is kept, as a whole word written in capitals. A name or heading with no lowercase letter at all does not count ("PILOT PROGRAM").
- No member is a single ordinary word: the validator checks members against a list of ordinary words kept beside the library (`ORDINARY` in control.ts).
- A word or phrase is in one group at most, and groups do not chain.
- An abbreviation with more than one common meaning in project finance is left out (TSA, DA, CTA, APA, BOP, MRA, LMA, REC, ITC), unless the deal's own paths give its long form.

The deal's own short names are learned from paths with no model, and only from evidence within one path: "Power Purchase Agreement (PPA)", or both forms in one path, where the abbreviation's letters are the phrase's initials, one per word. The learned short names sit beside the library.

## Item keywords

The app reuses the search trail from the latest result. The separate cache by item wording described here is planned.

The search agent's replies (its searches for an item) are kept by the item's wording in the deal's shared check log. Each is written once per wording and claimed (`claim`/`release`) so that two PCs do not both ask, and a later check starts from them instead of asking again. The agent's second try "in other words" is kept too, by wording and the documents' hash. These lines are new and separate from the trail on each result line (ai.ts:2004), which stays as the gap's display. Calls are counted against `limits.searchCalls` as they are now, and a kept search costs none. The core set uses the kept searches; an item not yet searched is matched on its wording, headings, and the library, and joins the set once it is searched. This needs no extra call, because the first pass already asks.

## Describing documents

Describing a document means the fast model reads it for a summary and search terms. The best 100 are described up front, as they already are, and a check waits for those only (a queue of its own in `describeSoon`, with `described(dealId, ids)`). Every other core document is described the first time a check or question reads it, as any document is (ai.ts:918). Only the best 100 are marked `*` in pick prompts. Nothing else uses the set beyond tie-breaks in `ranked` and the order of a folder read, so the rest of the set mostly sets the order of reading.

## Filling gaps (part 4)

Reading 100 documents up front is acceptable, but nothing may stop further searching when a check has gaps to fill. There must still be some limit, and the further searching uses the tool-calling search that is already built. Without this part, an item gets its main call (up to `limits.docsPerCall` documents, shared), one second look of a quarter of a handful (ai.ts:2243), and no third round. An item whose searches find nothing is searched once more in other words, and is then a gap (decisions.md line 207).

In this part, items that a check leaves not settled or as gaps are handed, a few at a time, to the chat agent's own tool-calling loop (`chatAgent`, src/backend/agent.ts), with its search and read tools unchanged: it searches and reads as often as it needs. Its existing ceilings are the safety stop: about `limits.chatTurns` turns (25) per run, `limits.searchCalls` per search run, and `limits.checkSearchCalls` per deal on each PC. An item that the agent still cannot settle stays a gap if nothing was found, and becomes "not settled" if the run stopped at a ceiling, saying so on hover. Questions in the chat already run on this loop. The extra calls per gap item are to be measured on the 2,400-item checklist before the defaults are set.

## Cost on a 1,779-file data room and a 2,400-item checklist

A simulation (names and paths only, with the repo's realistic 2,400-item checklist and a generated solar data room) put the set under the first draft of the rules at 300 to 460 documents, with whole series and precedents in it. The rules above are written to cut those out, and are to be measured again on that generated room, which is kept as a test fixture.

- **Choosing the set:** no model calls. The method this design replaces took about 7 calls of 300 paths and 3 to 4 merges, roughly 100,000 to 150,000 tokens, once.
- **Item keywords:** no new calls; repeat search calls on later checks are saved.
- **Describing up front:** 100 documents, as before. On the Claude path, each call sends the whole document (claude.ts:124).
- **On the PC:** names are tokenized once per document, with an inverted index from words to documents, and each item is scored only against documents that hold its words (#461). The target is under 10 seconds at 2,400 items by 2,000 documents.

## Parts

The design is built in four parts, each in its own pull request:
1. **Core set without a model or a cap** (this design, less what parts 2 and 3 hold): per-item top 3, the best 100 described up front, the rest described on first read, explicit version marks as drafts, hubs, the library and learned short names, precedent folders by name, and the no-checklist mode. It is built with two things narrower than described above: an item's searches are those already kept on its latest result (the trail), not a new store of searches by wording, which is not built yet; and the best 100 join the existing describe queue rather than a queue of their own. The prototype (names and paths only, 1,779 files and 2,400 items) chose 153 to 189 documents in 0.6 s. The PPA, EPC contract, credit agreement, LTSA, O&M, interconnection, and REC agreements were core in every mode, and no earlier version and no precedent was in the set.
2. **Complete families beyond drafts:** related documents (schedules, exhibits, and amendments, both ways) and series (monthly reports, letters), including series spread across folders. Built; the design is in [core-families-design.md](core-families-design.md).
3. **Documents of another project:** built; the design is in [other-project-documents-design.md](other-project-documents-design.md), with no rule that guesses at names.
4. **Filling gaps:** the chat agent's tool-calling search on items left open (above). Built.

## Changes to decisions

- Line 174: replaced by this design (done in part 1, with the library as its own line).
- Line 170 (part 3): "Tracked changes and blacklines" is edited in place (done in part 3); unclear blacklines stay unread.
- Line 172: versions in one folder are drafts (done in part 1).
- Line 176: "the deal's short names folded" becomes the library and learned short names (done in part 1).
- Line 30: "Core documents N of M read" counts the whole set; flagged for review.
- Code: `askCore`, `AiOptions.coreMax` and `corePage`, `limits.coreDocs` and `limits.corePage`, and their tests are removed (done in part 1). No core lines are written anymore, and old ones are ignored.
- An earlier decision and line 174's "no hand-kept list" are reversed.

## Acceptance criteria

- The core set has no cap, and no model call chooses it.
- The same documents, checklist, keywords, and library give the same set on every PC.
- On a generated 1,779-file room (kept as a test fixture) and the repo's 2,400-item checklist (tests/backend/dealList.ts): the main agreements (PPA, EPC, credit agreement, LTSA, and the like) are core; no earlier version and no precedent is in the set (and at most one member per series: part 2); every item whose subject terms match has its top 3 in it; and the set's size and the items that add nothing are reported. The prototype of the second draft of the rules chose 203 documents in 357 ms.
- Only the newest draft of a family is core, including versions in one folder.
- (Part 3.) A document of another project never settles an item, raises or closes a finding, or answers a question on its own.
- The library validator rejects a member in two groups, a single ordinary word (checked against its word list), and the listed ambiguous abbreviations.
- Working out the set takes under 10 seconds at that scale.

## Appendix: starter synonyms and abbreviations (for review)

The list has one group per line. The validator rejects a group of one, so owner's engineer, IFC performance standards, Equator Principles, and investment tax credit are not in the control file until each has a second name. In the control file, legal due diligence report has "legal DD report" as its second name. IE, LC, CP, FA, EP, and HoT are also left out of the control file as ambiguous.

- PPA, power purchase agreement, offtake agreement, energy purchase agreement
- EPC, EPC contract, engineering procurement and construction contract, turnkey construction contract
- O&M, O&M agreement, operation and maintenance agreement, operations and maintenance agreement
- LTSA, long-term service agreement, long term services agreement
- SHA, shareholders agreement, shareholders' agreement
- JVA, joint venture agreement
- SPA, share purchase agreement, stock purchase agreement
- MIPA, membership interest purchase agreement
- ECCA, equity capital contribution agreement
- ICA, intercreditor agreement, intercreditor deed
- facility agreement, facilities agreement, credit agreement, loan agreement
- direct agreement, consent and agreement, consent to collateral assignment
- ISDA, ISDA master agreement, hedging agreement, swap agreement
- DSRA, debt service reserve account
- DSCR, debt service cover ratio, debt service coverage ratio
- LLCR, loan life cover ratio, loan life coverage ratio
- PLCR, project life cover ratio, project life coverage ratio
- conditions precedent, condition precedent, CP checklist
- COD, commercial operation date, commercial operations date
- liquidated damages, delay liquidated damages, performance liquidated damages
- NTP, notice to proceed
- information memorandum, offering memorandum, confidential information memorandum
- independent engineer, lenders' technical advisor, lenders technical adviser
- owner's engineer
- insurance advisor, lenders' insurance advisor, insurance adviser, insurance consultant
- market advisor, market adviser, market consultant
- market study, market report
- ESIA, environmental and social impact assessment
- EIA, environmental impact assessment
- ESAP, environmental and social action plan
- IFC performance standards
- Equator Principles
- KYC, know your customer
- NDA, non-disclosure agreement, confidentiality agreement
- term sheet, heads of terms
- PCG, parent company guarantee, parent company guaranty, parent guarantee
- letter of credit, standby letter of credit, SBLC
- LGIA, large generator interconnection agreement, interconnection agreement, grid connection agreement
- ground lease, land lease, solar lease, wind lease, lease agreement
- financial model, base case model, banking case
- model audit report, model audit
- legal opinion, capacity opinion, enforceability opinion
- tax equity, partnership flip, tax equity investment agreement
- investment tax credit
- PTC, production tax credit
- renewable energy certificate, renewable energy credit
- PILOT, payment in lieu of taxes
- FERC, Federal Energy Regulatory Commission
- MBR, market-based rate authority
- QF, qualifying facility
- articles of association, memorandum and articles, constitutional documents
- certificate of incorporation, certificate of formation
- LLC agreement, limited liability company agreement
- board minutes, board resolutions
- security agreement, security and pledge agreement
- pledge agreement, equity pledge
- mortgage, deed of trust
- accounts agreement, account bank agreement, depositary agreement
- energy yield assessment, wind resource assessment, solar resource assessment, resource assessment
- technical due diligence report, independent engineer's report
- legal due diligence report
- insurance due diligence report, insurance report
