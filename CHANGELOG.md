# Changelog

What's new in MD Editor & Office Viewer, release by release.

## [1.6.0] - 2026-11-21

Word, Excel and PDF files now open right inside VS Code. Edit your Word documents and Excel workbooks, and read PDFs, without leaving your editor.

### Added

- **Edit Word documents.** Open a `.docx` file as pages, press **Edit** (Ctrl+E), and change text in paragraphs and table cells. Apply bold, italic, underline, headings, bullet and numbered lists, and indentation. Undo and redo work as usual, and everything you do not touch is saved exactly as it was.
- **Edit Excel workbooks.** Open an `.xlsx` file in a spreadsheet grid with sheet tabs and a formula bar, then edit cells, keep your formulas with their saved results, enter dates, and copy and paste. Insert and delete rows and columns, and add, rename or delete sheets. You are asked before any change that cannot fully update charts, pivot tables or drawings (see the new `confirmStructuralEdits` setting).
- **View Word and Excel files.** Word documents are drawn as pages with tables, pictures, headers and footers, footnotes and lists, plus zoom and a link to open the file in Word. Excel workbooks keep their fonts, colours, borders, merged cells and number, date and currency formats, with Sum, Average and Count shown for selected cells, find across sheets and hyperlinks. Content that cannot be shown is listed in a notice and is always kept when you save.
- **View PDFs.** Smooth scrolling, zoom from 25% to 500% (Fit width, Fit page, Actual size), a page box, and view rotation. The sidebar shows thumbnails, bookmarks and attached files (save them with **Save as...**), and a document properties dialog is included. Find text with a match count, copy text, and follow links. Password-protected files ask for the password. Scripts in a PDF never run.
- **Files open in View mode by default.** Click **Edit** or press **Ctrl+E** to start editing. To start in Edit mode instead, turn on the new `vscodeMdEditor.office.startInEditMode` setting.
- **Choose Editors for Office and PDF Files...** command: pick, for Word, Excel and PDF files, whether this extension, VS Code's default editor or automatic selection opens them. **Open With...** and `workbench.editorAssociations` work too.
- **New settings:** `vscodeMdEditor.office.startInEditMode`, `vscodeMdEditor.office.confirmStructuralEdits`, `vscodeMdEditor.office.sheetAppearance` (follow your VS Code theme, or always show a light sheet) and `vscodeMdEditor.pdf.defaultZoom`.
- A clear message, with a button to open the file elsewhere, for files that cannot be shown: password-protected Office files, older `.doc` and `.xls` files, damaged files and empty files.

### Improved

- Word, Excel and PDF viewers follow your VS Code theme, including high-contrast themes, and work with the keyboard and screen readers.
- Files stay on your machine: the viewers load nothing from the internet, and macros and scripts in documents are never run.

### Changed

- **VS Code 1.95 (October 2024) or newer is now required**, up from 1.85.

## [1.5.0] - 2026-10-13

### Added

- **Find and Replace in the Markdown editor.** Press **Ctrl+F** to find or **Ctrl+H** to find and replace (Cmd on macOS), or use the new toolbar button. Includes a case-sensitive option, a match count, next and previous (Enter, Shift+Enter, F3), Replace and Replace All. In Edit mode it searches the text as you see it, without moving your cursor; in Raw and Split it searches the Markdown source.

### Improved

- Updated Mermaid to version 12 and refreshed other bundled components.

## [1.4.0] - 2026-07-26

### Added

- **Refresh button on both sidebar tabs** to rescan your files on demand. It is rarely needed now, but helps with network and remote drives, folders excluded from file watching, and very large projects.

### Fixed

- **New files appear in the sidebar straight away.** Files added outside VS Code, such as from a terminal, a Git checkout or a script, used to show up only after reloading the window. Deleted files are noticed too.
- **Links in files created by other programs are picked up** once their content is written, so they appear in backlinks and the graph. Files rewritten outside VS Code are noticed too.

## [1.3.2] - 2026-07-26

