# PDF gates P1, P3 and P4 — human checklist

Date: 2026-11-21 · PDF plan §6 (PWP-12, Gate P1), §10, §13 · PDF spec §7, §9, §10, §12, §13, §14

One list for every human check still open on the PDF viewer and editor: **Gate P1** (viewer, built and registered), plus the reader checks the spike still owes you (section 2) and the outline of **Gate P3** (annotations) and **Gate P4** (forms), which are not built yet and are only sketched in section 4. Everything a script can check (`check-types`, `compile`, `npm test`, packaging, the isolated dev-host runs recorded in `log.md` for PWP-08 and PWP-11) is already done. Work top to bottom; each fixture is opened once and checked for everything at the same time.

- **[must]** = the gate cannot pass without it. **[nice]** = worth doing, may be skipped and noted.
- Fixtures are in `tests/fixtures/pdf/` (abbreviated `fx/`); one line per file in `tests/fixtures/pdf/README.md`. Record failures with the item id (for example `A3`, `K7`) and a screenshot, and paste the results into `log.md` ("Gate P1 passed" or the list of open items).
- Nothing from the next phase merges, and no feature flag flips, until its gate is recorded as passed.
- Editing is not built. `PDF_FLAGS` in `src/pdf/core/featureFlags.ts` are both `false`: there is no Edit button, nothing can be dirty, nothing is ever written. Do not flip them for Gate P1.

| Section | Time |
|---|---|
| 0 Before you start | 10 min |
| 1 Items needed from you | 5 min |
| 2 Reader checks owed from the spike (S3, S5, S7) | 30 min (needed by Gate P3, not P1) |
| 3 Gate P1 — viewer (97 items: 79 [must], 18 [nice]) | 115 min (95 [must] + 20 [nice]) |
| 4 Gates P3 and P4 | not buildable yet; sketch only |
| **Total for Gate P1 (sections 0, 1, 3)** | **about 2 h 10 min**; the [must] items alone about 1 h 50 min |

Sections can be done in separate sittings. Section 3 is organised so that you open each fixture once; groups A to C cover the fixtures, D to P are focused passes on one or two files.

---

## 0. Before you start (about 10 minutes)

- [ ] **0.1 [must] Build.** From the repo root (the checkout being gated): `npm ci`, then `npm run compile`. It must finish without errors. For a closer match to the shipped build, `node esbuild.js --production` instead.
- [ ] **0.2 [must] Launch an isolated Extension Development Host.** Other PDF or markdown extensions in your normal profile can claim `*.pdf`, so use a throwaway profile. In PowerShell, from the repo root:

  ```powershell
  $tmp = Join-Path $env:TEMP ("vsmd-p1-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force "$tmp\user\User", "$tmp\ext", "$tmp\scratch" | Out-Null
  @'
  { "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off", "update.mode": "none",
    "extensions.autoCheckUpdates": false, "extensions.autoUpdate": false, "workbench.tips.enabled": false,
    "window.restoreWindows": "none", "chat.disableAIFeatures": true }
  '@ | Set-Content "$tmp\user\User\settings.json"
  code --extensionDevelopmentPath="$PWD" --user-data-dir="$tmp\user" --extensions-dir="$tmp\ext" --new-window --disable-extensions "$PWD\tests\fixtures\pdf"
  ```

  Expected: a new VS Code window titled with the fixtures folder, the Explorer listing the fixtures, no other extensions. (`--disable-extensions` does not stop the extension under development.) There is deliberately **no** `workbench.editorAssociations` entry: the check that `.pdf` opens in the PDF Viewer by default (G1) depends on it. Keep `$tmp` for the whole session (G2 to G4 reuse the profile); delete it when finished.
