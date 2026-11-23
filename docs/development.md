# Development

This page explains how to build, run, and test Punchlist. The UI runs in two places: in a browser on stand-in (mock) services, called the browser demo, and in the Electron desktop app on the real backend (`src/backend/`).

## Prerequisites

You need the following:

- Node.js 22 (see `.nvmrc`) and npm
- Google Chrome at `/usr/bin/google-chrome` for browser tests. Set `PUNCHLIST_CHROME_PATH` to the absolute
  executable path when Chrome is installed elsewhere.
- LibreOffice at `/usr/bin/soffice`. `npm test` skips the tests that need it when it is missing; `npm run check:all`
  first converts a small workbook with it (`node scripts/office-check.mjs` runs that check alone) and stops if it
  cannot, then runs those tests on it rather than skip them. Two tests still skip without their extra part:
  - The presentation file-name field test also needs LibreOffice Impress.
  - The spreadsheet column-width test also needs Calibri or Carlito.

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
| `npm run browser` | Runs every browser suite against `dist/`, five at a time (add `-- --jobs 3 keyboard` to set how many suites run at once and which suites run), and starts its own server. `--shard 2/4` runs only the second of four groups of suites. |
| `npm run typecheck` | Type-checks with TypeScript, with no output files. |
| `npm run lint` | Runs Biome (lint only, no formatter). |
| `npm run check` | Runs the type-check, Biome, the secrets check and the AI-attribution check on every tracked file (the attribution check also reads the branch's commit messages), readability hints for the changed code (never failing), and the unit tests. |
| `npm run check:all` | Runs `check`, the build, browser suites, and desktop smoke and sign-in checks. Run it before every merge. CI on GitHub runs the same steps as parallel jobs on every pull request and push to `main`. |
| `npm run screens` | Takes screenshots of every main screen into `out/` (add `-- 1440x900 --pdfs <folder>` for options). Needs `npm run serve`. |
| `npm run package` | Optional local release ZIP containing the app, source, and `docs/`, written to `out/punchlist-<version>.zip`. |

The GitHub Actions workflow also builds the Windows installer when it is started by hand.

The Store is the object that holds the app's state and runs its commands; see [architecture.md](architecture.md).

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
