# Implementation Log

## 2026-02-24

### Phase 0: Project Setup
- Created `CLAUDE.md` with project rules
- Created `todo.md` with full task checklist
- Created `log.md` (this file)

### Phase 1: Wikilink Parser
- Created `src/wikilink/wikilinkParser.ts` with:
  - `WIKILINK_REGEX` for matching `[[target]]` and `[[target|display]]`
  - `parseWikilinks()` — extracts all wikilinks, skips code blocks, computes line/column
  - `isInsideCodeBlock()` — detects fenced and inline code ranges
  - `resolveWikilinkTarget()` — case-insensitive stem lookup, strips .md extension
  - `parseTags()` — extracts YAML frontmatter tags and inline #tags
- Added `getFileStem()` and `escapeRegex()` to `src/utils.ts`
- Type-check: clean

### Phase 2: File Index Service
- Created `src/wikilink/fileIndexService.ts` — singleton service that:
  - Scans all `**/*.md` files on activation
  - Maintains `FileIndex` (relativePath → FileEntry) and `BacklinkIndex` (stem → Set<path>)
  - Registers watchers: onDidSaveTextDocument, onDidCreateFiles, onDidDeleteFiles, onDidRenameFiles, onDidChangeTextDocument (debounced)
  - Exposes queries: getAllFiles, getBacklinksFor, getUnlinkedMentions, resolveWikilink, getAllStems
  - Emits `onDidUpdateIndex` event
- Modified `src/extension.ts`: creates FileIndexService, passes to MarkdownEditorProvider
- Modified `src/markdownEditorProvider.ts`: accepts FileIndexService, added onDidChangeActiveDocument event
- Type-check: clean

### Phase 3: Wikilink Autocomplete
- Extended `src/types.ts` with WikilinkSuggestion, graph types, and new message types
- Added autocomplete module to `media/editor.js`:
  - Detects `[[` trigger via regex on text before cursor
  - Sends `requestWikilinkSuggestions` to extension
  - Renders dropdown overlay with keyboard nav (up/down/enter/tab/escape)
  - Positions overlay using textarea font metrics
  - Inserts `[[stem]]` on confirmation
- Added autocomplete CSS styles to `media/editor.css`
- Added message handlers in `markdownEditorProvider.ts` for `requestWikilinkSuggestions` and `openWikilink`
- Type-check: clean

### Phase 4: Wikilink Preview Rendering
- Added `preprocessWikilinks()` to `media/editor.js` — replaces `[[target]]`/`[[target|display]]` with `<a class="wikilink">` elements (skipping code blocks)
- Modified `renderPreview()` to preprocess wikilinks before markdown-it rendering
- Added click handler on `.wikilink` links to send `openWikilink` message
- Added wikilink CSS styles (dashed underline, hover effect)
- Type-check: clean

### Phase 5: Backlink Panel
- Created `src/wikilink/backlinkTreeProvider.ts`:
  - TreeView with two collapsible sections: Backlinks and Unlinked Mentions
  - BacklinkFileItem shows source file with folder description
  - BacklinkContextItem shows the line containing the link
  - Click to open file, click context to jump to line
  - Refreshes on active editor change and index updates
- Added `viewsContainers` (activity bar "Markdown Links") and `views` to `package.json`
- Registered TreeView in `extension.ts` with active file tracking
- Type-check: clean

### Phase 6: Rename Propagation
- Created `src/wikilink/renamePropagation.ts`:
  - `handleWillRenameFiles()` intercepts .md renames
  - Uses BacklinkIndex for O(1) lookup of affected files
  - Builds single WorkspaceEdit replacing `[[old-stem]]` → `[[new-stem]]` across all references
  - Part of the same undo group as the rename
- Registered `onWillRenameFiles` handler in `extension.ts`
- Type-check: clean

### Phase 7: Graph Visualizer
- Installed `force-graph` npm package
- Updated `scripts/copy-vendor.js` to copy `force-graph.min.js` to media/
- Created `src/graph/graphDataService.ts`:
  - `getGlobalGraph()` — all nodes and edges from index
  - `getLocalGraph()` — BFS from active file with configurable depth
  - `applyFilters()` — orphan toggle, folder/tag filter, search
- Created `src/graph/graphViewProvider.ts`:
  - WebviewViewProvider for sidebar panel
  - Bidirectional messaging with graph.js
  - CSP with `unsafe-eval` for force-graph's d3 internals
  - Controls: mode toggle, depth slider, orphan checkbox, search
- Created `media/graph.js`:
  - Force-directed Canvas rendering via force-graph library
  - Click → open file, double-click → zoom to node, hover → highlight neighbors
  - Responsive sizing via ResizeObserver
  - Filter controls dispatch filterChanged messages
- Created `media/graph.css` — graph panel styles with VS Code theme variables
- Added graph commands and config to `package.json`
- Registered GraphViewProvider and graph commands in `extension.ts`
- Full build: `npm run compile` passes clean

### Code Review & Bug Fixes (2026-02-24)
- **editor.js**: Consolidated two `window.addEventListener('message')` handlers into one switch statement (eliminated duplicate message processing)
- **editor.js**: Replaced per-render `mousedown` listeners on autocomplete items with single event delegation on overlay (fixed event listener leak)
- **editor.js**: Changed markdown-it `html: true` to `html: false` (closed XSS surface)
- **editor.js**: Wrapped scroll sync in `requestAnimationFrame` (eliminated layout thrashing at 60fps)
- **editor.js**: Removed unused `totalWidth` variable in divider drag handler
- **graph.js**: Extracted `getNodeSize()` function to eliminate duplicate `Math.max(2, Math.sqrt(...) * 3)` calculation
- **graph.js**: Added `Array.isArray()` validation on incoming `graphData` messages
- **graph.js**: Reset `highlightedNode`/`highlightedNeighbors` when new graph data arrives (fixed stale highlight glitch)
- **fileIndexService.ts**: Fixed race condition in `onDidRenameFiles` — collected `indexFile()` promises and awaited them before firing index update event
- **fileIndexService.ts**: Added `console.warn` to silent `catch {}` block in `indexFile()`
- **renamePropagation.ts**: Added `console.warn` to silent `catch {}` block
- **diagnosticsProvider.ts**: Removed unused `debounce` import
- **extension.ts**: Removed unused module-level `editorProvider` variable and dead `getFileStem` import
- **graphViewProvider.ts**: Removed unused `disposables` array and empty `dispose()` method (webview disposables handled in `onDidDispose`)
- **editor.css**: Removed unnecessary `!important` from `.grammar-btn`
- Full build: `npm run compile` passes clean

### Git Setup & Repository (2026-02-24)
- Initialized git repo with `master` branch
- Added remote: `https://github.com/Advancer-Limited/vscode-md-editor.git`
- Updated `.gitignore` with node_modules, dist, .vsix, OS files
- Initial commit with 33 files (6165 insertions), pushed to `origin/master`
- Created `develop` branch from master, pushed to origin
- Set branch protection on `master` and `develop`:
  - Required PR reviews (no direct push)
  - No force pushes, no deletions
- Created `feature/mvp-features` branch from `origin/develop`
- Updated `CLAUDE.md` with git branching workflow documentation
- Created `LICENSE` (MIT License, Copyright Advancer Limited)
- Created `README.md` with features, installation, usage, configuration, and contributing guide
- Created `CONTRIBUTING.md` with detailed contributor instructions
- Added `license`, `repository`, `homepage`, `bugs` fields to `package.json`
- Build: `npm run compile` passes clean

### Phase 8: Default WYSIWYG Editor + Inline Grammar Highlights (2026-02-24)

**Custom editor as default:**

- Changed `priority` from `"option"` to `"default"` in `package.json` — .md files now open in the custom editor automatically

**Inline grammar highlights:**

- Added `GrammarMatch` interface and `grammarResults`/`applyGrammarFix` message types to `src/types.ts`
- Added `onGrammarResults` EventEmitter to `src/diagnosticsProvider.ts` — fires alongside diagnostic collection with offset-mapped grammar matches
- Wired grammar results from diagnostics → provider → webview in `src/extension.ts` and `src/markdownEditorProvider.ts`
- Added `applyGrammarFix` handler in `markdownEditorProvider.ts` — applies WorkspaceEdit at the given offset
- Implemented grammar highlight rendering in `media/editor.js`:
  - `applyGrammarHighlights()` — walks preview DOM text nodes with TreeWalker, wraps matches in `<span class="grammar-error">`
  - `showGrammarTooltip()` / `hideGrammarTooltip()` — positioned popup with message and clickable suggestion buttons
  - Event delegation for hover/click on grammar error spans
