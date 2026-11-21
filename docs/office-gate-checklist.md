# Office gates R1, R2 and R4 — human checklist

Date: 2026-11-21 · Plan §6 (gates R1-R4), §10, §13 · Spec §7, §9.3-9.6, §10.3, §11, §14, §15, §16

One list for every human check still open on the Office viewers/editors: **Gate R1** (viewers), **Gate R2** (Excel cell editing) and **Gate R4** (Excel rows, columns, sheets). Gate R3 (Word editing) is not in this list; Word editing has not been built yet. Everything a script can check (`check-types`, `compile`, `npm test`, packaging) is already recorded in `log.md`. Work top to bottom; each fixture is opened once and checked for everything at the same time.

- **[must]** = the gate cannot pass without it. **[nice]** = worth doing, may be skipped and noted.
- Fixtures are in `tests/fixtures/office/` (abbreviated `fx/`). Record failures with the item id (for example `W3`, `H8`) and a screenshot, and paste the results into `log.md` ("Gate R1 passed", "Gate R2 passed", or the list of open items).
- Nothing from the next phase merges, and no feature flag flips, until its gate is recorded as passed.
- Fixture contents: `tests/fixtures/office/README.md`. Office-script usage: `tests/office/README.md`.

| Section | Time |
|---|---|
| 0 Before you start | 10 min |
| 1 Items needed from you | 5 min |
| 2 Phase 0 S3 Ctrl+Z spike | 5 min |
| 3 Gate R1 — viewers | 70 min (50 [must] + 20 [nice]) |
| 4 Gate R2 — Excel cell editing | 75 min (15 Office + 60 dev host) |
| 5 Gate R4 — Excel rows/columns/sheets | 50 min (10 Office + 40 dev host) |
| 6 Excel goldens (WP-37) | 10 min of your time (an agent does the COM run) |
| **Total** | **about 3 h 45 min**; the [must] items alone about 2 h 45 min |

Sections can be done in separate sittings: R1 any time; R2 and R4 each need editing switched on (0.8) and desktop Excel.

---

## 0. Before you start (about 10 minutes)

- [ ] **0.1 [must] Build.** From the repo root (the checkout being gated): `npm ci`, then `npm run compile`. It must finish without errors. For a closer match to the shipped build, `node esbuild.js --production` instead.
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
- [ ] **0.7 [must] Automated baseline.** `npm test`. Expect about 1,190 passing and **one skip** (the PENDING `libreoffice.xlsx` case), 0 failures. Two tests are load-sensitive and can fail once on a busy machine: `saveBlocking.test.mjs` (longest event-loop block must stay under 1,000 ms, 3 attempts) and the `large.xlsx` S4 budget test in `xlsxRead` (10 s limit). Close other heavy programs and re-run just that file (`node --test tests/office/saveBlocking.test.mjs`) before treating it as a real failure. `npm test` also regenerates `tests/.out/**`, which sections 4 and 5 verify.
- [ ] **0.8 [must for R2/R4] Temporarily turn editing on for a test session.** Editing is off in the build on purpose (`OFFICE_FLAGS` in `src/office/featureFlags.ts` are all false until the gates pass). For R2 and R4 only: edit that file **locally**, set `xlsxEdit: true` and `xlsxStructure: true` (leave `docxEdit: false`), then `npm run compile` and launch the dev host (0.2). Without the first flag there is no Edit button and no Save As; without the second, row/column/sheet operations are refused. **Do not commit this change.** To revert: `git checkout -- src/office/featureFlags.ts`, `npm run compile`, and check `git status` is clean. Do the "flags off" check (H21) before flipping the flags, or after reverting.
- [ ] **0.9 [must for H11] Corrupt-save hook.** To rehearse a verification failure, start the dev host from a shell that has `$env:VSMD_OFFICE_CORRUPT_SAVE = '1'` set (PowerShell, before the `code --extensionDevelopmentPath ...` line in 0.2). Use a **separate** window for H11 only; close it and unset the variable (`Remove-Item Env:VSMD_OFFICE_CORRUPT_SAVE`) afterwards so every other check runs normally.

---

## 1. Items needed from you (not checks)

