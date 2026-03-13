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
