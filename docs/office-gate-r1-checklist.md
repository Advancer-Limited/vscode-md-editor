# Gate R1 — human checklist (Phase 1 viewers)

Date: 2026-11-21 · Plan §6 (Gate R1), §10 · Spec §7, §10.3, §11, §12, §14 (Phase 1 acceptance), §15

This is the single list of human checks for Gate R1. Everything that a script can check (check-types, compile, `npm test`, packaging, bundle size) is already recorded in `log.md` under "WP-17". Work top to bottom; items are grouped so one fixture is opened once and checked for everything at the same time. Budget: about 50 minutes for the **[must]** items, 20 more for **[nice]**.

- **[must]** = Gate R1 cannot pass without it. **[nice]** = worth doing, may be skipped and noted.
- Fixtures are in `tests/fixtures/office/` (abbreviated `fx/` below). Record failures with the item id (for example `W3`) and a screenshot.
- Record the result in `log.md` ("Gate R1 passed" or the list of open items). Nothing from Phase 2 merges before that.

Reference for what each fixture contains: `tests/fixtures/office/README.md`.

---

## 0. Setup (about 5 minutes)

- [ ] **0.1 [must] Build.** From the repo root (the checkout being gated): `npm install` (if needed) then `npm run compile`. It must finish without errors. For a closer match to the shipped build, `node esbuild.js --production` instead.
- [ ] **0.2 [must] Launch an isolated Extension Development Host.** Other markdown/Office extensions in your normal profile can claim `.docx`, `.xlsx` and `.md`, so use a throwaway profile (the tip from `log.md`, 2026-10-13). In PowerShell, from the repo root:

  ```powershell
  $tmp = Join-Path $env:TEMP ("vsmd-r1-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force "$tmp\user\User", "$tmp\ext" | Out-Null
  @'
  { "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off", "update.mode": "none",
    "extensions.autoCheckUpdates": false, "extensions.autoUpdate": false, "workbench.tips.enabled": false,
    "window.restoreWindows": "none", "chat.disableAIFeatures": true,
    "workbench.editorAssociations": { "*.md": "vscodeMdEditor.editor" } }
  '@ | Set-Content "$tmp\user\User\settings.json"
  code --extensionDevelopmentPath="$PWD" --user-data-dir="$tmp\user" --extensions-dir="$tmp\ext" --new-window --disable-extensions "$PWD\tests\fixtures\office"
  ```

  Expected: a new VS Code window titled with the fixtures folder, the Explorer listing the fixtures, no other extensions. (`--disable-extensions` does not stop the extension under development.) Delete `$tmp` when finished.
- [ ] **0.3 [must] Extension activates cleanly.** In the dev host run **Developer: Show Running Extensions**: "VS Code MD Editor" is listed as activated with no errors; **Developer: Toggle Developer Tools** console shows no red errors from the extension host on first open of a `.docx` and an `.xlsx`.
- [ ] **0.4 [must] How to read a webview console and network.** With a viewer tab focused: **Developer: Open Webview Developer Tools**. Used for E5/E6 below. Leave one window open per viewer type while sweeping.
- [ ] **0.5 [must] Scratch copies.** Copy `basic.docx` and `basic.xlsx` to a folder outside the repo (for example `$tmp\scratch`). Items that need you to edit and save a file in Word/Excel (W10, X13, E3) use these copies, never the committed fixtures.
- [ ] **0.6 [must] Know the baseline.** Before opening anything: `git status` in the repo is clean. It is checked again in E7.

---

## A. Word viewer (about 12 minutes)

Open each file from the Explorer by clicking it (it should open in "Word Document Viewer" without any picker).

