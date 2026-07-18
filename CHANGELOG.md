# Changelog

All notable changes to the VS Code MD Editor extension will be documented in this file.

## [0.3.0] - 2026-07-18

### Added

- **Mermaid diagrams** — `\`\`\`mermaid` fences render as live diagrams in the WYSIWYG/split preview (read-only there — edit the source in Raw/Split mode). Rendered SVG is cached so unrelated re-renders don't re-invoke Mermaid, and invalid syntax shows an inline error while keeping the last valid render.
- **`.mmd`/`.mermaid` editor** — opening a Mermaid source file directly now uses a dedicated forced-split editor (source + live preview), independent of the markdown editor.
- **Task checklists** — GFM `- [ ] task` / `- [x] task` render as clickable checkboxes in the preview and toggle back to `[ ]`/`[x]` in the markdown source.
- Diff view and the markdown editor now fully support `.markdown` (not just `.md`) — wikilinks, the file index/graph, and diff commands all recognize it.

### Fixed

- **WYSIWYG cursor jump, for real this time.** The caret position was tracked as a single character offset across the whole preview, which is ambiguous exactly at block boundaries (e.g. right after pressing Enter into a new empty paragraph) — the most common case where earlier fixes (0.2.1, 0.2.4) had already reduced *how often* a caret restore ran, but not the underlying offset math. Replaced with a block-anchored position that removes the ambiguity structurally.
- A debounced webview edit still in flight to the extension host could be silently overwritten by a stale update racing it.
- CRLF-line-ending files had their entire body rewritten on the very first keystroke.
- **"Compare with Saved" was actually comparing against the last commit (HEAD), not the saved file** — now correctly diffs against what's on disk.
- The diff viewer no longer splits a fenced code block (including a Mermaid diagram) across separate hunks when only an interior line changed — a changed block now always renders as one complete removed block plus one complete added block.
- A code block containing a shell-style `$(...)` or similar could corrupt neighboring preview text due to a `String.replace()` special-pattern interpretation bug.
- Grammar-check highlighting could mark (and apply a suggested fix to) the wrong occurrence of a repeated phrase.
- A clicked grammar-fix suggestion could be silently lost if another edit was in flight at the same moment.
- Hardened the preview's HTML sanitizer against case variation and embedded control characters in `javascript:`-style URLs, and extended the check beyond `href` to `src`/`xlink:href`/`formaction`/`poster`.

## [0.2.4] - 2026-07-09

### Fixed

- **WYSIWYG: cursor no longer jumps or loses focus while typing.** Automatic grammar checks were rebuilding the editable preview mid-typing; highlights now refresh in place without re-rendering, document updates that would clobber pending keystrokes are skipped, and IME composition is no longer interrupted.
- Edits are applied to the document as a minimal ranged edit instead of a whole-document replace (granular undo, no cursor/scroll disturbance in a parallel raw editor); a rejected edit resyncs the webview instead of silently diverging.
- Grammar: per-document check debouncing (edits in one file no longer cancel another file's pending check); automatic checks fail silently instead of spamming warnings when the API is unreachable; quick fixes verify the target text hasn't shifted before replacing.
- Graph: "Center force" toggle actually re-enables the force; node tooltip escapes tag text; sidebar list keeps its scroll position when expanding/collapsing.
- Diff viewer renders line breaks, links, and typography the same way as the editor.

### Changed

- Updated markdown-it to 14.3.0; removed the obsolete Askance tooling and its dependency.
- Vendor-file copy step now fails the build loudly if a webview library is missing.

## [0.2.3] - 2026-06-17

### Fixed

- Grammar highlights: skip text already wrapped in a highlight so a repeated phrase advances to its next un-highlighted occurrence instead of re-marking the first.
- LanguageTool: add a request timeout so a hung upstream after the tunnel is established no longer leaves the request pending forever.
- Editor: replace the boolean edit guard with a depth counter so overlapping edits from fast typing don't clear the echo-suppression guard early.
- Rename propagation: don't rewrite `[[wikilink]]` references when another file owns the stem's resolution; share a single whitespace-tolerant, regex-safe stem matcher.

### Added

- Unit tests for the wikilink stem matcher used by rename propagation.

## [0.2.2] - 2026-06-16

### Fixed

- Preserve table formatting when editing tables in WYSIWYG mode (#29).
- Keep `[[wikilink|alias]]` syntax intact when used inside a table cell.
- Use a cryptographically secure nonce for the webview Content Security Policy.
- File index: debounce per-document so rapid edits across files aren't dropped; index files changed during the initial workspace scan.
- Bound memory/time of the version-diff algorithm on large files.

### Added

- Unit test suite (`npm test`) covering the table round-trip and diff algorithm.

## [0.2.1] - 2026-06-16

### Fixed

- Prevent cursor jump in WYSIWYG mode during editing (#24).

## [0.2.0] - 2026-03-13

### Added

- **Version Diff** — Compare markdown files against previous git commits in a rendered diff viewer.
  - "Compare with Previous Version" — diff against the most recent commit (smart: HEAD if uncommitted changes, else HEAD~1).
  - "Compare with Commit..." — pick from a list of recent commits (QuickPick with hash, message, author, date).
  - "Compare with Saved" — diff working changes against HEAD.
  - Right-click context menu entries for `.md` files in the Explorer.
  - Custom webview panel renders both versions through markdown-it with green/red diff highlighting.

## [0.1.1] - 2026-02-24

### Fixed

- Added marketplace icon.
- Updated `.gitignore`.

## [0.1.0] - 2026-02-24

### Added

- WYSIWYG editing with contenteditable preview, split view, and raw markdown modes.
- Toolbar with formatting buttons (bold, italic, headings, links, images, code, lists, quotes).
- `[[Wikilinks]]` with autocomplete suggestions and preview rendering.
- Markdown Links sidebar with file list and incoming/outgoing link display.
- Full-screen force-directed link graph with Obsidian-style controls.
- LanguageTool grammar and spelling integration with inline highlights and quick-fix suggestions.
- Rename propagation — renaming a `.md` file updates all wikilink references.
- Real-time incremental grammar checking (paragraph-level on edit).
