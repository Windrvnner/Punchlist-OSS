# Punchlist

Punchlist is a Windows desktop app for deal due diligence. It checks data room documents against the master checklist
and cites supporting sources. It uses TypeScript, Preact, Node.js, and Electron. The browser build uses mock services
so development and testing can run without model credentials, OneDrive, or Windows.

CLAUDE.md and AGENTS.md contain the same text for different coding tools. Change both together.

## Where to look

Start with these documents:

- [README.md](README.md) describes what the app does.
- [docs/development.md](docs/development.md) covers setup, scripts, the code layout, test hooks, and how issues and pull requests work.
- [docs/architecture.md](docs/architecture.md) explains how the app works, including how to add a command.
- [docs/requirements.md](docs/requirements.md) lists what you need to run the Windows app.
- [docs/decisions.md](docs/decisions.md) lists the decisions in force.
- [docs/design.md](docs/design.md) describes how the app looks. Read it before you work on any screen.
- [docs/linking-design.md](docs/linking-design.md) describes the parts, not yet built, of the design that links checklist items to findings and Q&A questions.
- [docs/review-prompt.md](docs/review-prompt.md) is the adversarial review prompt for every pull request.
- The repository's **Issues** tab tracks every bug and every planned feature. The planned features make up the Build list.

## Commands

These commands need Node.js 22, Google Chrome at `/usr/bin/google-chrome`, and LibreOffice at `/usr/bin/soffice`. Tests that need LibreOffice are skipped when it is missing, except under `npm run check:all`, which checks LibreOffice first and fails without it.

```sh
npm ci                                       # install dependencies and the pre-commit hook
npx tsc -p . --noEmit                        # type-check
npx biome lint --diagnostic-level=error .    # lint (errors block commits)
npx vitest run [path/to/file.test.ts]        # unit, backend, and end-to-end tests, or one file
npm run check                                # type-check, lint, secrets check, readability hints, and unit tests
npm run build                                # build into dist/
npm run browser -- --jobs 2 [suites]         # browser suites against dist/ on port 4178 (set PUNCHLIST_PORT to change it)
npm run check:all                            # everything CI runs, including the desktop app, on this machine
npm run e2e:live [-- tests/e2e/live-agent.test.ts]  # live tests on the real model (paid): only when asked for
npm run ai:check -- <openai|claude|north>    # the AI check on a live service, with the key in PUNCHLIST_AI_KEY: only when asked for
```