- [ ] **W1 [must] `fx/basic.docx` opens as pages.** Title, Heading 1-3, bold/italic/underline runs, a bullet list and a numbered list with a nested level are all visible and look like Word. There is no Edit button and no dirty dot on the tab. Toolbar shows zoom, section count, Open in Word, About.
- [ ] **W2 [must] `fx/rich.docx` visual check against Word** (open the same file in desktop Word side by side). Expected: table, inline picture, floating picture, header and footer, footnote, hyperlink, page break and section break all render; layout is close to Word (docx-preview is approximate, not identical: no re-pagination, floating picture may sit slightly differently). The toolbar's section count matches the number of explicit page/section breaks plus one. The notices bar lists nothing that is not actually in the file. This is the Phase 1 acceptance item for Word (spec §14).
- [ ] **W3 [must] Zoom.** On `rich.docx`: the zoom buttons step 50-200%; **Fit width** fills the window with a sensible margin (the 40 px `FIT_MARGIN_PX` should look neither cramped nor wasteful, with and without the scrollbar); Ctrl+wheel zooms; Ctrl+= and Ctrl+- zoom; resizing the window while on Fit width re-fits.
- [ ] **W4 [must] Find.** On `rich.docx`: Ctrl+F opens VS Code's find widget for the webview; typing a word that appears in the body highlights matches and Enter steps through them; Esc closes it and focus returns to the page.
- [ ] **W5 [must] Links.** (a) `rich.docx` external hyperlink: click it. VS Code shows its trusted-domain prompt, then the browser opens that URL; the webview itself does not navigate. (b) `anchors.docx` and `fields.docx`: click an internal bookmark / TOC / cross-reference link: the page scrolls to the target (smooth scrolling off if `prefers-reduced-motion`). (c) Any link in a document that is not http/https/mailto does nothing.
- [ ] **W6 [must] Notices bar.** Each shows a notice naming the feature, and the document still displays: `tracked.docx` (tracked changes, "shown as if accepted"; insertions visible, deletions gone); `anchors.docx` (comments, with the count); `external-image.docx` (picture linked from the web is not loaded, with an explanation); `fields.docx` and `content-controls.docx` (open and display; no false notices).
- [ ] **W7 [must] Variants open without an error view.** `multi-run.docx` (mixed formatting, tabs, soft break), `no-heading-styles.docx`, `no-numbering.docx`, `protected.docx` (viewing is fine, no error), `localised-de.synthetic.docx` (German heading text displays).
- [ ] **W8 [must] `fx/tables.docx`.** Mixed formatting in cells, a list inside a cell, a nested table, merged cells (`gridSpan`/`vMerge`), the 70-row table that spans pages, and the tracked row insertion all render. Compare to Word.
- [ ] **W9 [must] `fx/large.docx` (about 300 pages).** Opens and renders without freezing VS Code (spec S4 measured under 1 s in the spike; the real extension should be within a few seconds); scrolling and zoom afterwards stay responsive; the editor area and the rest of VS Code (typing in another editor) stay usable while it renders. Note the render time.
- [ ] **W10 [must] Reload after saving in Word.** Open the scratch `basic.docx` in the viewer. Open the same file in desktop Word, change a word, save. Within a couple of seconds the viewer shows the new text and the tab never becomes dirty. (This is the "document is clean, so reload" path.)
- [ ] **W11 [must] Open in Word.** The toolbar button opens the file in desktop Word. **[nice]** About shows the brand/about content and closes with Esc.
- [ ] **W12 [nice] User-supplied files, if they have arrived** (`tests/fixtures/office/README.md`, "PENDING"): `libreoffice.docx`, `googledocs.docx`, `localised-de.docx` open and display basic content. If not present, note "not available" and continue.

---

## B. Excel viewer (about 15 minutes)

