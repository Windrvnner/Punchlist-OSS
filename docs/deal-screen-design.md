# Deal screen: what is left to build

This is the design for the rebuilt deal screen: a conversation on the left and a tabbed pane on the right that holds
Tasks, Diligence, Q&A, and the items a person opens. None of it is built yet. Its decisions are in
[decisions.md](decisions.md), under "Deal screen". Where this page and the decisions differ, the decisions win.

The mock-up is [deal-screen/mock.html](deal-screen/mock.html), with its icons in
[deal-screen/icons.js](deal-screen/icons.js). It uses the app's tokens and built stylesheet and sample data only. The
source document page ([deal-screen/guarantee-p4.png](deal-screen/guarantee-p4.png)) is a generated sample, not a
real deal document. When this design is built, this page and the `deal-screen/` folder are removed.

## Rendering the screens

Run `npm run build`, then `node docs/deal-screen/shoot.mjs`. It writes each screen to
[deal-screen/shots/](deal-screen/shots/), in light at 1280×736. For the dark theme or another size, pass them, for
example `node docs/deal-screen/shoot.mjs 1024x640 dark`; those shots go to `out/deal-screen/`, which git ignores.
Running work animates, so a new render can differ from a kept shot in a spinner's position.

## Screens

| # | Screen | Shows |
|---|---|---|
| 01 | [Empty deal](deal-screen/shots/01-empty-deal-light-1280x736.jpg) | Deals only in the sidebar, the composer centered |
| 02 | [Deal menu](deal-screen/shots/02-deal-menu-archive-light-1280x736.jpg) | **Archive Deal** in a deal's ⋯ menu |
| 03 | [Archive confirm](deal-screen/shots/03-archive-confirm-light-1280x736.jpg) | The confirm dialog, with **Cancel** |
| 04 | [Archived shown](deal-screen/shots/04-archived-shown-light-1280x736.jpg) | Archived deals folded open, with a changed deal's update line |
| 05 | [Unarchive menu](deal-screen/shots/05-unarchive-menu-light-1280x736.jpg) | **Unarchive Deal** in an archived deal's ⋯ menu |
| 06 | [Conversation](deal-screen/shots/06-conversation-light-1280x736.jpg) | A conversation at full width, with no pane |
| 07 | [Answer action tooltip](deal-screen/shots/07-answer-action-tooltip-light-1280x736.jpg) | The answer actions, named in tooltips |
| 08 | [Past conversations](deal-screen/shots/08-past-conversations-light-1280x736.jpg) | The conversation title's menu of this deal's conversations |
| 09 | [Diligence running](deal-screen/shots/09-diligence-running-light-1280x736.jpg) | Tasks, with the sidebar folded to its rail |
| 10 | [Other conversation](deal-screen/shots/10-other-conversation-tasks-kept-light-1280x736.jpg) | Tasks unchanged in another conversation of the deal |
| 11 | [Diligence report](deal-screen/shots/11-diligence-report-light-1280x736.jpg) | The Diligence tab, with the Checklist's own marks |
| 12 | [Finding](deal-screen/shots/12-finding-light-1280x736.jpg) | An opened finding as a tab after the three fixed tabs |
| 13 | [Source document](deal-screen/shots/13-source-document-light-1280x736.jpg) | Reading mode's viewer in the pane, with no highlighting |
| 14 | [Source document, sidebar shown](deal-screen/shots/14-source-document-sidebar-shown-light-1280x736.jpg) | A pinned sidebar narrows the pane |
| 15 | [Q&A widened](deal-screen/shots/15-qa-widened-light-1280x736.jpg) | The Q&A table in a widened pane |
| 16 | [Report rechecking](deal-screen/shots/16-report-rechecking-light-1280x736.jpg) | A running re-check, in the chat and on the Diligence tab |
| 17 | [Finding updating](deal-screen/shots/17-finding-updating-light-1280x736.jpg) | A finding being updated from new files |
| 18 | [Q&A item, draft](deal-screen/shots/18-qa-item-draft-light-1280x736.jpg) | An opened question with a draft response |
| 19 | [Q&A item, answered](deal-screen/shots/19-qa-item-answered-light-1280x736.jpg) | An opened question with its response |
| 20 | [Task running](deal-screen/shots/20-task-running-light-1280x736.jpg) | A task's steps while it runs, and its card in the chat |
| 21 | [Task done](deal-screen/shots/21-task-done-light-1280x736.jpg) | A finished task's result, with its reply box |
| 22 | [Sidebar shown, Q&A](deal-screen/shots/22-sidebar-shown-qa-light-1280x736.jpg) | Q&A beside a pinned sidebar |
| 23 | [Sidebar shown, finding](deal-screen/shots/23-sidebar-shown-finding-light-1280x736.jpg) | A finding beside a pinned sidebar |
| 24 | [Q&A list](deal-screen/shots/24-qa-roomy-light-1280x736.jpg) | Q&A as a one-column list beside the conversation |
| 25 | [Q&A list, question open](deal-screen/shots/25-qa-roomy-item-light-1280x736.jpg) | An opened question in its card, in the list layout |
| 26 | [Q&A list, answered](deal-screen/shots/26-qa-roomy-answered-light-1280x736.jpg) | An answered question in the list layout |
