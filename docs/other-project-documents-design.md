# Documents of another project (core documents, part 3)

Status: built. Decided: a "precedent" tag, and the chat still answers from these sources, tagged. Unclear blacklines stay unread (section E). This is part 3 of the [core-documents design](core-documents-design.md) (section "Parts"), and it replaces that design's section "Documents of another project".

## The rule

A redline (also called a blackline: a document that shows the changes from one document to another) against another project is read, but never used as a main source for findings, Q&A, or anything else, because it is hard to tell apart from this deal's own terms. Precedent-folder documents follow the same rule (flagged below).

## What was already built

Much of this was already built for every blackline (see "Tracked changes and blacklines" in [decisions.md](decisions.md#documents-and-indexing)). A blackline, recognized by its name or by a comparison tool's cover page, is:
- read only together with, or after, its clean draft, which is the truth for the deal's terms ([`withClean`](../src/backend/ai.ts));
- told to the model as the model's reading, never as fact ([`blacklineLine`](../src/backend/ai.ts));
- cited with the "reading" tag ([`fit`](../src/backend/ai.ts)), and a checklist item whose only citations carry it is never settled ([`check`](../src/backend/ai.ts)); it never closes a finding by itself (same decision).

Before this design, three things were missing for a redline against another project:
1. **Findings and Q&A.** A finding could be raised or reassessed on blackline pages alone ([`check`](../src/backend/ai.ts), [`reassess`](../src/backend/ai.ts)), and a Q&A response could be drafted from them alone ([`draft`](../src/backend/ai.ts)).
2. **What the model is told.** Every blackline was described as "a comparison of two drafts" ([`blacklineLine`](../src/backend/ai.ts)). For one against another project that is wrong: its deleted text is the other project's wording, not an earlier draft of this deal, which is the confusion to avoid.
3. **Precedent-folder documents** were read as this deal's own and could settle an item, and a precedent in a folder beside dated draft folders could become a family's newest draft and a blackline's clean draft (reproduced; filed as #433, which also covers any undated folder).

## Rules not used, and why

Nothing in this design guesses at names to call something another project's:
- **Capitalized names after "compared to" or "vs"** would flag this deal's own blacklines: "SPA v3 Redline to SPA v2" names "SPA v2".
- **Other deals' names** depended on which deals a person has and how far start-up has loaded them (startup in [architecture.md](architecture.md#storage-shared-between-pcs)), so people got different answers.
- **Documents 3 or more other deals hold** (`SHARED_BY`, `ai.ts`; this design's first draft): with four deals made from one data room, `alsoIn` drops every document 3 others hold ([`alsoIn`](../src/backend/ai.ts)), so the whole room would be another project's; and it depends on loaded deals.
- **"A vs B" with different first words** (this design's second draft): it made "Budget vs Actual Q3.pdf" and "Base Case vs Downside Case.pdf" into blacklines, and "Doe vs Roe judgment.pdf" and "Landlord vs Tenant dispute summary.pdf" too, against the cases in [`blacklines.test.ts`](../tests/backend/blacklines.test.ts). A comparison tool's output is a blackline by its cover page whatever its name, so only an uncovered, oddly named comparison is missed, and it is read as now.
- **"Precedent" in a file's name** (second draft): "Gas Transportation Precedent Agreement.pdf" is this deal's own contract.

A blackline is called this deal's own only when that is confirmed; otherwise the rule for another project's blackline is applied, since which it is cannot be told. A wrong call costs no more than a more careful sentence to the model, and a source that only supports, never a source used as the deal's terms.

## Reused

- `blacklines.ts`: `isBlackline`, `cleanDrafts` (clean, unclear or standalone), `coverOf` and the kept cover, and the name forms "A Redline to B" and "A vs B" (`wants`, `VS`), all unchanged in what they decide.
- `families.ts`: drafts in sibling dated folders; with part 1, versions in one folder; `roomPath`.
- Part 1's precedent-folder rule: a folder named Precedent, Precedents or Precedent Documents once a leading number and punctuation are taken off ("12. Precedents", never "Conditions Precedent").
- The "reading" tag, its chip and tooltip ([`ResearchView`](../src/ui/research.tsx)), and the rule in [`check`](../src/backend/ai.ts).
- [`blacklineLine`](../src/backend/ai.ts) and the listing lines in [`send`](../src/backend/ai.ts).
- The parent design's cap of two places in any pick for a document of another project.

## New

### A. Documents of another project

A document is of another project when every place it is in (`roomPath` of its main place and of each copy, so the deal folder's own name counts: a deal folder "X:\Precedents" is one) has a precedents folder on it. A precedent copied into a working folder, or this deal's executed agreement also filed in Precedents, is this deal's own. "Form", "Forms" and "Templates" are not used (this deal's own forms and filings). The test uses names and paths only, so the result is the same on every PC.

A document of another project is never in a family and never a clean draft. A blackline that is itself of another project gets no clean draft from this deal: `cleanDrafts` maps it to `false` (read on its own, as a standalone blackline already is), and it is told as a blackline made on another project (D).

### B. What a blackline was compared against

One new function in `blacklines.ts`, `againstOf`, beside `cleanDrafts`, asks no model and reads only names, paths, and the kept cover. It finds the original:
- on a cover, the first file name it gives, with its path. This is new parsing (`namedAt` and `namedLater` find only names of files in the data room), tested on Litera's ("Original filename:"), Workshare's ("Document 1 ID file://…") and Word's compare covers, within the 1,500 characters kept;
- else B in "A Redline to B", "A blackline against B" or "A vs B" (the forms `cleanDrafts` already reads);
- else none.

It returns one of three answers, checked in this order:
- **Another project:** the blackline or its original is of another project (A), or the cover's path for the original runs through a precedents folder ("C:\Precedents\Fabrikam PPA.docx").
- **Own:** it has a clean draft, and the original is a draft of the same document: in the clean draft's family, or its name is the clean draft's once version marks, dates, status words (execution version, executed, signed, conformed, final, clean), bracket characters (never the words inside them) and the blackline words are taken off. "SPA v3 Redline to SPA v2" beside "SPA v3.docx": own. A cover of "SPA v2.docx" and "SPA v3.docx": own. A precedent saved as "PPA.docx" outside a precedents folder and compared against "PPA v3.docx" also reads as own; that cannot be told from names, and own blacklines still never settle an item or close a finding by themselves.
- **Not known:** anything else, including "SPA redline.pdf" with no cover, a standalone or unclear blackline, and an original named differently from the clean draft ("Beta SPA executed.docx" against "SPA v3.docx").

### C. Never a main source

A **secondary source** is a document of another project, or a blackline that is another project's or not known. An own blackline keeps the existing blackline rules exactly ("Tracked changes and blacklines" in decisions.md), since this rule is about redlines against another project. A citation of a blackline keeps "reading"; a citation of another project's document carries its own tag (question 1). Then:
- **Checklist item:** settled only with at least one citation of a document of this deal that is not a blackline (the rule in [`check`](../src/backend/ai.ts), now also for documents of another project). Quick checks, which skip that rule, are unchanged.
- **Finding raised by a check:** one with no citation of this deal's own documents is not raised; the item is left "more", needing "a document of this deal that shows it", as a blackline-only item already is ([`check`](../src/backend/ai.ts)).
- **Finding reassessed:** a reassessment with no citation of this deal's own documents, none at all included, is not offered; the finding stays as written, with the reason in the failure line reassess already shows ([`reassess`](../src/backend/ai.ts)).
- **Finding re-checked:** its reply carries no citations, and it only marks the finding for a person to look at ([`verify`](../src/backend/ai.ts), [`mark`](../src/backend/ai.ts)). The rule goes in what the model is told (D), both ways.
- **Q&A draft:** secondary citations do not count toward "a draft rests on a document it cites"; a draft resting only on them is "none", as a draft with no citation already is. A reused earlier response still counts, but the model's own paragraph after it is added only when it cites a document of this deal that is not secondary ([`draft`](../src/backend/ai.ts)).
- **Chat answers:** see question 2 below.

One citation of this deal's own documents is enough to pass; the app does not check that it backs each point, which would take a model's judgment.

Every secondary source takes at most two places in any pick (the parent design's cap), after the clean documents of its family where it has one, so 100 or more blacklines never crowd this deal's documents out of a call.

### D. What the model is told

`blacklineLine` gains the result of (B); a line for a document of another project is added in `send` the same way:
- **Own:** as now ("a comparison of two drafts").
- **Another project:** "D3 compares this deal's draft (its clean draft is D2) with another project's document. Its deleted wording is the other project's, not an earlier draft of this deal: never report a deletion or insertion as a change made in this deal."
- **Not known:** "D3 compares its clean draft with another document, which may be an earlier draft of this deal or another project's. Do not report a difference as a change made in this deal unless a draft of this deal shows it."
- **Blackline made on another project** (itself in a precedents folder): "D3 is a blackline made on another project; neither side is this deal's. Use it only to compare, and cite it only beside a document of this deal."
- **Document of another project:** "D4 is another project's document, not this deal's. Its terms are never this deal's: use it only to compare, and cite it only beside a document of this deal. By itself it never shows that a finding is put right or that its problem is back."

### E. Unclear blacklines

A blackline whose clean draft cannot be told, even from its folder path, name and cover, stays out of every choice, as before ([`ranked`](../src/backend/ai.ts)). A blackline misread is a far greater risk than one missed.

### F. Speed

Before this design, [`cleanOf`](../src/backend/ai.ts) was worked out again on every [`ranked`](../src/backend/ai.ts) and [`withClean`](../src/backend/ai.ts) call. With `againstOf` added, both are kept per deal and worked out again only when the deal's documents change.

## Changes to decisions

- "Tracked changes and blacklines" ([decisions.md](decisions.md#documents-and-indexing)) is edited in place: a blackline against another project, or one that cannot be told to be against this deal's own earlier draft, is never by itself the source of a settled item, a raised or reassessed finding, or a Q&A response; documents of another project (every place in a precedents folder) are treated the same and are never drafts; the model is told which of the three a blackline is.
- "Core documents" ([decisions.md](decisions.md#documents-and-indexing)) is replaced by the core-documents design; this part adds that secondary sources are never core. A blackline is not a draft, so this does not go against including a draft whose kind is unclear.

## Acceptance criteria

Tested on the repo's realistic names and the generated 1,779-file data room, with blacklines and precedents placed as a deal team would place them:
- **Own:** "SPA v3 Redline to SPA v2.pdf" beside "SPA v3.docx"; "Project Tailwind SPA v4 vs Project Tailwind SPA v3.pdf" beside v4; "EPC Contract blackline.pdf" with a Litera cover of "EPC Contract v6.docx" and "EPC Contract v7.docx"; a blackline in a dated draft folder against its earlier dated draft.
- **Another project:** a Workshare cover naming "C:\Precedents\Fabrikam PPA.docx"; a blackline against a document in "12. Precedents"; "12. Precedents/PPA blackline.pdf", which gets no clean draft from this deal (`false`), is read on its own, and is told as a blackline made on another project.
- **Not known:** "PPA redline.pdf" with no cover, and a blackline in a dated draft folder with no cover naming its original (as built, "own" needs the original to be named, by cover or by name; a date written with a month name is not yet taken off, so such a pair is not known, which is the safe side); a cover naming "Beta SPA executed.docx" against "SPA v3.docx".
- **This deal's own, not blacklines:** "Budget vs Actual Q3.pdf" beside "Budget.xlsx", "Landlord vs Tenant dispute summary.pdf" beside "Landlord.pdf", "Gas Transportation Precedent Agreement.pdf", "Conditions Precedent Checklist.xlsx", a folder "Conditions Precedent", and an executed agreement in both "03 Legal" and "Precedents". The existing blackline tests pass unchanged.
- "Drafts/2026-03-01/PPA.docx", "Drafts/2026-04-15/PPA.docx" and "Drafts/Precedents/PPA.docx": the precedent is in no family and is no blackline's clean draft.
- A deal folder named "Precedents": its documents are another project's.
- For each kind of secondary source: a checklist item, a raised finding, a reassessment and a Q&A draft citing only it are not settled, raised, offered or drafted; with one of this deal's documents cited beside it, they are. An own blackline behaves exactly as it did before this design.
- Four deals made from one data room: none of its documents becomes another project's.
- Same inputs give the same results on every PC.
- At 2,000+ documents with 100+ blacklines, `cleanDrafts` with `againstOf` under a second once per change of the deal's documents (measured: `cleanDrafts` at 237 ms for 2,150 documents and 150 blacklines), and nothing per pick.

## Questions, now decided

Beyond the redline rule, this design adds: precedent-folder documents under the same rule, a "precedent" tag, never making these sources core, treating a blackline that cannot be told to be this deal's own as against another project, and new lines that tell the model which kind a blackline is.

1. **The tag on another project's document.** A blackline's citation shows "reading". Decided: the same chip with the word "precedent", and the tooltip "Another project's document, not this deal's terms."
2. **Chat answers.** Decided: in the chat, these sources are tagged and the model is told, but it still answers from them, since a person may ask about a precedent on purpose.
3. **Unclear blacklines.** Decided: they stay unread (section E).
