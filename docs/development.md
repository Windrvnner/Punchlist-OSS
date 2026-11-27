# Development

This page explains how to build, run, and test Punchlist. The UI runs in two places: in a browser on stand-in (mock) services, called the browser demo, and in the Electron desktop app on the real backend (`src/backend/`).

## Prerequisites

You need the following:

- Node.js 22 (see `.nvmrc`) and npm
- Google Chrome at `/usr/bin/google-chrome` for browser tests. Set `PUNCHLIST_CHROME_PATH` to the absolute
  executable path when Chrome is installed elsewhere.
- LibreOffice at `/usr/bin/soffice`. `npm test` skips the tests that need it when it is missing; `npm run check:all`
  first converts a small workbook with it (`node scripts/office-check.mjs` runs that check alone) and stops if it
  cannot, then runs those tests on it rather than skip them. Two tests also need an extra part. `npm test` skips each
  one without it; `npm run check:all` and CI run them and fail without it:
  - The presentation file-name field test needs LibreOffice Impress.
  - The spreadsheet column-width test needs Calibri or Carlito; without either, it fails on a column width.

## Setup

```sh
npm ci                  # install dependencies and the pre-commit hook (lint-staged and a secrets check)
cp .env.example .env    # for live runs only: put the model key in .env, which git ignores
```

## Run

```sh
npm run dev             # run the browser demo with Vite
npm run build           # type-check and build into dist/
npm run serve           # serve dist/ on port 4178 (used by the browser tests and screenshots)
npm run desktop         # build and open the desktop app on the real backend (folders in %LOCALAPPDATA%\Punchlist)
npm run installer       # build the Windows installer into out/installer (on Windows; see vendor/libreoffice/README.md)
```

## Test and check

| Script | What it does |
| --- | --- |
| `npm test` | Runs the unit tests with Vitest: domain, Store, commands, components, repository contract, and backend |
| `npm run e2e` | Runs the composed backend end to end, on a stand-in model. |
| `npm run e2e:live` | Runs end-to-end tests on Anthropic (add `-- tests/e2e/live-agent.test.ts` to choose a file). Uses Haiku by default and needs an API key in `.env` or `PUNCHLIST_AI_KEY`. |
| `npm run ai:check -- openai` | Runs a live smoke check on an OpenAI-compatible endpoint. Substitute `claude` or `north` to check those providers. Supply the matching key or token and configure the endpoint for OpenAI-compatible or North. |
| `npm run desktop:live` | Opens the desktop app, signed in with that key when no key has been entered (`npm run desktop` ignores the key). |
| `npm run desktop:test` | Builds the desktop app and runs it end to end on temporary folders (on Linux, run `xvfb-run -a npm run desktop:test`). |
| `npm run browser` | Runs every browser suite against `dist/`, five at a time (add `-- --jobs 3 keyboard` to set how many suites run at once and which suites run), and starts its own server. `--shard 2/4` runs only the second of four groups of suites of about equal time, split by each suite's CI time in `tests/browser/suite-times.json`. |
| `npm run browser:times` | Rewrites `tests/browser/suite-times.json` from the suite times of the latest `npm run check:all`. |
| `npm run typecheck` | Type-checks with TypeScript, with no output files. |
| `npm run lint` | Runs Biome (lint only, no formatter). |
| `npm run check` | Runs the static checks and the unit tests. |
| `npm run check:static` | Runs the type and lint checks, then the source checks described below. |
| `npm run check:all` | Runs `check`, the build, browser suites, and desktop smoke and sign-in checks. CI on GitHub runs the same steps as parallel jobs on every pull request and push to `main`, and the desktop checks on Windows as well; their required checks gate merging, so a local run is optional. |
| `npm run screens` | Takes screenshots of every main screen into `out/` (add `-- 1440x900 --pdfs <folder>` for options). Needs `npm run serve`. |
| `npm run package` | Optional local release ZIP containing the app, source, and `docs/`, written to `out/punchlist-<version>.zip`. |

The app workflow test runs deal-scale imports, question drafting, folder matching, and Q&A log updates through a
Store with stand-in ports. Run the test in Node without a window.

```sh
npx vitest run tests/app/coreWorkflows.test.ts --environment node --no-file-parallelism
```