- [ ] **U1 [must for Word editing] Producer fixtures.** Create and drop into `tests/fixtures/office/` under exactly these names (recipes: `tests/fixtures/office/README.md`, "PENDING"): `libreoffice.docx`, `libreoffice.xlsx` (LibreOffice Save As of `basic.*`), `googledocs.docx`, `googlesheets.xlsx` (upload `basic.*` to Google Drive, download), and `localised-de.docx` (a Word with German UI; styles "Überschrift 1/2/3"). Phase 0-2 and 4 do not need them; Word editing (group D) and the v1 definition of done do (no `PENDING` left). Their absence is why `libreoffice.xlsx` is the one skipped test.
- [ ] **U2 [must] Release point.** Decide when users get something: after Gate R1 (viewers only), after Gate R2 (plus Excel cell editing), after R4 (plus structure), or only at v1 (plan §13.5 lists R1, R3 or R-final). Tell Claude; it decides which flags ship on and whether a version-bump PR is cut at that point.
- [ ] **U3 [must] Push and open the PR stack.** Nothing is pushed. When ready, tell Claude "push and open the PRs": it pushes the Office branches and opens the PRs into `develop` in plan order, self-reviews each, and (only if you say so) merges with `gh pr merge --admin`. Per the plan, nothing past a gate merges until that gate is recorded as passed.

---

## 2. Phase 0 S3 Ctrl+Z spike (about 5 minutes) — needed before Word editing (group D)

Not a gate blocker for R1, R2 or R4. The result goes into spec §16 (assumption 2) and `log.md`. It decides whether Ctrl+Z inside an open edit field stays local. Excel cell editing currently ships the documented fallback (Ctrl+Z in an open cell editor cancels that edit), so H3 is worded to match either result. Synthetic key events cannot test this, so it needs real key presses in the throwaway spike extension, not this repo's build.

Not a Phase 1 blocker; it must be recorded before the Word editing work (WP-32/34, "group D") starts, and the result goes into spec §16 and `log.md`. It decides whether Ctrl+Z inside an open edit field stays local or also fires VS Code's document undo. Synthetic key events cannot test this, so it needs real key presses. It uses the throwaway spike extension, not this repo's build.

- [ ] **S3.1 [must for group D] Launch the S3 session:**

  ```powershell
  pwsh -File D:\Development\advancer\VSMarkdownEditor-spike\spike\office\run-dev.ps1 -Folder inputs-s3 -NoWait
  ```

  An isolated dev host opens `s3.docx` in the spike's document editor with three fields: a `textarea`, an `input`, and a `contenteditable` ("Edit me" island), plus a "guard on (capture-phase stopPropagation)" checkbox, ticked.
- [ ] **S3.2 [must for group D] Guarded run.** For each of the three fields in turn: click inside it, type a few characters, press **Ctrl+Z**, then **Ctrl+Y**. After about a second the page prints a line per key press, for example `Ctrl+Z in f1 guard=true: nativeUndo=historyUndo hostCallback=no => PASS`. Expected: all six lines (3 fields x Z and Y) say **PASS** (the browser's own undo ran and the host's document-undo callback did not fire).
- [ ] **S3.3 [must for group D] Control run.** Untick the guard, click in the textarea, type, press Ctrl+Z. Expected (to prove the test is real): the host callback fires, so the line says `FAIL`. Record it as the control.
- [ ] **S3.4 [must for group D] Record.** Results are also written to `spike/office/out/s3-result.json` in the spike worktree (vscode version and platform are included). Paste the verdict into `log.md` under the Phase 0 spike report (replace "Pending (user)") and into spec §16. If any guarded line fails, adopt the documented fallback from plan WP-01: Ctrl+Z cancels the in-progress edit and undoes the last committed one. Do macOS too if one is available. Close the window when done.


---

## 3. Gate R1 — viewers (about 70 minutes: 50 [must], 20 [nice])

Phase 1 acceptance (spec §14). Section 0 setup (0.1-0.6) comes first; the Phase 0 spike is section 2.

### 3A. Word viewer (about 12 minutes)

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

