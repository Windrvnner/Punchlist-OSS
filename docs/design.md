# Design

This page describes how Punchlist looks. New screens follow it rather than working out the look again. Anything this page specifies before it is built is marked as not built yet. Where this page and [docs/decisions.md](decisions.md) differ, the decisions win and this page is corrected.

The look is defined in these files: `src/styles.css` (tokens, the shell, and controls), `src/ui/ui.css` (later additions), `src/control.ts` (every color), `src/ui/icons.ts`, `src/ui/tip.ts`, and `src/ui/dialogs.tsx`. `src/control.ts` is the control file: the one place where the app's colors are set, along with the on-screen names for the model service and for AI-written text. Reference screenshots of every main screen, in the dark and light themes, are in [docs/design/](design/) at 1280×736. A number in parentheses, such as (06), refers to one of these screenshots, listed under [Reference screenshots](#reference-screenshots). Throughout this page, "dark" and "light" mean the app's two themes.

## Direction

- **Perplexity, Harvey, and Apple.** The look takes a reading column from Perplexity, monochrome seriousness from Harvey, and material, glass, and concentric radii from Apple. Cited text has a dotted underline: hovering over it lists its sources, and clicking it opens its source in reading mode. There are no numbered markers or footnotes (#636). The existing screens already follow this direction: match them exactly and never regress from them.
- **Glass, not flat.** Panes of glass float over a softly lit surface, and popups are glass too. Every mock-up starts from glass. Nothing takes on the generic AI look.
- **No explainer or helper text on screen.** A screen says what things are, not how to use them. Explanations go in tooltips.
- **Few controls.** A heading has one row of controls under it, never a second. When a header runs short of room, it gives up words first and then turns buttons into icons. Controls that are clicked repeatedly keep a fixed width and place.
- **No thin full-height lines down a left edge.** A finding's 3px stripe spans only its own row.
- **Color carries meaning, sparingly.** The accent marks the following:
  - The main action (filled buttons, send)
  - Where you are and what is chosen: the open tab, the current page in the slim rail, checked boxes, radios, chosen options and filters (a picked choice card is marked in gray instead; see Choice cards), and the check mark on an answer used as its response
  - Links and sources (citations, source numbers, link buttons, and links and buttons under the pointer)
  - Focus, selected text, a name being edited, and a drop target
  - Progress (read progress, the open part of the Q&A bar, and a research step under way)
  - AI drafts (the Draft status word, a draft's actions, and the AI dot in a deal's news)
  - News on a finding (its update dot and its reviewed check mark) and a document held on this PC
  - A few small marks (deal and context chips, the mode badge, numbered cards, and the avatar)

  Red marks what needs you: an open finding's stripe, flagged items, warnings, and failures. The accent also marks what the model wrote, a field being edited, and a connection that is waiting. The one gray marks what is done or fine: a satisfied check mark, done items in the slim rail, and a working connection. Everything else is ink, in three strengths.
- **No vendor names on screen.** Text a person sees never names the model service or the model maker (OpenAI, Claude, Anthropic, North, or Cohere). It says "Intelligence", in the connection card too, and marks text the model wrote as "AI". Both names are set in the control file (`names.service` and `names.aiContent`), and nothing on screen writes them in directly. Code, settings files, and docs keep the real names.

## Layout

- **Shell:** The window is a grid of the sidebar (236px; 208px at 1180px wide and narrower) and the page, 12px apart and 12px from the window edge (`--gap`). Any screenshot shows it.
- **Sidebar** (`.rail`): The sidebar is one glass pane with a 22px radius. From the top, it holds the app's mark and the + button, Search (Ctrl K) as a field, Home, the deal groups (Live, Monitoring, Pitches, and Closed) with their counts, each shown only once it has a deal, and the account row at the foot. It lists only deals: a deal's pages are its tabs. On finding and question pages, it folds to a slim rail of icons (06).
- **Page:** Content sits on the surface, not in a pane, in a column up to 900px wide. The deal pages (Overview, Findings, Checklist, and Q&A) use a wider column, up to 1,240px, and everything on them shares its edges: the trail, the header row, the ask box, and the content. There, the ask box runs the full width, stays one line until it is used, and grows in place (option A). A deal page opens with the trail, the breadcrumb path at the top (Home › deal › page · facts), with the counterparty alone at the top right. Then comes one header row: the deal name in the heading weight (see Type); the tabs (Overview, Findings, Checklist, and Q&A, each with its count in `--ink-3`); and, at the right, Deal status and one ⋯ menu. The ⋯ menu holds Check Again with its last-checked date, Deal Memo…, Rename, and, set apart, Delete Deal… While the memo is being made, ⋯ spins and its memo item reads "Making the deal memo…" and is turned off. A 1px `--line` rule runs under the header row, and the open tab has a 2px `--accent` underline. On Q&A, scrolling down the list tucks the header row away and the list takes its height; scrolling up, or reaching the top, brings it back. The trail, ask box, controls, and column heads stay, and the trail's page name is then `--ink`, 500, standing in for the tabs (design C).
- **Ask box:** The ask box sits under the header on every deal page. Until it is used, it is one line with a 999px radius
  (03). On Q&A, an open question's panel takes its place. Once open, it is the same composer as Home's (04) and a
  conversation's (06), with a 22px radius, 14px padding all around, 15px text on one line until more is typed, and 32px
  buttons and send.
- **Side pane:** The open item on Checklist sits in a glass pane beside the list, with its top on the list's top line and its bottom on the sidebar's bottom line (08). The open question on Q&A takes a glass panel across the top (09).
- **Reading mode:** A demo PDF without a preview shows “Page preview unavailable.” in
  `--paper-ink` below the title. The paper still shows its page number, and the reading controls stay in place (#443).
- **Windows:** Window sizes run from 1024×640 to 1536×864. Check every screen at 1280×736 and 1024×640, in dark and light.

## Type

Punchlist uses one type family, the computer's own interface font, as native apps do: Segoe UI on Windows. On Windows 11 this is Segoe UI Variable, whose weights run continuously; Windows 10's Segoe UI has only 400, 600, and 700, so a 500 there shows as 400. The Display cut (`--display`) is used only at 19px and above, and `--body` below that. Nothing is bundled or fetched. Headings stand apart by weight and size, never by a second typeface.

**Typeface check** (the "no generic AI look" rule): Punchlist uses no typeface that AI-made interfaces default to, including Inter, Geist, and a display serif such as Newsreader or Fraunces set over a sans serif for headings. A design check that adds or changes a font checks it against this list.

| Use | Weight | Size |
|---|---|---|
| Deal name (header) | 600, letter-spacing −0.4px | 24px |
| A conversation's question, page headings (`h1`) | 600, letter-spacing −0.4px | 26px |
| Home question, empty state | 600, letter-spacing −0.5px | 28px |
| Dialog titles | 600, letter-spacing −0.3px | 19px |
| Section headings (`h2`), deal names in lists | 600, letter-spacing −0.2px | 18px |
| An open finding's, item's or question's title | 600, letter-spacing −0.15px | 17px / 1.35 |
| List row titles (findings, deals, feed) | 600 | 14px |
| Overview column names | 500 | 14px |
| Overview fact labels | 600, `--ink-2` | 13px |
| Body | 400 | 14px / 1.5 |
| Tables, panes, menus, buttons | 400 to 500 | 13px (12px on small buttons) |
| Section labels (Findings, Show in the List) | 600, `--ink-2`, Apple title style, never all capitals | 13px |
| Column heads | 600, `--ink-2`, Apple title style | 11px |
| Trail, meta lines | 400, `--ink-2` | 12–13px |

The table gives the default sizes. [Controls](#controls) specifies 12.5px for composer buttons and native selects.
Overview progress counts and source popover rows also use 12.5px as specified in their sections.

Numbers that line up use tabular figures (`.num`). All text is en-US.

Labels, column heads, buttons, menu items, value capsules, and dialog titles that aren't questions use Apple's title style: every word is capitalized except articles, coordinating conjunctions, and short prepositions, and the first and last words are always capitalized (`titleStyle` in `src/ui/titleStyle.ts`). Sentences, tooltips, body text, and meta lines stay in sentence case.

## Color

Every color is worked out from three base colors in the control file (`src/control.ts`): `colors.neutral` (#606469, a cool slate gray), `colors.accent` (#d9c5a3), and `colors.red` (#a8392a), the same for both themes. `src/palette.ts` gives each token its base and how light it is in each theme, and takes the base's hue and strength, so changing a base recolors its whole family: changing red to blue turns red and light red into blue and light blue. Pure white and black (the glass's light and the dark shadows) have no hue and stay as they are. The `-soft` tints and the other blends in `src/styles.css` and `src/ui/ui.css` are mixed from the tokens, so they follow too. No color is written anywhere else (the black in a mask is never painted, so it does not count), and icons take the text color. Windows High Contrast uses system colors (the `forced-colors` block).

Three colors carry meaning, one meaning each: red means something needs you; the accent means the main action, what is chosen, and what is in progress; and the one gray (`--ink-3`) means done. Two shades of one color never carry different meanings.

| Token | Base | Dark | Light | Use |
|---|---|---|---|---|
| `--surface` | neutral | #0e1013 (slate) | #dfe4e9 (light slate, not beige) | The window behind the glass |
| `--ink` | neutral | #e8eaed | #191b1e | Text |
| `--ink-2` | neutral | #a7aaae | #595c60 | Secondary text |
| `--ink-3` | neutral | #93969b | #5c5f63 | Labels, counts, placeholders; done, satisfied, a working connection |
| `--accent` | accent / neutral | #d9c5a3 (sand) | #2a2e34 (graphite, from the neutral) | The main action, the open tab, focus, links, in progress, AI marks, a connection that is waiting |
| `--accent-ink` | accent | #18150f | #ffffff | Text on the accent |
| `--high` | red | #e28a7b | #a8392a | Needs you: open findings, flagged items, failures, warnings |
| `--paper` / `--paper-ink` | neutral | #f0f1f3 / #1a1c1f | #fcfdff / #1a1c1f | Document pages |
| `--toast` / `--toast-ink` | neutral | #e8eaed / #111111 | #191b1e / #ffffff | Notices and tooltips |
| `--off` | neutral | #e8eaed | #191b1e | A turned-off button's fill, used at 7% in dark and 5% in light (`--off-soft`) |

The glass, lines, page details, overlays, and shadows are listed with their bases in `src/palette.ts`. The build stops, naming the base to change, when text would fall under 4.5:1 (3:1 for marks) on what it sits on.

On document paper, error text and its always-underlined **Retry** use `--paper-ink`, including the focus ring (#439).

Soft tints, such as `--accent-soft` and `--high-soft`, mix their color at 10–14%.

## Glass, radii, and shadows

- **Glass** (`.glass`): A `--glass` fill, a 1px `--glass-edge`, `backdrop-filter: blur(28px) saturate(150%)`, a 1px top highlight (`--spec`), a sheen from the top-left, and `--shadow`. It is used for the sidebar, the ask box, the Q&A panel, and the Checklist pane.
- **Popup glass:** Every panel that opens over the page, other than the tooltip, is glass too: dialogs, menus, popovers (a source's details on hover or focus), search results, and the connection card. None of them is a solid panel (outside Windows High Contrast). The page shows through each one, blurred, so it reads as glass and not as a gray card. Notices are popup glass too (see Notices); the app's tooltip stays solid `--toast` at 8px (see Tooltips). The recipe is as follows:
  - **Fill:** In dark, `--glass-2` alone; in light, `--menu-solid` at 36%.
  - **Blur:** `backdrop-filter: blur(12px) saturate(150%)`: the page behind reads through as soft shapes, so the panel is plainly glass, while a bright control behind it softens to a glow and never sharpens behind a label.
  - **Edges:** A 1px `--glass-edge`, the `--spec` top highlight, an `--inset-edge` foot, the `--glass-sheen` from the top-left, and the popup's own shadow (see Shadows). A dialog's sticky header and actions take the dialog's own fill, not a solid one.
  - **Legibility:** Text on popup glass keeps a contrast of at least 4.5:1 against what shows through, in dark and light. In light, a popup's footer line and a review's old wording take `--ink` and `--ink-2` in place of `--ink-2` and `--ink-3`, which fall below that on this glass.
  - **Backdrop:** Behind every dialog the page is lightly dimmed (`--scrim-soft`) and slightly blurred (`blur(4px)`). Behind a menu the page is neither dimmed nor blurred and looks exactly as it is, though the menu's backdrop still takes the pointer. While a dialog or menu is open the rest of the app does not respond. A click on the backdrop closes an open menu (with a menu open over a dialog, the menu closes and the dialog stays), but never closes a dialog, so a stray click cannot lose work. Escape, too, closes only the topmost popup. Only the dialog or menu, and any notices, sit above the backdrop; behind a dialog everything else, the button that opened it included, is dimmed and blurred alike. Notices keep working. Search results never dim or blur the page, and neither do the connection card and source popovers, which show on hover or focus.
  - **Panes:** The panes keep their own glass; only popups take this one.
  - **Windows High Contrast:** Popups are solid Canvas with no blur.
  - **As built:** Menus, popovers, search results, and the connection card are lifted into the browser's top layer (`src/ui/popups.ts`), so their own glass blur reaches the page even when they open inside a blurred pane, and nothing on the page can cut them off; a menu's backdrop is an element of its own in the top layer, just under the menu (`.popshield`), since a popover's `::backdrop` cannot take the pointer. A dialog's backdrop blur is on its scrim's `::before`, so the scrim does not stop the dialog's glass from seeing the page. Reference screenshots 02, 10, 11, 12, and 14 were taken before this change.
- **Lit surface:** Three soft radial lights shine over `--surface` (`body::before`), so the glass has something to show.
- **The glass family.** What makes a screen read as this app's Liquid Glass is that every pane, popup, row, and control is one of the levels below (measured from the built app, `src/styles.css`, in dark and light). A new or changed screen is built from these levels. Built screens that differ are filed as issues and are never copied: popups (#571), fields (#569), segmented controls (#570), and radii (#622).

  | Level | Recipe | Where |
  |---|---|---|
  | Pane glass | `.glass` above | Sidebar, closed ask box, Q&A panel, Checklist pane |
  | Popup | The popup glass recipe above (decisions.md: popups are glass, never solid). Menus 12px, search results and the connection card 14px, dialogs 22px; a source's popover has no approved radius yet (#571), so ask before choosing one. | Dialogs, menus, search results, the connection card, a source's popover |
  | Raised row | `--glass-2` fill, `inset 0 1px 0 var(--spec)` and a 1px `--glass-edge` ring (a box-shadow on `.rail a.on`, a border on `.f.on`), no blur, radius 9px (`.rail a.on`) or 14px (`.f.on`) | Home or the open deal in the sidebar, the open finding row |
  | Control | `--card` fill under a 1px `--line` edge, no blur, no highlight; `--card-hover` under the pointer. Switched on (a filter that is on): the edge turns `--ink-3` (`.btn.on`) or `--accent` | Buttons, editable values, fields, selects, the segmented control's track, a dialog's ×, the sidebar's Search |
  | Chosen segment | `--ink` fill, `--surface` text, 500, no edge | The chosen option in `.seg` |
  | Main action | `--accent` fill, `--accent-ink` text and icon, transparent edge | `.btn.pri`, send |
  | Bare | No fill, no edge; `--card-hover` and radius 9px under the pointer | Sidebar rows and menu items (8px); the Q&A panel's details and Responded by with its date |

  A control at rest never has an edge without the `--card` fill under it: a thin outline around text with no `--card` fill under it is not one of the levels and fails the check, whether on the page or inside a pane. An edge here means a border, an `outline`, or a box-shadow ring. The as-built exceptions are the turned-off icon button's `--off-edge` ring (see Controls), the Ctrl K key cap in the sidebar's Search, and fields that sit inside a box or popup that already has its own fill (not a pane), which have a 1px `--line` edge on a transparent fill: the search field at the top of a menu or popup (`.psearch`), the note box's text area (`.fnote textarea`), the find field in Add deal (`.addfind input`), and a folder's label in New deal (`.ndrow input.lab`, a 26px capsule). Every fill, edge, and text color resolves to a token from the control file (values in the Color table and `src/control.ts`), or to a `color-mix()` that `src/styles.css` or `src/ui/ui.css` already uses (for example the `-soft` tints, `--off-icon`, `--ink` at 6% on a highlighted menu row) or that this page specifies (the popup glass fill); any other mix or a written-in color fails.
- **Reading mode:** The conversation pane and follow-up composer use pane glass at `--r-pane`. The sticky trail keeps
  its solid backing over the scrolling thread. Conversation content stops above the composer and keeps its place
  from the end when the composer resizes. The pane's glass shows behind and below the composer. Its shadow extends
  into the surrounding gaps. In dark, the placeholder and research details use stronger text tokens over glass
  and the document page's glow (#437, #438, #442).
- **Radii:** Panes and dialogs are 22px (`--r-pane`); cards, search results, and the connection card 14px (`--r-card`); menus 12px; fields, selects, and list rows 9px (`--r-ctl`); and menu items and tooltips 8px. Buttons, icon buttons, editable values, the dialog ×, chips, segmented controls and their options, the closed ask box, and notices are full capsules (999px). These built exceptions are filed as bugs, and new controls do not copy them: the sidebar's `+` (8px), a sidebar deal's more button (7px), a New deal folder's × (6px), and `.colmenu .fb` (7px) (#622). Other built shapes with their own radii (the account row 10px, the search box 18px, Past conversations 16px, a sent message 16px, and research chips 8px) are not patterns for controls.
- **Shadows:** `--shadow` is for panes; `--shadow-pop` for menus, popovers, search results, the connection card, notices, and tooltips; and `--shadow-dlg` for dialogs. In dark, a document page carries a faint glow (`--shadow-sheet`).
- **Motion:** `--fast` is 160ms, `--base` 260ms, and `--slow` 420ms, all on `cubic-bezier(.2,.7,.2,1)`. Dialogs fade and lift 10px; buttons press to 97%. The system's reduced-motion setting turns all of it off.

## Controls

Every size below was measured in the built app, in dark and light, at 1280×736 and 1024×640, and is the same in each. Padding is measured inside the border. A new control copies the row of the control it is most like; it does not take in-between values.

| Control | Height | Padding (left/right) | Radius | Text | Icon |
|---|---|---|---|---|---|
| Button `.btn` | 32px | 13px | 999px | 13px / 500, `--ink` | 7px gap to the words |
| Small button `.btn.sm` (page headers, panes, Q&A panel) | 28px | 10px | 999px | 12px / 500 | 14px where it has one (Folders) |
| Small button in a section-label row (Findings' New finding and ⋯, Overview's Check again line; Folders is 28px) | 26px | 10px | 999px | 12px / 500 | 14px, 6px gap |
| Button beside a 32px field (`.ndpaste`, New deal's Add) | 32px | 10px | 999px | 12px / 500 | |
| Composer button (`.scopebtn`: Attach, Standard, Past conversations) | 32px; 30px in a closed deal-page ask box | 11px | 999px | 12.5px / 400, `--ink-2` | 13px, 6px gap |
| Send | 36×36 in a closed ask box; 32×32 in an open composer | none set; icon centered by grid | 999px | | 16px, `--accent-ink` on `--accent` |
| Main action `.btn.pri` | as its size above | as above | 999px | `--accent-ink` | |
| Icon button `.btn.sm.ico` | 28×28 | 0 | 999px | | 15px, `--ink`, delete `--ink-3` (close in a pane 14px, More 16px) |
| Dialog × (`.sdlg .x`) | 30×30 | | 999px | | 15px |
| Field `.field` | 32px (38px with 12px padding for Delete deal's name) | 10px | 9px | 14px, placeholder `--ink-3` | |
| Select `select.field` | 32px, 12.5px text | 10px left, 28px right | 9px | | Arrow 12px wide, 9px from the right, `--ink-3` |
| Editable value (see Editable values) | 28px | 10px, with or without an icon or chevron | 999px | 12px / 500, `--ink`; Not set `--ink-3` | Leading 14px `--ink-2`, 6px gap; picks end in `chev` 13px at 70%, 4px after the words |
| Segmented control `.seg` | 34px: 3px padding, 2px between options | | 999px | | |
| Segment option | 26px | 11px | 999px | 12px / 400, `--ink-2`; chosen 500 (Checklist's options are 600, a bug, #570) | |
| Segmented control in a section-label row (`.fhead .seg`) | 28px: 2px padding, 22px options | 10px | 999px | 400 | |
| Sidebar Search | 34px | 10px | 9px | 13px, `--ink-2` | |
| Menu item (`.colmenu .mi`, the More menu) | 33.5px (7px padding) | 10px | 8px | 13px | Checkbox 14px |
| Menu item in a pick list (`.stlist .mi`) | 32px | 10px | 8px | 13px | Check mark 14px |

- **Spacing in a row:** Controls are 6px apart in the deal header (`.hacts`: Deal status, ⋯) and between a section label's buttons (`.lblacts`; 8px on Findings, `.fhead`); 8px apart in a toolbar or a panel header (`.qph`, `.xfoot`, `.sphead`, and the Q&A toolbar); and 10px apart in a list's head row and Overview's check row. Some rows add margins on top: in the Q&A panel header the position ("1 of 3") is 10px from the arrows. The Q&A panel's details run on one 20px rhythm measured on the drawn ink (status to the first detail, detail to detail, and the Response label to Responded by to its date). A new row takes the gap of the approved row it is most like.
- **Overview progress** (leader lines, side by side): Progress on Overview is three columns 32px apart (22px at 1180px and narrower), lined up with the Structure, Sector, and Technology columns above. Each column has the name, 14px/500 `--ink`, with a 12px `chevr` in `--ink-3`, and "N in all", 12.5px `--ink-3`. Under them is one 14px bar whose parts are 2px apart, with 4px corners and at least 8px wide: open parts `--high`, in-progress parts `--accent`, and done parts `--bar-ix`. Each part's words, 13px, sit on a 2px leader line in the part's color, below the bar to the right where they fit, and otherwise to the left, centered, or above. Open counts are `--high` 500, done counts `--ink-2`, and what they are made of `--ink-3` after a "·". The deal's facts read "Structure: value", with the label 13px/600 `--ink-2`.
- **Buttons** (`.btn`): Buttons are capsules with a 1px `--line` edge on a `--card` fill; the sizes are in the table.
- **Hierarchy:** There is one main action per place, filled with the accent (`.btn.pri`: `--accent` fill, `--accent-ink` text, no edge), such as "Draft All Open", "Create and Start Indexing", "Continue", and the send arrow. Everything else is the plain capsule.
- **Turned off**: Any button, the main one included, becomes a flat gray capsule (`--off-soft`) with `--ink-2` words, no accent and no edge, so its words stay readable (at least 4.5:1) and it plainly can't be pressed. An icon button instead keeps a fainter ring (`--off-edge`) and a dimmed icon (`--off-icon`), with no fill, so it never reads as chosen. These buttons are not faded with opacity; other controls that are off (link buttons, Attach, menu items, selects, the reading arrows) still fade to 45%.
- **Icon buttons:** Icon buttons are square with no padding, with the icon centered by grid (`place-items:center`); small ones are 28×28. The icon set is line icons on a 24px grid, with a 1.75 stroke and round caps (`src/ui/icons.ts`), drawn at 11 to 16px by place (sizes in the table), in the control's text color unless the table says otherwise. A chevron is drawn: the `chev`, `chevr` or `chevup` icon, or a select's own arrow (`--select-arrow`); never a typed character such as ⌃, ⌄ or ▾. Every icon button has a name on hover (`title`) and for screen readers (`aria-label`).
- **Segmented control** (`.seg`): A segmented control is a capsule of options; the chosen one is filled with `--ink` and has `--surface` text (Open/Answered/Closed on Q&A, and Appearance in Settings).
- **Choice cards** (`.rsv-r` in Resolve): Where a person picks one of a few texts, each choice is a card, not a button: a heading line with a 14px radio dot and its name, over a `--card` box with `--r-ctl` corners and a 1px `--line` edge holding the text. The picked one has a 2px `--ink-2` edge and a gray check mark (the `check` icon, 14px, `--ink-2`) in place of its dot (a selection is marked in gray, not the accent); the two-PC versions panel's cards mark a pick the same way, an `--ink-2` edge and check mark. A choice the AI would write is the same card, full width under the others, holding the AI mark on the baseline of what it does ("Merge Both Versions": it is a third option, so it is not a capsule); once drafted it shows its text with the AI draft's dashed edge (1px `--ink-3`), and picked it is the box to edit, with a 2px dashed `--accent` edge. Keyboard focus is a 2px accent ring outside the card's edge. The headings of side-by-side cards stay at the top while the body scrolls.
- **Fields** (`.field`): Fields are 32px high (38px for Delete deal's name), with a 9px radius, a `--card` fill, a 1px `--line` edge, and the placeholder in `--ink-3`. A select draws its own arrow in `--ink-3`.
- **Editable values:** Every value a person changes in place is a glass capsule, the same object as a small button (`.btn.sm`), so it reads as something to press. That covers Overview's Structure, Sector, and Technology, the counterparty, the question's status and Deal status (such as Live). No dotted underline on any of them.
  - **The Q&A panel's details:** These are the exception: Workstream, Priority, Submitted by, Received, and a response's Responded by and date are plain words at the Bare level (The glass family), 12px / 400 `--ink-2` with their 14px icon in `--ink-3`, 2px inside each side, 5px from icon to words, radius 9px and no chevron; `--card-hover` under the pointer, as a sidebar row. While typing in one, the box shows the Control level (`--card` fill, 1px `--line` edge) with the focus outline. They open the same lists and fields as the capsules. The "Question" and "Response" labels over them are 13px / 500 `--ink-2`.
  - **Shape:** A capsule is 28px high, 10px inside each side whatever it holds, with a 999px radius, a `--card` fill, a 1px `--line` edge, and no blur or highlight. Under the pointer it takes `--card-hover` (fading over `--fast`), and nothing else changes. Deal status is the app's own pick, as a question's status is, with its list under the capsule's right edge (#567).
  - **Words:** The words are 12px, 500, `--ink`; "Not set" and an empty field's placeholder are `--ink-3`.
  - **Leading icon:** A 14px icon in `--ink-2`, 6px before the words, says what kind of value it is: building for the counterparty (a new icon, added to `src/ui/icons.ts` with the build: `M3 21h18 M5 21V4h10v17 M15 9h4v12 M8.5 8.5h3M8.5 13h3`), `user` for Responded by and Submitted by, `cal` for dates, `tag` for Workstream, `flag` for Priority. Overview's values, status, and Deal status have none. The building and `user` icons sit 0.5px higher, so they look centered.
  - **Chevron:** Values picked from a list (Overview's picks, Workstream, Priority, status, Deal status) end in the `chev` icon, 13px, the words' color at 70% (`--ink-3` on Not set), 4px after the words. Typed values have no chevron.
  - **Editing:** Typing happens inside the capsule, which keeps its look and gains the 2px `--accent` focus outline, 2px off. The field inside is transparent and borderless, 26px high, in the capsule's font; on Overview it sizes to what is typed. The status pick uses the capsule's chevron, not its own.
  - **Spacing:** Capsules in a row are 8px apart; in the Q&A panel header the status and details are one 20px apart on the ink (16px and 12px margins), and a detail that does not fit on the top line goes onto the next, 10px below, starting at the header's left edge, at every window size. On Overview each capsule's left edge lines up with its label.
  - **Windows High Contrast:** The edge, icons, and chevron are drawn in `ButtonText`.
  - **Measured in the mock-ups:** Words sit within 0.25px of center and icons within 0.5px, with 10px inside each side.
  - **Long values:** A capsule is as wide as its value, with no width cap, the counterparty too. The one exception is a value longer than the room its line has, which is cut with an ellipsis: in practice a counterparty near its 80-character limit at 1024px, which gives way before the deal's name in the trail.
  - **As built** (`src/ui/ui.css`, Editable values): Picks are `.pickbtn`, `button.qp`, `.qph .stsel` and `.headrow .hsel`; a typed value is an EditField with `cap`, whose `.efcap` holds the icon and the field, with its notes (Not saved, Changed elsewhere) outside the capsule. The question's status and Deal status are the same `Pick` (`src/ui/qa.tsx`). The Q&A panel's details are drawn plain by the block after it (The Q&A panel's details: `.qpanel .qprops`, `.qpanel .qlbl .sub.by`).
- **Focus:** Focus is a 2px `--accent` outline, 2px off the element. Everything works from the keyboard alone.
- **Targets:** Small targets are at least 24px high.

## Dialogs

See reference screenshots 02, 11, and 12.

- **Placement and size:** A dialog is centered over the popup backdrop, in popup glass (both described in Glass, radii, and shadows), with a 22px radius and `--shadow-dlg`. It is 620px wide by default; confirms (`.sdlg`) are 560px; and Settings, import, and Locate Deal Folders are 720px.
- **Header:** The title (19px, 600) is at the left, and the close button, a round 30×30 ×, is at the top right (`.sdlg .x`), with the version or other short facts just left of it where they belong (Settings).
- **Close is the × only.** There is no separate Cancel or Close button: the × and Escape close a dialog, and a click on the backdrop does not. Focus stays inside the dialog while it is open and returns to what opened it. An import closes at once like any dialog, since it is kept as it was left (see "An import in progress" under Storage and sharing between PCs in [docs/decisions.md](decisions.md)). Its "start over" link, beside "change" on the File row, asks first in the footer: "Clear this import and start over?", with Keep Going focused and Start Over filled. Keep Going returns the focus to where it was.
- **Actions:** A dialog shows only its own actions, the main one filled. In a form they sit at the bottom right, with a count or an error at the footer's left; in a dialog taller than the window the body scrolls and the actions stay in reach. Where the main action belongs with a field, it sits beside it (Add Deal: the search field, then New Deal). A confirm that deletes for good names the safe choice instead of Cancel (Keep the Deal, then Delete for Good).
- **Form rows:** Rows in a form dialog are a label column and a value column, divided by 1px `--line` rules (Settings).
- **Checklist wording review:** The Wording heading puts the 14px `.xcheck` checkbox 8px before the suggestion count.
  The label has a 24px target. The checkbox is checked when every available suggestion is checked.
- **Drop areas** (`.dropzone`, the `FileDrop` component, every file drop area in the app): A drop area is a 12px-radius area with a 1px dashed `--dash` edge on `--dash-bg`, the import icon at 20px in `--ink-3` centered above the words (for example "Drop a file here, or choose a file…", where "choose a file…" is an accent link that opens the file picker), 8px between them. A file dragged over it turns the edge accent and the fill `--accent-soft`. Where a drop area stands in for an empty list (the master checklist with no lists yet) it is 160px tall, in a dialog at least 360px tall. The folder area in New deal, which also holds the list of folders, is not a drop area to look at: a raised glass box (the Raised row level: `--glass-2` fill, 1px `--glass-edge` edge, the `--spec` top highlight, `--r-card` corners) with two `.btn.sm` buttons under the list, "Choose Folders…" (the import icon at 14px before its words) and "Paste a Path"; folders can still be dropped on it, which the first button's tooltip says ("Or drop folders here"). In Folders the drop area is one line under the list (`.dropzone.row`, 12px 14px padding, 13px words, 14px above it), with the icon at 16px before "Drop folders here, or paste a path", where "paste a path" opens the path field under it; Choose Folders… is the footer's button, not a link here.
- **Add Deal:** The title and × are on one line. Below them is Find a deal with New Deal beside it, and below that the deals, each with Add (its tooltip "Add to my deals") or In your deals.

## Menus and lists

- **Menus** (`.colmenu`; 10): Menus open under their button, with a 12px radius, 8px padding, popup glass, and `--shadow-pop`. Items are 13px rows with 8px radius and a `--card-hover` hover; in dark the row under the pointer is lit more, `--ink` at 14%, so it stays apart from the chosen row. Groups are split by a 1px rule and headed by a section label. A single choice in a menu, in every menu that marks one, is marked by a check mark at the row's right end, the `check` icon at 14px in `--ink-2` (`ChoiceCheck`), as macOS menus mark it, not by a radio or bold, on a light highlight (`--mi-chosen`): the accent at 10% in light, `--card-hover` at 50% in dark, so it is found at a glance in a long list. A list with counts keeps room for the check mark on every row, so the counts line up. Checkboxes, for several choices, are drawn small (14px) and filled with the accent when on. An item that ends in "…" opens a dialog.
- **Source popovers** (a cited phrase on hover or focus): A source popover has one 12.5px row per document, with the name in `--ink` and its places after a "·" in `--ink-3`; the places give way first to an ellipsis (whole in the tooltip). The one action sits under a 1px `--line` rule, in `--accent`. The popover is 360px wide and hangs 14px below the line box of the phrase's last line. A finding's name lists up to four documents, or three and "N more".
- A cited phrase uses the pointer cursor if it opens a source. A phrase with a hover-only popover uses the default
  cursor (#440).
- A source chip keeps its page or location and its reading or precedent tag at full width. The document name uses the
  shared ellipsis and full-name tooltip when it runs out of room. When the tail alone fills the slot, it keeps the
  end of the name with a leading ellipsis. The document icon also shows the full filename on hover when space is
  tight (#441).
- **Order:** A dropdown menu is A to Z, with "All …" or a prompt first and a "No …" or "None" option last, which in a long menu stays in view below the scrolling choices, under a 1px rule; the scrolling part shows whole rows only. Which dropdowns keep an order of their own is in [docs/decisions.md](decisions.md).
- **Search** (14). Results drop from the sidebar field in a popup glass panel (radius 14px, `--shadow-pop`), grouped
  under labels split by rules (Deals, Findings, Checklist Items, Questions, and Documents). The label is 13px in
  600-weight `--ink-2` and title style. The total count uses 13px tabular figures in `--ink-3`. Each group starts with
  five results. “Show N More” at the right of the label (13px, 500, `--accent`) names the number it adds, up to 50.
  Until the selection moves, Enter skips “Show N More” and opens the first result. Matched words on the first line
  use weight 600. A hit inside a deal names its deal on the second line in `--ink-3`. Its question number, pages,
  or sheet cell appear at the right in tabular figures. For a shared deal name, the line starts with what distinguishes
  the deal (the counterparty or creation date), with both on hover.
  The location stays on one line and keeps the first meaningful word after “Project” along with the full question
  number or page range (#495). A sheet cell too wide for the location is left to the hover.
  In Search and the sidebar, a shortened counterparty keeps the words that distinguish same-name deals (#492).
  An ellipsis marks a shortened suffix after those words (#791).
  An oversized single-word counterparty ends in an ellipsis (#494) with normal spacing before the separator (#790).
  The start of a right-to-left deal name stays visible in Search (#490). Full labels are available to screen readers
  and on hover.
  A deal's own hit gives on its second line what tells it apart, or otherwise its sector.
- A Search question keeps the current deal's Q&A filters. From Home or a different deal it opens with All (#497).
- Choosing an open Checklist item in Search reveals its row again (#496).
- Keyboard selection in Search moves focus to the opened question or Checklist row (#498).
  When a question closes and its row is hidden by the active filter, focus returns to the Q&A filters.
- Search shows “No matches.” once it finishes reading My Deals and finds no results (#491).
- Search keeps the highlighted result when more records arrive, while that result is still listed (#501).
- **Lists and tables:** Rows are divided by 1px `--line` rules, no boxes. Column heads are set as in Type, in title style; on Q&A they stay in view above the list as it scrolls (with design C). The open row is the strongest; the row under the pointer is a step lighter.
- **Links between records** (#2): A finding's page lists, under its text, its checklist item as a dotted link (as the Checklist pane links its finding), the questions asked (the Checklist pane's Asked list) and Ask the counterparty with its card (the same New question card). A question's panel says "Asked for “…”" on its Question label line, in `--ink-2` like the Response label's notes, with a dotted link. It stays beside the label and gives way to an ellipsis, whole in the tooltip, so the question keeps its lines.
- **Folders dialog:** Each folder is a list row, as in Finder, with no box and no column heads: the `folder` icon at 16px in `--ink-3`, the name (12px 500 `--ink`) over the full path (12px `--ink-3`, cut at its start, whole on hover), the count (12px `--ink-3`, tabular; "2,148 of 5,190 indexed" in `--ink-2` while the folder is indexed, "Indexing" on hover) and the ×. Rows are at least 44px, divided by 1px `--line` rules, and a group's last row has none. The row under the pointer is Bare (`--card-hover`, `--r-ctl`); the name in it, an editable value, is bare at rest and the Control level under the pointer (`--card` in a 1px `--line` ring, 26px capsule), with "Edit name" in the app's tooltip. Folders waiting to be added are listed under a To Add heading below the deal's folders, with the same row ("1,486 files · 3.2 GB"). The footer has one filled action: Choose Folders… while nothing waits, then Add and Index, with Choose Folders… plain beside it. No rule under the title or over the footer, and 23px under the buttons, as in "Is this Project X?".
- **Locate Deal Folders**: There is no rule under the title or over the footer. The folders still to locate come first, with no heading: the new `warn` icon (a triangle with "!", in the icon set's line style) at 16px in `--high`, the path (13px `--ink`, cut at its start) over its line, which starts with why in 12px 500 `--high` ("Not found on this PC", or "Files not found") before "4 folders · Coho, Fabrikam" in `--ink-2`, and Locate… at the right. Every folder found so far follows, listed openly under "Found 42" (a section label with its count, 500, tabular, 6px after it), each with the `folder` icon at 16px in `--ink-3` in the same slot, so all paths line up, and Change… (a 28px `.btn.sm`). Rows are 56px, divided by `--line` rules. The footer says only what went wrong, beside Use These Folders.
- **Removed folders**: In the Folders dialog, folders taken off the deal are listed below its folders under a Removed heading, a section label. Each row is dimmed with the text tokens, not opacity (name `--ink-2`, path `--ink-3`), and only its icon fades (.6), with Restore (a 28px `.btn.sm`) in place of its count and ×, so no column changes width. Restore is off, with the reason on hover, while a folder added since overlaps it. In light, the paths, counts, and a removed folder's name take `--ink`: with no row box under them, `--ink-2` measured 4.1:1 on the dialog's glass (see Legibility); weight tells the name from the path.
- **Marks:** Marks are set 12px in from a Checklist row's left edge, with the group and section headings lined up with them: a 3px stripe at the left of a row (red while a finding is open), a small dot or dashed circle for a gap, a check mark for satisfied. Status words are plain text, colored only when outstanding: "Not saved" with its Retry or its reason, and "Changed elsewhere", under a field are red; the plain "Not saved" of a read-only field is gray.

## Notices

See reference screenshot 13.

- **Placement:** The notices sit at the top center of the page column. Up to three toasts form one deck, up to 400px wide: the newest is in front, with the older notices peeking behind it. Pointing at or tabbing into the deck spreads the notices out. Standing notices can wrap onto separate lines around the deck as needed.
- **Layout:** Every notice is one base, `Notice` in `src/ui/notice.tsx`: the toasts, the offline notice, Read-only, and an interrupted action alike, differing only in words and glyph. Inside the capsule, 6px from every side, on one 24px line: a 16px glyph in `--ink-2` in a 24px slot (`check` for something done, `warn`, a triangle, for something that did not happen), the title 13px/600 `--ink`, then the detail 13px `--ink-2` (the words after " · ", which stays in the text for screen readers but is not shown), its first letter capitalized; then optional actions such as Undo, Open, Retry, Retry Now, or Sign In, as 24px capsules at least 60px wide (`--card` fill, 1px `--line` edge, 12px/500 `--ink`); then the ✕, 24px, `--ink-3`, when the notice can be dismissed. No color marks a notice. The detail gives way to an ellipsis before the title does; the whole text shows on hover. A deal named with its twin line, as "Project Kestrel (Wingtip)", gives way before the verb, after its notice's detail, which is drawn not at all rather than as a stub (it is still read aloud); the label gives way at whole words: its name first, down to "Project" and one more word, then its twin line; where no whole word fits, the name is cut at a letter and the twin line's first word stays.
- **Material:** The capsule is popup glass, the same material as every menu (see Glass, radii, and shadows: new elements are Liquid Glass).
- **Timing and closing:** Toasts stay 8 seconds, paused while the pointer or focus is on them. Ctrl Z does what the showing Undo does. ✕ closes a toast; on the offline, Read-only, and interrupted notices it only hides that notice until it shows again (the account row still says Read-only, and an interrupted action keeps its Retry and Discard).
- **Standing notices:** Offline reads "**Not connected** Retrying" with Retry Now; while nobody is signed in to Intelligence, "**Read-only** Not signed in to Intelligence" with Sign In; an interrupted action, "**<action> interrupted** <where>" with Retry and Discard.
- **Interrupted actions out of view:** The summary counts dismissed and overflowed actions. **Show** brings another
  group into view and focuses its first Retry. The summary stays while any interrupted action is out of view (#565).

## Connection card

The connection card shows the state of the app's connections.

- **Placement:** The card appears right above the account row, at its width, while the row is pointed at or focused, and only when something is wrong. It is popup glass, with a 14px radius, `--shadow-pop`, and 13px text.
- **Sections:** The card has four sections divided by `--line` rules: Network, OneDrive, Intelligence, and Sync. Each has a 7px dot (`--ink-3` when fine, `--accent` while waiting, `--high` when out), its name at 14px weight 500, and one fact per line beneath in `--ink-2`; a line too long for the row (a long PC name) ends in an ellipsis, whole on hover.
- **Avatar dot:** The avatar's dot is 9px `--accent` with a `--surface` ring, at its lower right. It is `--high` while nobody is signed in, when the account row also says "Read-only" in `--high` under the name. [docs/decisions.md](decisions.md) says when the dot shows.
- **OneDrive notice:** When OneDrive has been out for 15 minutes, this is also reported once in an ordinary notice (see Notices): "OneDrive hasn’t synced since 2:41 PM".

## Tooltips

- **Names and reasons:** On hover, these use the native `title`: an icon button's name ("More", "Close (Esc)"), why a control is off ("Give the deal a name"), a deal's full name.
- **Shortened names:** A name shortened to fit shows in full on hover in the app's own tooltip (`src/ui/tip.ts`): after 350ms, 8px above the element (below it when there is no room), in the notice colors, 12.5px, radius 8px, at most six lines. It goes on any key, click, scroll or navigation.
- **Explanations:** Anything that explains how something works belongs in a tooltip, not on the screen.

## How to check a screen

Every control, row, pane, and popup a mock-up or change adds or alters passes only when every point holds, in dark and light, at 1280×736 and 1024×640. The rest of the screen is as built; where it differs from these rules it is filed (see Glass, radii, and shadows) and is not a template. Measure in the browser, not by eye, after transitions have settled (wait at least 500ms): `getComputedStyle` and `getBoundingClientRect()` on the control, a `Range` over each run of its text, and the `svg` box of each icon. Words inside an `<input>` or `<select>` can't be reached by a `Range`; the browser centers them itself when the field's top and bottom padding and borders are equal, so check that instead. A control's center is the middle of its box inside its border, and its padding is measured inside the border too.

1. **Materials.** Every pane, popup, row, and control is one level of the glass family (Glass, radii, and shadows). Every fill, edge, and text color equals one token's computed value, or a mix the app's CSS already uses or this page specifies (see that section); anything else fails, and so does an edge at rest without a fill, outside the listed exceptions.
2. **Sizes.** Height, padding, radius, and type match the control's row in the Controls table exactly (±0.5px for subpixel rounding). A control that is none of them copies the nearest one and says which. An editable value follows the Editable value row and Editable values exactly; a dotted underline, a bare outline, or a typed chevron on one fails.
3. **Vertical centering.** For every control with words or an icon, however it is laid out (flex, grid, inline-block or a plain box): each text run's box center is within 1px of the control's center, and each icon's within 0.5px. The approved buttons, picks, segments, properties, and menu items measure 0 to 0.9px for text and 0px for icons. Not checked this way: tabs (on a shared baseline), multi-line text boxes (words start at the top), and list rows (top-aligned).
4. **Horizontal centering.** An icon-only button's icon is within 0.5px of its center (all measure 0). In a button or pick sized to its content, the space from the inside of its border to the first item and from the last item to the other side differ by at most 1px (the status pick measures 10px and 10px). Menu items and list rows are left-aligned and not checked this way; for a select, check its padding against the table.
5. **Chevrons and icons.** Every chevron or arrow is an `svg` from `src/ui/icons.ts` or a select's own arrow; a typed one (⌃ ⌄ ▾ ▴ ˅ ˄ ⌵ and the like) in a control's text fails. New check marks are the `check` icon or the menu checkbox; the typed ✓ in the Finding status menu and the model menu is filed (#571).
6. **Spacing.** Gaps between controls in a row equal the gaps in the matching approved row (Controls, Spacing in a row), ±0.5px, and the controls in one row share one center line (within 1px). Heights in a row may differ only as the approved ones do (the Q&A toolbar: segmented control 34px, Filter field 32px, buttons and the workstream filter button 28px).
7. **Side by side.** Put the new screen next to the reference screen below that holds the same controls, at the same size and theme, and compare them at 100%: same heights, radii, fills, edges, and weights. Any difference fails unless this page or decisions.md names it.

| Checking | Compare with |
|---|---|
| Header buttons, icon buttons, tabs | 03 Overview, 05 Findings |
| Editable values | 03 Overview, 09 Q&A |
| Panel header: Discuss, arrows, × | 09 Q&A, question open |
| Segmented control, field, filled main action, toolbar | 09 Q&A, 08 Checklist |
| Pane glass, side pane, pane header | 08 Checklist |
| Dialog ×, form fields, footer actions | 02 New deal, 11 Settings, 12 Delete deal |
| Menus, checkboxes | 10 Q&A More menu |
| Composer, Attach | 04 Home |

Check by script and by eye; a screen that passes the script and looks off to the eye still fails.

## Reference screenshots

All at 1280×736, in [docs/design/](design/), `-dark.jpg` and `-light.jpg`, taken from the browser build's sample deal.

| # | Screen | Shows |
|---|---|---|
| 01 | First run | Empty state: the heading and its main action alone |
| 02 | New deal dialog | Form dialog |
| 03 | Overview | Header row, tabs, ask box, figures, section labels |
| 04 | Home | The question and the composer at the window's vertical center, example questions fading in its box; the same composer as a deal page's open box, Attach included |
| 05 | Findings | List rows with stripes, header actions |
| 06 | Finding | Slim rail, the finding and its item, conversation, suggested open question, composer |
| 07 | Reading mode | Page as paper, reading bar |
| 08 | Checklist | Side pane in the sidebar's glass, segmented filter |
| 09 | Q&A, question open | Glass panel across the top, main action filled |
| 10 | Q&A, More menu | Menu with groups and check marks |
| 11 | Settings | Dialog header with ×, label and value rows |
| 12 | Delete deal | Confirm dialog, footer actions |
| 13 | Notice | Notice with Undo |
| 14 | Search | Results dropping from the sidebar |

These screenshots show the look to keep; they are not a record of what is correct. A screen with an open bug in the GitHub issues shows that bug too.