- `npm run check` takes about 10 minutes. Timing-sensitive tests fail on a busy machine (for example, `tests/e2e/split.test.ts` occasionally; see #131). Re-run a failing file on its own before you treat the failure as real. The browser runner automatically re-runs a suite that fails under load, this time on its own with no other suites running.
- CI on GitHub runs the steps of `npm run check:all` as parallel jobs on every pull request and push to `main`. Its
  required checks (`check`, `desktop`, `desktop-windows`, and `browser (1)` to `browser (4)`) are the test gate for
  merging; a local `npm run check:all` is optional. Start or re-run the workflow on GitHub whenever it helps. Run
  `npm run package` only when every test passes.

## Code

- **Readable code.** Every change must be easy for a person to review on GitHub. New or changed code that breaks the rules below is a review blocker, just like lost work or a crash. Code that a pull request did not touch never is.
  - Put one statement on each line, and keep lines to 120 characters at most, comments included.
  - Keep new functions to about 60 lines and files to about 500. Don't grow a function that is already past that limit; add a named helper instead.
  - Names say what a thing is. Use single-letter names only in short lambdas and loop counters.
  - Put a new special case in its own named helper, with a comment that names its decision or issue, rather than adding another branch to a long function.
  - Copy nothing (share the code instead), and leave no dead code (remove it). Comment anything that isn't self-explanatory.
  - Lines that a change touches follow these rules. Untouched code is left alone, and the formatter stays off. Older code is brought up to these rules in separate, behavior-neutral cleanup pull requests.
  - `npm run check` lists changed lines over 120 characters and new functions that are too complex, compared with the branch's merge base with `main` (`scripts/check-readability.mjs`). It does not fail on them.
- **Reuse before building.** Rework an existing screen, dialog, component, or piece of code rather than building something new, and name what you reused.
- **Keep it simple.** Use the plain approach and the tools already in the app. LibreOffice ships with the app, and spreadsheets go through it. Take dependencies only from npm or GitHub.
- **Send deal PDFs whole for AI analysis.** Send the original file so the model can read the pages directly.
  Word counts may be used to rank and pick documents. See docs/decisions.md for the planned handling of PDFs that
  the model service refuses as too large (#119) and the current checklist import behavior.

## Commits and pull requests

- Never commit or push directly to `main`.
- Do each task on its own new branch (for example, `feat/short-description`) and open a pull request into `main`.
- Merge a pull request only after its adversarial review and once the required GitHub checks pass on its latest
  commit, following the merge order. Squash-merge it on GitHub, then delete its branch.
- If a pull request makes existing documentation inaccurate, update the affected documentation in that pull
  request before merging.
- Before merging, require an independent adversarial review for the smallest fix, bugs, oversights, and weak tests.
  Every reviewer, whatever the tool, uses [docs/review-prompt.md](docs/review-prompt.md).
- No attribution anywhere in the repo: code, docs, commits, pull requests, and issues never say who asked for,
  decided, or said something (names, "the owner wants", "the maintainer asked", quotes of the user, or notes that
  carry a person and a date) and carry no AI attribution trailers. Product terms and data fields such as `owner` are
  fine. State decisions plainly ("Decision: X"). Attribution blocks a merge, like lost work.
- Clean contributions: everything written to GitHub (issues, comments, pull requests, reviews, commit messages,
  docs, and code comments) follows ordinary open-source hygiene. It carries no personal information, no internal or
  private links, no references to non-public systems or services, and no text copied from third-party documentation.
  Wording stays provider-neutral, since the app supports several model providers. Changes are described in technical
  terms. A breach blocks a merge, like attribution.
- Commit at each natural stopping point. Each commit has about 100 changed lines at most, an accurate plain-English message, and `(#N)` for its issue. A pull request that fixes a bug or finishes an item says `Fixes #N`.
- Every issue fills in its template in full (`.github/ISSUE_TEMPLATE/`), sets its issue type, and carries its type label (`bug` or `build list`), a severity label, its area labels, and its status label, as in docs/development.md.
- Use the contributor's own Git identity for commits. No AI-tool attribution, footers, or links to AI chat sessions
  appear in commits, pull requests, issues, or comments. `scripts/check-attribution.mjs` (part of `npm run check`)
  enforces this for tracked files and the branch's commit messages.

## Secrets and the model key

- The Claude API key for live tests lives only in the git-ignored `.env` file, as `PUNCHLIST_AI_KEY=…`. Never print
  it, commit it, zip it, or put it in any output. Other tools and test runs never read `.env` or anything under
  `~/.config/`.
- Only `npm run e2e:live`, `npm run desktop:live` (both set `PUNCHLIST_LIVE=1`), and `npm run ai:check` use the key;
  every other run ignores it. Never export `PUNCHLIST_LIVE=1` in a shell. Never export `PUNCHLIST_AI_CHECK` in a
  shell either: with it set, every plain test run includes the paid AI check (`vitest.config.ts`). `npm run ai:check`
  reads `.env` only for the Claude backend. Live runs make paid calls, so they are rare. Claude sends every tier to
  Haiku by default. `PUNCHLIST_LIVE_ROUTING=1` routes each tier to its configured Claude model.
- A pre-commit check (`scripts/check-secrets.mjs`) blocks keys and `.env` files.
- The end user manages security around the app (network, sign-in, and devices). Don't over-engineer it. The app's own basics still hold: no secrets in the repo, careful input handling, robust error handling, and self-recovery.

## Product rules

- Lost work comes first. Anything that can lose what a person typed or chose is fixed before anything else.
- Only a person changes a record's state; the app and the model propose. Big actions, including deletes, ask first in the app's own confirmation dialog and keep their **Undo**. Deleting a deal asks twice and has no **Undo**.
- Screens carry no explainer or helper text; explanations go in tooltips. Use en-US throughout.
- The look follows Perplexity, Harvey, and Apple, in glass: no generic AI look and no thin full-height lines down a left edge. Match the existing screens and never regress them.
- Mock up any UI first, in dark and light, at 1280x736 and 1024x640, and check it both by script and by eye.

## How decisions are made

- Read the README and `docs/decisions.md` before changing anything. Check `docs/decisions.md`, `docs/architecture.md`, and the code before proposing anything, and say what already exists. Follow a settled decision and say where it was decided. Still ask first about a major design decision, even when it looks settled.
- Check claims before making them. File a bug only once it is reproduced on the current build. Close a UI bug whose element no longer exists as not planned, with the label `no longer applies`.

## Documentation and decisions

- All documentation is Markdown in this repo, never in hosted document tools, web pages, or spreadsheets. Docs describe the app as it is now; how it got there lives in issues, pull requests, and git history.
- A decision goes in `docs/decisions.md` as one or two present-tense lines with its issue or pull request, for example: "A finding's stripe is red while it is open and gray once closed." Reasoning goes in the issue or pull request, not in the decision.
- Issues, comments, pull requests, and docs never attribute a decision or ask to anyone and never date a decision.
- A changed decision replaces its line in place, here and in the other docs. Old plans are not kept.
