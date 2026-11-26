# Architecture

This page describes how Punchlist is put together: the overall shape of the system and the rules that apply across many files. The details live in the code, in the TSDoc comments on the interfaces in `src/ports/index.ts` and at the top of each file in `src/backend/`, and the tests serve as the executable specification. Where this page and the code differ, the code is correct.

## Layers

Dependencies point inward, following these rules:

- `domain` imports only `control`, `palette`, `ports` types, and zod.
- `app` never imports `backend`, `adapters`, or `ui`.
- `adapters` and `backend` implement the ports.
- `ui` reads `domain` helpers but changes records only through `app`.
- `ui` never imports `backend`, `adapters`, `desktop`, or `shell`, and reaches services and storage only through `app`.
- `logRepository.ts` and `changeLog.ts` are bundled into the browser build, so they must stay free of Node imports.

The source tree is organized as follows:

```
src/
  domain/    zod schemas and IDs, state transitions and invariants, citation markers, spreadsheet tables. Pure: no I/O.
  app/       the Store (state, dispatch, journal, startup), commands/ (one file per area), orchestration
  ports/     the interfaces the outside world plugs into
  adapters/  browser implementations: the demo's record store and folders, local storage, mock services
  backend/   the real backend on Node, assembled by composeBackend (compose.ts)
  ui/        Preact components
  shell/     main.tsx (browser demo) and desktop.tsx (desktop window), which wire in the adapters; common.tsx registers the commands; bridge.ts is the desktop bridge
  desktop/   the Electron main process and preload script
  control.ts the control file: every value a deployment may change, importing nothing
```

The design uses no event sourcing, no CQRS, and no message bus. A command is a file with a schema and a `plan` function, a port is an interface with a handful of methods, and the Store is a single object.

## Records

- The records are deals, questions, findings, members, tombstones (a deleted record, kept so that it can be restored), operations (entries in the undo journal), each deal's checklist items, and the lists in the master checklist. Each record also has an append-only history. Their shapes are defined by the zod schemas in `src/domain/model.ts` and `src/domain/checklist.ts`.
- IDs are opaque ULIDs with a prefix for the kind of record (`d_`, `q_`, `f_`, `op_`). When two PCs can each create the same record from the same source, the record takes an ID derived from that source, so both PCs create the same record:
  - A checklist item's ID (`i_`) is derived from the deal and the item's wording.
  - Each list in the master checklist has an ID (`l_`) derived from its layer and name.
  - An imported question's or issues-list finding's ID is derived by `derivedId` (`src/domain/derivedId.ts`).

  A derived ID is fixed when the record is created: edits and renumbering never change it. A question's number is display data only.
- Every record has a revision number, `rev`, that only increases. A write must name the `rev` it read, or it is refused as a conflict.
- Text keeps its line breaks, as the file or the person wrote them. Dates are `YYYY-MM-DD` or empty, and timestamps are full ISO 8601.
- Records keep any fields that the current build does not recognize. A record from a newer schema than `CURRENT_SCHEMA` is read-only. A record and the journal line that carries it are marked with the lowest schema that holds their content (`schemaOf`, `lineSchema`), so only records with a newer field, such as a draft's citation boundary, are read-only to an older build.
- Status and response changes go only through `src/domain/transitions.ts`, which commands call and the UI never does. Only a command that a person triggered changes a record's state. The backend adds findings and may mark a finding "to reassess", and nothing more.

## The Store and commands

Everything that changes a record is a command (`src/app/command.ts`, `src/app/commands/`). Every command must be registered in `COMMANDS` (`src/shell/common.tsx`), because the Store looks up follow-up commands and retries by name. A command has:

- An input schema
- A `targets` function that names the records it writes
- A pure `plan` function that returns either a rejection or the result: the writes, the history entries, an inverse command for **Undo**, a message, and an optional effect

`Store.dispatch` (`src/app/store.ts`) handles a command in this order:

1. It validates the input.
2. It waits behind any earlier operation on the same records.
3. It plans against the current state, and refuses writes to records that are in two versions or that come from a newer build.
4. It records the operation as pending in the journal: the undo journal kept on each PC, which holds operations for **Undo** and for recovering interrupted work.
5. It commits the writes in one repository transaction. A plan can also list records it only read (`expects`); the transaction is refused if one has changed since.
6. It settles the journal entry.
7. Only then does it apply the result to the state.

There is no optimistic state: the screen never shows a change that the repository has not accepted.