- Added grammar highlight CSS (wavy underlines, tooltip, suggestion buttons) in `media/editor.css`

**WYSIWYG editable preview (default view):**

- Installed `turndown` npm package, updated `scripts/copy-vendor.js` to vendor it
- Added Turndown script tag in `markdownEditorProvider.ts` HTML template
- Made `#preview-content` div `contenteditable="true" spellcheck="false"`
- Initialized TurndownService with custom rules for wikilinks and grammar error spans
- Contenteditable `input` handler syncs HTML→markdown via Turndown, debounced postMessage to extension
- `isContentEditableUpdate` flag prevents re-render loop on contenteditable input
- Changed default view to `preview-only` (WYSIWYG), renamed toggle buttons: Edit/Split/Raw
- Updated all toolbar buttons to dispatch `document.execCommand()` in preview mode (bold, italic, strikethrough, headings, link, image, code, lists, quote, hr)
- Added keyboard shortcuts (Ctrl+B/I/K) on previewContent for contenteditable mode
- Updated wikilink click handler: Ctrl+Click navigates in edit mode, plain click places cursor
- Updated status bar: shows word count from `previewContent.textContent` in preview mode
- Full build: `npm run compile` passes clean

### Bug Fixes (2026-02-24)

- **Frontmatter rendering**: Added `stripFrontmatter()` in `media/editor.js` to strip YAML frontmatter (`---...---`) before markdown-it rendering. Frontmatter is stored and re-attached when contenteditable syncs back to markdown.
- **Frontmatter in grammar check**: Added frontmatter skip in `stripMarkdownForChecking()` in `src/utils.ts` so YAML metadata isn't sent to LanguageTool.
- **Grammar button feedback**: Made `checkGrammar` command async with `vscode.window.withProgress()` notification. Added user-visible warnings when LanguageTool is disabled, no document is active, or API is unreachable.
- **Grammar error messages**: Improved error messages in `languageToolService.ts` for rate limits and connection failures.
- Full build: `npm run compile` passes clean

### Phase 10: Obsidian-Style Graph Experience (2026-02-24)

**Replaced backlinks tree with unified graph sidebar + full graph panel.**

**Types (`src/types.ts`):**
- Added `RelationshipItem` interface (relativePath, label, direction, depth)
- Added `relationshipData` to `ExtensionToGraphMessage`
- Added `openFullGraph` to `GraphToExtensionMessage`
- Added `ExtensionToFullGraphMessage` and `FullGraphToExtensionMessage` types

**GraphDataService (`src/graph/graphDataService.ts`):**
- Added `getRelationships(filePath, maxDepth)` — BFS from active file tracking direction (incoming/outgoing) and depth level

**Sidebar graph (`graphViewProvider.ts`, `graph.js`, `graph.css`):**
- Added "Expand" button to open full graph in main editor
- Sends `relationshipData` alongside `graphData` on every refresh
- Relationship list renders below mini graph, grouped by depth level
- Each item shows direction arrow (← incoming, → outgoing) and opens file on click
- CSS: flexbox split layout (50% graph / 50% relationship list), sticky depth headers

**Full graph panel (`fullGraphPanel.ts`, `fullGraph.js`, `fullGraph.css`):**
- `FullGraphPanel` — WebviewPanel singleton, creates/reveals on command
- Obsidian-style collapsible controls overlay:
  - Filters: search input, show orphans toggle
  - Display: label visibility mode (auto/always/never), show arrows toggle
  - Forces: repulsion strength slider, link distance slider, center force toggle
- Enhanced interactions: click for tooltip, double-click to open file, drag to pin, right-click to unpin
- Zoom controls: Fit, +, − buttons in bottom-right corner
- Node tooltip shows name, folder, connections, tags with Open button
- Active file highlighted with gold glow effect
- Preserves pinned node positions across data refreshes

**Extension wiring (`extension.ts`):**
- Removed `BacklinkTreeProvider` import and registration
- Added `FullGraphPanel` import
- Registered `vscodeMdEditor.openFullGraph` command
- Active file change notifies both sidebar and full graph panel

**Package.json:**
- Removed `vscodeMdEditor.backlinks` view
- Added `vscodeMdEditor.openFullGraph` command

**Deleted:**
- `src/wikilink/backlinkTreeProvider.ts` (replaced by relationship list in sidebar)

- Full build: `npm run compile` passes clean

### Phase 10 Bug Fixes (2026-02-24)

**Sidebar rewrite to flat file list:**
- User reported "expand button does nothing" — added cache-busting (`?v=${Date.now()}`) to all script/CSS URIs
- User reported "no nodes listed" — discovered force-graph method chain bug: `.d3Force('charge')?.strength()` returns the d3 force object, NOT the graph instance; broke into separate statements
- User requested simplification: completely rewrote sidebar as pure DOM file list (no force-graph canvas)
  - `graphViewProvider.ts` — sends `fileList` message with `SidebarFileNode[]`, no GraphFilters
  - `graph.js` — event-delegated file node rendering with expandable link sub-lists
  - `graph.css` — file list layout styles, active file highlight, link direction icons
  - CSP simplified (no `unsafe-eval` since no force-graph in sidebar)

**Full graph panel fixes:**
- Fixed race condition: registered message handler BEFORE setting webview HTML (was losing `ready` message)
- Added fallback `setTimeout` to send data 1000ms after creation
- Added explicit dimension initialization via `requestAnimationFrame` after graph creation
- Added `graph.width/height` call before setting graphData to ensure canvas has proper size
- Added debug logging throughout for diagnosis

**Wikilink rendering investigation:**
- User reported wikilinks showing as raw `<a class="wikilink">` HTML in preview
- Code review confirmed: `html: true` is set in markdown-it, `preprocessWikilinks` is correct
- Added diagnostic console.log in `renderPreview()` to check if HTML is preserved vs escaped
- Pending user test to check Developer Console output

- Full build: `npm run compile` passes clean

### Debug Logging Cleanup (2026-02-24)

Removed excessive `console.log` debug statements from 5 files while preserving all `console.error` and `console.warn` statements:

**`media/editor.js`** (6 statements removed):

- Removed grammar results reception logging (match count, first match details)
- Removed grammar highlight application logging (match count, text node count, per-match failure, applied count)

**`src/diagnosticsProvider.ts`** (2 statements removed):

- Removed paragraph check logging (char count, offset)
- Removed match count per-paragraph logging

**`src/graph/fullGraphPanel.ts`** (3 statements removed):

- Removed graph data send logging (node/edge counts)
- Removed message delivery logging and retry logging
- Preserved `console.error` for sendGraphData errors

**`src/languageToolService.ts`** (6 statements removed):

- Removed chunk splitting logging (text length, chunk count)
- Removed per-chunk send logging (chunk number, size, offset)
- Removed total matches summary logging
- Removed API response logging (match count, language)
- Removed proxy detection logging
- Removed connection logging (hostname, port)
- Preserved `console.error` for chunk failures

**`src/markdownEditorProvider.ts`** (4 statements removed):

- Removed `sendGrammarResults` logging (match count, known panels, panel found/not found)

- Full build: `npm run compile` passes clean

### Phase 11: Markdown Diff — Rendered Diff Viewer (2026-03-13)

**Approach**: Custom webview panel renders both versions through markdown-it and highlights
changes with diff styling (green for additions, red with strikethrough for deletions).
Uses a line-level LCS diff algorithm with no external dependencies.

**New files:**

- `src/diff/diffService.ts` — Git CLI wrapper for file history and content retrieval:
  - `getRepoRoot(fileUri)` — finds git repo root via `git rev-parse --show-toplevel`
  - `getFileHistory(repoRoot, relativePath, maxCount)` — returns commits touching a file via `git log --follow`
  - `getFileContentAtCommit(repoRoot, relativePath, commitHash)` — retrieves content via `git show <ref>:<path>`
  - `getRelativePath(repoRoot, fileUri)` — normalizes paths (forward slashes, lowercase drive letter)