### 3B. Excel viewer (about 15 minutes)

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
- [ ] **X12 [nice] Hidden sheets, chart sheets and a damaged sheet.** Open `fx/hidden-sheets.xlsx`: tabs show Values and Second Sheet only; "Hidden Sheet" is reachable from the "Hidden sheets" menu and then shows a temporary tab; "Very Hidden Sheet" is not offered anywhere. Open `fx/chartsheet.xlsx`: "Chart Sheet" shows a "not displayed" placeholder with **Open in Excel**. Open `fx/damaged-sheet.xlsx`: Values and Second Sheet display normally; selecting "Damaged Sheet" shows the `sheet-unavailable` warning notice, not a blank grid or an error view.
- [ ] **X13 [must] Reload on change.** Open the scratch `basic.xlsx` in the viewer on Second Sheet; change a cell in Excel and save. The viewer reloads with the new value and stays on the same sheet; tab never dirty.
- [ ] **X14 [nice] `vscodeMdEditor.office.sheetAppearance`.** Set to `light` in Settings, reopen `styles.xlsx` in a dark theme: the grid is drawn light as authored. Set back to `theme`.
- [ ] **X15 [must] Open in Excel.** The toolbar button opens the file in desktop Excel.
- [ ] **X16 [nice] User-supplied files, if they have arrived:** `libreoffice.xlsx`, `googlesheets.xlsx` open and display basic content. If not present, note "not available".

---

### 3C. Errors and security (about 8 minutes)

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
- [ ] **E7 [nice] Restricted Mode.** Start the dev host with workspace trust prompting on (leave **Restricted Mode** on for the folder). package.json declares no `capabilities.untrustedWorkspaces`, so the whole extension is disabled there: `.docx` and `.xlsx` fall back to VS Code's default editor, with no error. (Declaring limited support is a separate, extension-wide decision; the README makes no untrusted-workspace claim.)
- [ ] **E8 [nice] Git history view.** If the fixtures folder is a git repo: open a committed revision of `basic.docx` from the Timeline or "Open Changes". It opens in the viewer read-only; no errors.

---

### 3D. Theming and accessibility (about 12 minutes)

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

### 3E. Regression: existing editors (about 5 minutes)

The Office work added step 2d/2e wiring in `extension.ts` and two `customEditors` entries; make sure nothing else moved.

- [ ] **R1 [must] Markdown editor.** Create a scratch `note.md`, open it (it opens in "VS Code MD Editor" in this profile): type text; toolbar bold/heading buttons work; switch Edit / Split / Raw; type `[[` and the wikilink autocomplete appears; Ctrl+F opens the editor's find bar (not VS Code's) and finds text; edit survives save and reload.
- [ ] **R2 [must] Mermaid editor.** Create a scratch `d.mmd` with `graph TD; A-->B;`. It opens in "Mermaid Diagram Editor": diagram renders, an error line is marked when you break the syntax, zoom/pan works.
- [ ] **R3 [must] glTF viewer.** Open any small `.gltf` (none is committed; use one from the three.js samples) or at least confirm a scratch `x.gltf` containing `{}` opens in "glTF 3D Editor" with its source pane and a sensible message rather than a crash.
- [ ] **R4 [nice] Sidebar.** The "Markdown Links" activity-bar view lists the markdown files; **Show Graph** opens the graph. Neither lists `.docx`/`.xlsx` files (Office files are not indexed in v1).
- [ ] **R5 [nice] Opt-out.** Right-click `basic.docx` in the Explorer → **Open With...** lists "Word Document Viewer" and VS Code's text editor; choosing **Configure default editor for '*.docx'...** and picking another option makes plain clicks use it. Setting `"workbench.editorAssociations": { "*.docx": "default" }` does the same (this is the README's switch-back instruction, so it must really work).

---

---

## 4. Gate R2 — Excel cell editing (about 75 minutes: 15 Office, 60 dev host)

Plan §6 R2, spec §6, §9.3-9.5, §10.3. The independent review (Fable) is done and its findings F1-F10 are fixed; what is left is real Office and a real Extension Development Host. Until R2 is recorded, `xlsxEdit` stays false.

### 4a. Real Excel on the saved outputs (about 15 minutes)

`scripts/verify-office-open.ps1` starts its own hidden Excel, opens every file read-only with repair disabled, recalculates, compares `.expect.json` cells, closes without saving, and prints a JSON summary (exit 0 = all passed, 1 = a failure, 2 = no files or no Office). It never touches an Excel you already have open. Run from the repo root in PowerShell.