### Added

- **New `vscodeMdEditor.exclude` setting** to choose folders the file lists and link graph ignore. It defaults to `node_modules`, `.git` and `.claude/worktrees`, and your `files.exclude` and `search.exclude` settings are respected as well.
- **Same-named files are easy to tell apart** in the flat list: a file whose name is shared by another file (such as several `README.md` files) shows its folder path in dimmed text.

### Fixed

- **Copies of your project inside your project are no longer listed.** Tools that create a working copy under your project folder (such as the git worktrees Claude Code creates in `.claude/worktrees`) caused every document to appear once per copy, and could make a `[[wikilink]]` open the copy instead of the real file.

## [1.3.1] - 2026-07-26

### Fixed

- **The sidebar Markdown list shows each file exactly once.** Files used to reappear as sub-rows under other files, which looked like duplicates. Link exploration lives in the interactive graph.
- **The flat view is strictly alphabetical.** The active file keeps its highlight but no longer jumps to the top.

## [1.3.0] - 2026-07-23

### Added

- **Print or save as PDF from the Markdown editor.** A new Print button opens the rendered document, including Mermaid diagrams, in your browser where Print and "Save as PDF" work properly.

### Improved

- **The sidebar flat view is a plain alphabetical file list**; switch to folder view to see where a file lives.
- **Sidebar tabs have icons.** "Markdown Links" is now just "Markdown", and the panel header reads "MD & MMD Editor".
- **Toolbar buttons use icons with tooltips** (link, image, code, code block, lists, quote, horizontal rule and print), saving space.

### Fixed

- A document opened through a differently-cased file path could appear twice in the sidebar.

## [1.2.0] - 2026-07-22

### Added

- **A Mermaid tab in the sidebar** listing every `.mmd` and `.mermaid` file in your workspace, with search.
- **Flat or folder view for each tab.** The folder tree shows only folders that contain matching files. Searching temporarily flattens the list, and each tab remembers its own view.
- **Right-click a folder in folder view** to add a new Markdown or Mermaid file there, or to show the folder in the Explorer.

## [1.1.2] - 2026-07-22

### Improved

- **The Mermaid snippet palette uses icon buttons** with tooltips, so the full set fits on one toolbar row.

### Fixed

- **Print and Save as PDF could fail on Windows** with a "Get an app to open this link" error.

## [1.1.1] - 2026-07-22

### Improved

- **The Activity Bar icon now matches the real logo**, drawn directly from the brand mark.

## [1.1.0] - 2026-07-20

### Added

- **A new Activity Bar icon**: the Advancer "A" in a single colour.
- **22 Mermaid starter templates**, up from 8, covering nearly every diagram type: flowchart, sequence, class, state, ER, Gantt, pie, mind map, user journey, git graph, kanban, timeline, quadrant, requirement, C4, block, Sankey, XY chart, radar, packet, architecture and treemap. The dropdown is searchable.
- **Smarter template insertion.** Templates insert at your cursor instead of replacing the whole file. If your cursor is inside an existing diagram, you are asked first.

## [1.0.0] - 2026-07-19

First stable release.

### Added

- **A better Mermaid editor** for `.mmd` and `.mermaid` files, with syntax highlighting and the failing line marked when a diagram has an error.
- **Zoom and pan** in the diagram preview (Ctrl+scroll to zoom, drag to pan), with zoom in and out, 100% and fit-to-view. Your view is kept as you type.
- **Export diagrams as PNG** with a light or dark background.
- **Print diagrams or save them as PDF.**
- **Refreshed diagram styling** with rounded corners, a cleaner palette and proper light and dark themes that follow VS Code.
- **Mermaid writing help:** a template gallery, a snippet palette that changes with the diagram type, and node-name completion that guards against a mistyped name quietly creating a stray node.
- **3D model editor for `.gltf` files**: the JSON source beside a live 3D preview with orbit, pan and zoom. The view keeps your camera position as you edit, and the toolbar has fit, reset, wireframe and grid buttons. (Binary `.glb` files are not supported.)
- An **About** button on the editor toolbars.