- Work that needs a service after the commit, such as an AI call, is an effect whose only output is a follow-up command, for example `RequestDraft` followed by `ApplyDraft`. A late result is dropped when it is planned, because it names the request it answers. A draft that can't be written yet is kept and retried, never dropped (`Store.waitReply`).
- **Undo** runs the stored inverse command as a normal operation, and is refused if the records have changed since.
- Startup moves through stages (`session`, `deals`, `journal`, `ready`), and recovery re-enters at the stage that failed. Operations that a crash left pending are offered with **Retry** and **Discard**. **Retry** waits for other saves, loads its target records, and checks their original revisions. It then reuses the interrupted entry with its current journal revision until the result is durable.
- A save that couldn't be written stays pending in the journal and is offered again, including after a restart. The app never re-runs a person's action by itself, with one exception: once the app is connected again, it saves a field's own typed text.
- `FieldSave` (`src/app/fieldSave.ts`) remembers the value that a field's text was typed over, sends saves, and keeps
  the draft through refusals and changes from elsewhere. `EditField` shows **Keep Mine** and **Take Theirs** when
  the app needs the person to choose.

## The control file

The control file, `src/control.ts`, holds every value a deployment may change: the firm name, the model service and its models, sign-in, limits, timings, default lists, every color, and the desktop settings. Each value has a note and an allowed range. `assertControl()` runs first in the browser shell, the backend, and the build, so a value outside its range stops the app with a message that names it. Because the control file is part of the source, a changed value takes effect only after the app is built again.

## Ports and adapters

A port is an interface through which the app reaches something outside it, and an adapter is an implementation of a port. The ports in `src/ports/index.ts` are `Repository`, `AiService`, `DocumentService`, `FileSystem`, `SpreadsheetCodec`, `Session`, `LocalStore`, `Clock`, and `Ids`, plus the optional `ConversationStore`, `SharedPlace`, `AiSignIn`, and `QaLogFiles`. Together they form one `Services` object. Fallible operations generally return a `Result`, either `ok` or a typed failure such as `conflict`,
`unreachable`, or `storageFull`. Optional ports can provide a feature or replace a local fallback.

The app owns the business rules: statuses, numbering, links, **Undo**, import, and export. Every change reaches the backend as one `Repository.transaction`. There is one `Repository`, the backend's `LogRepository`, which has no Node imports. The browser demo runs it on folders in the window's storage (each browser tab acts as a separate PC), and the tests run it on folders in memory, against the contract tests in `tests/adapters/contract.ts`.

## The backend

`composeBackend` (`src/backend/compose.ts`) builds the backend and returns `repo`, `ai`, `docs`, `session`, and `conversations`. The end-to-end tests use the same function, so what they run is what ships.

**Model service.** The app reaches providers through `ModelService` in `src/backend/service.ts`. The `models.service`
setting chooses North, a direct OpenAI-compatible or Claude API, a custom model gateway, Azure OpenAI, Bedrock, or
Vertex AI. The gateway and Azure reuse the OpenAI-compatible connector, and Bedrock and Vertex use the Claude Messages
connector with a provider-specific transport. [Windows setup requirements](requirements.md) describes each route. Everything
above the interface is tested against `StandInService`, and each connector is tested against a stand-in. A connector
reports a lost connection, timeout, rate limit, or server error as `unreachable` so a check waits and resumes.

**Limits and retries.** `src/backend/limits.ts` holds each model's output and input limits (taken from the control
file, and lowered where the service reports a smaller limit) and the two errors that every connector throws in the
same way: `cutoff` and `toolong`. `src/backend/parts.ts` sizes work on many items so that each part fits, and halves
the parts after a reply is cut off. Every model call goes through one retry policy (`src/backend/retry.ts`): two more
tries, with a doubling wait, for an empty reply or for a failure that resending can fix (that is, not unreachable, cut
off, too long, or a 4xx error). Every call gets these retries, however many calls before it failed.

**Desktop shell.** The desktop app is an Electron app. The main process (`src/desktop/main.ts`) assembles the backend and serves it to a single window across a bridge. The window runs the same Store and UI as the browser demo.

- `src/shell/bridge.ts` lists every method the window may call, and the main process refuses anything else. The window has no access to Node or to file paths (context isolation and the sandbox are on). PDF pages are served by token, never by path.
- Bridged service calls resolve to a `Result`. An unreachable main process produces `unreachable`. A thrown method
  produces `failed`.
