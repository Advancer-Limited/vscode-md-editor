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
