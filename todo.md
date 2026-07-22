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
- [x] Follow-ups: editor cursor-sync race, rename edge cases, grammar highlight offset, LT proxy timeout

## Release 0.2.3

- [x] Bump version to 0.2.3 (package.json, package-lock.json)
- [x] Add CHANGELOG 0.2.3 entry
- [x] PR fix/bump-0.2.3 → develop, self-review, merge
- [x] PR develop → master, merge
- [x] Publish 0.2.3 from master to VS Code Marketplace

## 2026-07-09 review pass (PRs #37–#39)

- [x] Root-cause WYSIWYG cursor jump (grammarResults innerHTML rebuild + stale update race)
- [x] PR #37 fix/wysiwyg-cursor-stability — in-place grammar highlight refresh, stale-update guard, IME guard, minimal-range host edits, applyEdit failure resync, computeMinimalEdit tests
- [x] PR #38 fix/review-followups-2 — per-document grammar debounce, silent auto-check errors, applyGrammarFix staleness guard (expectedText), cursorOffsets dispose cleanup, startup runCheck catch, fullGraph tag escaping + center-force fix, sidebar scroll preservation, diff.js markdown-it parity, copy-vendor hard failure
- [x] PR #39 chore/remove-askance-and-dep-bumps — remove Askance (CLAUDE.md, .mcp.json, @askance/cli, ignore entries); markdown-it 14.3.0 (+re-vendor), @types bumps, typescript ^5.9.0
- [x] Merge PRs #37 → #38 → #39 → #40 (user granted `gh pr merge` permission)
- [x] Release develop → master (PR #41)
- [x] Publish 0.2.4 to VS Code Marketplace

### Deferred / future work
- [ ] TypeScript 6.x/7.x major upgrade (TS 7 shipped 2026-07-08; let ecosystem settle, land 6.x first)
- [ ] Align @types/node major with the Node version bundled in current VS Code Electron
- [x] Diff viewer renders each hunk through markdown-it independently — multi-line constructs (fenced code, tables) that straddle hunk boundaries render as plain text; needs a hunk-grouping or whole-document render approach — fixed 2026-07-18, PR #46 (`segmentLines()` collapses a fence into one atomic diff unit)
- [ ] fullGraphPanel CSP includes 'unsafe-eval' — confirm force-graph actually needs it, drop if not
- [ ] src/types.ts graph sidebar message types drifted from actual graphViewProvider.ts SidebarMessage protocol — reconcile

## 2026-07-18 review pass (PRs #43–#46)

- [x] Root-cause the WYSIWYG cursor jump for real this time (two prior attempts, PR #24 and PR #37, were both merged but insufficient — see log.md for why)
- [x] PR #43 fix/wysiwyg-cursor-jump — block-anchored caret bookmarks (replaces the global-plain-text-offset scheme from PR #24), empty-guard + IME guard on grammar-highlight refresh, editAck message to close an in-flight-edit race, CRLF whole-document-rewrite fix, stale-lastSentEditText fix
- [x] PR #44 feature/mermaid-and-checkboxes (stacked on #43) — mermaid diagrams render as live SVG in WYSIWYG/split preview (read-only, atomic block, cached by source hash, lossless Turndown round-trip); GFM task-list checkboxes with click-to-toggle; code-review fixes: preprocessWikilinks `$`-pattern corruption, grammar-match wrong-occurrence highlighting, grammar-fix-suggestion lost-to-race bug, sanitizeHtml scheme-check hardening, stale grammar matches on external update
- [x] PR #45 feature/mmd-editor — dedicated forced-split CustomTextEditorProvider for `*.mmd`/`*.mermaid` files (independent of the markdown editor)
- [x] PR #46 feature/diff-fence-atomicity — atomic fenced-code-block diff hunks (`segmentLines()`), "Compare with Saved" now diffs the actual on-disk file instead of HEAD, full `.markdown` extension parity across wikilinks/graph/diff (was `.md`-only in several places despite the editor claiming both)

### Deferred / future work (new)
- [ ] Mermaid diagram rendering in the diff view itself (a changed diagram currently shows as plain fenced-code hunks, not rendered SVG) — needs the shared mermaid vendor files from #44/#45 merged first
- [ ] `.mmd` file diff support (side-by-side rendered old/new diagram) — diff commands aren't yet gated for `.mmd` in package.json menus
- [ ] #44 and #45 both independently vendor `mermaid` as a dependency (built in parallel off develop) — trivial duplicate-addition conflict expected in package.json/package-lock.json when both merge

## 2026-07-19 Mermaid editor overhaul + 1.0.0 (PR #50)

- [x] Capture a behavioral baseline suite of the existing .mmd editor (14 checks) BEFORE changing anything, as an explicit regression contract
- [x] Syntax highlighting in the .mmd source pane (transparent-textarea-over-<pre> overlay; tokenizer extracted to media/mermaidSyntax.js with 26 committed unit tests incl. HTML-injection cases)
- [x] Error-line marking when a diagram fails to parse
- [x] Zoom/pan in the diagram preview, transform preserved across re-renders
- [x] PNG export with light/dark background choice (native QuickPick)
- [x] Print via host -> temp HTML -> external browser (window.print() is suppressed in VS Code webviews)
- [x] Professional diagram restyle + light/dark theming with live theme-switch re-render
- [x] About/brand button on both editor toolbars
- [x] Bump to 1.0.0, add author field, update README/CHANGELOG
- [x] Fable adversarial review; fixed 3 bugs + 4 risks it found (see log.md)

### Deferred / follow-up work
- [ ] PR: Mermaid toolbox (snippet palette, template gallery) + IntelliSense-style autocomplete in the raw view
- [ ] PR: glTF 3D viewer — `.gltf` raw view + three.js preview with zoom/orbit navigation (Fable to design; decide live-rerender-preserving-viewport vs an explicit Update button)
- [ ] Evaluate D2 (`@terrastruct/d2`, MPL-2.0) as a second diagram renderer for architecture diagrams — needs `wasm-unsafe-eval` + `worker-src blob:` CSP additions, ~8MB bundle
- [ ] AVOID PlantUML: core is GPL. An MIT-flavoured `@plantuml/core` build exists but is very new and its MIT-ness depends on the maintainer gating GPL paths each release — unacceptable risk given the intent to keep commercial options open
- [ ] Clickable/editable mermaid diagrams in the markdown WYSIWYG view (currently read-only by design — Turndown round-trip would mangle an editable SVG)

## 2026-07-19 Mermaid authoring assistance (PR #51)

- [x] `media/mermaidCompletions.js` — templates, context-aware snippet palette, node-id scanner, completion engine (UMD, unit-testable) + 28 committed tests
- [x] Template gallery: 8 starter diagrams (flowchart, sequence, class, state, ER, gantt, pie, mindmap) with placeholder selection
- [x] Context-aware snippet palette that follows the detected diagram type
- [x] IntelliSense-style completion overlay: node ids after arrows (the headline feature — a typo'd id silently creates an orphan node in mermaid), diagram types, directions, keywords, arrows
- [x] Regression gate: all 44 pre-existing Playwright checks + 66 unit tests still pass

## 2026-07-19 glTF 3D viewer (PR #52)

- [x] Fable design spec (formats, three.js vendoring, resource resolution, live-vs-Update decision)
- [x] `src/gltfEditorProvider.ts` — `.gltf` split-view editor, document-sync copied from the mermaid provider
- [x] three.js vendored via a second esbuild IIFE bundle (three ships ESM only since r160 — file-copy is not possible)
- [x] Live re-render with `JSON.parse` gate, semantic-identity skip, 2MB size gate + Update button
- [x] Camera preservation across reloads (structural: renderer/scene/camera built once, only the model subtree swaps)
- [x] Full GPU disposal walk (three.js never GCs GPU resources)
- [x] External `.bin`/texture resolution via `asWebviewUri` base + `connect-src` CSP
- [x] `media/gltfViewerMath.js` + 13 unit tests; 6 Playwright checks incl. camera preservation and GPU-leak accounting

### Deferred
- [ ] `.glb` (binary) support — needs a separate `CustomReadonlyEditorProvider`; the viewer half is reusable
- [ ] Draco / KTX2 compressed assets (currently fail with a clear error)
- [ ] Animation playback (animated models load, but don't play)
- [ ] Manual VS Code verification: `LoaderUtils.resolveURL` against real `vscode-resource:` URIs, and `visibilitychange` in a genuinely hidden panel

## 2026-07-20 Activity bar icon + expanded mermaid template dropdown (PR #55)

- [x] Monochrome Advancer 'A' activity-bar icon (media/activity-icon.svg), replacing the generic $(link) codicon — same silhouette as the toolbar brand mark, verified via a CSS-mask simulation of VS Code's icon recoloring
- [x] Researched most-common Mermaid diagram types to prioritize dropdown ordering (flowchart/sequence/class/ER/state confirmed as the daily-use core)
- [x] Expanded the template dropdown from 8 to 22 diagram types (within the "up to 25" budget), covering essentially every official Mermaid diagram type
- [x] Every template body verified with mermaid.parse() against the actual vendored bundle (11.16.0) — 4 of the initial 22 candidates needed quoted identifiers for multi-word names (sequence participants, ER entities, state names) that mermaid's grammar rejects unquoted; caught by empirical validation, not guessed
- [x] All example content rewritten to generic, obviously-editable placeholders (Box 1, Task 2, Entity 1...) instead of domain-flavored content (Customer, Order, Animal...)
- [x] Searchable dropdown (filter input + keyboard nav + scrollable list), mirroring the existing wikilink-picker pattern in editor.js, since 22 items in a plain list would be hard to scan
- [x] Cursor-position-aware template insertion: inserts directly at the caret when it's at the very start/end of the document; when strictly mid-document, asks the host to confirm first (native modal, since confirm() is blocked in webviews) — replaces the previous "replace the whole document" flow entirely
- [x] Fable adversarial review on PR #55; fixed 2 template bugs (sequence alias syntax backwards; 4 templates with a placeholder on a referenced identifier that broke on edit) + 2 UI bugs (keyboard Enter/Space didn't activate a Tab-focused menu item; select-all bypassed the mid-document confirmation) + 1 latent risk (stale menu left open across an external document update) — see log.md for detail

## 2026-07-22 Activity bar icon replaced with a pixel-traced silhouette (v1.1.1)

- [x] The 1.1.0 icon (media/activity-icon.svg) was a hand-drawn approximation that read as a plain hollow triangle rather than an "A" — replaced with a silhouette traced directly from media/icon.png's actual pixels (alpha-thresholded to black/white, then vectorized to straight-edged paths with potrace, rescaled to the 24x24 viewBox), so it's pixel-accurate to the real logo, counter and base included
- [x] Verified with a rendered preview simulating VS Code's activity-bar CSS-mask recoloring at real 24px size before committing, per user request
- [x] Version bumped 1.1.0 -> 1.1.1 (patch)

## 2026-07-22 Mermaid print/openExternal fix + icon-only snippet palette (v1.1.2)

- [x] Print/Save as PDF could fail with a "Get an app to open this vscode-userdata link" error on Windows — the print HTML file's URI could carry a `vscode-userdata:` scheme (from `context.globalStorageUri`) rather than `file:`; fixed by rebuilding via `vscode.Uri.file(file.fsPath)` before `openExternal()`
- [x] Snippet palette (Box, Diamond, Participant, Loop, etc.) changed from text-label buttons to 24x24px icon buttons with title/aria-label tooltips, so the full palette fits on one toolbar row instead of wrapping across 2-3
- [x] Verified with Playwright: icon-only rendering, tooltip carries label+description, layout fits one row, click-to-insert still works, palette still switches per diagram type — plus updated the pre-existing toolbox-tests.js snippet-palette assertions, which read button textContent (now empty, since buttons are icon-only) rather than the title tooltip
- [x] Full regression: 110 unit tests + 89 Playwright checks (25 toolbox + 10 fable-fix + 23 feature + 7 review-fix + 14 behavior + 10 new icon-palette), all green
- [x] Version bumped 1.1.1 -> 1.1.2 (patch)
