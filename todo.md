# TODO — Wikilinks + Graph Visualizer

## Phase 0: Project Setup
- [x] Create CLAUDE.md, todo.md, log.md

## Phase 1: Wikilink Parser
- [x] Create `src/wikilink/wikilinkParser.ts` (regex, parseWikilinks, isInsideCodeBlock, resolveWikilinkTarget, parseTags)
- [x] Add `getFileStem()` and `escapeRegex()` to `src/utils.ts`

## Phase 2: File Index Service
- [x] Create `src/wikilink/fileIndexService.ts` (singleton, scan, index, watchers, queries)
- [x] Modify `src/extension.ts` to create FileIndexService and pass to MarkdownEditorProvider
- [x] Modify `src/markdownEditorProvider.ts` constructor to accept FileIndexService
- [x] Verify build compiles

## Phase 3: Wikilink Autocomplete
- [x] Extend `src/types.ts` with WikilinkSuggestion and new message types
- [x] Add autocomplete module to `media/editor.js`
- [x] Add autocomplete styles to `media/editor.css`
- [x] Handle requestWikilinkSuggestions + openWikilink in markdownEditorProvider.ts

## Phase 4: Wikilink Preview Rendering
- [x] Add wikilink preprocessing in `media/editor.js` renderPreview
- [x] Add wikilink click handler in preview
- [x] Add wikilink CSS styles in `media/editor.css`

## Phase 5: Backlink Panel
- [x] Create `src/wikilink/backlinkTreeProvider.ts`
- [x] Add viewsContainers + views to `package.json`
- [x] Register TreeView in `src/extension.ts`

## Phase 6: Rename Propagation
- [x] Create `src/wikilink/renamePropagation.ts`
- [x] Register onWillRenameFiles in `src/extension.ts`

## Phase 7: Graph Visualizer
- [x] Install force-graph, update `scripts/copy-vendor.js`
- [x] Create `src/graph/graphDataService.ts`
- [x] Create `src/graph/graphViewProvider.ts`
- [x] Create `media/graph.js` + `media/graph.css`
- [x] Add graph view + commands + config to `package.json`
- [x] Register GraphViewProvider in `src/extension.ts`
- [x] Full build passes (`npm run compile`)

## Phase 8: Default WYSIWYG Editor + Inline Grammar Highlights

- [x] Make custom editor default (`priority: "default"` in package.json)
- [x] Add `GrammarMatch` type and grammar message types to `src/types.ts`
- [x] Add `onGrammarResults` event emitter to `src/diagnosticsProvider.ts`
- [x] Wire grammar results to webview (`extension.ts` + `markdownEditorProvider.ts`)
- [x] Render grammar highlights inline in `media/editor.js` (TreeWalker, tooltips, suggestions)
- [x] Add grammar highlight CSS styles to `media/editor.css`
- [x] Install Turndown, vendor it via `scripts/copy-vendor.js`
- [x] Make preview `contenteditable`, change default view to preview-only (WYSIWYG)
- [x] Implement contenteditable → markdown sync via Turndown
- [x] Update toolbar buttons to dispatch `execCommand` in preview mode
- [x] Add keyboard shortcuts (Ctrl+B/I/K) for contenteditable preview
- [x] Update wikilink click handler (Ctrl+Click to navigate in edit mode)
- [x] Update status bar for preview mode (word count from preview text)
- [x] Full build passes (`npm run compile`)

## Phase 9: Bug Fixes & Polish

- [x] Fix `fetch` failing in VS Code extension host — switch to Node.js `https` module with IPv4
- [x] Fix LanguageTool 413 error — chunk text into ≤1400 char segments for free API
- [x] Fix wikilink rendering — re-enable `html: true` in markdown-it config
- [x] Fix yellow focus border on contenteditable preview
- [x] Fix Link button — shows wikilink file picker instead of URL prompt
- [x] Add real-time incremental grammar checking (paragraph-level on edit)
- [x] Fix grammar highlight CSS — use `text-decoration: underline wavy` instead of invalid `border-bottom: wavy`
- [x] Verify grammar highlighting renders in preview (pending user test)
- [x] Clean up debug logging

## Phase 10: Obsidian-Style Graph Experience

- [x] Add `RelationshipItem` type and new message types to `src/types.ts`
- [x] Add `getRelationships()` BFS method to `src/graph/graphDataService.ts`
- [x] Update `src/graph/graphViewProvider.ts` — relationship data, "Expand" button, updated HTML
- [x] Update `media/graph.js` — relationship list rendering, depth-grouped, click-to-open
- [x] Update `media/graph.css` — split layout (mini graph + relationship list), styles
- [x] Create `src/graph/fullGraphPanel.ts` — full graph in main editor area (WebviewPanel singleton)
- [x] Create `media/fullGraph.js` — Obsidian-style controls (Filters, Display, Forces), drag-to-pin, zoom controls, tooltips
- [x] Create `media/fullGraph.css` — full-viewport layout with overlay controls panel
- [x] Update `src/extension.ts` — register `openFullGraph` command, remove BacklinkTreeProvider
- [x] Update `package.json` — remove backlinks view, add `openFullGraph` command
- [x] Delete `src/wikilink/backlinkTreeProvider.ts`
- [x] Full build passes (`npm run compile`)
- [x] Rewrite sidebar as flat file list (no force-graph canvas) — user-requested simplification
- [x] Fix force-graph method chain bug (`.d3Force()` returns d3 force, not graph)
- [x] Add cache-busting (`?v=${Date.now()}`) to all webview script/CSS URIs
- [x] Fix full graph canvas not rendering — race condition fix + dimension initialization
- [x] Fix wikilinks rendering as raw HTML in preview — debug logging added
- [x] Verify grammar highlighting renders in preview

## Phase 11: Markdown Diff (Rendered Diff Viewer)

- [x] Create `src/diff/diffService.ts` — Git CLI wrapper (history, content at commit, repo root)
- [x] Create `src/diff/diffAlgorithm.ts` — Line-level LCS diff with `\r\n` normalization
- [x] Create `src/diff/markdownDiffPanel.ts` — Webview panel rendering diffs through markdown-it
- [x] Create `media/diff.js` + `media/diff.css` — Webview diff rendering and styling
- [x] Add 3 commands to `package.json` with explorer context menu entries
- [x] Register commands in `extension.ts` with shared `resolveDiffContext` helper
- [x] Smart commit selection in "Compare with Previous" (HEAD if uncommitted, else HEAD~1)
- [x] Update `README.md` with Version Diff docs, Commands table, usage section
- [x] Create `CHANGELOG.md`
- [x] Full build passes (`npm run compile`)
- [x] Tested: rendered markdown diff with green/red highlights

## Release 0.2.1

- [x] Bump version to 0.2.1 (package.json, package-lock.json)
- [x] Add CHANGELOG 0.2.1 entry
- [ ] PR fix/bump-0.2.1 → develop, self-review, merge
- [ ] PR develop → master, merge
- [x] Publish 0.2.1 from master to VS Code Marketplace
- [x] Fix WYSIWYG table formatting loss (Turndown GFM table rules)

## Code review pass (fix/review-fixes)

- [x] getNonce → CSPRNG
- [x] Extract + unit-test Turndown table rules; fix wikilink pipe in cells
- [x] fileIndexService: per-URI debounce, watchers-before-scan, stem-safe removal
- [x] extension: catch initialize() rejection
- [x] diffAlgorithm: prefix/suffix trim
- [x] Add Node test runner + table & diff tests
- [ ] Follow-ups (deferred): editor cursor-sync race, rename edge cases, grammar highlight offset, LT proxy timeout