## [0.3.0] - 2026-07-18

### Added

- **Mermaid diagrams in Markdown.** A `mermaid` code fence renders as a live diagram in the Edit and Split views. Invalid syntax shows an inline message while keeping the last good diagram.
- **A dedicated editor for `.mmd` and `.mermaid` files**, with source and live preview side by side.
- **Task checklists.** `- [ ]` and `- [x]` lines show as clickable checkboxes that update your Markdown.
- Version comparison, wikilinks, the file list and the graph now work with `.markdown` files as well as `.md`.

### Fixed

- **The cursor no longer jumps in the Edit view**, including when you press Enter into a new paragraph.
- A change you had just typed could occasionally be overwritten by an older update.
- Files with Windows line endings no longer have their whole body rewritten on the first keystroke.
- **"Compare with Saved" now compares against the file saved on disk**, not the last commit.
- Version comparison no longer splits a code block or Mermaid diagram across separate changes; a changed block shows as one removed block and one added block.
- Code containing `$(...)` or similar could scramble nearby text in the preview.
- Grammar highlights and fixes could land on the wrong occurrence of a repeated phrase, and a clicked fix could be lost if you were typing at the same moment.
- Stronger protection against unsafe links in the preview.

## [0.2.4] - 2026-07-09

### Fixed

- **The cursor no longer jumps or loses focus while you type in the Edit view.** Grammar highlights refresh in place, and typing with an input method is no longer interrupted.
- **Edits are applied more gently**, giving finer-grained undo and no disturbance to a second editor on the same file. A rejected edit now resyncs instead of leaving the view out of step.
- **Grammar checking:** edits in one file no longer cancel another file's pending check, automatic checks stay quiet when the service is unreachable, and fixes check the text has not moved before applying.
- **Graph and sidebar:** the "Center force" toggle works, node tooltips display tag text safely, and the file list keeps its scroll position.
- The version comparison view shows line breaks, links and typography the same way as the editor.

### Improved

- Updated the Markdown engine.

## [0.2.3] - 2026-06-17

### Fixed

- Grammar highlights move on to the next occurrence of a repeated phrase instead of re-marking the first.
- A grammar check no longer hangs forever if the service stops responding.
- Fast typing no longer causes duplicate or lost updates.
- Renaming a file no longer rewrites `[[wikilink]]` references that belong to another file with a similar name.

## [0.2.2] - 2026-06-16

### Fixed

- Table formatting is preserved when you edit tables in the Edit view.
- `[[wikilink|alias]]` links stay intact inside table cells.
- Rapid edits across several files are no longer dropped from the file index, and files changed during the first scan are included.
- Version comparison stays fast on large files.

## [0.2.1] - 2026-06-16

### Fixed

- The cursor no longer jumps while editing in the Edit view.

## [0.2.0] - 2026-03-13

### Added

- **Version comparison.** See what changed in a Markdown file against earlier Git versions, on the rendered page with additions in green and deletions struck through in red.
  - **Compare with Previous Version** compares against the most recent commit that changed the file.
  - **Compare with Commit...** lets you pick from recent commits, with message, author and date.
  - **Compare with Saved** compares against the saved file.
  - Right-click a Markdown file in the Explorer for quick access.

## [0.1.1] - 2026-02-24

### Fixed

- Added the Marketplace icon.

## [0.1.0] - 2026-02-24

First release.

### Added

- Rich Edit view, Split view and Raw Markdown modes.
- A formatting toolbar for bold, italic, headings, links, images, code, lists and quotes.
- `[[Wikilinks]]` with autocomplete suggestions.
- A Markdown sidebar listing files with their incoming and outgoing links.
- A full-screen interactive link graph with filter and display controls.
- Grammar and spelling checking with LanguageTool, with inline highlights and quick fixes, checked as you type.
- Renaming a Markdown file updates all `[[wikilink]]` references to it.