- [ ] **V1 [must] Dry run.** `pwsh scripts/verify-office-open.ps1 -DryRun -Path "tests\.out\r2-excel-check"`. Expected: lists 23 files (the independent reviewer's workbooks: `f01`-`f19`, `n01`-`n03`, `c01`, `t01`), creates no Office objects. The folder is git-ignored and exists in the `D:\Development\advancer\VSMarkdownEditor-refs` worktree (copied there from the reviewer's scratchpad); run from that worktree, or copy the folder. If it's gone, ask Claude to rebuild the 23 workbooks (generator: the reviewer's `gen.cjs`).
- [ ] **V2 [must] Independent-reviewer workbooks.** Same command without `-DryRun`, with `-Kind Excel -JsonPath r2-excel-check.json`. These are formulas the formula validator accepts, built to see whether Excel disagrees.
  - `n01`-`n03`, `c01`, `t01` and `f17` **must open cleanly**.
  - **Any repair prompt or failure on `f01`-`f19` means the formula checks (F2: `validateFormula`, the function arity table) must be tightened.** Record which file(s) and what Excel said; keep the JSON. Do not flip `xlsxEdit` until Claude has tightened and re-verified.
- [ ] **V3 [must] Every test output.** `npm test` first (regenerates `tests\.out`), then `pwsh scripts/verify-office-open.ps1 -Kind Excel -Path tests\.out -JsonPath r2-out.json`. All subfolders are verified, including `xlsxCellEdit`, `xlsxFormula`, `xlsxDateStyle`, `xlsxEditWiring` (and, for section 5, `xlsxStructure`, `xlsxSheets`, `xlsxStructureUi`; this one run covers Q1 too). Expected: exit 0, every file opens with no repair and every `.expect.json` cell matches after recalculation. A failure names the file; record it.
- [ ] **V4 [must] Open XML SDK validator.** `dotnet run -c Release --project scripts/validate-openxml -- tests/.out` (needs the .NET SDK; the first run restores NuGet). Expected: every file valid except known SDK false positives on extension elements (`'uri' attribute is not declared` on `extLst`) and the calcChain `s="1"` "style index missing" report (that is a calc-chain flag, not a style index). For anything else, compare with the same file before the change and record it.
- [ ] **V5 [must] Recalculation in a real window.** Open three edited outputs by hand in desktop Excel (for example one from `tests\.out\xlsxFormula`, one from `xlsxDateStyle`, one from `xlsxCellEdit`): no repair prompt, the edits are present, typed dates show as dates, an edited formula shows its computed value (the workbook recalculates on load), untouched cells look unchanged.
- [ ] **V6 [nice] Other consumers** (plan §10.4): the same three files in Excel for the web, and LibreOffice if installed (not installed on the dev machine; skip and note).

### 4b. Extension Development Host (about 60 minutes)

Editing on (0.8), isolated host (0.2), scratch copies (0.5) of `basic.xlsx`, `formulas.xlsx`, `tables.xlsx`, `features.xlsx`, `large.xlsx` in `$tmp\scratch`. Open from the Explorer: the editor opens in View mode; press **Edit**.

