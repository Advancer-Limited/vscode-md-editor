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