The static checks scan tracked files for secrets and attribution.
They also scan the text each branch commit adds, and its commit message, so a secret or attribution added and then
removed in the same branch still fails.
The history scan of secrets runs with `--all` (`npm run check:tracked` and CI), not in the pre-commit hook.
On `main` itself the added text of past commits is not re-scanned for attribution or secrets; the pull-request run is
the gate.
Attribution still scans the latest 200 commit messages there.
Attribution includes a role credited with a decision and an email address other than an example or no-reply one.
The readability script also lists added `src/` lines that name a guess (overlap, fuzzy, fallback, repair and the like).
After readability hints, `scripts/check-pane-of-glass.mjs` checks UI imports, service and repository access,
browser storage, cookies, the Cache API, network calls, timers, list work, loops, length limits, dates, and patterns.
A UI `import()` or `require()` call must name its module with a plain string, `require` is
used only in such a call, and UI code reads `import.meta` only as `import.meta.env`; anything else counts as an import.
Every match is listed line by line in `scripts/pane-of-glass-baseline.json`, a JSON array of allowances.
The vendor-name test and the skipped-test gate use the same format
in `scripts/vendor-names-allowance.json` and `scripts/skipped-tests-allowance.json`.
An allowance is `{ file, kind, line, count, issue }` or `{ file, kind, line, count, decision }`.
`line` is the trimmed text of the matching line, and `count` is how many times it matches in that file.
For a model name `line` is the model name, and for a skipped test it is the test's full name.
The vendor-name test reads the string literals, template parts, and JSX text of `src/ui/**/*.ts(x)` and
`src/app/**/*.ts(x)`, plus the model names each connector returns.
Code that names a provider elsewhere is not flagged.
Text written outside `src/ui` and `src/app` that can still reach a screen is not scanned, such as the control-file
startup errors in `src/control.ts` and backend error messages; the known lines are tracked in #1241.
It does not read comments, html, css, or json files, names held only in identifiers, names split by concatenation,
or names with a digit attached (`gpt4o`, `claude3`).
Exactly one of `issue` (an open issue number) or `decision` (a line of `docs/decisions.md` that is on
`scripts/verified-decisions.json`) is set.
Skipped-test entries also carry `platform` and `reason`.
`node scripts/check-pane-of-glass.mjs --list` prints the matches not yet listed, and `--lower` lowers each count to
its matches and removes entries that no longer match; neither adds an issue or decision.
`node scripts/check-allowance-history.mjs` compares each allowance file with `main`.
Every entry, whether it cites an issue or a decision, can only be kept, lowered, or removed.
So a new flagged line in `src/ui` cannot be added: it belongs in `src/app`, formatting helpers included.
An entry whose issue `main` already names cannot switch to another issue or to a decision; a decision entry can
switch to an issue.
A `decision` entry needs a decision already on `main`'s `scripts/verified-decisions.json`, so a decision verified in a
pull request cannot be used in that same pull request.
An allowance file that `main` does not have yet has no ceiling, except the pane-of-glass baseline: when `main` has no
array baseline, the ceiling is the matches `main`'s own `src/ui` has.
`node scripts/check-open-issues.mjs` runs in CI only and fails when an issue named in an allowance is not open.
If the checkout lacks the history needed for comparison, the diagnostic gives the Git command to fetch it.
`node scripts/check-skipped-tests.mjs <vitest.json>` fails on a skipped test that is not listed.
Each CI job passes its own scope, so an entry that no longer matches is reported only by the job that could see it.
A skipped-test entry with `root: true` is for a skip that happens only when the tests run as root: it excuses a
skip, and is reported when it no longer matches, only in a run as root (CI never runs as root).
`node scripts/check-skipped-tests.mjs --files` fails on a test file that Vitest never runs.
The timer, list, loop, limit, date, and pattern kinds catch only these forms:
any reference to `setTimeout`, `setInterval`, or `requestIdleCallback`;
a call of a list method named in `scripts/pane-of-glass-rules.mjs` (such as `.sort`, `.filter`, `.slice`, `.forEach`,
`.reverse`, or `.indexOf`) or of `Object.groupBy` or `Map.groupBy`;
a `for`, `while`, or `do` loop;
a comparison with anything but 0 of a plain dotted `.length` or `.size` read, or of `+` or `-` arithmetic containing
one (computed reads such as `rows['length']` and other arithmetic such as `rows.length * 2` are not caught), an
assignment to `.length`, and a numeric `maxLength`, `minLength`, `min`, or `max` attribute;
`Date.parse`, `Date.UTC`, `Date.now`, and `new Date` with arguments;
and a regex literal or a `RegExp` call.
Any other method, property, or construct is review's job, for example `.split`, `.trim`, `.startsWith`, `.pop`,
`.shift`, a method name held in a variable, `Function.prototype.call`, destructured `length` or `Date.parse`,
`performance.now`, `queueMicrotask`, plain `if` logic on state, references that are not called
(`const f = Date.now`, `rows.sort` passed as a value), and named constants.

The GitHub Actions workflow also builds the Windows installer when it is started by hand.