- [ ] **H1 [must] Edit mode.** The Edit toggle shows and works; files open in View by default, in Edit when `vscodeMdEditor.office.startInEditMode` is true. Viewer features (selection, find, copy, sheet tabs) still work in Edit mode.
- [ ] **H2 [must] Entering values** (`basic.xlsx`). F2, Enter or double-click opens the in-cell editor; typing a character opens it with that character. A number, text, `TRUE`, a date typed in a General cell (in your locale's form; it shows as a date, not text, and Excel later agrees) and a formula (`=SUM(A1:A3)`) commit with Enter (moves down) and Tab (moves right; Shift reverses); Esc cancels; Delete clears. The tab gets a dirty dot after the first commit. An edited formula cell shows "Not calculated" in italics, other formulas keep their cached values, and the stale-formulas banner appears.
- [ ] **H3 [must] Undo and redo.** Outside an editor: Ctrl+Z / Ctrl+Y undo and redo the last committed edit; undoing back to the save point clears the dirty dot; a paste is one undo step. Inside an open cell editor: Ctrl+Z cancels that edit only and Ctrl+Y does nothing there (the S3 fallback; if the S3 spike in section 2 shows the browser's own undo stays local, record what you see instead). A refused (stale) undo shows a clear message.
- [ ] **H4 [must] Save and reopen** (`basic`, `formulas`, `tables`, `features`; plan §10.5). Edit one cell, Ctrl+S: the dirty dot clears; close and reopen: the edit is there; the same file in Excel opens with no repair prompt and everything else is unchanged (for `features.xlsx`: chart, image, notes and pivot still present).
- [ ] **H5 [must] Save As.** Save As with an edit writes a new file with the edit and leaves the original untouched; Save As with **no** edits writes the original bytes (compare size/hash); cancelling the Save As dialog shows **no** error toast.
- [ ] **H6 [must] Revert.** Edit, then File > Revert File: the grid returns to the disk content and dirty clears. With two Office files open, the command reverts the focused one.
- [ ] **H7 [must] Hot exit.** Edit without saving, close the window and reopen the folder: the edit is restored and the tab is dirty; Ctrl+S saves it. Do it once with `large.xlsx`.
- [ ] **H8 [must] Hot exit with the file changed outside (F3).** Edit without saving, close the window; change the same file in Excel and save; reopen VS Code. The **conflict modal** appears; each choice does what its label says and nothing is lost silently.
- [ ] **H9 [must] Conflict on save.** Edit in VS Code, change and save the file in Excel, then Ctrl+S in VS Code: the conflict modal appears (never a silent overwrite).
- [ ] **H10 [must] File locked by Excel.** With the scratch file open in desktop Excel, edit and save in VS Code. Expected: a clear "open in Excel" style message, the original file intact, no leftover temp file, and no duplicate error toast.
- [ ] **H11 [must] Verification-failure hook** (0.9: a separate window with `VSMD_OFFICE_CORRUPT_SAVE=1`). Edit and save: the save is refused with a verification-failure message, the file on disk is **unchanged** (timestamp and size), the dirty dot stays, and "Save a copy of diagnostics" is offered; the diagnostics file contains no document content. Then close that window and unset the variable.
- [ ] **H12 [must] Autosave does not commit a half-typed cell (F4).** Set `files.autoSave` to `afterDelay` (1,000 ms). Open a cell editor, type `12` and wait several seconds without Enter: the cell is not committed, the grid keeps the old value, nothing is saved. Press Enter: it commits and autosave then saves.
- [ ] **H13 [must] Ctrl+S inside a cell editor (F4).** Type a value and press Ctrl+S without Enter: the value commits first, then the file saves with it.
- [ ] **H14 [must] Host stays responsive on `large.xlsx` (F5).** Edit one cell, then (a) wait for the hot-exit backup (about 30 s idle, or switch window focus) and (b) press Ctrl+S. While each runs, type in another editor tab and scroll the grid: no noticeable freeze (measured longest block: 42-85 ms backup, 83-187 ms save on an idle machine).
- [ ] **H15 [must] Save targets (F8: saves are in place).** (a) A file reached through a **symlink** (`New-Item -ItemType SymbolicLink`; may need Developer Mode): saving keeps the link and updates the target. (b) A file in a **OneDrive**-synced folder: saves, no sync-conflict copy, no error. (c) A **read-only** file: the save fails with a clear message and nothing is lost. (b) is [nice] if OneDrive is not set up.
- [ ] **H16 [must] Stale banner after reopen (F9).** Save a workbook with an edited formula, close and reopen it: the stale-formulas banner shows on open. Open it in Excel and save there; reopen in VS Code: no banner.
- [ ] **H17 [nice] Signed file warning.** Editing a digitally signed workbook warns that saving removes the signature. (Needs a signed file; skip and note if you have none.)
- [ ] **H18 [must] Paste from Excel, and F1 on screen.** (a) Copy a rectangular block in Excel, paste into the grid: values land at the active cell, one undo step, display strings right, quotes/tabs/newlines inside cells survive. (b) Paste a block that contains **one invalid formula** (build it in Notepad, tab-separated, one cell `=SUM(1,`): the **whole paste is refused** with a hint naming the cell, **no** cell shows a changed value (no phantom values), the undo stack is unchanged. (c) More than 10,000 cells, a cell over 32,767 characters, or a paste past the sheet edge is refused with a hint.
- [ ] **H19 [must] Shared-formula dependant seed** (`formulas.xlsx`). Select a dependant of a shared formula and press F2: the editor opens seeded with its formula text (`=...`), not blank. Commit a change: only that cell changes and the group's other cells keep their formulas; save and open in Excel to confirm.
- [ ] **H20 [must] Formula errors and caret.** Type `=SUM(1,`, `=NOSUCHFN(1)`, `=IF()` and `=Nope!A1` (a sheet that does not exist): each is rejected with a plain message, the formula bar reopens with the caret at the "(at character N)" position, the cell is unchanged and nothing becomes dirty. A valid `=SUM(A1:A3)` is accepted. A double leading `=`, the `#`/`@` operators and an external reference are refused.
- [ ] **H21 [must] Flags off = read-only.** After reverting 0.8 (or in a clean build): no Edit toggle, no Save As, Ctrl+S in the viewer does nothing, no dirty dot: exactly Phase 1 behaviour.
- [ ] **H22 [nice] Guards.** Locked cells on `protected-sheet.xlsx`, a table header cell (`tables.xlsx`) and a read-only cell are refused with a hint and change nothing.
- [ ] **H23 [must] Theme and keyboard for an edit (plan §10.6).** In all four themes the in-cell editor, formula bar, stale banner, stale marker and hints are readable. Keyboard only: navigate, F2, type, Enter, Esc, undo, Ctrl+S; a screen reader announces the hints and errors.
- [ ] **H24 [must] Clean-up.** After the session `git status` shows only the local `featureFlags.ts` change (revert it, 0.8) and no stray temp files sit next to the scratch workbooks.

---

## 5. Gate R4 — Excel rows, columns, sheets (about 50 minutes: 10 Office, 40 dev host)

Plan §6 R4, spec §9.6, §11.3. The automated parts (Tier B refusal tests, Tier A and C coverage, 120-step random run, undo/redo byte-identical) are green. WP-41's log entry has no numbered manual list, so the dev-host items below are built from what it delivered. Until R4 is recorded, `xlsxStructure` stays false. The `/code-review` (high) of PR-13 is not a human check.

### 5a. Real Excel on the saved outputs (about 10 minutes)

- [ ] **Q1 [must] Structure outputs.** The V3 run over `tests\.out` already includes `xlsxStructure`, `xlsxSheets` and `xlsxStructureUi`. If V3 was done before the last `npm test`, run `pwsh scripts/verify-office-open.ps1 -Kind Excel -Path tests\.out\xlsxStructure`, then `...\xlsxSheets`, then `...\xlsxStructureUi`. Expected: exit 0, no repair, `.expect.json` cells match after recalculation.
- [ ] **Q2 [must] Open XML SDK validator** on those three folders (V4 covers them): only the known false positives.
- [ ] **Q3 [must] Calc chain after a non-append Add Sheet (ECMA `i` = sheetId assumption).** Add Sheet writes the new sheet with `sheetId` max+1 and **keeps** `xl/calcChain.xml` (no `fullCalcOnLoad`); this assumes calc-chain `i` attributes are sheet ids, not positions. Open in Excel an output where a sheet is added **not at the end** (the `xlsxSheets` "add: named, after a given sheet" output, or make one: in the dev host on `formulas.xlsx` add a sheet after the first tab and save). Expected: no repair prompt, no "removed records" message, formulas on the existing sheets still calculate (Ctrl+Alt+F9 and compare with the original), and the new sheet sits where chosen.
- [ ] **Q4 [nice] Spot-check shifting against Excel.** On `formulas.xlsx` insert 2 rows before `Data` row 3 in the extension (save as a copy) and in Excel: compare formulas on all four sheets (`'My Sheet'!A2+Data!A5`, `SUM(Data!A2:A12)`, the `LocalName` name = `Data!$G$2`, and so on). Differences feed section 6.

### 5b. Extension Development Host (about 40 minutes)

Editing and structure on (0.8), scratch copies in `$tmp\scratch`. The structure menus exist only when `xlsxStructure` is on, the document is editable and Edit mode is on.

- [ ] **K1 [must] Hidden and disabled states.** Flags off, or View mode: no row/column/sheet structure entries, no "+" tab button, F2 on a tab does nothing. Flags on and Edit mode: they appear; toggling View/Edit makes them disappear and reappear.
- [ ] **K2 [must] Insert and delete rows** (`formulas.xlsx`, `basic.xlsx`). Right-click a row header (also Shift+F10, Menu key): Insert above / below, Delete; the count follows the selection (select 3 rows, insert gives 3). A header outside the current selection selects that row first. After an insert the new band is selected; after a delete the selection collapses to the position; scroll stays. Formulas that referenced moved cells now point at the moved cells (check three by eye, including one on another sheet and one named range); a formula whose whole target was deleted shows `#REF!`. Ctrl+Z restores everything (byte-identical after saving), Ctrl+Y redoes.
- [ ] **K3 [must] Insert and delete columns.** The same as K2 for columns (Insert left / right, Delete), including a range that spans the band (grows or shrinks), merged cells, column widths and a frozen pane (`styles.xlsx`: the freeze shifts; deleting every frozen row/column is refused).
- [ ] **K4 [must] Cell context menu.** On a cell, Shift+F10 shows both axes (insert row above/below, insert column left/right, delete row, delete column) and acts on the selection. (There is no keyboard header selection and no Ctrl+Shift+= / Ctrl+- or Excel-style dialog: expected, spec §11.3 asks only for Shift+F10.)
- [ ] **K5 [must] Sheet tabs: add, rename, delete.** The "+" button and the tab menu (right click, Shift+F10, Menu key) add a sheet, which becomes the selected tab. F2 or double-click renames inline with live validation: empty, over 31 characters, any of `[ ] : * ? / \`, a leading or trailing apostrophe, `History`, and a duplicate that differs only by case are rejected with a message and the old name is kept; Esc cancels; Enter applies and formulas/names/validation that used the old name follow. Delete **always** asks for confirmation (even with `confirmStructuralEdits: false`), then selects the neighbour tab; deleting the last visible sheet is refused.
- [ ] **K6 [must] Tier C confirmation** (`features.xlsx`, sheet `PivotData` and others with drawings). Insert a row at row 3 where cells really move on a sheet with a chart/drawing, hyperlink location, pivot source or extension-list CF/DV: a modal warning lists exactly what will not follow, and the default button is Cancel. Cancel/Esc: nothing changes, not dirty. Continue: it applies and Ctrl+Z undoes it. If the document changes while the modal is open, the answer is discarded (stale), not applied twice.
- [ ] **K7 [must] `confirmStructuralEdits: false`.** Set `vscodeMdEditor.office.confirmStructuralEdits` to false: the K6 insert applies with no prompt; Delete Sheet still asks.
- [ ] **K8 [must] Blocked cases show a plain reason and change nothing** (no dirty dot, same file bytes): delete a table's header row (`tables.xlsx`); delete or move through a table column intersection; any structural op on `protected-structure.xlsx` (all sheet ops blocked) and row/column ops on `protected-sheet.xlsx`; delete the chartsheet (`chartsheet.xlsx`); delete a pivot source sheet (`features.xlsx`); a cell with a note or comment at or beyond the insert point; an insert that would push content off the grid.
- [ ] **K9 [must] Keyboard only.** K2-K5 and K8 without a mouse: Shift+F10 on a header/tab/cell, arrows to choose, Enter to run, Esc to close, focus returns to the grid/tab; F2 renames a tab.
- [ ] **K10 [must] Screen reader.** Menus announce as menus with their items; the rename box announces validation errors; the result of an operation (rows inserted, sheet deleted) is announced. Record which reader.
- [ ] **K11 [must] Theme sweep.** In the four themes the header menus, tab menu, "+" button, rename box (including its error state) and the confirmation modal are readable and visibly focused.
- [ ] **K12 [must] Hot exit.** Insert rows and add a sheet without saving; close the window and reopen: both edits restored and the tab dirty; Ctrl+S saves; the file opens in Excel.
- [ ] **K13 [must] Save, reopen, Excel.** After structural edits on `formulas.xlsx` and `tables.xlsx`: save, reopen in VS Code (values right) and in desktop Excel (no repair prompt; formulas, table, merges, names and conditional formats where you expect them).
- [ ] **K14 [nice] Undo/redo of a sheet operation: what to observe.** After Ctrl+Z / Ctrl+Y of Add, Rename or Delete Sheet the webview rebuilds its workbook model and sheet ids are re-derived **by position**, so the view may land on a **different sheet** than the one you were on. Note which sheet is shown after each undo/redo and whether selection and scroll look sensible. It is a failure only if data or the tab list is wrong; if it is confusing, tell Claude (a fix would pin the selection to the sheet's name or position).
- [ ] **K15 [nice] Large file.** On `large.xlsx` insert a row at row 1, then undo: the UI stays responsive (about 0.8 s insert, 0.6 s undo measured standalone).

---

## 6. Excel goldens still to capture (WP-37)

WP-37 (`scripts/office-fixtures/make-goldens.ps1`, `tests/fixtures/office/goldens/cases.json`, at least 20 cases over `formulas`, `tables`, `features`, `styles`) is a scripted COM run: it performs each operation in real Excel and dumps formulas, merges, table refs, names, CF/DV and autofilter refs. **An agent can do it once you are at the machine**: about 10 minutes of your time, with no other Excel work during the run. Until then the cases below are checked only against hand-written expectations (tagged `[WP-37]` in the tests); Gate R4 can pass on the K and Q items, with the goldens as the outstanding comparison (and required for WP-38's full acceptance).

- [ ] **G1 [must for v1] Capture the goldens.** Tell Claude "run WP-37" while you are at the machine; afterwards the golden comparison must be green.

What the goldens must settle (from `tests/office/xlsxRefs.test.mjs`, `xlsxStructure.test.mjs`, `refs.ts`, `structure.ts`):

- **Reference shifting (WP-36).** Insert at the top/left edge of a range moves it whole instead of growing it. A cell or range start pushed off the grid (row 1,048,576 / column XFD) becomes `#REF!`; a range whose end is pushed off is clamped (`A1:A1048576` stays). A range reaching the last row shrinks on delete (`A1:A1048574`; Excel may keep it whole). A deleted reference is written as a bare `#REF!` where Excel writes `Sheet1!#REF!` (compare modulo the qualifier). The `formulas.xlsx` hand-verified shifts (cross-sheet, quoted names, `_xlfn` functions, defined names).
- **Sheet structure (WP-38).** Frozen-pane split shifting and `sheetView` topLeftCell/selection after a delete; `cols` split, shrink, remove and rejoin, with new columns unstyled; a merge reduced to one cell is removed; internal hyperlink `location` strings are not rewritten; row/column page breaks (`brk/@id`, counts); an insert just above a table totals row grows the data area.
- **Case count:** 10 flagged formula cases in `xlsxRefs.test.mjs`, the `formulas.xlsx` hand-verified group, and 6 tagged structure tests (merges to one cell, cols, sheetView/frozen panes, hyperlinks, page breaks, totals row).

---

## 7. When a gate passes — what to tell Claude

- **"R1 passed"** (or the failed item ids): Claude records Gate R1 in `log.md` and `todo.md` and unblocks Phase 2 merges. If you chose a viewers-only release point (U2), it prepares that release.
- **"R2 passed"**: Claude flips `xlsxEdit` to `true` in the **last PR-8 commit** (`src/office/featureFlags.ts`), records Gate R2, and reverts your local test edit from 0.8. If any of `f01`-`f19` failed (V2), say which: Claude tightens `validateFormula` and re-verifies before flipping.
- **"R4 passed"**: Claude flips `xlsxStructure` to `true` in the **last PR-14 commit**, records Gate R4 and runs the `/code-review` (high) on PR-13. If WP-37 (G1) is still outstanding, say whether R4 may pass without it.
- **"S3 passed"** (or the failing lines): the result goes into spec §16. Word editing (group D, WP-25 onward) starts after S3 **and** the LibreOffice/Google/German-Word fixtures (U1). Gate R3 and Word editing are not covered by this list.
- Failures: give the item id, one line on what you saw and a screenshot. Claude fixes them on the owning branch and re-lists only the affected items.

---

## Appendix: Gate R1 coverage map

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

Not coverable here: the `<!DOCTYPE` refusal (automated tests only). The `sheet-unavailable` notice is covered by X12 with `fx/damaged-sheet.xlsx`.