- `src/diff/diffAlgorithm.ts` — Line-level LCS diff algorithm:
  - `computeLineDiff(oldText, newText)` — returns `DiffHunk[]` (added/removed/unchanged)
  - Normalizes `\r\n` → `\n` before comparing (critical for Windows + git compatibility)
  - Groups consecutive same-type lines into hunks for cleaner rendering

- `src/diff/markdownDiffPanel.ts` — Webview panel for rendered markdown diff:
  - Static `show()` method creates panel with embedded diff data
  - Passes hunks as HTML-escaped JSON in a hidden input element
  - Loads markdown-it + diff.js/diff.css from media/

- `media/diff.js` — Webview script for diff rendering:
  - Parses embedded hunk data and renders each hunk through markdown-it
  - Wraps hunks in styled divs with gutter markers (+/−)

- `media/diff.css` — Diff styling using VS Code theme variables:
  - Added lines: green background (`--vscode-diffEditor-insertedTextBackground`)
  - Removed lines: red background + strikethrough (`--vscode-diffEditor-removedTextBackground`)
  - Legend bar, gutter markers, and markdown content styles

**Modified files:**

- `package.json` — Added 3 diff commands and explorer context menu entries
- `extension.ts` — Registered 3 diff commands with shared `resolveDiffContext` helper:
  - `diffWithPrevious` — smart commit selection (HEAD if uncommitted changes, else HEAD~1)
  - `diffWithCommit` — QuickPick of recent commits with hash, message, author, date
  - `diffWithSaved` — HEAD vs current working content
- `README.md` — Added Version Diff feature docs, Commands table, usage section
- `CHANGELOG.md` — Created with version diff entry

**Impact**: Zero changes to `markdownEditorProvider.ts` or any existing editor/wikilink/graph/grammar code. All diff code is in new isolated files.

- Full build: `npm run compile` passes clean

## 2026-06-16 — Release 0.2.1 to VS Code Marketplace

- Marketplace already had 0.2.0; master/develop contained unpublished fix #24 (cursor jump in WYSIWYG) still tagged 0.2.0.
- Bumped version 0.2.0 → 0.2.1 (patch) on branch `fix/bump-0.2.1` off `develop`.
- Modified: `package.json`, `package-lock.json` (version), `CHANGELOG.md` (0.2.1 entry).
- Flow: PR fix/bump-0.2.1 → develop, then develop → master, then publish from master.
- `npm run check-types` passes.

## 2026-06-16 — Published 0.2.1 + corrected vault docs

- Published `advancer-limited.vscode-md-editor v0.2.1` to VS Code Marketplace from `master`.
- Documented PAT location (`kv-askance-prod`) was wrong — that vault does not exist. Correct vault is `kv-advancer-prod` in the `Advancer` Azure subscription.
- Created new PAT (All accessible orgs + Marketplace: Manage) and stored it as secret `vsce-marketplace-pat` in `kv-advancer-prod`.
- Updated CLAUDE.md Publishing section with correct vault name and fetch command.

## 2026-06-16 — Fix: WYSIWYG table formatting lost on edit

- Bug: editing inside a table in WYSIWYG (contenteditable) mode destroyed the markdown table.
- Root cause: `media/editor.js` runs Turndown (HTML→markdown) on every input, but Turndown's core has NO table support, so `<table>` was flattened to plain concatenated cell text and saved as the source.
- Fix: added self-contained GFM table rules to the TurndownService (tableCell, tableRow, tableSection, table) — adaptation of turndown-plugin-gfm, no new dependency.
  - Preserves header separator row, column alignment (reads both `align` attr and `text-align` style, since markdown-it emits inline styles), inline cell formatting, and escapes literal pipes.
  - Only tables with a heading row are converted (others left to default handling).
- Verified with a markdown→html→markdown round-trip test (basic, aligned, inline, escaped-pipe cases all pass); `npm run compile` passes.

## 2026-06-16 — Code review pass + tests (fix/review-fixes)

Ran a parallel code review (webview + extension host) and fixed the high-confidence, low-risk findings:

- **src/utils.ts**: `getNonce` now uses `crypto.randomBytes` (CSPRNG) instead of `Math.random` — CSP nonces must be unpredictable.
- **media/turndownTableRules.js** (new): extracted the GFM table rules into a shared, unit-testable UMD module. Fixed a real interaction bug: pipes inside `[[wikilinks]]` are no longer escaped to `\|` (the editor preprocesses wikilinks into `<a>` before the table parser, so the pipe must stay literal; escaping it broke the wikilink regex).
- **media/editor.js**: now calls `installTurndownTableRules(turndownService)` from the shared module.
- **src/markdownEditorProvider.ts**: loads `turndownTableRules.js` via a nonce'd `<script>` before editor.js.
- **src/wikilink/fileIndexService.ts**: per-URI debounce timers (a single shared timer dropped pending updates when a second file was edited within 500ms); register watchers BEFORE the initial scan (files changed during scan were missed); stem→path mapping is only deleted on removal if it still points at the removed file (duplicate-stem safety).
- **src/extension.ts**: `.catch()` on the fire-and-forget `initialize()`.
- **src/diff/diffAlgorithm.ts**: trim common prefix/suffix before the O(m*n) LCS, bounding memory/time for small changes in large files.

Tests (new — Node built-in runner, zero new deps; `npm test`):
- `tests/turndownTable.test.js` — render→edit→serialize round-trip for tables (basic, alignment, inline formatting, escaped pipes, wikilink-with-alias pipe preservation, idempotency, regression guard that proves the rules are what fix the bug).
- `tests/diffAlgorithm.test.mjs` — diff correctness + the prefix/suffix-trimming isolation on a 5000-line file.
- `.vscodeignore` excludes `tests/`; `package.json` adds `"test": "node --test ..."`.

Deferred (documented, not fixed — higher risk / edge, to avoid destabilizing pre-release): markdownEditorProvider `isApplyingEdit` boolean race (recently-fixed cursor-sync area); renamePropagation for spaced `[[ link ]]` and duplicate stems; grammar-highlight first-occurrence `indexOf`; LanguageTool proxy CONNECT timeout.

All 16 tests pass; `npm run check-types` and `npm run compile` pass.

## 2026-06-16 — Deferred review follow-ups (fix/review-followups)

- **Cursor-sync race** (markdownEditorProvider.ts): replaced the boolean `isApplyingEdit` guard with a depth counter `applyingEdits` so overlapping edits from fast typing don't clear the guard early; wrapped both applyEdit calls in try/finally so a failed edit can't wedge the guard permanently.
- **Rename edge cases** (wikilinkParser.ts + renamePropagation.ts): added pure, unit-tested `findWikilinkStemRanges` that matches `[[stem]]`/`[[stem|display]]` case-insensitively and tolerant of inner whitespace (`[[ Foo ]]`), selecting only the stem span. Rename now also skips files whose stem currently resolves to a *different* file (duplicate-stem safety). Inlined escapeRegex into wikilinkParser to keep it dependency-free (and testable under Node type stripping); removed the now-unused utils.escapeRegex.
- **Grammar highlight offset** (editor.js): skip text already inside a `.grammar-error` span so repeated phrases advance to the next un-highlighted occurrence instead of re-marking the first.
- **LanguageTool proxy timeout** (languageToolService.ts): added a 15s timeout + handler to the inner tunneled request so a hung upstream after CONNECT can't leave the promise pending forever.
- Tests: added tests/renameMatch.test.mjs (8 cases). Full suite now 24 tests, all passing; check-types clean; build passes.

## 2026-06-17 — Release 0.2.3 (develop → master + publish)

