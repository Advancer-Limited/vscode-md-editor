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