- [ ] **0.3 [must] Extension activates cleanly.** In the dev host run **Developer: Show Running Extensions**: "VS Code MD Editor" is listed as activated with no errors. **Developer: Toggle Developer Tools**: the console shows no red errors from the extension host on first open of `outline.pdf`.
- [ ] **0.4 [must] How to read a webview console and network.** With a viewer tab focused: **Developer: Open Webview Developer Tools**. Used in C1 to C3. Keep the Console and Network panels open (tick "Preserve log"), and clear them between fixtures. Leave one window open while sweeping.
- [ ] **0.5 [must] Scratch copies.** Copy `basic.pdf` and `outline.pdf` to `$tmp\scratch`. Items that change the file on disk from outside (D2, D3) use these copies, never the committed fixtures.
- [ ] **0.6 [must] Know the baseline.** Before opening anything: `git status` in the repo is clean (the isolated profile's folder is outside the repo). It is checked again in D7.
- [ ] **0.7 [must] Automated baseline.** `npm test`. Expect 819 passing, 0 failures (the Office suite is part of it). Two Office tests are load-sensitive (`saveBlocking.test.mjs`, the `large.xlsx` budget); re-run only that file before treating one as a real failure. The PDF suite warns about the eight PENDING fixtures (section 1): that is expected.
- [ ] **0.8 [nice] A second reader for comparison.** Open the same fixtures in desktop Chrome or Edge (drag the file into a window). A1 to A8 compare against it.

---

## 1. Items needed from you (not checks)

- [ ] **U1 [must for P1 completeness] User-supplied fixtures.** Drop into `tests/fixtures/pdf/` under exactly these names: `linearized.pdf` (a fast-web-view file), `xfa.pdf` (a real XFA form), `scanner.pdf` (from a scanner: image plus OCR text layer, or image only), `latex.pdf` (LaTeX-produced, Type 1 / OpenType fonts, hyperref links). Used in section 3, group O. Their absence only skips O1 to O4. The other four PENDING files are for later gates: `acrobat-annotated.pdf`, `acrobat-signed.pdf`, `certified.pdf` (before Gate P3) and `acrobat-forms.pdf` (before Gate P4); see section 4.
- [ ] **U2 [must] Release point.** Decide when users get something: the plan recommends a viewer-first release straight after Gate P1 (minor version bump, the usual bump PR then `develop` to `master`), then optionally after P3, then at P-final. Tell Claude. Note the Office viewers are not released yet either; say whether the PDF viewer ships in the same release.
- [ ] **U3 [must] Confirm the memory budget decision.** The spike (S4) measured a peak of about 8 times the file size in the webview while saving a 100 MB file. The plan keeps the 100 MB edit limit and restates the budget (spec §9.3); the alternative is to lower the limit to about 25 MB. Not a Gate P1 blocker (nothing saves yet); needed before Gate P2. Tell Claude "keep 100 MB" or "lower it".
- [ ] **U4 [must] Push and open the PR stack.** Nothing is pushed. When ready, tell Claude "push and open the PRs": it pushes the PDF branches and opens the PRs into `develop` in plan order, self-reviews each, and (only if you say so) merges with `gh pr merge --admin`. The PDF stack sits on the Office viewers (it shares `officeEditorProviderBase.ts`), so the Office PRs merge first; expect a rebase conflict in that file against the Office editing branches.

---

## 2. Reader checks owed from the spike (about 30 minutes, needed by Gate P3)

Not part of Gate P1: the viewer writes nothing. They show how Acrobat, Edge, Chrome and Firefox react to what pdf.js `saveDocument()` writes, which Gate P3 and P4 depend on, and the answer decides whether the writer is acceptable (S3) and how appearances look (S5, S7 Acrobat wording).

- [ ] **SP1 [must for P3] Run the spike checklist.** Follow `D:\Development\advancer\VSMarkdownEditor-pdfspike\spike\pdf\out\for-user\CHECKLIST.md` (twelve files `01` to `12`, plus `baseline/`): Acrobat Reader opens clean and does not ask to save on close; Edge, Chrome and Firefox show the marks; highlight colours are see-through, ink widths and colours are right; comment text and author `Spike User` show on hover; file 06 lost only its first highlight; forms 09 and 10 show their values; for files 11 and 12 write down Acrobat's exact signature wording (a throwaway self-signed certificate: "identity unknown" is expected and is not a finding). Fill the table at the bottom of that file, or tell Claude the failing row numbers.
- [ ] **SP2 [must for P3] Pass on the result.** Paste the table (or the verdict) into `log.md` under the spike report's "Not verified" list and tell Claude "spike readers passed" or the failing rows. A failing row can force the S3 fallback in the plan (own object writer), which changes the Phase 2 plan.

---

## 3. Gate P1 — viewer (about 115 minutes: 95 [must], 20 [nice]; the plan guessed 75 before the open items were folded in)

Phase 1 acceptance (spec §14, plan PWP-12). Section 0 setup (0.1 to 0.6) comes first. Open each file by clicking it in the Explorer: it must open in the "PDF Viewer" with no picker.

### 3A. Fixtures against Chrome and the rest of the sweep (about 20 minutes)

For the files below, open the same file in Chrome or Edge (0.8) and compare page by page: pages look the same (colours, images, fonts, layout), page count and rotation agree. pdf.js and Chrome's PDFium differ slightly in anti-aliasing; only a visible difference (a missing image, wrong font, misplaced text, wrong rotation) is a finding.

- [ ] **A1 [must] `fx/outline.pdf`.** Three pages, nested bookmarks, page-1 links. Renders like Chrome. (Outline and links themselves are checked in S2 and T6.)
- [ ] **A2 [must] `fx/annotated.pdf`.** Existing Highlight, Underline, Text note, Ink, FreeText and Link annotations draw like Chrome (highlight translucent over text, ink line, FreeText box, note icon). Popups do not clutter the page. Nothing is changeable.
- [ ] **A3 [must] `fx/rotated.pdf`.** Four pages with `/Rotate` 0, 90, 180 and 270, mixed page sizes, two CropBoxes: each page is oriented and cropped like Chrome, and page sizes stay distinct (no page squashed to a neighbour's size). The page box, thumbnails and Fit page all behave on the rotated pages.
- [ ] **A4 [must] `fx/cjk.pdf`.** Non-embedded Japanese and Chinese fonts render real glyphs (not empty boxes or nothing). If glyphs are missing in the viewer but present in Chrome, note whether the webview console reports a font or CMap request (it must not).
- [ ] **A5 [must] `fx/jpx-jbig2.pdf`.** The JPEG 2000 and the JBIG2 images both show (the wasm decoders run under the CSP). Compare with Chrome.
- [ ] **A6 [must] `fx/word.pdf`.** Word-made tagged PDF: text, heading styles, table, list, hyperlink, embedded subset fonts. Layout and fonts match Chrome.
- [ ] **A7 [must] `fx/chrome.pdf`.** Edge-made, six pages: embedded fonts, link, table. Matches Chrome.
- [ ] **A8 [must] `fx/forms.pdf` (read-only).** Fields are visible (text, multiline, comb, checkbox, radio, dropdown, list box) but cannot be typed into or toggled. The page does not change when you click them. No dirty dot. Compare appearance with Chrome (Chrome will let you type; the viewer must not).
- [ ] **A9 [must] Encrypted files.** `fx/encrypted-user.pdf` asks for a password (wrong, right and cancel are in E1 to E3); `fx/encrypted-owner.pdf` (empty user password, restricted permissions) opens with no prompt. The notice bar says "This PDF is encrypted. It can be viewed but not changed here." in both. Copy and find still work on the owner-restricted file (permission flags are not enforced; spec §7.3).
- [ ] **A10 [must] `fx/scanned.pdf`.** Three image-only pages show. A notice says the PDF may be scanned. The find bar stays usable; searching for anything gives "No matches" and then the note that no text was found anywhere (it may be scanned), not an endless "Searching". Selecting text selects nothing and does not error.
- [ ] **A11 [must] The rest open to a correct view.** `basic.pdf`, `xref-stream.pdf`, `multi-revision.pdf`, `hybrid-xref.pdf` (page 2 exists only in an object stream: both pages show), `base14.pdf` (Symbol and ZapfDingbats show symbols, not letters), `tagged.pdf`, `attachments.pdf`, `signed.pdf` (notice "This PDF has 1 digital signature. Signatures are not verified here."), `broken-xref.pdf` (opens through pdf.js recovery; both pages show; no error view), `forms-js.pdf`, `js-openaction.pdf` (checked for scripts in C4). No fixture shows a spinner that never ends, a blank white page, or a console exception.
- [ ] **A12 [must] The three error fixtures show the shared error view.** `fx/empty.pdf` ("This file is empty."), `fx/not-a-pdf.pdf` ("This file isn't a PDF."), `fx/truncated.pdf` ("This file is damaged and can't be displayed." with a technical reason under Details). Each has an **Open externally** button and none shows a blank page or throws. **[nice]** Pressing Open externally hands the file to your system's default PDF reader.
- [ ] **A13 [must] No fixture ever shows a dirty dot, an Edit button, or a save prompt on close.** Keep this in mind as you go; D7 checks the files on disk.

### 3B. Pages, zoom and navigation (about 8 minutes)

On `fx/large.pdf` (2,000 pages) unless stated, and `fx/rotated.pdf` for rotation.

- [ ] **V1 [must] Opens fast, scrolls smoothly.** `large.pdf` shows page 1 within about a second of the tab appearing; wheel scrolling, scrollbar dragging and PageDown on 2,000 pages show no stutter and no long blank areas (placeholder pages fill in promptly). Budget: no frame over 100 ms, placeholders under 300 ms (spec §9.3; spike S4 measured 75 ms max). If it looks doubtful, record a Performance trace in the webview DevTools while dragging the scrollbar.
- [ ] **V2 [must] Page box.** The toolbar shows "1 of 2000"; type `1500` and Enter jumps there; a page label is accepted where the file has labels; an out-of-range value reverts (no error). Esc leaves the box and returns focus to the pages.
- [ ] **V3 [must] Zoom.** The Zoom select offers Automatic, Actual size, Fit page, Fit width and 25-500 %. The +/- buttons step; Ctrl+wheel zooms; Ctrl+= / Ctrl+- / Ctrl+0 zoom; resizing the window while on Fit width re-fits. Zoomed to 500 % on `chrome.pdf` pages stay sharp (CSS-scaled beyond the canvas cap is acceptable) and the viewer stays responsive.
- [ ] **V4 [must] Rotate.** The rotate button (and `R` / Shift+`R`) turns all pages clockwise / counter-clockwise on `rotated.pdf`; rotation is for the session only and never marks the document changed. Close and reopen the file: it is back to the file's own rotation.
- [ ] **V5 [must] Keyboard scrolling.** With focus on the pages: arrows, PageUp/PageDown, Space/Shift+Space, Home/End (first/last page) all work, and the page box follows.
- [ ] **V6 [nice] Pinch zoom** on a precision touchpad or touch screen works like Ctrl+wheel.
- [ ] **V7 [must] Default zoom setting.** In settings, set `vscodeMdEditor.pdf.defaultZoom` to each of `page-width`, `page-fit`, `actual`, `auto`; reopen `basic.pdf` each time: the initial zoom matches the description (auto = page width but never beyond 100 %). A zoom you change while viewing is kept for that tab only.

### 3C. Text, find, copy and links (about 10 minutes)

- [ ] **T1 [must] Selection and text-layer alignment.** On each of `word.pdf`, `chrome.pdf`, `tagged.pdf` and `basic.pdf`: drag-select a few lines; the selection highlight sits exactly on the rendered text (not a line above or below, not offset sideways), at 100 % and at 200 %. A pdf.js text layer misplacement is the typical symptom of an engine-too-old situation (see M1). Also check `cjk.pdf` (selection boxes over the Japanese text).
- [ ] **T2 [must] Copy.** Select a paragraph in `word.pdf`, press **Ctrl+C**, paste into a scratch editor: plain text, in reading order, no stray characters. Ctrl+A selects the rendered pages' text only (documented limitation).
- [ ] **T3 [must] Find.** On `word.pdf` or `chrome.pdf`: **Ctrl+F** opens the viewer's own find bar (not VS Code's find widget); typing a word that appears highlights matches and shows "1 of N"; Enter / Shift+Enter and **F3** step through; match case, whole words and highlight all toggle; wrap-around is announced; **Esc** closes it and puts focus back on the pages. On `large.pdf` the count reads "more than N" while pages are still being scanned and settles when done.
- [ ] **T4 [must] Find in `cjk.pdf`.** Searching for a Japanese word that is on the page finds it.
- [ ] **T5 [must] External links.** `outline.pdf` page 1 has an `https:` link. Click it: VS Code shows its trusted-domain prompt, then the browser opens that URL, once (one prompt, one browser tab: the webview stops the click before VS Code's own link handler sees it). The webview itself does not navigate. **[nice]** An `https:` link on `word.pdf` and `chrome.pdf` behaves the same.
- [ ] **T6 [must] Blocked and internal links.** On `outline.pdf` page 1: the `javascript:` link and the Launch action do nothing but show the "link was not opened" hint; no alert, nothing launches. The named-destination and explicit-destination links scroll to their pages.
- [ ] **T7 [must] mailto.** A `mailto:` link, if any fixture has one (`latex.pdf` or `word.pdf` may), opens your mail client through the host. If none exists, note "no fixture".

### 3D. Sidebar (about 8 minutes)

- [ ] **S1 [must] Toggle.** The sidebar button and **F4** show and hide the sidebar; pages re-fit if Fit width is on; focus lands sensibly (first tab, then back to the pages on hide).
- [ ] **S2 [must] Outline.** On `outline.pdf` the **Outline** tab shows the nested bookmarks as a tree; arrow keys move, Right/Left expand and collapse, Enter or click jumps to the page; the named and explicit destinations and the `GoTo` action land on the right pages. The tab is absent on a PDF without bookmarks (`basic.pdf`).
- [ ] **S3 [must] Thumbnails with a big file.** Open `large.pdf` and the Thumbnails tab: thumbnails appear for the visible range only (they render a few at a time), scrolling the sidebar fills new ones, the current page is highlighted, clicking or Enter goes to that page. Memory in the webview process does not keep growing while you scroll the strip from page 1 to page 2000 (canvases outside the window are released; check Process Explorer / the DevTools Memory tab if in doubt). `IntersectionObserver` is not exercised by the automated tests, so this needs the real window.
- [ ] **S4 [must] Thumbnails on odd pages.** On `rotated.pdf` thumbnails show each page's own orientation and size.
- [ ] **S5 [must] Attachments.** `fx/attachments.pdf` has three embedded files, one with an awkward name (path-like or reserved characters). The **Attachments** tab lists them. **Save as...** opens a host save dialog whose suggested name is a safe base name (no folders, no `..`, no reserved characters); saving writes the file where you chose; saving never overwrites or touches `attachments.pdf` itself; nothing is opened or run; Cancel does nothing. The notice bar says "This PDF has 3 attached files. They are never opened here; you can save them from the sidebar." Check the saved bytes by opening them in a text editor (the fixtures contain plain text).
- [ ] **S6 [must] Document properties.** The Properties item opens a small dialog: title, author, producer, page size and so on for `word.pdf`; Esc closes it and focus returns; Tab stays inside the dialog. (If the button is disabled until the document loads, that is fine.)
- [ ] **S7 [nice] Sidebar tab state** is kept when you switch to another tab and back (see also D1).

### 3E. Passwords, notices and errors (about 6 minutes)

- [ ] **E1 [must] Password prompt, wrong.** `fx/encrypted-user.pdf` shows a masked password box, not a blank page. Type a wrong password and Enter: "Incorrect password" appears, the box stays for another try.
- [ ] **E2 [must] Password prompt, right.** Type `test` and Enter: the document opens. Find and copy work. Closing and reopening the tab asks again (the password is kept only in the webview's memory, never stored).
- [ ] **E3 [must] Password prompt, cancel.** Press Esc or Cancel: the error view appears with **Open externally** and a Retry; nothing is stuck, and Retry brings the prompt back.
- [ ] **E4 [must] XFA.** With `xfa.pdf` (U1): the notice "This form was made with Adobe LiveCycle (XFA) and can't be shown or filled here." appears and the page shows the fallback content the file contains (often "please wait..."), not a crash. If the file is not available, mark "not available" (unit tests cover detection).
- [ ] **E5 [must] JavaScript notice.** `js-openaction.pdf` and `forms-js.pdf` each show "This PDF contains scripts. Scripts in this PDF are not run." `signed.pdf` does **not** show it (the spike found `hasJSActions()` lies for signed files).
- [ ] **E6 [nice] Many-pages file.** There is no committed file over 20,000 pages. Note "no fixture" (the host rule is unit-tested).
- [ ] **E7 [must] A page that fails to render** (hard to provoke; only if you see it): that page shows "This page couldn't be displayed" and the rest works. Otherwise "not seen".

### 3F. Security, privacy and scripts (about 6 minutes)

- [ ] **C1 [must] No CSP violation on any fixture.** With the webview Console open (0.4), open each of the 26 fixtures in turn (a fast pass: you already opened them in A). The console shows no "Refused to ..." messages and no red errors. Record any fixture that does, with the message.
- [ ] **C2 [must] No network request on any fixture.** The Network panel (preserve log) shows no request to any origin other than the webview's own resource origin (`vscode-resource` / `file+.vscode-resource.vscode-cdn.net`) for every fixture, including `cjk.pdf` (CMaps are local), `base14.pdf` (standard fonts are local) and `jpx-jbig2.pdf` (wasm is local). In particular no request to a CDN, to the document's links or to a `file:` URL.
- [ ] **C3 [must] Output channel shows nothing alarming.** **View > Output**, channel **VS Code MD Editor**: a PDF that triggers `csp-violation`, `worker-fallback` or `page-render-failed` writes a `pdfLog` line there (at most 50 per document, never a toast). After the sweep the channel contains no `csp-violation` and no `worker-fallback` lines. If the channel does not exist yet, that is the expected result for a clean sweep: it is created only on the first report. If you want to see it work, run G5.
- [ ] **C4 [must] `js-openaction.pdf` and `forms-js.pdf` run nothing.** Opening `js-openaction.pdf` shows no alert dialog, no message mentioning `JS-OPENACTION-RAN` or `JS-DOC-LEVEL-RAN`, and nothing in the console; `forms-js.pdf` calculates nothing (field values do not change). Scroll through both files and click around.
- [ ] **C5 [must] Hostile links are dropped.** In `outline.pdf` the `javascript:` link and the Launch action do nothing (T6). A link to a `file:` URL, if you can construct one, is dropped too (unit-tested; optional here).

### 3G. Performance and limits (about 3 minutes; V1 is the main one)

- [ ] **L1 [must] First page budget.** Open `large.pdf` (about 1 MB): first page in about a second. Note the time.
- [ ] **L2 [nice] A 100 MB file.** If you have a real 100 MB PDF, open it: first page within about 3 seconds (spike measured 1.4 to 1.8 s), the large-file notice appears above 150 MB, VS Code stays responsive while it loads, and the webview process uses about the file size plus 200 MB (spec §9.3). A file over 500 MB must show the "too large" error view without reading it. Note "no file" if you have none (the 100 MB test file `huge.pdf` is generated only by the unit tests).
- [ ] **L3 [nice] Memory after closing.** Open `large.pdf`, scroll, close the tab: the webview process memory falls back (no leak across open/close of five tabs).

### 3H. Themes and high contrast (about 6 minutes)

Open `outline.pdf` (sidebar open), `annotated.pdf` and `forms.pdf`; switch themes with **Preferences: Color Theme** while the tabs are open.

- [ ] **H1 [must] Dark theme and Light theme.** Toolbar, sidebar, find bar, notices bar, password box and the properties dialog follow the theme with readable text and visible focus; pages stay as authored (white paper, not inverted) on a themed backdrop. Switching theme live updates an already-open tab with no reload. Tooltips and the page box are readable.
- [ ] **H2 [must] High Contrast (dark) and High Contrast Light.** Each page has a visible outline (`contrastBorder`); the focus ring on toolbar buttons, tabs, tree rows and thumbnails is visible; selection and find matches use the theme's highlight colours and are visible over the white page; no control disappears (borderless buttons get a border); `forced-colors` rendering has no invisible icons.
- [ ] **H3 [must] Thumbnails and sidebar theming.** In every theme the thumbnail strip, its selected/focused state and the outline tree are legible; the selected thumbnail is not identified by colour alone.
- [ ] **H4 [nice] Reduced motion.** With Windows animation effects off (or `prefers-reduced-motion`), jumping to a page or a bookmark does not scroll smoothly.

### 3I. Keyboard and VS Code shortcuts (about 8 minutes)

Do this with the mouse out of the way, starting from a fresh tab of `outline.pdf`.

- [ ] **K1 [must] Tab order.** From the tab title, Tab walks: toolbar (a single tab stop, arrows move within it; Home/End jump), sidebar tabs, the sidebar content, the pages, then the find bar when open. Shift+Tab goes back. There is no keyboard trap, including the password box and the properties dialog (focus stays inside the dialog until Esc).
- [ ] **K2 [must] Focus rings.** Every focusable control shows a visible focus ring in Dark and in High Contrast.
- [ ] **K3 [must] Toolbar.** `role="toolbar"`: Left/Right/Home/End rove between buttons; Enter/Space activate; the sidebar and rotate buttons report their pressed state.
- [ ] **K4 [must] Ctrl+C.** With text selected, Ctrl+C copies it (T2). With nothing selected it does nothing and does not copy the page.
- [ ] **K5 [must] Ctrl+F does not open VS Code's find widget** (the PDF viewer registers `enableFindWidget: false`) and opens the viewer's find bar once, not twice; Ctrl+F while the find input has focus selects its text. **F3** and **Esc** behave as in T3, and Esc with the bar closed does nothing harmful.
- [ ] **K6 [must] Double-firing against VS Code keybindings.** Each of these does the viewer action **once**, and VS Code does not also act on it (no extra zoom of the whole window, no side panel opening, no Go to Line prompt):

  | Key | Viewer action | VS Code binding that must not also fire |
  |---|---|---|
  | Ctrl+F | open find | Find |
  | Ctrl+G | focus the page box | Go to Line |
  | Ctrl+= / Ctrl+- / Ctrl+0 | zoom in / out / reset | window zoom (Zoom In/Out/Reset) |
  | F4 | toggle the sidebar | none by default (note any extension binding) |
  | R / Shift+R | rotate | none |

  Also check with the page box focused: typing `r`, `g` or `0` there goes into the box, not into a shortcut (single-letter shortcuts are inactive in text inputs).
- [ ] **K7 [must] Esc.** Closes the find bar, closes the properties dialog, cancels the password prompt, and leaves the page box; with nothing open it is ignored.
- [ ] **K8 [nice] Shortcuts while the sidebar has focus.** Ctrl+= / Ctrl+- still zoom, and arrows in the outline tree do not scroll the pages.
- [ ] **K9 [nice] Remapped keys.** If you have custom VS Code keybindings for Ctrl+F or Ctrl+G, note whether the viewer still wins when the webview has focus.

### 3J. Screen reader (about 10 minutes; Narrator or NVDA)

Use Narrator (Win+Ctrl+Enter) or NVDA. Open `fx/tagged.pdf` first, then `outline.pdf`, `fx/word.pdf` and `fx/attachments.pdf`.

- [ ] **R1 [must] Tagged content.** On `tagged.pdf`, browse the document: the heading ("H1"), the two paragraphs and their order are read; a tagged file exposes headings, lists, tables and figure text through the structure layer, an untagged file (`basic.pdf`) is read in content order only. This is a property of the file and is stated in the README.
- [ ] **R2 [must] Page regions.** Each page is announced as a region named "Page N of M", and moving the page with PageDown or the page box announces the new page through the live region without repeating.
- [ ] **R3 [must] Toolbar and live announcements.** Buttons have names (page, zoom, rotate, sidebar); a zoom change and rotation are announced politely; the page box has the label "Page".
- [ ] **R4 [must] Find announcements.** In the find bar the count ("3 of 17" or "more than N") and the wrap-around are announced; no announcement repeats for each keystroke.
- [ ] **R5 [must] Sidebar tree and thumbnails.** The outline is announced as a tree with expanded/collapsed state and level; thumbnails have accessible names ("Page N") and the current one is identifiable without sight; the tab list is announced as tabs.
- [ ] **R6 [must] Attachments and Save dialog.** The attachment rows and their **Save as...** buttons are reachable and named; the properties dialog is announced as a dialog and Esc closes it with focus restored. The notices bar is announced when it appears, not repeatedly.
- [ ] **R7 [nice] Password box.** The password input is labelled and "Incorrect password" is announced.

### 3K. State, lifecycle, git and reloads (about 8 minutes)

- [ ] **D1 [must] State restore across a window reload.** Open `large.pdf`, scroll to about page 1200, set Fit width, rotate once, open the sidebar. Run **Developer: Reload Window**. The tab comes back at about the same page and zoom, rotation and sidebar state, and it did not open as text.
- [ ] **D2 [must] Reload on external change.** Open the scratch `basic.pdf`. Overwrite it from outside (replace with another fixture of the same name, for example copy `chrome.pdf` over it). Within a couple of seconds the viewer shows the new content; the tab never becomes dirty; scroll position is kept where sensible. Do the same with a growing file (append bytes) and note whether a half-written file shows an error view that recovers on the next change.
- [ ] **D3 [must] Deleted and recreated.** Delete the scratch `outline.pdf` while open: the viewer keeps showing the loaded document (or a clear message), VS Code shows no raw error; recreating the file brings it back.
- [ ] **D4 [must] Moving a tab.** Drag a PDF tab into a second editor group and into a new window ("Move into New Window"): the document renders in both places, state is kept, nothing errors, only one tab per group (`supportsMultipleEditorsPerDocument: false`; opening the same PDF in a second group may focus the existing one or create a second view; note which).
- [ ] **D5 [must] Hidden tab.** Open `large.pdf`, switch to another tab for a minute, switch back: no reload flash, same position (`retainContextWhenHidden`).
- [ ] **D6 [must] Git: the diff side.** In a git repository containing a committed PDF (copy one into a scratch repo, commit, change it, commit), open **Source Control**, click the changed `.pdf`: VS Code shows a diff; each side opens in the viewer (or VS Code's "cannot compare binary" message). The left (`git:` scheme) side must open read-only without error; the file on disk is untouched. Note exactly what you see.
- [ ] **D7 [must] `git status` clean.** After all of the above, `git status` in the repo is clean: no fixture was written, dirtied or recreated, and no `.pdf` backup or `.tmp` file appeared next to a fixture. The only written files are attachments you chose to save (S5) and the scratch copies in `$tmp`.
- [ ] **D8 [must] Never dirty, never saves.** Press Ctrl+S in a viewer tab and close tabs with the "x": no save prompt appears, ever.
- [ ] **D9 [nice] Multi-root and remote.** Open a PDF in a multi-root workspace and, if you have one, a remote (SSH/WSL/dev container) workspace: it opens. A `vscode-vfs` or other non-file scheme file shows the expected explanation if it cannot be read.

### 3L. Registration, startup and settings (about 6 minutes)

- [ ] **G1 [must] Default editor.** In the isolated profile (no `editorAssociations`), clicking any `.pdf` in the Explorer opens it directly in the **PDF Viewer** with no picker; the tab title and the **Reopen Editor With...** list show "PDF Viewer".
- [ ] **G2 [must] The startup race.** The PWP-11 harness once opened a `.pdf` passed on the command line as **plain text** at window startup (opening after startup worked). Verify with an ordinary profile, three ways, and record each: (a) restore: open `outline.pdf` in the viewer, set `"window.restoreWindows": "all"` in `$tmp\user\User\settings.json` if needed, close the window and relaunch with the same command (0.2), without the folder path argument: the restored tab is the PDF Viewer, not text; (b) command line: `code --extensionDevelopmentPath="$PWD" --user-data-dir="$tmp\user" --extensions-dir="$tmp\ext" --new-window --disable-extensions "$PWD\tests\fixtures\pdf\outline.pdf"`: it opens in the PDF Viewer, not as text, not as "cannot display binary"; (c) a window with several restored tabs including a PDF behind another tab: activating it later opens the viewer. If any case opens text, tell Claude exactly which.
- [ ] **G3 [must] Choose Editors command lists PDF.** **Markdown Editor: Choose Editors for Office and PDF Files...** shows a **PDF Viewer** row alongside Word and Excel. Choosing "VS Code's default editor" for PDF writes `"*.pdf": "default"` to your user `workbench.editorAssociations` (and keeps other keys); the next PDF opens with VS Code's built-in handling; choosing the viewer back restores it. Undo any change to the throwaway profile when done.
- [ ] **G4 [must] Other ways back.** Right-click a PDF tab: **Reopen Editor With...** lists "PDF Viewer" and the text editor; **Open With...** in the Explorer offers the same and **Configure default editor for '*.pdf'...** changes the default. Setting `"workbench.editorAssociations": { "*.pdf": "default" }` by hand has the same effect as G3.
- [ ] **G5 [must] The output channel shows `pdfLog` lines.** To see a line, open **View > Output** and choose **VS Code MD Editor**, then open a PDF with a page that fails to render, or provoke a worker fallback. If you cannot provoke one, in the webview DevTools console run `document.dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', { violatedDirective: 'img-src', blockedURI: 'https://example.com/x?y=1' }))`: a `csp-violation` line appears in the channel (query string removed), no toast appears, and a second identical event does not add a second line. Do this only to confirm the plumbing.
- [ ] **G6 [nice] Setting UI.** **Settings** shows `PDF: Default Zoom` (`vscodeMdEditor.pdf.defaultZoom`) with its four descriptions; an invalid hand-edited value behaves as `auto`.
- [ ] **G7 [must] Other editors unaffected.** A `.md` opens in the Markdown editor, `basic.docx` and `basic.xlsx` (from `tests/fixtures/office/`) in their viewers, `.mmd` as before; the Markdown Links sidebar still lists files.

### 3M. Old VS Code (about 5 minutes, nice)

- [ ] **M1 [nice] Engine-too-old view.** The shipped `engines.vscode` is `^1.95.0`, so a real VS Code older than 1.95 refuses the extension and you will never see the in-viewer message from a release build. To check the in-viewer error view, temporarily set `"vscode": "^1.85.0"` in `package.json` **locally** (do not commit), `npm run compile`, download an old VS Code archive (for example 1.94.2 from `https://update.code.visualstudio.com/1.94.2/win32-x64-archive/stable`), launch it with the 0.2 flags, and open `outline.pdf`: expected, the error view "The PDF viewer needs a newer version of VS Code." with Open externally (1.88 to 1.94 pass the loader but fail the CSS `round()` check; 1.85/1.87 fail `Promise.withResolvers`). Revert with `git checkout -- package.json`, recompile, and confirm `git status` is clean. If it is not practical, note "not run": the check is unit-tested and was measured in the spike (S2).
- [ ] **M2 [nice] Marketplace metadata.** `package.json` still says `^1.95.0` and `@types/vscode` `^1.95.0`; README and CHANGELOG say 1.95.

### 3N. Wording review (about 3 minutes)

Read each sentence once as a user would; reply "ok" or give the replacement text. The read-only sentences are the ones in `media/officeCommon.js` (`PDF_READ_ONLY_TEXT`) that appear when editing arrives; the others show today.

- [ ] **N1 [must] Notices.** The seven notices read well and say what they mean: encrypted ("This PDF is encrypted. It can be viewed but not changed here."), signed, XFA, scripts, may be scanned, many pages, attachments.
- [ ] **N2 [must] Error views and the password prompt.** Messages for empty / not a PDF / damaged / too large / password wrong / engine too old (spec §9.4) are clear and not alarming; the Open externally and Retry buttons are labelled well.
- [ ] **N3 [must] PDF read-only sentences (own wording, to be reviewed here).** "Editing is turned off. Press Edit (Ctrl+E) to annotate this PDF." · "Read-only: this file cannot be written to (for example a Git revision or a read-only file system)." · "Read-only: this PDF is too large to edit safely." · "Read-only: this PDF is password protected. Editing protected PDFs is not supported." · "Read-only: this PDF has a structure this editor cannot edit safely. Open it in a PDF reader to change it." · "Read-only: this version of VS Code is too old to edit PDFs. Update VS Code to enable editing." They are not visible in the viewer-only release; this is the review the PWP-06 log entry deferred to this gate. Replacement text goes in `PDF_READ_ONLY_TEXT`.

### 3O. User-supplied fixtures (about 5 minutes, [nice]; needs U1)

- [ ] **O1 [nice] `linearized.pdf`.** Opens and renders; first page appears quickly; no errors (the viewer loads the whole file, there is no range loading).
- [ ] **O2 [nice] `xfa.pdf`.** E4.
- [ ] **O3 [nice] `scanner.pdf`.** With OCR text: find works and selection lands on the scanned words; image-only: the no-text notice (A10). Both cases render sharply.
- [ ] **O4 [nice] `latex.pdf`.** Type 1 / OpenType fonts and ligatures render; hyperref links work (internal jumps and an external `https:` link); copy yields sensible text (ligatures may copy as `fi`); the outline from `\tableofcontents` appears in the sidebar.
- [ ] **O5 [nice] Your own PDFs.** Open three everyday PDFs of yours (a bank statement, a manual, a slide deck): nothing about them surprises you. Note any that render differently from Chrome.

### 3P. Regression (about 2 minutes)

- [ ] **P1 [must] Other editors and the sidebar still work.** Open a `.md` in the Markdown editor, type, preview; open `basic.docx` and `basic.xlsx` in their viewers; run **Show Link Graph**. No console errors.
- [ ] **P2 [must] Packaging.** `npx @vscode/vsce package` (or `npm run package`) produces a VSIX; `docs/**`, `tests/**`, `scripts/**` are excluded, `media/` contains the pdf.js bundle, worker, cmaps, standard fonts and wasm with their licences. Install the VSIX in the isolated profile (`--install-extension`) and open `outline.pdf`: it works from the packaged build, not just from source. About 4.6 MB for the VSIX (it was 2.2 MB before the PDF work).

---

## 4. Gates P3 and P4 (not built yet; sketch only)

These gates cannot be run until the editing work exists (flags `pdfEdit` and `pdfForms`). The items below are the known human checks; the full lists will be added to this file when each gate's packages are merged (plan PWP-22 to PWP-29), with timings. Estimates: Gate P3 about 60 minutes, Gate P4 about 40 minutes.

**Gate P3 — annotations (needs `pdfEdit`; estimated 60 minutes).** For `basic`, `word`, `chrome`, `rotated`, `annotated`, `multi-revision`, `xref-stream`, `acrobat-annotated.pdf` and `acrobat-signed.pdf`: add each highlight colour, ink stroke and comment; save; reopen in the viewer and in **Acrobat Reader, Edge, Chrome and Firefox** with no repair message and no "save changes?" prompt on close; delete an existing annotation; undo/redo, Save As, revert, hot exit, conflict, locked file; a signed file warns once and shows "valid, with later changes" in Acrobat; `certified.pdf` wording recorded; the spike reader checks (section 2) passed first; the verification-failure test hook leaves the disk file untouched. Needs the PENDING fixtures `acrobat-annotated.pdf`, `acrobat-signed.pdf`, `certified.pdf`.

**Gate P4 — forms (needs `pdfForms`; estimated 40 minutes).** For `forms.pdf` and `acrobat-forms.pdf`: fill each field type (text, multiline, comb, checkbox, radio, dropdown, list box); locked and read-only fields stay locked; XFA and scripted forms behave as specified (notice, no scripts); filled values show in Acrobat, Chrome and Firefox without a repair prompt; the multi-line "Notes" field's appearance in Acrobat (the spike saw PDFium draw it oversized); `setAnnotationMode` forms mode is Phase 4 and is not a Gate P1 item. Needs the PENDING fixture `acrobat-forms.pdf`.

---

## 5. When a gate passes — what to tell Claude

- **"P1 passed"** (or the failed item ids): Claude records Gate P1 in `log.md` and `todo.md`, unblocks Phase 2 merges, and (per U2) prepares the viewer-first release: the version-bump PR (`npm version X.Y.Z --no-git-tag-version`, CHANGELOG "Unreleased" becomes the new version), then `develop` to `master`, then the publish (after checking the marketplace version with `npx @vscode/vsce show advancer-limited.vscode-md-editor`).
- **"spike readers passed"** (or failing rows of section 2): Claude records them under the spike report and keeps or changes the Phase 2 writer plan.
- **"keep 100 MB"** or **"lower it"** (U3): Claude sets `core/limits.ts` accordingly and updates spec §9.3.
- **"push and open the PRs"** (U4): see U4.
- Failures: give the item id, one line on what you saw and a screenshot (and the webview console text for C-items). Claude fixes them on the owning branch and re-lists only the affected items. A G2 failure (viewer not picked at startup) is a registration fix and blocks the release.

---

## Appendix: Gate P1 coverage map

| Source | Covered by |
|---|---|
| Plan Gate P1: every fixture opens to the right view or error view (spec §14 list) | A1-A13, O1-O4 |
| Side-by-side with Chrome: `outline`, `annotated`, `rotated`, `cjk`, `jpx-jbig2`, `word`, `chrome` | A1-A7 (plus `forms`, `encrypted-*`, `scanned`: A8-A10) |
| Password prompt (wrong, right, cancel) | E1-E3 |
| Find, copy, links (allowed, blocked), sidebar, zoom, rotate | T1-T7, S1-S7, V1-V7 |
| No CSP violation and no network request, every fixture | C1, C2 |
| `js-openaction.pdf` and `forms-js.pdf` run nothing | C4, E5 |
| `large.pdf` scroll budget | V1, L1 |
| Light, dark and both high-contrast themes | H1-H4 |
| Keyboard-only walkthrough | K1-K9, V5 |
| Narrator or NVDA on `tagged.pdf` | R1-R7 |
| `git status` clean afterwards; no file dirtied or written | A13, D7, D8, 0.6 |
| Result recorded in `log.md`, then the viewer-first release | section 5, U2 |
| PWP-08 open items (CSP, link handling, password, large file) | C1-C5, T5-T7, E1-E3, V1 |
| PWP-09 open items: real thumbnails, theming, Save dialog, screen reader | S3-S5, H3, R5, R6 |
| PWP-10 open items: Ctrl+F not opening VS Code's find, F3/Esc, announcements, `_pendingFindMatches` count | T3, K5, R4 |
| PWP-11 open items: registration, startup race, theming, high contrast, many pages, page landmarks | G1-G4, H1-H2, E6, R2 |
| `pdfLog` and the output channel | C3, G5 |
| "Choose Editors for Office and PDF Files..." lists PDF | G3 |
| Read-only sentence wording review | N3 |
| Double-firing with VS Code keybindings (Ctrl+F, Ctrl+G, Ctrl+=/-/0, F4, R) | K6 |
| Text-layer alignment on tagged, Word and Chrome PDFs | T1, A4, A6, A7 |
| State restore after reload or tab move | D1, D4, D5 |
| Reload on external change; git diff side | D2, D3, D6 |
| 100 MB budgets | L2 |
| Engine-too-old view | M1 |
| Attachment Save dialog with odd names | S5 |
| User-supplied PENDING fixtures | U1, O1-O5 (P3/P4 ones in section 4) |
| Spike reader checks (S3, S5, S7) | section 2 |
| `setAnnotationMode` forms mode | not Phase 1; Phase 4 (section 4) |

Not coverable here: the `>20,000 pages` host rule and the `> 500 MB` refusal need files that are not committed (E6, L2: unit tests cover them); strict-reader and writer checks arrive with Phase 2.
