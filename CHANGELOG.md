# Changelog

All notable changes to the VS Code MD Editor extension will be documented in this file.

## [Unreleased]

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