- develop was 2 commits ahead of master (PR #33, the deferred review follow-ups above) but both were still tagged 0.2.2, which is already on the Marketplace.
- Reviewed the develop↔master diff (grammar highlight dedup, LanguageTool timeout, edit depth-counter guard, rename-propagation hardening, new renameMatch tests) — clean. `check-types`, `npm test` (24 pass), and `npm run compile` all green.
- Bumped 0.2.2 → 0.2.3 (patch) on branch `fix/bump-0.2.3` off develop: `package.json`, `package-lock.json`, `CHANGELOG.md` (0.2.3 entry).
- Flow: PR fix/bump-0.2.3 → develop, then develop → master, then publish 0.2.3 from master.

## 2026-06-17 — Published 0.2.3 to VS Code Marketplace

- Published `advancer-limited.vscode-md-editor v0.2.3` from `master` via `npx @vscode/vsce publish` (PAT from `kv-advancer-prod` / secret `vsce-marketplace-pat`).
- PRs #34 (bump → develop) and #35 (develop → master) merged with `--admin` (branch protection requires review; self-review per CLAUDE.md, user-authorized).

## 2026-07-09 — Full review pass: cursor fix, review follow-ups, Askance removal, dep upgrades

### Investigation: WYSIWYG cursor jump (user-reported, persistent)
- Root cause: automatic incremental grammar checks (diagnosticsProvider, 1.5s debounce after each edit) complete asynchronously; the webview `grammarResults` handler called `renderPreview(textarea.value)`, rebuilding the contenteditable innerHTML mid-typing and restoring the caret by approximate plain-text offset. Any non-identity markdown→HTML round-trip (typographer `...`→`…`, smart quotes, `- ` becoming a list) shifted the offset → cursor jump; selection momentarily outside the preview → restore skipped → caret/focus loss.
- Secondary: stale non-echo `update` messages re-rendered older text over fresher keystrokes while a debounced local edit was pending.

### PR #37 — fix/wysiwyg-cursor-stability
- media/editor.js: grammarResults now refreshes highlights in place (clearGrammarHighlights unwraps spans + normalize, applyGrammarHighlights re-wraps — text content unchanged, caret restore exact); stale-update guard (localEditPending + lastSentEditText); IME composition guard (compositionstart/end, sync deferred to compositionend).
- src/markdownEditorProvider.ts: edits applied as minimal ranged edit via new computeMinimalEdit (utils.ts) instead of whole-document replace; rejected applyEdit resyncs webview.
- tests/computeMinimalEdit.test.mjs: 11 new cases. Suite 35/35.

### PR #38 — fix/review-followups-2 (multi-agent code review findings)
- diagnosticsProvider.ts: per-document debounce timer Map (shared timer let doc B cancel doc A's pending check → permanently stale diagnostics).
- languageToolService.ts: check() `silent` option — auto-checks no longer spam warning popups every 1.5s when API unreachable.
- markdownEditorProvider.ts + types.ts + editor.js: applyGrammarFix sends/verifies expectedText (stale offsets could corrupt unrelated text); cursorOffsets deleted on panel dispose.
- extension.ts: startup runCheck rejections caught.
- fullGraph.js: tooltip tags now escaped (was only unescaped innerHTML field); Center-force toggle fixed (window.d3 doesn't exist — capture built-in center force).
- graph.js: scroll position preserved across list re-renders.
- diff.js: markdown-it options aligned with editor (breaks/linkify/typographer; html deliberately off — no sanitizer here).
- scripts/copy-vendor.js: refactored to a list, exits non-zero on missing vendor file.

### PR #39 — chore/remove-askance-and-dep-bumps
- Removed Askance everywhere (user: obsolete): CLAUDE.md section, .mcp.json deleted, @askance/cli devDep dropped (no longer resolvable on npm registry), .gitignore/.vscodeignore entries.
- markdown-it 14.2.0→14.3.0 (media/markdown-it.min.js re-vendored), @types/markdown-it ^14.1.2, @types/node ^20.19.0, typescript ^5.9.0. npm audit: 0 vulnerabilities.
- Deferred deliberately: TS 6/7 (TS 7.0 shipped 2026-07-08, too fresh), @types/node 26.x (should track VS Code Electron's Node), @types/vscode stays ^1.85.0 (matches engines floor).

### Notes
- PRs stacked #37 → #38 → #39; merge in that order. Branch protection requires human merge (admin bypass declined by policy).
- GitHub's 34 Dependabot alerts are against master's old lockfile; develop's lockfile audits clean — releasing develop → master clears them.
- Known issues logged in todo.md for later: diff viewer per-hunk rendering tears multi-line constructs; fullGraphPanel CSP 'unsafe-eval'; types.ts graph sidebar protocol drift.

## 2026-07-09 — Released & published 0.2.4

- User granted `gh pr merge` permission; merged stacked PRs #37 → #38 → #39 → #40 into develop (admin merge per protected-branch workflow, self-reviewed per CLAUDE.md).
- Verified develop green post-merge: `npm ci`, `npm run compile`, `npm test` 35/35, `npm audit` 0 vulnerabilities.
- Release PR #41 develop → master, merged.
- Published `advancer-limited.vscode-md-editor v0.2.4` from `master` via `npx @vscode/vsce publish` (PAT from `kv-advancer-prod` / `vsce-marketplace-pat`).
- Note: `vsce`/compile regenerate `media/markdown-it.min.js` with line-ending churn against the committed copy — discard with `git checkout -- media/markdown-it.min.js` before switching branches.

## 2026-07-18 — Cursor jump (third attempt), mermaid diagrams, task checkboxes, diff fence atomicity

Investigation and code review delegated first to a Fable-model subagent (full diagnosis + implementation spec, ~190k tokens); implementation split across the main session (sequential work in `media/editor.js`) and two parallel Sonnet worktree agents (isolated, independent files).

### Why the cursor still jumped after PR #24 and PR #37
- PR #24 introduced the caret save/restore mechanism as a single global plain-text character offset over the whole preview.
- PR #37 made the grammar-highlight refresh happen in place (no full innerHTML rebuild) and added stale-update/IME guards — this reduced *how often* a caret restore ran, but never touched the offset math itself.
- The global-offset scheme is ambiguous exactly at block boundaries: the offset at the end of block A and the start of block B are numerically identical, and an empty block (`<p><br></p>` from pressing Enter) has no text node to walk to at all. `refreshGrammarHighlights` still ran a full save/restore cycle on every incremental grammar check (scheduled ~1.5s after every edit, i.e. continuously while typing), so this fired reliably in the single most common editing action: press Enter, keep typing.

### PR #43 — fix/wysiwyg-cursor-jump
- media/editor.js: replaced the global-offset caret scheme with a block-anchored bookmark (`{ blockIndex, offset }` — which top-level child of the preview the caret is in, plus an offset within just that block). Removes the boundary ambiguity structurally; content changes in *other* blocks can no longer shift the caret.
- refreshGrammarHighlights: short-circuits when there's nothing to add or clear (the common case — most incremental checks come back clean) instead of paying for a full save/restore cycle every time; also now defers to `compositionend` during IME composition (previously unguarded).
- New `editAck` message (host → webview) closes a race where a debounced edit already posted to the host, but not yet applied/acknowledged, could be silently clobbered by a stale `update` racing it.
- Also fixed in the same pass: CRLF documents had their entire body rewritten on the first keystroke (`message.text` is always LF, `document.getText()` may be CRLF — `computeMinimalEdit` saw the whole body as changed); a stale `lastSentEditText` could cause a later genuine external change to be misclassified as an echo and dropped.
- Verified with Playwright against `test-server.html` (gitignored dev harness — patched to load turndown/turndownTableRules/mermaid scripts it was missing, and given `contenteditable="true"` on the preview div to match the real webview): reproduced the exact bug against the pre-fix code (typed text merges into the end of the previous paragraph after a simulated `grammarResults` message lands on a fresh empty block), then confirmed the fix holds in both the zero-matches and highlighted-match cases.

### PR #44 — feature/mermaid-and-checkboxes (stacked on #43)
- Mermaid (`^11.4.0`) vendored via `scripts/copy-vendor.js`, loaded in the editor webview. `` ```mermaid `` fences render as live SVG (async `mermaid.render()`, cached by a hash of the source so unrelated re-renders reuse it synchronously) inside an atomic `contenteditable="false"` block; a Turndown rule round-trips the block back to its exact original source via a `data-mermaid-source` attribute, independent of whatever markup mermaid produced.
- Diagram SVGs contain real text nodes (labels) — added a shared `rejectMermaidBlocks` TreeWalker filter and applied it everywhere the caret-bookmark and grammar-match code walks preview text, so diagram labels are never mistaken for document prose.
- GFM task-list checkboxes (`- [ ] text` / `- [x] text`): a markdown-it core-ruler pass (not regex preprocessing — needs no source-position mapping, which the wikilink code-block placeholder scheme would make unreliable) plus a Turndown round-trip rule and a click-to-toggle handler. Hit one real bug while building this: the checkbox's raw HTML included a trailing space for visual spacing, which combined with Turndown's whitespace-preservation-after-void-elements behavior *and* the Turndown rule's own trailing space to double up into `"[x]  text"` — fixed by dropping the manual space (the existing `margin-right` CSS on the checkbox already supplies it).
- Review fixes bundled in (same file/area): `preprocessWikilinks`'s code-block placeholder restore used string-mode `replace()` (interprets `$&`/`$1`/etc. as special patterns — a fenced block containing e.g. a shell `$(...)` could corrupt neighboring text); grammar highlighting matched the first occurrence of `matchedText` in the DOM regardless of which occurrence LanguageTool actually flagged; a clicked grammar-fix suggestion relied solely on a host round trip and could be silently lost to an in-flight-edit race (now applied to the DOM immediately, host round trip kept as a safety net); `sanitizeHtml`'s `javascript:` scheme check was case-sensitive and didn't strip control characters (bypassable via `java<tab>script:`), and only checked `href` — hardened and extended to `src`/`xlink:href`/`formaction`/`poster`, `<base>` now stripped too; stale grammar matches are cleared on a genuine external update instead of re-searched against unrelated new content.
- Verified with Playwright: a diagram renders to SVG and round-trips byte-identical through an unrelated WYSIWYG edit; a checkbox toggle round-trips to `[x]`/`[ ]` in the raw source with exactly one space (not the double-space bug above).

### PR #45 — feature/mmd-editor (parallel Sonnet worktree agent, independent of #43/#44)
- New `src/mermaidEditorProvider.ts` + `media/mermaidEditor.js/.css`: a self-contained CustomTextEditorProvider for `*.mmd`/`*.mermaid`, always forced split view (source left, live debounced render right). Mirrors the markdown editor's echo-suppression/minimal-edit sync pattern; independently discovered and fixed the same CRLF issue as #43 (webview normalizes to LF internally, host re-expands on the way in).
- Verified with Playwright against a standalone harness: valid diagram renders; invalid syntax shows an error banner while keeping the last valid render visible; fixing the syntax recovers.
- Note: both #44 and #45 independently vendor `mermaid` as a dependency (built in parallel off `develop`) — expect a trivial duplicate-addition conflict in package.json/package-lock.json when both merge.

### PR #46 — feature/diff-fence-atomicity (parallel Sonnet worktree agent, independent)
- Closes a known issue logged in todo.md on 2026-07-09: `computeLineDiff` diffed purely line-by-line with no fence awareness, so a single changed line inside a multi-line fenced code block could split the fence's markers across separate hunks, which `media/diff.js` then rendered independently through markdown-it — broken/mismatched output. New `segmentLines()` in `diffAlgorithm.ts` collapses a complete fence (`` ``` `` or `~~~`, matching character, closer length ≥ opener length) into one atomic diff unit; downstream LCS/hunk-grouping logic needed no changes. 6 new tests (interior fence change, unterminated fence, `~~~` fences, adjacent unchanged prose, 4+-backtick nesting).
- Also: "Compare with Saved" was diffing against `git show HEAD:<path>` instead of the actual on-disk file (wrong when there are committed changes plus further saved-but-uncommitted edits) — now reads the file directly via `vscode.workspace.fs.readFile`.
- Also: `.markdown` files were second-class throughout wikilinks/graph/diff despite the editor's customEditors selector claiming both `.md` and `.markdown` — the file index scan glob, all watchers, rename propagation, and menu `when` clauses only checked `.md`. Added a shared `isMarkdownFile()` helper and used it everywhere.

### Notes
- PR #44 is stacked on #43 (not `develop`) for a clean review — merge #43 first, then retarget #44's base to `develop`.
- PR #45 and #46 are independent of #43/#44 and of each other; can merge in any order.
- All four branches: `npm run check-types`, `npm run compile`, `npm test` green (#43/#44: 35/35 tests; #46 adds 5 more, 40/40).

## 2026-07-19 — Mermaid editor overhaul, release 1.0.0

Planned by a Fable subagent (full implementation spec), built in the main session, then adversarially reviewed by a second Fable subagent. Three research agents ran in parallel on renderer/licensing questions (see Research notes below).

### Method: regression contract first
Before touching anything, captured a 14-check behavioral suite against the *existing* `.mmd` editor covering the parts most at risk — echo suppression, CRLF normalization, stale-update dropping, keep-last-good-render, the ready handshake. Baseline: 14/14. Re-run after every subsequent change; still 14/14. This is what makes "didn't break existing functionality" a verified claim rather than an assertion. Reviewer independently confirmed the sync-critical block is byte-identical to develop.

### Features
- **Syntax highlighting** in the `.mmd` source pane via a transparent-textarea-over-highlighted-`<pre>` overlay. Tokenizer extracted to `media/mermaidSyntax.js` (UMD, following the `turndownTableRules.js` precedent) so it is unit-testable: 26 committed tests covering tokenization, exact source round-trip, and HTML-injection attempts — the output goes to `innerHTML`, so escaping is security-critical, not cosmetic. Escape-then-wrap; class names come from a fixed whitelist so no user input ever reaches an attribute.
- **Error-line marking** — structured jison `err.hash` first, message-text regex as fallback, banner-only when mermaid reports no line (e.g. UnknownDiagramError).
- **Zoom/pan** with cursor-anchored Ctrl+wheel zoom, drag-pan, fit/reset/percentage toolbar. Transform deliberately preserved across re-renders — resetting the view on every keystroke made zooming into a large diagram useless.
- **PNG export** with a light/dark background choice via native QuickPick; a light export *re-renders* rather than rasterizing the on-screen dark diagram (which would give unreadable light-on-white).
- **Print** — `window.print()` is suppressed in VS Code webviews (sandboxed iframe, no allow-modals) and fails *silently*; the host writes a standalone page and opens it externally where the real print dialog and Save-as-PDF live.
- **Visual restyle** — themeVariables plus a `<style>` injected *inside* the SVG (so preview, PNG and print all share it): rounded corners, flatter palette, cleaner type. Live re-render on VS Code theme change via a MutationObserver on the body class.
- **About/brand button** on both editor toolbars; version 1.0.0; `author` field added.

### Empirical findings worth remembering
- Mermaid emits `width="100%"` and **no** `height` — export dimensions must come from the **viewBox**, not the attributes.
- Mermaid uses `<foreignObject>` for flowchart labels. This *does* rasterize correctly to canvas in Chromium (verified by writing the PNG out and inspecting it), so no `htmlLabels:false` workaround is needed. Would not hold in Safari — irrelevant, webviews are always Chromium.
- Rasterizing an inline SVG via a `data:` URL does **not** taint the canvas, so `toDataURL()` works and no CSP change was needed (`img-src data:` was already present). A `blob:` URL *would* have required widening the CSP.

### Review findings fixed (all in the new export path; none touched document sync)
1. **BUG** dark export from a *light* editor filled the canvas with the light body background → fixed constants per export theme.
2. **BUG** export/print with a broken source silently fell back to the on-screen SVG in the wrong theme *and reported success* → now renders from `lastGoodSource` (matching what keep-last-good is displaying) and fails loudly if that's unavailable.
3. **BUG** a diagram wider than 8192px produced a 0-byte PNG with a success toast (`Math.max(1, …)` prevented scaling *down*; oversized canvas → `toDataURL()` returns `"data:,"`) → allow scale < 1 and reject empty output on both sides.
4. Themed export leaked mermaid's scratch node on failure → same orphan cleanup as the preview path.
5. Host `exportPng` had no try/catch or payload validation → added.
6. Print temp files accumulated forever in globalStorageUri → age-based sweep (immediate deletion is unsafe, the browser opens them async).
7. `vscode-high-contrast-light` was classified as dark → fixed.
8. Reviewer asked for a *manual* check that `scrollbar-gutter: stable` really equalises content width in both scrolling and non-scrolling states — automated it instead; passes both.

### Research notes (parallel agents) — renderer and licensing decisions
- **Licensing is the deciding filter**, given the intent to keep commercial options open. The repo already has a CLA, so contributor rights are assigned and relicensing remains possible.
- **D2** — MPL-2.0 (file-level copyleft; safe to depend on without open-sourcing our code). Official `@terrastruct/d2` WASM build bundles dagre+ELK; TALA is proprietary and excluded. ~8MB, and needs `wasm-unsafe-eval` + `worker-src blob:` added to the CSP. **Recommended** as a future second renderer for architecture diagrams.
- **PlantUML** — core is GPL. A first-party MIT-flavoured `@plantuml/core` (TeaVM) build now exists and genuinely renders client-side including Graphviz-dependent diagram types, but it is very new and its MIT-ness depends on the maintainer gating GPL paths correctly every release. **Avoid** — the downside is the whole product becoming GPL-encumbered.
- **3D** — no "Mermaid for 3D" exists. A-Frame (MIT, three.js-based, LLM-fluent) is a *scene* language with no auto-layout, so an LLM must compute coordinates. Recommendation for architecture visualisation is a small custom DSL compiling to vendored three.js, with compiler-side layout so the LLM never emits coordinates. OpenSCAD/X_ITE are GPL — avoid.

### Verification
66 unit tests, 14 behavioral regression, 23 new-feature Playwright, 7 review-fix Playwright — all passing; `check-types` and `compile` clean.

## 2026-07-19 — Mermaid authoring assistance (toolbox + completions)

Follow-on to the mermaid editor overhaul. Same method: pure logic extracted to a UMD module for the Node test runner, DOM work in the webview, and the existing Playwright suites re-run as a regression gate before anything else.

### What was built
- `media/mermaidCompletions.js` — diagram templates, the context-aware snippet palette, the node-id scanner and the completion engine. No DOM access, so it is unit tested directly (28 tests).
- **Template gallery** (8 starter diagrams) — the highest value-per-effort item: it solves "I can never remember mermaid syntax" outright. Replacing a non-empty document asks for confirmation first.
- **Snippet palette**, rebuilt only when the detected diagram type changes (avoids DOM churn on every keystroke).
- **Completion overlay** — VS Code's CompletionItemProvider does not apply to a textarea in a webview, so this is a custom overlay modelled on the markdown editor's `[[wikilink]]` autocomplete. Offers node ids after an arrow (the standout: a typo'd node id doesn't error in mermaid, it silently creates an orphan), plus diagram types, directions, keywords and arrows.
- All insertion goes through `document.execCommand('insertText')` so the browser's native undo stack survives and a real `input` event fires — which is what drives the existing highlight refresh, render debounce and document sync. Assigning `textarea.value` directly would break undo AND fire no event, silently desyncing the document. There is a manual splice + synthetic event fallback in case execCommand is ever removed.

### Bugs caught during verification
1. **Completion list closed the instant it opened.** The `scroll` handler hid it, and typing itself scrolls the textarea to keep the caret visible. Fixed by repositioning on scroll instead of hiding — which is the better behavior anyway.
2. **Overlay swallowed toolbar clicks** (caught by the *existing* feature suite, not the new one — the regression gate earning its keep). The overlay clamped to the window edge, so a long line pushed it over the preview pane where it covered the toolbar. Now clamped to the source pane, plus an outside-mousedown dismiss.
3. **Layout broken — caught only by looking at a screenshot, with all 61 automated checks passing.** `.mmd-editor-pane` is `display: flex` with default row direction, so the new source toolbar became a row-sibling and squeezed the text into a one-character-wide strip. Fixed with `flex-direction: column` (+ `min-height: 0` on the stack instead of `height: 100%`, which would now overflow by the toolbar's height). A good reminder that behavioral tests keyed on element IDs say nothing about whether the thing is usable.

### Verification
94 unit tests (66 existing + 28 new); 61 Playwright checks (14 behavioral regression, 23 feature, 7 review-fix, 17 new toolbox/completions); check-types and compile clean.

## 2026-07-19 — glTF 3D viewer

Designed by a Fable subagent, built by a Sonnet subagent in an isolated worktree, then independently verified and reviewed here.

### Key design decisions (from the spec)
- **`.gltf` only for v1.** `.glb` is binary — a `CustomTextEditorProvider` would show mojibake and corrupt it on save. Supporting it needs a separate `CustomReadonlyEditorProvider`; the whole viewer half is reusable when we do.
- **three.js cannot be file-copied like mermaid.** It removed its UMD builds at r160/r161 and ships ESM only; `examples/jsm` (GLTFLoader, OrbitControls) has been ESM-only since r148. Solved with a *second, parallel* esbuild context producing an IIFE global (`media/three-bundle.js`, 778KB), leaving the extension-host build untouched. MIT licensed — commercially safe.
- **Live re-render, not an Update button** — with a `JSON.parse` validity gate (the document is usually invalid mid-typing, so invalid states cost nothing), a semantic-identity skip so reformatting is free, and a 2MB size gate above which auto-render is disabled. An Update button always exists as a force path.
- **Camera preservation is structural, not save/restore.** Renderer/scene/camera/OrbitControls are created once per webview lifetime; a reload only swaps the model subtree. The viewport therefore survives every reload by construction — the same insight as the mermaid editor's transform surviving `innerHTML` replacement.
- **`connect-src` had to be added to the CSP** — GLTFLoader's FileLoader/ImageBitmapLoader use `fetch` for `.bin` buffers and textures. Easy to miss; would only fail on real multi-file models.

### Build agent's deviations, all accepted
- Passes the already-`JSON.parse`d object into `GLTFLoader.parse()` rather than the raw string: `parse()` does its own unguarded `JSON.parse` on a string, which throws *synchronously* and bypasses `onError`. Genuinely better than the spec.
- Dedicated `THREE.LoadingManager` rather than the shared default, for isolation.
- Added `loadCount` to the debug hook so tests can detect completion deterministically instead of via fixed timeouts.

### Review finding fixed
`lastRenderedJson` was recorded *before* the async load succeeded, so a glTF that parsed as JSON but failed to load would poison the identity cache: returning to that exact text later hit the skip path, which clears the error banner while the stale previous model is still displayed — a broken document silently presenting as fine. Now recorded only on success.

### Verification note worth keeping
My first camera-preservation test reported a failure that was **my test's bug, not the code's**: OrbitControls has damping enabled, so the camera keeps easing for a second or two after a drag, and I measured mid-settle. A controlled comparison (drift with reload vs drift over the same interval without one) gave 0.000000 vs 0.000022 — proving preservation exactly. The build agent had actually warned about this in its report. Lesson: when a test disagrees with a design claim, measure the control before believing either.

### Verification
107 unit tests (94 + 13 new); 6 glTF Playwright checks (render, camera preservation, GPU-leak accounting over 8 reloads, invalid-JSON keep-last-good); the mermaid behavioral suite re-run against the merged branch (14/14, no cross-feature regression); check-types and compile clean.

## 2026-07-20 — Activity bar icon + expanded mermaid template dropdown

### Activity bar icon
Replaced the generic `$(link)` built-in codicon with a monochrome SVG (`media/activity-icon.svg`) using the same silhouette as the toolbar's brand/About button (`src/utils.ts` `getBrandButtonHtml`) — an outer triangle with a smaller triangular aperture cut via `fill-rule: evenodd`. VS Code recolors activity-bar SVGs via a CSS mask, so the file's own fill color is irrelevant to what renders; verified this empirically by simulating the mask technique (`background + mask-image`) in a headless browser rather than assuming — confirmed a clean, recognizable white silhouette on both the resting and "active" (blue indicator bar) states.

### Mermaid template dropdown: 8 → 22 diagram types
Researched actual usage patterns first (flowchart/sequence/class/ER/state confirmed as the "daily-use" core across sources) to order the dropdown sensibly, then drafted 22 candidates covering nearly every official Mermaid diagram type up to the "up to 25" budget the user set.

**Every template body was validated against the real vendored mermaid bundle (11.16.0) via `mermaid.parse()`** — not hand-verified syntax. This caught 4 real failures on the first pass: sequence-diagram participants, ER entities, and state names with spaces in their names (`"Actor 1"`, `"Entity 1"`, `"State 1"`) are rejected unquoted by mermaid's grammar; fixed by quoting the identifier and using a short alias for arrow references. Empirical validation over guessed syntax paid off immediately.

All example content was written (and one existing test extended to enforce) as generic, obviously-placeholder text — "Box 1", "Task 2", "Entity 1" — rather than domain-flavored content ("Customer", "Order", "Animal") that a user might mistake for real content and forget to edit, per explicit instruction.

### Searchable dropdown + cursor-position-aware insertion
With 22 items a plain scrolling list would be hard to scan, so added a search/filter input at the top of the menu — mirroring the existing wikilink-picker pattern already in `editor.js` (search input, live filter, arrow-key nav, Enter to confirm, Escape to close) rather than inventing a new UI convention.

**Insertion behavior changed entirely**, replacing the previous "replace the whole document" flow: a template now inserts at the current caret. If the caret sits at the very start or end of the document, it inserts directly (no prompt) — otherwise (caret strictly inside existing content, i.e. likely inside an existing diagram's syntax, since mermaid only supports one diagram per file) the host shows a native modal warning suggesting the user move to the start/end instead, with an "Insert Anyway" option to proceed regardless. Confirmation is necessarily host-side: `confirm()`/`alert()` are blocked in VS Code's sandboxed webviews (same restriction as `window.print()`, already documented from the PR #50 work) — a blocked `confirm()` would make the safety warning silently do nothing.

### A real bug the tests found in themselves, not the app
The Playwright test for choosing a template initially used `element.click()` inside `page.evaluate()`, which dispatches only a synthetic `click` event with no preceding `mousedown` — but the app's menu-item handler listens on `mousedown` (matching the wikilink-picker's existing convention, so a real mouse click always fires it). The test silently did nothing on the first three insertion-position scenarios. Fixed by switching to Playwright's `locator.click()`, which simulates the full physical mousedown/mouseup/click sequence. Worth remembering: a scripted `.click()` is not equivalent to a real click for mousedown-driven UI.

### Verification
110 unit tests (28 in mermaidCompletions alone, including 3 new ones asserting the template count/budget, exactly-one-placeholder-per-template, and no domain-flavored example content); 69 Playwright checks (44 pre-existing regression/feature/review-fix suites re-run unchanged, plus 25 new ones covering the dropdown, search, and all three insertion-position paths — end/start/mid-document — with the exact "content spliced around the insertion point" assertion for the mid-document accept case). check-types and compile clean.

## 2026-07-22 — PR #55: Fable review findings fixed

Opened PR #55 (`feature/mmd-templates-and-activity-icon` → `develop`), then ran a Fable subagent adversarial review of the diff, which posted its findings to the PR. It found real bugs the original "does it parse?" validation missed:

- **Sequence template alias syntax was backwards** — `participant "${Actor 1}" as A1` parses, but mermaid reads `id [as label]`, not `label as id`; the whole quoted `"Actor 1" as A1` string became a single garbage id/label, and the diagram silently grew two extra actors. Fixed to `participant A1 as ${Actor 1}`.
- **Four templates put the editable placeholder on an identifier other lines referenced by name** (gitgraph's branch name, architecture's group id, requirement's requirement id, ER's duplicated entity name) — typing over the placeholder, exactly the documented "type straight over it" workflow, broke the diagram (gitgraph: "branch which is not yet created"; architecture: "parent does not exist") or silently created orphaned/dangling references (requirement, ER). The original empirical validation only parsed the *as-shipped* body, never the body *after* the placeholder is edited — which is the one that matters, since the placeholder exists specifically to be typed over. Fixed by moving each placeholder onto a label nothing else references (gitgraph: a commit tag instead of the branch name; architecture: the group's display label instead of its id; requirement: the requirement text instead of its id; ER: moved the attribute block off the templated entity onto a fixed one). Re-validated by parsing every template twice — as-shipped, and with the placeholder text swapped out — confirming all 22 survive both.
- **Menu items are real `<button>`s, so Tab could focus one directly, but the insert handler only listened on `mousedown`** — Enter/Space on a keyboard-focused item silently did nothing. Added a `keydown` handler for Enter/Space alongside the existing mousedown handler.
- **A stale template menu ignored external document changes** — if the file changed on disk while the menu was open, the caret captured at open-time could now be out of range or misclassified. `closeTemplateMenu()` is now called from the same `update` handler that already hides the autocomplete overlay for the same reason.
- **Select-all then choosing a template hit the "safe" fast path** — `selectionStart === 0` looked like "caret at document start" even though the entire document was selected, silently inserting at position 0 without deleting the selection (old content kept, producing an invalid two-diagram file) and no warning shown. The boundary check now also requires the selection to be collapsed; any active selection routes through the same host-confirmation modal.

All fixes verified: unit tests (110/110), the existing 69 Playwright checks re-run clean, plus 10 new Playwright checks written specifically against these findings (keyboard Tab+Enter activation, select-all confirmation, stale-menu-closes-on-external-update, and all 5 repaired templates rendering error-free after typing over their placeholder).

## 2026-07-22 — Activity bar icon replaced with a pixel-traced silhouette (v1.1.1)

The user pointed out the 1.1.0 activity bar icon didn't actually look like `media/icon.png` — it was a hand-drawn approximation (an outer triangle with a triangular hole cut out) that read as a plain hollow triangle, not the "A" mark.

Rather than redraw it by eye again, traced it directly from the source image's pixels:
1. Read `media/icon.png` (128x128) pixel-by-pixel with `pngjs`; every pixel with alpha > 50% became solid black, everything else white — this flattens all the logo's color facets into one silhouette, exactly the way VS Code's activity-bar CSS-mask recoloring will flatten it anyway regardless of the source's colors.
2. Traced that black/white mask into an SVG path with `potrace`, using `optCurve: false` and `alphaMax: 0` to force straight-edged polygon output (curve-fitting is wrong for a source that's entirely triangular facets).
3. Rescaled the resulting path from the 128px source down to a 24x24 viewBox to match the existing file's convention.

This makes the icon pixel-accurate to the real logo — same silhouette, same counter/hole, same base — rather than an approximation. Before committing, rendered a preview simulating VS Code's activity-bar CSS-mask recoloring at real 24px icon size (published as a Claude Artifact) so the user could confirm it looked right first.

Version bumped 1.1.0 → 1.1.1 (patch — visual fix only, no behavior change).

## 2026-07-22 — Mermaid print/openExternal fix + icon-only snippet palette (v1.1.2)

Two fixes were made directly in the working tree (not through this session originally) and handed off for testing and release:

**Print/Save as PDF failing on Windows.** The print flow writes the diagram's SVG to a temp HTML file under `context.globalStorageUri` and hands that URI to `vscode.env.openExternal()` to open in the system browser. `globalStorageUri` can carry a `vscode-userdata:` scheme rather than `file:` (seen on Windows) — `openExternal` passes that scheme straight to the OS shell, which has no application registered for it, producing a "Get an app to open this vscode-userdata link" prompt instead of the browser's print dialog. Fixed in `src/mermaidEditorProvider.ts` by rebuilding the URI as `vscode.Uri.file(file.fsPath)` before calling `openExternal` — `fsPath` resolves to the real filesystem path regardless of the URI's scheme, so wrapping it forces a proper `file:` URI the shell can actually open.

**Snippet palette: text labels → icon buttons.** The `.mmd` editor's context-aware snippet palette (Box, Diamond, Hexagon, Participant, Loop, Alt, Par, etc. — the buttons beside Template) used text-label buttons, which wrapped across 2-3 toolbar rows once a diagram type's full snippet set was shown. Replaced with small 24×24px icon buttons (hand-authored inline SVG per snippet, sharing a `viewBox="0 0 16 16"` with `stroke="currentColor"` so they theme automatically), with the old label + description now living in the `title` tooltip and a matching `aria-label`. Verified the full palette now fits on a single row at normal editor widths.

Testing found one thing needing an update, not a bug: the pre-existing `toolbox-tests.js` Playwright suite queried snippet buttons by `.textContent` to find/verify them by name (e.g. `find(b => b.textContent === 'Diamond')`) — with icon-only buttons this is now always empty, so the assertions and the "click the Diamond snippet" helper both silently failed. Updated those to read the button's `title` (`"Label — Description"`) instead, which is the whole point of the change: the label moved from the DOM text to the tooltip, not away entirely.

Verification: 110 unit tests, existing 89 Playwright checks (across toolbox/fable-fix/feature/review-fix/behavior suites) re-run clean after updating the stale label-lookup assertions, plus 10 new Playwright checks specifically for the icon palette (icon-only rendering, tooltip content, one-row layout, click-to-insert still works, palette still switches per diagram type). The `openExternal` fix itself isn't Playwright-testable (host-side VS Code API, not reachable from the webview harness) — verified by code review instead: `file` is `vscode.Uri.joinPath(this.context.globalStorageUri, ...)`, and `.fsPath` resolves to the real filesystem path regardless of the source URI's scheme, so `vscode.Uri.file(file.fsPath)` is a safe, correct rebuild.

Version bumped 1.1.1 → 1.1.2 (patch — one bug fix, one UI change, no breaking behavior).

## 2026-07-22 — Sidebar tabs: Mermaid tab + flat/folder view + folder context menu (v1.2.0)

The user asked for a review of the sidebar (previously reviewed and suggested a tab-based direction in this same session — Markdown Links, Mermaid, Aiqbee Brains, an Askance dev UI), then asked to build just the tab setup with a first Mermaid tab, then in three follow-up messages (mid-turn, before the previous step finished) expanded scope to: a per-tab flat/folder view toggle (with three explicit design decisions locked in via AskUserQuestion: per-tab independent state, always-fully-expanded folders — no collapse state — and search overriding to flat view), and a folder right-click context menu for creating a file in that folder or revealing it in the native Explorer.

**Architecture decision.** VS Code's `viewsContainers` API has no native horizontal-tab primitive — only stacked collapsible views per container, or one webview per container. Since the user explicitly wanted "tabs across the top," the whole thing stays as the single existing `GraphViewProvider` webview, now rendering a client-side tab bar with two panels; switching tabs is pure DOM show/hide, no host round-trip, since both tabs' data is already sent to the webview on `ready`.

**New `MermaidFileIndexService`** (`src/graph/mermaidFileIndexService.ts`) is a deliberately lightweight sibling to `FileIndexService` — enumerates and watches `.mmd`/`.mermaid` files but does no content parsing, since (unlike markdown) there's no wikilink/backlink graph to maintain for diagram files. Discovered along the way that `getActiveFilePath()`/`getActiveFileUri()` in `extension.ts` are markdown-only (custom editors don't populate `vscode.window.activeTextEditor`, so `MarkdownEditorProvider` tracks its own active document — `MermaidEditorProvider` has no equivalent). Rather than add that tracking as a side-quest, the Mermaid tab simply doesn't highlight an "active" file — not something the user asked for, and out of scope for this pass.

**Folder tree is entirely a client-side rendering concern.** The host still sends the exact same flat node list it always did; `graph.js` derives the full folder path from each node's `relativePath` and builds a tree client-side (`buildFolderTree`) — folders are only ever created in the tree when a file actually needs one, so "don't show folders with no matching file" falls out of the data structure itself rather than needing a separate prune/filter pass. This meant zero new host→webview message types were needed for the toggle itself. Per-tab view-mode state is persisted via the webview's own `vscode.setState()`/`getState()` (already available since `acquireVsCodeApi()` was already captured), so each tab's flat/folder preference survives a webview reload.

**Search-vs-folder-view interaction** (per the AskUserQuestion answers): typing in a tab's search box forces that render to flat regardless of the toggle's stored state (search results and a folder tree don't compose, by design), and the toggle button visibly disables itself while a query is active so it's clear why clicking it does nothing; clearing the search reverts to whatever the toggle was last set to.

**Folder context menu.** Webviews get no contributed context menu for arbitrary DOM elements, so this is a floating `<div>` menu built and positioned on `contextmenu`, exactly mirroring the pattern already established for the wikilink picker and the mermaid template menu earlier in this project. "Add Markdown"/"Add Mermaid" needs a filename — `window.prompt()` is blocked in VS Code's sandboxed webviews (same restriction already documented for `confirm()`/`print()`), so the webview posts a message and the **host** shows a native `vscode.window.showInputBox()`, auto-appends the right extension if the user didn't type one, checks for an existing file of that name first (no silent overwrite), then creates and opens it. "Show in Explorer" resolves the folder's relative path against `vscode.workspace.workspaceFolders?.[0]` (matching this extension's existing implicit single-root-workspace assumption elsewhere) and runs the built-in `revealInExplorer` command.

**Verification.** Built a new Playwright test harness for the sidebar webview specifically (`graph-test-server.html` + `sidebar-tabs-tests.js`, same shimmed-`acquireVsCodeApi()` pattern used for the mermaid editor's tests, extended here with a `getState`/`setState` shim) — 27 checks covering tab switching, the mermaid list populating and posting `openMermaidFile` on click, folder-tree grouping/nesting/pruning, root-level (no-folder) files still rendering, search-forces-flat plus the toggle's disabled state, per-tab state independence (toggling one tab's view doesn't affect the other), both folder-menu actions for both file kinds (including the kind-specific "Add Markdown" vs "Add Mermaid" label), outside-click dismissal, and `setState` persistence — plus explicit regression checks for the pre-existing Markdown Links behavior (active-file highlight, backlink expand/collapse, link-click-to-open, the Show Graph button), since there was no prior test coverage at all for `graph.js` before this rewrite. **Like every other Playwright suite referenced in this log, these live only in the session scratchpad — Playwright is not a committed devDependency and this harness is not part of the repo** (same accepted limitation flagged by the Fable review of PR #55). 110 unit tests unaffected and still green; `check-types`/compile clean.

A Fable adversarial review of this PR (#61) found real bugs beyond what the above verification caught, since none of it exercises the extension-host TypeScript directly (only the webview side is Playwright-testable without a running VS Code instance):
- **Multi-root workspace: file creation could land in the wrong root.** `resolveWorkspaceFolderUri` unconditionally used `workspaceFolders[0]`, while `relativePath` on every indexed file is computed against *that file's own* root — in a multi-root workspace, right-clicking a folder under root #2 would create the file under root #1 (and `workspace.fs.writeFile`'s implicit mkdirp would have silently fabricated the directory chain there). Fixed by resolving the correct root from an actual indexed file under the target folder (`vscode.workspace.getWorkspaceFolder(match.uri)`) instead of assuming index 0, with a fallback and a containment check (resolved path must still be inside the resolved root — defense in depth against a crafted `folderPath` escaping via `..` segments through `Uri.joinPath`'s normalization).
- **Stale search after the webview is torn down and re-resolved.** `searchQuery`/`mermaidSearchQuery` live on the long-lived provider instance, not the (shorter-lived, DOM-reset) webview — hiding and re-showing the sidebar reloads a fresh, visually-empty search box while the host silently kept filtering by the old query. Fixed by resetting both on every `'ready'` (which only ever fires on a fresh load).
- **TOCTOU race in file creation** — a separate `stat`-then-`writeFile` could silently truncate a file that appeared in the gap between them. Replaced with a `WorkspaceEdit.createFile(uri, { overwrite: false, ignoreIfExists: false })` + `applyEdit`, which fails atomically instead.
- **Stuck tooltip** — disabling the folder-view toggle while searching set an explanatory tooltip but never restored the real one when re-enabled after the search cleared. Fixed.
- **Transient stale content while typing** — the instant client-side flip to flat rendering (added so the view doesn't wait on the debounced host round-trip) was re-rendering the *stale, unfiltered* node list for ~200ms under a visibly non-empty query. Since the webview already has the full data, added a client-side filter (mirroring the host's own label/folder substring match) so the instant preview is correct immediately, not just eventually.
- Also added keyboard activation (Enter/Space), Escape-to-close, and viewport-edge clamping to the folder context menu — the same class of mousedown-only keyboard-inaccessibility bug Fable found in the mermaid template menu during the PR #55 review, replicated here and fixed the same way.

All fixes re-verified: 110 unit tests, 27 Playwright checks (scratchpad-only, as above) re-run clean, `check-types`/compile clean. The multi-root/TOCTOU/containment fixes are host-side TypeScript with no VS Code instance available to exercise them end-to-end here — verified by code review only, consistent with how the mermaid print/`openExternal` fix earlier in this session was verified.

Version bumped 1.1.2 → 1.2.0 (minor — new user-facing feature, no breaking changes).