- [ ] **X1 [must] `fx/basic.xlsx`.** Numbers, text including non-ASCII, booleans, constant errors (`#DIV/0!`), dates, time, percent, currency and custom formats show the same display text as Excel (open the file in Excel alongside). Tab **Second Sheet** switches and shows its content. (The expected strings were hand-written in WP-12; this is the check against real Excel.) No Edit button, no dirty dot.
- [ ] **X2 [must] `fx/styles.xlsx` against `fx/expected/styles.pdf`.** Compare with the PDF (Excel's own export): column widths and row heights, merged cells, frozen panes (headers stay pinned while scrolling), fonts, solid fills, theme colours with tint (within a few percent of Excel's), borders, alignment/wrap/indent, hidden row and hidden column shown as a thin marker. Gradient/pattern fills may show as the nearest solid colour (known). This is the Phase 1 acceptance item for Excel (spec §14).
- [ ] **X3 [must] `fx/large.xlsx` scroll performance.** Scroll with the wheel, the scrollbar thumb and PageDown/Ctrl+End. Expected: no visible stutter; blank areas fill in promptly (cells load in blocks); sticky row/column headers and frozen panes stay pinned; no frame over 100 ms on the reference machine (check with the webview DevTools Performance tab while dragging the scrollbar if it looks doubtful). Memory in the webview process does not keep growing while scrolling.
- [ ] **X4 [must] `fx/formulas.xlsx`.** Select formula cells: the formula bar shows the formula text; the cell shows the cached value. On sheet `NoCache`, cells show `=formula` in italics and the formula bar shows a "Not calculated" marker. Shared-formula dependents: note what the formula bar shows for a dependent cell (expected: the value is correct; the formula text may be absent, which is a known Phase 1 limit). Cross-sheet and quoted-sheet references display their cached values.
- [ ] **X5 [must] `fx/features.xlsx`.** Per-sheet notices list what is present but not drawn: chart, image, conditional formatting, data validation, sparklines, pivot table (as applicable to the sheet). Cell values still display. A cell with a note shows a corner marker and a tooltip on hover (and via keyboard focus). Ctrl+click on an `https` hyperlink opens the browser (after VS Code's prompt); Ctrl+click on an internal `#Sheet!A1` link switches sheet and selects the cell; a plain click does not follow a link.
- [ ] **X6 [must] Selection and status bar** (on `basic.xlsx`). Click, drag, Shift+arrows, Ctrl+A. The status bar shows the address/range and Sum, Average, Count for numeric cells. For percent and currency cells the Sum uses the raw value (50% counts as 0.5), not the displayed text. Ctrl+Home/Ctrl+End, Ctrl+arrows (jump to data edge), Home, PageUp/PageDown behave like Excel.
- [ ] **X7 [must] Find** (on `basic.xlsx` or `formulas.xlsx`). Ctrl+F opens the grid's own bar. Search finds display text and formula text; Enter/Shift+Enter/F3 step; the match-case toggle works; scope "this sheet" vs "all sheets" works and all-sheets switches tabs to reach a match; the count reads "1,000+" when capped (try a common character on `large.xlsx`); Esc closes the bar and focus returns to the grid. VS Code's own find widget does not appear instead.
- [ ] **X8 [must] Copy.** Select a block on `basic.xlsx` and press Ctrl+C, then paste into Notepad: tab-separated, one line per row, displayed text as shown in the grid. The toolbar Copy button and Shift+F10 → Copy do the same. On `large.xlsx`: Ctrl+A then Ctrl+C does not hang VS Code (a capped/partial result is acceptable; a freeze is not).
- [ ] **X9 [must] Sheet tabs.** Tab buttons switch sheets; arrow keys move between tabs; Ctrl+PageUp/Ctrl+PageDown switch sheets from the grid and are not swallowed by VS Code; many-sheet tab strips scroll. Switching back keeps the earlier selection/scroll sensibly.
- [ ] **X10 [must] `fx/date1904.xlsx`.** Dates match what Excel shows (the 1904 date system is honoured; they must not be off by 4 years and 1 day).
- [ ] **X11 [must] Open-all sweep, Excel.** Each opens to a view and none shows an error view or a blank grid: `tables.xlsx`, `protected-sheet.xlsx` and `protected-structure.xlsx` (viewing allowed), `inline-strings.xlsx`, `no-shared-strings.xlsx`, `no-styles.xlsx`, `prefixed-namespaces.xlsx`, `data-descriptors.xlsx`, `no-date-style.xlsx`, `no-date-style-nocount.xlsx`. (The synthetic ones have minimal styling; content is what matters.)
- [ ] **X12 [nice] Hidden sheets and chart sheets.** No committed fixture has a hidden sheet or a chartsheet. If you have one (or hide a sheet in a copy of `basic.xlsx` in Excel): the hidden sheet is reachable from the "Hidden sheets" menu and then shows a temporary tab; a chartsheet shows a "not displayed" placeholder with **Open in Excel**.
- [ ] **X13 [must] Reload on change.** Open the scratch `basic.xlsx` in the viewer on Second Sheet; change a cell in Excel and save. The viewer reloads with the new value and stays on the same sheet; tab never dirty.
- [ ] **X14 [nice] `vscodeMdEditor.office.sheetAppearance`.** Set to `light` in Settings, reopen `styles.xlsx` in a dark theme: the grid is drawn light as authored. Set back to `theme`.
- [ ] **X15 [must] Open in Excel.** The toolbar button opens the file in desktop Excel.
- [ ] **X16 [nice] User-supplied files, if they have arrived:** `libreoffice.xlsx`, `googlesheets.xlsx` open and display basic content. If not present, note "not available".

---

## C. Errors and security (about 8 minutes)

- [ ] **E1 [must] Error views.** Each opens an error view (never a blank page, never a toast only) with the exact plain message, an **Open in Word/Excel** button and, for the damaged/empty cases, **Retry**, and a **Details** disclosure with a technical reason:
  - `fx/encrypted.docx`, `fx/encrypted.xlsx` — "This file is password-protected. Open it in Word/Excel to view it." (password is `test`).
  - `fx/legacy-renamed.docx` — "This looks like an older .doc file saved with a .docx name."
  - `fx/truncated.docx` — "This file is damaged and can't be displayed."; Details names a truncation / bad data reason.
  - `fx/zip64.xlsx` — "This file uses a packaging feature this viewer doesn't support."
  - Make these in the scratch folder (PowerShell): a zero-byte `empty.docx` (`New-Item empty.docx`) — "This file is empty."; a copy of `basic.docx` named `~$basic.docx` — "This is a temporary lock file created by Word..."; a text file named `notzip.docx` — damaged message.
- [ ] **E2 [must] Open in Word/Excel from an error view** works from at least one Word and one Excel error view (`encrypted.docx` in Word asks for the password, which proves the hand-off).
- [ ] **E3 [must] File open in Word.** With the scratch `basic.docx` open in desktop Word (so `~$basic.docx` exists next to it), open it in the viewer: it opens normally with a warning notice that the file appears to be open in Word. Repeat for `basic.xlsx` / Excel. (Closing Word and reopening in VS Code: no notice.)
- [ ] **E4 [must] Hostile and no-network: `fx/external-image.docx`.** In the webview DevTools **Network** tab (open before loading the file, preserve log on): reload the tab (close and reopen). There is no request to `127.0.0.1:9` or any other host. The picture appears broken and the notices bar explains why. Expected for WP-10 and spec §12.
- [ ] **E5 [must] CSP sweep.** With Webview Developer Tools open on a viewer tab, open each of: every `.docx` and every `.xlsx` in `fx/` that renders (all except the negative fixtures of E1). The **Console** shows no "Refused to ..." Content-Security-Policy violation and no uncaught exception for any of them. Do this as you go through sections A and B instead of as a separate pass: keep the console open, and tick this item at the end if it stayed clean. Also confirm there are no `Failed to load resource` errors other than the one external image in E4.
- [ ] **E6 [must] Nothing becomes dirty, nothing is written.** After sections A, B and E: no tab has a dirty dot; closing all tabs raises no "Save changes?" prompt; pressing Ctrl+S in a viewer does nothing visible; in the repo `git status` is clean (fixtures unchanged) and the files' timestamps in `tests/fixtures/office/` are unchanged. This is the Phase 1 acceptance item "No file is ever written; documents are never dirty."
- [ ] **E7 [nice] Restricted Mode.** Start the dev host with workspace trust prompting on (leave **Restricted Mode** on for the folder): `.docx` and `.xlsx` still open in the viewers (they run nothing from the workspace).
- [ ] **E8 [nice] Git history view.** If the fixtures folder is a git repo: open a committed revision of `basic.docx` from the Timeline or "Open Changes". It opens in the viewer read-only; no errors.

---

## D. Theming and accessibility (about 12 minutes)

Use one Word file (`rich.docx`) and one Excel file (`styles.xlsx`) open at the same time. Switch with **Preferences: Color Theme**.

- [ ] **T1 [must] Four themes.** For each of **Light+**, **Dark+**, **Dark High Contrast**, **Light High Contrast**:
  - Word: the page stays a light "paper" with the document's own colours on a themed backdrop; in the high-contrast themes the page has a visible contrast outline; toolbar, zoom control, notices bar and error view are readable.
  - Excel: with `sheetAppearance: theme`, unfilled cells use the editor background, automatic text uses the editor foreground, filled cells keep their fills and their text stays readable (black or white chosen by contrast with the fill), an explicit low-contrast font colour is replaced. Gridlines, selection and the focus ring are visible; formula bar, status bar, sheet tabs and find bar are readable; nothing relies on colour alone (a stale formula shows the text "Not calculated").
- [ ] **T2 [must] Live theme switch.** With both viewers open, change the theme from Light to Dark without reopening the tabs: the Excel grid recolours immediately (the grid's colours refresh on theme change; this was fixed after WP-16 and is not yet seen in a real host); Word chrome follows.
- [ ] **T3 [must] Keyboard-only walkthrough, Word.** No mouse. Tab reaches the toolbar; Left/Right arrows move among its buttons (one tab stop for the toolbar); Enter/Space activate zoom, Fit width, Open in Word; Ctrl+= / Ctrl+- zoom; Ctrl+F then Esc returns focus to the page; every control has a visible focus ring; you can scroll the page with arrows/PageUp/PageDown once focused.
- [ ] **T4 [must] Keyboard-only walkthrough, Excel.** No mouse. One Tab stop reaches the grid; arrows, Tab/Shift+Tab, Home, Ctrl+Home/End, Ctrl+arrows, PageUp/PageDown move the active cell and scroll; Shift+arrows and Ctrl+A select; Ctrl+C copies; Ctrl+F opens find and Esc returns focus to the grid; Shift+F10 opens the context menu (arrows, Enter, Esc; focus returns to the grid); the sheet tab list is reachable with arrow keys; Ctrl+PageUp/Down switch sheets. Nothing is hover-only (the cell note tooltip is reachable from the keyboard).
- [ ] **T5 [must] Screen reader spot check (Narrator, or NVDA).** Word: toolbar buttons are announced with names ("Fit width", "Open in Word", ...); the page text reads in order. Excel: entering the grid announces a grid with row and column counts; moving with the arrow keys announces cells with address and value (for example "B7, 1,250.00, has formula" on a formula cell) and row/column headers; sheet tabs announce as tabs with the selected state; the status bar sum change and the find count are announced politely. Record which reader and version you used.
  - Known and accepted for Phase 1 (do not fail on it): Word headings are not announced as headings with a level (`role="heading"`/`aria-level` arrive with the block list in the editing phase).
- [ ] **T6 [nice] Reduced motion and forced colours.** With Windows "Animation effects" off, no animated scrolling in the viewers. With a Windows contrast theme on (forced-colors), the toolbar and grid remain usable and the focus ring is visible.

---

## E. Regression: existing editors (about 5 minutes)

The Office work added step 2d/2e wiring in `extension.ts` and two `customEditors` entries; make sure nothing else moved.

- [ ] **R1 [must] Markdown editor.** Create a scratch `note.md`, open it (it opens in "VS Code MD Editor" in this profile): type text; toolbar bold/heading buttons work; switch Edit / Split / Raw; type `[[` and the wikilink autocomplete appears; Ctrl+F opens the editor's find bar (not VS Code's) and finds text; edit survives save and reload.
- [ ] **R2 [must] Mermaid editor.** Create a scratch `d.mmd` with `graph TD; A-->B;`. It opens in "Mermaid Diagram Editor": diagram renders, an error line is marked when you break the syntax, zoom/pan works.
- [ ] **R3 [must] glTF viewer.** Open any small `.gltf` (none is committed; use one from the three.js samples) or at least confirm a scratch `x.gltf` containing `{}` opens in "glTF 3D Editor" with its source pane and a sensible message rather than a crash.
- [ ] **R4 [nice] Sidebar.** The "Markdown Links" activity-bar view lists the markdown files; **Show Graph** opens the graph. Neither lists `.docx`/`.xlsx` files (Office files are not indexed in v1).
- [ ] **R5 [nice] Opt-out.** Right-click `basic.docx` in the Explorer → **Open With...** lists "Word Document Viewer" and VS Code's text editor; choosing **Configure default editor for '*.docx'...** and picking another option makes plain clicks use it. Setting `"workbench.editorAssociations": { "*.docx": "default" }` does the same (this is the README's switch-back instruction, so it must really work).