A new browser suite needs an entry in `tests/browser/suite-times.json` (a unit test checks the file lists every suite).
After `npm run check:all`, `npm run browser:times` rewrites the file from that run's suite times, scaled to CI speed,
and lists what changed: commit it with any pull request that adds a suite or makes one noticeably slower.
`npm run browser:times -- out/gate/<time>` takes the times of an earlier run instead.

The Store is the object that holds the app's state and runs its commands; see [architecture.md](architecture.md).

Each `npm run check:all` run writes its stage times and test results to `out/gate/<time>/`: `gate.json` (each stage's
command, seconds and exit status), `vitest.json`, `browser.json` (each suite's checks, time and re-runs) and
`smoke.json` (the desktop smoke check IDs). A change that speeds up the tests shows it keeps coverage with
`node scripts/gate-compare.mjs <before> <after>`, which prints each stage's difference and exits 1 if any Vitest test,
smoke check or stage that passed before is missing, skipped or failing after, or if a browser suite has fewer checks
or passes. It lists the browser PASS lines seen only before, since their notes can change between runs. Both folders
must be under `out/gate/`; the scripts read and write run folders nowhere else. Standalone commands write nothing
there.

### Linux test runner troubleshooting

On Linux, the browser suites' layout checks expect Inter in place of Segoe UI: install the `fonts-inter` package and
copy `tests/browser/fonts.conf` to `/etc/fonts/conf.d/56-prefer-inter.conf`, as CI does.

Run one `npm run check:all` at a time on a shared runner. CPU contention can push the checklist Retry test past
Vitest's five-second timeout and the document-family test past its one-second limit per large room. On Linux
with cgroup v2, `cat /sys/fs/cgroup/cpu.max` shows the CPU quota and period. For example, `400000 100000`
allows four cores' worth of CPU time even if the guest exposes five vCPUs. Retry these cases with one worker
when the runner is idle.

```sh
npm test -- --maxWorkers=1 tests/backend/checklistImportAi.test.ts tests/backend/related.test.ts \
  -t 'failing points are set aside|takes under a second for each room'
```

For the file-name and spreadsheet formatting tests, `/usr/bin/soffice` should point to a stable LibreOffice
installation with Writer, Calc, and Impress. The spreadsheet width check also needs Calibri or Carlito.
Verify the executable and font before the run.

```sh
/usr/bin/soffice --version
fc-match -f '%{family}\n' Calibri
npm test -- --maxWorkers=1 tests/backend/documents.test.ts tests/backend/logEdit.test.ts \
  -t 'field that prints|presentation prints|fills a cell and adds a row|keeps the column widths'
```

If a conversion or edit fails with `nothing was reported`, LibreOffice did not write the macro completion
file. A LibreOffice pre-release build can exit successfully without running the macro. LibreOffice 26.2.7.3
with Carlito passes the file-name and formatting checks (#176).

### Test hooks

The browser build runs on stand-in services (`src/adapters/mocks.ts`), with these test hooks on `window`:

| Hook | What it does |
| --- | --- |
| `store` | The app's Store |
| `__peer` | Acts as another PC |
| `__down` | Makes the services unreachable (offline) |
| `__fail` | Fails a chosen type of service call |
| `__sheets` | Stands in for LibreOffice reading a spreadsheet |
| `__oneDrive = false` | Acts as if OneDrive is not running |
| `__copies` and `__places` | Set a document's copies |
| `__sameRoom` and `__alsoIn` | Make another deal hold the same data room |
| `__addressed` | Lists the question texts the stand-in model proposes under a chat answer |

To test two copies of the code side by side, give the second copy its own port: `PUNCHLIST_PORT=4201 npm run browser -- …`.

### Screenshots

The README's screenshots in [images](images) come from `node scripts/readme-shots.mjs`, which needs `npm run serve`. The script uses the browser demo with a deal of 2,000 questions, in dark and light, at 1440×900.

The README shows every screen in light mode. Its **Dark mode** section shows the Q&A page as one looping wipe from light to dark and back (`dark-mode.webp`). Because GitHub runs no scripts in a README, the animation is made from the light and dark pair with ffmpeg:

```sh
ffmpeg -y -loop 1 -t 3 -i docs/images/qa-light.jpg -loop 1 -t 4.4 -i docs/images/qa-dark.jpg \
  -loop 1 -t 3 -i docs/images/qa-light.jpg -filter_complex "[0]scale=1200:750,fps=25[a];[1]scale=1200:750,fps=25[b];\
[2]scale=1200:750,fps=25[c];[a][b]xfade=transition=wipeleft:duration=1.4:offset=1.6[ab];\
[ab][c]xfade=transition=wiperight:duration=1.4:offset=4.6" -c:v libwebp_anim -q:v 90 -loop 0 docs/images/dark-mode.webp
```

The design reference screens in [design](design) show the same sample deal at 1280×736, one file per theme.

## Code layout

```
src/domain/    records, transitions, and invariants (pure code, with no side effects)
src/app/       the Store, commands, and orchestration
src/ports/     the interfaces between the app and the outside world
src/adapters/  browser implementations and mock services
src/backend/   the real backend on Node.js, put together in compose.ts
src/ui/        Preact components
src/shell/     wiring for the browser demo and the desktop window, and the bridge between the window and the backend
src/desktop/   the Electron main process and preload script
tests/         unit, backend, end-to-end, and browser tests
scripts/       test runners, screenshots, packaging, and the secrets and attribution checks
public/vendor/ License for the PDF.js preview and worker bundled from pdfjs-dist
```

## Documentation

The rest of the project is documented in these places:

- [architecture.md](architecture.md) explains how the parts fit together.
- [decisions.md](decisions.md) lists the decisions in force.
- [requirements.md](requirements.md) covers Windows setup, including the model provider, organization name, OneDrive folder, and checks after installation.
- [linking-design.md](linking-design.md) describes the parts, not yet built, of the design that links checklist items to findings and Q&A questions (#2).
- [deal-screen-design.md](deal-screen-design.md) holds the mock-up and screens, not yet built, of the rebuilt deal screen.
- [design.md](design.md) describes how the app looks, with reference screenshots.
- [review-prompt.md](review-prompt.md) is the adversarial review prompt for every pull request.
- The detailed contracts are the TSDoc comments in `src/ports/index.ts` and `src/backend/*.ts`, and the tests.

## Issues and pull requests

- Every bug and every Build list item (a planned feature or change) is a GitHub issue, made from the templates in the repository's **Issues** tab. A bug has the label `bug` and the issue type Bug; a Build list item has the label `build list` and the issue type Feature. There is no project board.
- Labels carry everything else: severity (`severity: major`, `minor`, or `polish`), area (`area: …`), and status. Bugs use the statuses `needs triage` and `discuss`; Build list items use `status: to decide`, `to design`, `decided`, `building`, `on hold`, and `later`.
- A fixed bug or a built item is closed as completed. Issues that are "Not an issue", "No longer applies", or "Dropped" are closed as not planned, with that label.
- Commits say `(#N)`. A pull request that fixes a bug or finishes an item says `Fixes #N`, so that merging it closes the issue. Review findings go on the pull request as review comments.
- Before a release, check its assets for unreviewed files and identifying metadata such as author fields, local paths, and build machine names.
- Before pushing commits, check that each commit's author and committer are the intended identities, using their GitHub noreply addresses.

### Batches

A batch is a Build list issue with the `batch` label that lists several fixes, each worked as its own pull request.
A batch is opened from the **Batch** template. Each fix is a sub-issue of the batch and is listed under Fixes as
a plain bullet (`- #N summary`), never as a task-list checkbox.
The batch's **How the batch is worked** section sets that batch's own rules.
These rules hold for every batch, in addition:

- Set the definition of done in the batch issue before the first pull request, with separate acceptance criteria for
  each goal, so the final status of every goal is clear.
- Open a pull request only once its design is proved to hold where the guarantee is enforced: for example, ownership
  is checked before a file is published, evidence before a finding is saved, and separate inputs stay separate before
  a draft is made. When a review exposes a wrong assumption, re-examine the design rather than patching the reported
  case. Open it as a draft at that point, so the required checks run while its independent review does.
- When a fix touches saving, write its before-and-after tests for failed writes, restarts, and edits from another
  window first.
- Apply these rules from the first pull request. Give every squash merge an explicit commit title and body, since a
  generated body can fail the attribution check (#864). Run one local test command at a time on a machine, since
  timing-sensitive tests fail under load. A pull request that reaches the round limit in
  [review-prompt.md](review-prompt.md) stays open as a draft until it is cut or split, with its blocker noted on it
  and on the batch issue.
- Test the failing case and the nearby cases that already work on `main`, so that a fix keeps the behavior around it.
- Check the files and dependencies a fix needs against the files the batch must not edit before starting it, and
  again whenever a revision changes a data contract.
- Use code, not a model, for any step a rule can decide: parsing, matching, numbering, dates and periods, sorting,
  counting, and formatting. Where a fix adds or keeps a model call, say in its pull request what language
  understanding the call needs that code cannot supply.
- Limit work in flight. When reviews keep finding the same kind of failure, open no new pull requests until the open
  ones are finished.
