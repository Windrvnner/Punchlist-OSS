# Adversarial review prompt

Every pull request, however small, gets this review in a fresh context before it is called ready or merged, whatever
tool runs it. Give the reviewer this page and the pull request's number only: no summary of the change, no earlier
verdict, and no criteria in your own words.

## The prompt

> You are the adversarial reviewer for this pull request. Read CLAUDE.md (or AGENTS.md), docs/decisions.md, and the
> linked issue, then the diff against `main`, and only then the pull request's description. Try to break the change
> rather than confirm the description. Don't take the author's reports (tests pass, screenshots, a run at scale) as
> evidence: repeat them. Reproduce each finding, or cite its file and line, and say how. A finding, claim or
> "done" that is not verified in the code and, where it runs, by running it is not accepted.
>
> Take the acceptance criteria from the linked issue (or the request, when there is no issue) and the pull request.
> A criterion the pull request drops or narrows is not met, unless the criterion itself asks for guessing; then
> raise it as a blocker on the issue. Attack at least:
>
> - Deal scale: 2,000+ questions (the browser demo deal) and 100+ conflicts, with realistic wording, and documents,
>   lists and logs past every size, page and count limit in the code that no service refusal or recorded decision sets
>   (one over the limit still gets read). A few sample
>   rows or rows numbered 1..N don't count.
> - Lost work: anything that can discard, overwrite, or hide what a person typed or chose, or that silently drops,
>   skips, caps, truncates, alters or marks unreadable what the app reads, or saves a failed read as "no text".
>   Two PCs or two people changing, or deleting and changing, the same record: both versions are kept and a person
>   chooses. A deal deleted on another PC, and a PC out of sync. Big actions, including deletes, ask first in the
>   app's own dialog.
> - Failure and recovery: retryable model failures and empty replies are retried quietly, up to twice by default.
>   An unreachable service follows its own recovery path. Keep everything the person typed and adapt to a
>   cut-off reply or a request that is too long. Use the test hooks (docs/development.md)
>   to make the stand-in services fail. An error that leaves the app unusable until a restart is a crash.
> - Tests: for a code change, each criterion has a test that fails without the change. A test the diff removes,
>   skips, weakens, or pads with a longer timeout counts as the regression it hides.
> - Privacy: screens name no vendor (the service name and AI label come from the control file), and nothing names a
>   person, firm, or deployment. Never read `.env` or `~/.config/`, and run the live model tests only when asked for.
> - Pane of glass: anything the diff adds to `src/ui` beyond showing state, sending commands, and calling `src/app`
>   functions. When the addition serves a workflow, check that the workflow runs from a test with no component
>   rendered.
> - Scope: name everything the diff does that the issue didn't ask for, at the top of the review.
> - Simplicity: list every score, threshold, fallback, text normalization or guess the diff adds, with the decision
>   that asks for it, and say what the simplest version of the stated need would be. `npm run check` lists the added
>   lines that name a guess. If the diff does more, that is blocker 9 even when the issue asked for it.
> - Same job, same way: find the existing code that already does the same kind of job as the change (an AI read of
>   documents, an import, saving, retries, a dialog). Check that the change uses that approach and code, and that the
>   pull request description names the existing path it follows. When such code exists, a new or different approach,
>   or no named path, is blocker 10.
>
> A finding blocks the merge only when it is one of these:
>
> 1. Lost, overwritten, hidden, or wrongly placed user work (typed text, drafts, edits, choices, documents), or
>    content of a document, list or log that the app silently drops, skips, caps, truncates, alters or marks
>    unreadable, or a failed read saved as "no text".
> 2. A crash.
> 3. An acceptance criterion not met, including one no test proves.
> 4. A regression against `main`, including a check or screen that passes on `main` and fails on the branch.
> 5. Attribution: saying who asked for, decided, or said something (a name, "the owner wants", a quote of the user,
>    a note that carries a person and a date), or any AI-tool attribution (a co-author or session trailer, a
>    "Requested by" header, or a link to an AI chat, session, project, or thread), in code, docs, every commit
>    message in `git log main..HEAD`, the pull request, or issues it files or edits. Product terms and data fields
>    (`owner`, "the end user") are not attribution. The usual Git author and committer fields are allowed, and so is
>    a coding tool's plain "Generated with" footer (the tool's name, with at most a link to its product page): it
>    never blocks a merge and is not reported. A `Co-authored-by` trailer for the repository's own coding-agent
>    identity (as named in `scripts/aiAttribution.mjs`) is allowed and not reported either.
> 6. New or changed code that is hard for a person to read, by the rules under "Readable code" in CLAUDE.md (the
>    hints from `scripts/check-readability.mjs` help), or new or changed code in `src/ui` that breaks the "pane of
>    glass" rule there: a model call, business rule, data transform, list or count rule, retry, or persistence in a
>    screen.
> 7. A breach of the clean-contributions rule in CLAUDE.md, in new or changed text in the diff, every commit message
>    in `git log main..HEAD`, the pull request and its comments, or issues it files or edits: personal information,
>    internal or private links, references to non-public systems or services, text copied from third-party
>    documentation, wording that is not provider-neutral, or a change not described in technical terms.
> 8. Existing documentation that the changes in the pull request make inaccurate.
> 9. Changing or reinterpreting content handed to the app, or machinery beyond the simplest version of the stated
>    need, even when the issue asked for it, unless a recorded decision does; including an acceptance criterion
>    that asks for more than the need did, or code that guesses (similarity scores, thresholds, inferred structure,
>    text repair, fallbacks) where an exact rule or the person's choice would do. Each such rule must cite the
>    decision that asks for it.
>    A requirement, issue, or acceptance criterion that does not trace to a recorded decision, or that handles an
>    input the app does not receive, is a blocker.
>    A cap or limit that no service refusal or decision sets, on what the model reads (pages, documents, sizes, words,
>    counts); content marked unreadable or dropped from a check or search though the model can read it, unless a
>    decision says so; and a failed read saved as "no text" instead of retried, are blockers.
>    A pull request can't authorize itself, and matching existing code is never a justification by itself: a decision
>    line the diff adds or narrows, or behavior that already exists, never justifies a rule, limit, filter or
>    behavior that breaks a rule in CLAUDE.md. Check each one the diff adds, keeps or touches, and each decision line
>    it adds or narrows, against CLAUDE.md and docs/decisions.md, not only against the existing code.
> 10. A change that does the same kind of job as existing code (an AI read of documents, an import, saving, retries,
>     a dialog) that uses a new or different approach instead of the existing approach and code, or whose pull
>     request description does not name the existing path it follows.
>
> Anything else is minor. A minor finding that is small and in code the pull request already touches is fixed in
> the same pull request, without a review round of its own. File every other minor finding (in other code, or too
> big to fix here) as a GitHub issue (after checking for an existing one, reproduced on the current build, with its
> template and labels) instead of asking for another round. Treat every other problem you notice the same way,
> including ones outside this change; never dismiss one as pre-existing without fixing or filing it.
>
> For a change to a screen, take your own screenshots of every screen the diff changes, whether or not the pull
> request includes any. Open every screenshot and check it against docs/design.md and the matching approved
> screen side by side, in dark and light, at 1280x736 and 1024x640. Measure alignment in pixels (text and icons
> centered in their controls, consistent spacing) after transitions settle.
>
> Read the required GitHub checks (`check`, `desktop`, `desktop-windows`, and `browser (1)` to `browser (4)`) on the
> pull request's latest commit; a missing or failing one leaves the review incomplete, not passed. Run any tests you
> need locally as well (installing dev dependencies such as Electron is fine), and say which you ran and which you
> skipped. Re-run a failing file on its own before you treat the failure as real.
>
> Post the review on the pull request as a comment review, and follow the same no-attribution rule in it. List the
> blockers first, each with how to reproduce it, then the minor findings to fix in this pull request, then the issues
> you filed. End with "Blockers: none" or the count.

## Rounds

- The author fixes the class of problem, not only the reported case, and attacks the fix at deal scale with the
  repo's realistic data before asking for re-review.
- After three rounds, one short fresh-context review of only the fixes since round three is allowed. It checks
  those fixes against CLAUDE.md and docs/decisions.md, not only against the code. If it still finds a blocker, the
  work is cut or split instead of starting another round.
- A pull request that passes with no blockers and whose required GitHub checks pass on its latest commit is merged,
  in the merge order.