---

## F. Pending Phase 0 item — S3 Ctrl+Z locality (about 5 minutes) — needed before Word editing (group D)

Not a Phase 1 blocker; it must be recorded before the Word editing work (WP-32/34, "group D") starts, and the result goes into spec §16 and `log.md`. It decides whether Ctrl+Z inside an open edit field stays local or also fires VS Code's document undo. Synthetic key events cannot test this, so it needs real key presses. It uses the throwaway spike extension, not this repo's build.

- [ ] **P0.1 [must for group D] Launch the S3 session:**

  ```powershell
  pwsh -File D:\Development\advancer\VSMarkdownEditor-spike\spike\office\run-dev.ps1 -Folder inputs-s3 -NoWait
  ```

  An isolated dev host opens `s3.docx` in the spike's document editor with three fields: a `textarea`, an `input`, and a `contenteditable` ("Edit me" island), plus a "guard on (capture-phase stopPropagation)" checkbox, ticked.
- [ ] **P0.2 [must for group D] Guarded run.** For each of the three fields in turn: click inside it, type a few characters, press **Ctrl+Z**, then **Ctrl+Y**. After about a second the page prints a line per key press, for example `Ctrl+Z in f1 guard=true: nativeUndo=historyUndo hostCallback=no => PASS`. Expected: all six lines (3 fields x Z and Y) say **PASS** (the browser's own undo ran and the host's document-undo callback did not fire).
- [ ] **P0.3 [must for group D] Control run.** Untick the guard, click in the textarea, type, press Ctrl+Z. Expected (to prove the test is real): the host callback fires, so the line says `FAIL`. Record it as the control.
- [ ] **P0.4 [must for group D] Record.** Results are also written to `spike/office/out/s3-result.json` in the spike worktree (vscode version and platform are included). Paste the verdict into `log.md` under the Phase 0 spike report (replace "Pending (user)") and into spec §16. If any guarded line fails, adopt the documented fallback from plan WP-01: Ctrl+Z cancels the in-progress edit and undoes the last committed one. Do macOS too if one is available. Close the window when done.