- After saving a snapshot of kept drafts, the window asks the main process to flush local storage to disk (#825).
- Everything the PC keeps is stored in `%LOCALAPPDATA%\Punchlist`. The shared folder is the one connected on this PC, recorded in `settings.json`. A PC that has never signed in shows the sign-in page first. Then, until a folder is connected, it shows only the connect page (`src/ui/connect.tsx`), which finds the team's Punchlist folders in OneDrive by itself (`teamFolders` in `src/desktop/host.ts`).
- Each install has an ID for each shared folder (`install.json`, written twice so that one copy is always complete) and its own undo journal (`ops-<id>.json`).
- Sign-in (`src/desktop/signin.ts`) accepts an API key or single sign-on, as the control file allows. The token is stored encrypted with Electron's `safeStorage`. While nobody is signed in, the app is read-only (`Store.readOnly`), and calls already under way wait for a sign-in.

## Storage shared between PCs

The shared store is a directory of files. OneDrive syncs those files between PCs in the automatic setup. A person
can select a different folder manually. The Windows sync status still checks for the OneDrive process (#111).
The code is in `src/backend/logRepository.ts` (files) and `src/backend/changeLog.ts` (turning lines into records),
with a record's current versions in `changeLogHeads.ts` and the folding of drafts in `changeLogDrafts.ts`.

- **Each PC appends only to its own files**, one line per transaction, in `changes-<install>-<deal>-<n>.jsonl` files that are split per deal and capped at 1 MB each. No file is written by two PCs, so OneDrive never has to reconcile one. A line read twice counts once.
- **State depends on which lines are present, not on their order.** Each record is a graph of versions, and each version
  names the versions it was based on. Two current versions that differ are a clash, which is kept for a person to
  resolve; the app never picks one. A question's draft is written by the app, so it folds into a person's change rather
  than clashing with it (`DraftFold` in `src/backend/changeLogDrafts.ts`). Any field that two PCs can write differently
  for the same content (a timestamp, who made the change, or the model's workstream choice) must be listed as a
  bookkeeping field in `src/domain/versions.ts`. Otherwise, records with derived IDs clash when they should not.
- **Clashes stay local to one record.** A line built on a version that hasn't arrived yet is held back until that version arrives, without pausing the rest of the deal. A held line more than a day old is let go and shown as a choice (`letGoStuck`).
- **Nothing is thrown away.** Every version that is not kept becomes a deletion entry under **Deleted** (`src/app/commands/keptVersions.ts`). When a deal is deleted on one PC, another PC keeps any changes the deleting PC hadn't seen, as a recovered copy (`src/domain/recovered.ts`).
- **A local copy guards against sync loss.** Each PC keeps its own files outside the synced folder, and restores any lines that the shared copy loses, even when the shared folder lost all of them and the PC lost its install files too.
- **The undo journal never leaves the PC.** Its entry is checked before a line is written and settled afterward, so a save that is cut off stays pending. A damaged journal is set aside, and its complete entries are still read.
- **Files are written safely.** A file that is replaced in full is written beside the old file, flushed, and then moved over it. When a sync client or virus scanner holds a file, the app waits briefly for it.
- **A copied install is detected**, and it stops writing.
- At startup, the app reads the list of deals first and each deal's files in the background. A deal that a person opens moves to the front of the queue.

The Store keeps clashing records in `state.conflicts`, shows them side by side (`src/ui/conflict.tsx`), and refuses any write except the person's choice (`ResolveConflict`). `sameContent` and `distinctVersions` in `src/domain/versions.ts` define what counts as "the same" and the order that every PC agrees on.

Some things are left out on purpose: a coordinator, edit leases, host handover, and compaction. The design relies on OneDrive behavior that can't be tested here: programs can write in the synced folder, changes arrive within a minute, and a file changed in two places is kept as two files.

## Documents and indexing

The code is in `src/backend/documents.ts`, `convert.ts`, `officeText.ts`, `wordIndex.ts`, `families.ts`, `blacklines.ts`, `core.ts`, and `storeKeeper.ts`.

- **Linked data room files are read in place.** The backend shares document records in per-PC
  `docs-<install>-<deal>.jsonl` files. Files attached directly to a deal can be copied into the shared folder under
  `attachments/`. Files attached from Home are kept with that person's conversations.
- **A document's ID is derived from the SHA-256 hash of its bytes** (`docIdFor`), so every PC gets the same ID, and a citation opens the document by its content or not at all.
- **Everything with pages becomes a PDF**, so the page cited is the page shown. LibreOffice does the conversion without a window, with its own profile, and shows tracked changes as markup. Spreadsheets stay in their own format and are cited by sheet and cell.
- **Indexing asks no model and uploads nothing.** Supported files that can be read are fingerprinted and page-counted. Their words go into this PC's own word index (`wordIndex.ts`), which ranks by name and path, title, and BM25 on the body text. Text in Word and PowerPoint files is read straight from the file.
- **Folders are checked again** every `timings.folderCheck` without opening any files (`freshen` in `src/app/folderWatch.ts`). A folder that has changed is indexed again once its listing stops changing.
- **A document leaves a deal only when a PC sees that it has gone** (`spot` in `documents.ts`):
  - A folder that is out of reach, empty, or closed to this person removes nothing.
  - A PC speaks only for its own copy of a folder. Once at least `limits.sameFolder` (70%) of the folder is unchanged, it also speaks for PCs that haven't read the folder for `timings.folderIdle` (30 days).
  - A file that is simply missing is removed only if a read a day or more later still doesn't find it.
- **Drafts form families** (`families.ts`), grouped by name across dated sibling folders or by explicit version marks. The newest draft is read first.
- **Blacklines** (`blacklines.ts`) are always sent with their clean draft, and their citations are marked as the model's reading.
- **Core documents** (`core.ts`) are each checklist item's top documents by name, path, and words. They are worked out in the same way on every PC, with no model. See [core-documents-design.md](core-documents-design.md).
- **Uploaded files have a retention limit.** On routes with a provider file store, the app uploads documents when
  first needed and removes its least recently used files when it exceeds `limits.storedFiles` (500 by default).
  Inline routes cache documents locally.

## AI calls

The code is in `src/backend/ai.ts`, `agent.ts`, and `lenient.ts`.

- **There is one way of asking.** The app picks a handful of documents (`limits.docsPerCall`, 8 by default), uploads them or sends them inline according to the provider route, asks a question, and reads a JSON answer.
  Larger sets of documents are batched across calls.
- **Picking the handful.** A keyword ranking with no model (by paths, words, summaries, and synonyms) comes first, and then the fast model picks from the top results. Before that, the checks have the fast model write searches for each item to run against the word index (`searchFor`).
- **The deal is the retrieval boundary.** A question on a deal reads only that deal's documents.
- **Nothing unverifiable is passed on.** Replies are read leniently, but a citation is kept only if it names a document that was sent and a page that document has.
- **Model tiers.** The fast model sorts and the standard model answers. For automated checks, Thorough is a fallback
  after Standard fails twice. Chat can use Thorough if it is enabled in the picker.
- **The chat agent** (`src/backend/agent.ts`) works in turns on the model the person chose, calling its `search`, `read`, `folder`, and `brief` tools until it answers, within `limits.chatTurns` turns. Before its first turn, code attaches the files given with the question (a finding's own documents among them) and searches everything once with the question's own words; after that the model chooses each tool and what to search. Searches of findings and Q&A match words in code, and a document search is run by a helper on the fast model. `brief` returns each deal's brief on its open findings (`dealBrief`), written once until a finding changes. Its steps are shown live and kept with the answer. The checks hand what they would otherwise leave as a gap to the same agent.
- **No model call starts on a timer.** Background retries only continue work that a person or an event started.

## Checks, and how PCs share them

The first pass checks a deal's documents against the checklist once the deal's folders finish indexing. A person can ask for another check, either quick or deep. Each item comes out as satisfied, a finding (with a source that opens), a gap, or not settled, and a run never stops to ask anything (`firstPass` and `checkAll` in `src/backend/ai.ts`).

Results go into per-PC `checks-<install>-<deal>.jsonl` files, ordered by a running number rather than by the clock, so every PC shows the same results. Each check runs as a round (`src/backend/rounds.ts`): one shared run of checks on one deal, which every PC with the deal can take part in. The PC that starts a round writes the list of pieces of work. Each PC works out its own share from the same lines, using rendezvous hashing over the members that are active. Work that costs a model call is claimed first, and a member that is quiet for 15 minutes has its work taken over. If every member leaves a round, any PC that has the deal open and holds its documents finishes it. Two PCs that open a round of the same kind while out of sync merge them into the round with the lower id; a batch still running in the merged round writes its results for the kept round, even once that has ended, unless a later round has begun.

New documents or responses go to the fast model, which says what they could change, with the standard model confirming any doubts, before a finding is marked to reassess.

Every issue that an outside advisor raises in a report becomes a finding, whether or not a checklist item covers it (`src/backend/reports.ts`, `reportRead.ts`, `reportsKit.ts`). After a round or first pass, and once each time a PC starts, a background sweep runs in two steps. First, the fast model sorts paths it has not seen into reports. Then the standard model reads the newest draft of each report, with the deal's findings in view, so that an issue already covered cites the existing finding instead of raising a new one. Each step is claimed and logged in the deal's check log, in the same way as describing documents. A finding's ID is derived from the deal, the report, and the issue's title, so two PCs raise the same record.

## Checklist items and links

A deal's checklist is made up of its own item records, linked to the findings and questions that bear on them (#2). The code is in `src/domain/checklist.ts`, `src/app/commands/checklist.ts`, `src/app/checklistImport.ts`, and `src/app/state.ts`. What is not built yet is described in [linking-design.md](linking-design.md).

- **The master checklist's lists** are one record per list (kind `firmList`, with an `l_` ID derived from its layer and its name's key), so two different lists brought in at the same time never clash. The content of a version is its items, in order. The name as typed, the file, and who brought the list in are bookkeeping fields. While a list is in two versions, deals get only the items that every version holds (`usableFirm`), and bringing the list in again is refused until a person chooses a version.
- **A bring-in** (bringing in a list from the master checklist) adds the new items to every deal that uses the list and is not marked Closed. "Undo all" first restores the list. If that is refused (because the list has changed since, or another PC brought in the same items), it undoes nothing else. Otherwise, it then undoes each deal's additions, leaving turned on any item that another of the deal's lists holds (`undoBringIn`).
- **A deal's items** (kind `item`) are only ever added, never removed. An item's ID is `i_` derived from the deal and its wording's `key()` (`norm()`, with case folded and any trailing period removed), so the same wording added on two PCs is one item. The wording, `from` (the list and its `rev`), and the section are bookkeeping fields. Turned off (`off`) is the only field a person sets, and a write of bookkeeping fields alone folds into a concurrent change of `off` (#19).
- **Items are added** when a deal is created; when a deal gets a new structure, sector, or technology (in the same change); by a bring-in; and by "Add them" when the master checklist's lists hold items the deal lacks. "Add them" is offered only on a loaded deal that is not marked Closed and not in two versions, and only while this PC's copy of each list the items name is at least as new as the `rev` they name (`offeredItems`). Picking another list swaps lists: items that only the old list held are turned off and marked `offBySwap`, and they are turned back on when a list that holds them returns.
- **Order:** Items are ordered by layer (general, structure, sector, technology), then in the order of the master checklist's lists for that layer (`orderItems`). An item whose wording is not in the current master checklist lists for the deal's layers shows an icon (`unlistedItems`).
- **The Checklist page** reads its rows, groups, filter counts, each gap's searches and each turned-off item's findings
  from `src/app/checklistView.ts`.
- **The checks** read a deal's items that are turned on, in this order. A deal with no items is checked against the checklist the backend was given.
- **Links:** A question records the item it was asked for (`linkedItem`), which is set by **Ask the Counterparty** and **Add All Unresolved to Q&A…**. A finding raised by a check records its item (`itemId`). A check matches a problem to a finding by its item, never by its title, and a reworded item is a new item. A finding names its item by that ID or, failing that, by the check line that names it (`findingItem` in `src/app/state.ts`).
- **An item's standing** (`state.ts`) is worked out as follows. Items that are turned off are left out of the counts.
  - An open finding on the item makes it **Flagged**.
  - If a person closed that finding, the item is **Resolved by a person**.
  - If that finding was deleted, the item is **Finding deleted**, and it still needs to be resolved.
  - Otherwise, the item shows the check's result: **Satisfied**, **Gap**, **Not settled**, or not checked.
- **Close This Question** and the bulk close share `CloseSettledQuestions`. The app rereads the rows just before planning.
  If any selected question is no longer settled, none are closed. Each close is one change with one **Undo**.
- **Add All Unresolved to Q&A…** (`AddUnresolved`) reads the rows again before writing and applies one change with one
  **Undo**. The fast model phrases a question for each gap or open finding that has no linked question. It works in
  parts sized by `inParts` and asks again, one at a time, about any points that failed. Points still without a question
  are counted and offered with **Retry**.

## Q&A log, imports, and the memo

- **The Q&A log** (`src/app/qaLog.ts`, `src/backend/qaLogs.ts`) is the team's own spreadsheet; the deal records only where it is. An update reads the log as it is, works out the cells to change (`logWrite` in `src/domain/logWrite.ts`, which finds each question's row with the import's own lookup, `matchQuestions` in `src/domain/qaMatch.ts`), and writes them into a copy (`editLog` in `src/backend/spreadsheets.ts`). It then checks that only those cells changed, archives the old version, and saves the copy over the log (`src/backend/qaLogFolder.ts`).
- **Q&A import** reads and proposes a table layout through `src/app/transfer.ts`. Its preview uses prepared dates
  where available. `src/app/qaImport.ts` submits the prepared rows through `ImportQuestions`. That workflow resumes retained
  submissions by their journal correlation and finishes the saved log choice.
- **The master checklist** is brought in pasted or from a file, read line by line by the model, and tied out so that every line is accounted for (`src/app/listRead.ts`, `src/domain/listRead.ts`). Its items go to every deal that uses the list and is not marked Closed, with one **Undo** for all of them.
- **An issues list** is attached and read through `src/app/issuesList.ts`. The model reads the file once, then proposes
  titles and matches (`issuesList` in `src/backend/ai.ts`). The preview and import command resolve the same matches
  through `src/app/issuesListJoins.ts`.
- **An import in progress** (the file, the model's reading, the choices, and the check marks) is kept on each PC,
  part by part, through the `KeptImports` port. Both shells use the IndexedDB adapter. `src/app/keptImports.ts` keeps
  the parts and coordinates Q&A submission checkpoints. A submission reaches the store before its operation starts
  and keeps a unique journal correlation until both the rows and its Q&A log choice are finished. Reopening resumes
  that submission without appending its rows again.
- **The deal memo** (`src/app/memo.ts`, `src/domain/memo.ts`, `src/domain/memoDoc.ts`) asks the model only for the summary and each open finding's rating. Everything else is worked out from the records, and LibreOffice turns the result into Word and PDF files.

## Conversations

A conversation belongs to one person and follows them between PCs. `src/backend/conversationLog.ts` keeps finished messages in per-PC `talk-<install>-<n>.jsonl` files in the shared folder, separate from the records, because a conversation never needs a choice between versions.

## UI rules

- Components read state with `useAppState()` and change records only through `store.dispatch(Command, input)`.
- `EditField` (`src/ui/editField.tsx`) is the only editor. Anything that syncs the DOM to the state runs in a layout effect, so it can't overwrite typing.
- Only one modal is open at a time (`Modal` in `src/ui/dialogs.tsx`). Whatever takes the focus gives it back, and the app moves the focus only for keyboard users (`lastInput` in `src/ui/hooks.ts`).
- Every menu uses `useDismiss`, and `src/ui/docName.tsx` is the only way a document's name is shown.
- Colors come only from the control file's three base colors. `src/palette.ts` works out every color token from them, and `paletteProblems` checks text contrast. The stylesheet only mixes soft tints from the tokens. The build targets Chromium only, so it has no `-webkit-` duplicates of standard properties.

## Tests

| Folder | What it covers | Run with |
| --- | --- | --- |
| `tests/domain`, `tests/app`, `tests/ui` | Transitions, command plans, the Store, and components | `npm test` |
| `tests/adapters` | The `Repository` contract | `npm test` |
| `tests/backend` | Each backend module, on real temporary folders and a stand-in model, with two and three simulated PCs | `npm test` |
| `tests/e2e` | The assembled backend end to end; the live tests (`npm run e2e:live` only); the AI check on a stand-in for each service | `npm run e2e`, `npm run ai:check` |
| `tests/browser` | Workflows in the built app with Playwright, in both themes | `npm run browser` |
| `tests/desktop` | The bridge, the built Electron app, and the sign-in window | `npm test`, `npm run desktop:test`, `npm run desktop:signin` |

The following can't be tested here: OneDrive itself, the real model service, and the installer.

## Known limits

- The installer needs Windows (or Wine) to build, and it isn't signed. Shipping LibreOffice needs a Windows copy of it in `vendor/libreoffice`.
- `composeBackend` doesn't yet pass `usage` through to the AI runners.
- There is no migration code: a record that needs a newer schema is read-only.
- A component that throws an error while rendering is not caught.
- When two people sign in to one PC, each runs their own copy of the app.
- A damaged line holds back whatever was built on it, and this is shown in the connection card.