---

## Coverage map

| Source | Covered by |
|---|---|
| Plan §6 Gate R1: every fixture opens to a view or the right error view | W1-W9, X1-X11, E1, E5 |
| `rich.docx` visual check | W2 |
| `styles.xlsx` against `expected/styles.pdf` | X2 |
| Scroll `large.xlsx` | X3 |
| Light, dark, HC dark, HC light | T1, T2 |
| Keyboard-only walkthrough | T3, T4 |
| Narrator/NVDA spot check | T5 |
| No CSP violation on any fixture | E5 |
| `external-image.docx` makes no request | E4 |
| No fixture becomes dirty | E6 |
| `/code-review` on PR-3 and PR-4 diffs | not a human check; run by the orchestrator (see `log.md`) |
| Plan §10 per-release items 1-4 (edited outputs in Word/Excel/LibreOffice) | not applicable: Phase 1 never writes a file (E6) |
| Plan §10 items 5-6 (edit/save/reopen/hot-exit) | not applicable in Phase 1; theme sweep and keyboard pass are T1-T4 |
| Spec §14 Phase 1: Word `rich.docx`; zoom, find, links, notices | W2-W6 |
| Spec §14 Phase 1: Excel `styles.xlsx`; large.xlsx; switching, selection, status bar, TSV, find | X2-X9 |
| Spec §10.3 error table (password, legacy, lock file, damaged, packaging, empty, open in Word, external changes) | E1-E3, W10, X13 |
| WP-08 (host shell: lock notice, reload on change, read-only) | E1, E3, E8, W10, X13 |
| WP-09 (chrome: toolbar roving tabindex, notices, error view) | T3-T5, E1 |
| WP-10 (rendering/theming, fit-width margin, find, bookmarks, no network, reload) | W2-W6, W10, E4 |
| WP-12 (display strings against real Excel) | X1, X10 |
| WP-13/14/15 (scroll, sticky layers, themes, raw-value stats, TSV, sheetAppearance) | X2, X3, X6, X8, X14, T1 |
| WP-16 (layout, menus, keyboard, large copy, links, chart/hidden sheets, formulas, reload, notices, live theme switch) | X4-X9, X12, X13, T2, T4 |
| Phase 0 pending: S3 | F (P0.1-P0.4) |

Not coverable here: the `sheet-unavailable` notice (needs a workbook with a damaged sheet part; no fixture) and the `<!DOCTYPE` refusal (automated tests only). Both are exercised by unit tests.
