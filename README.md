# VS Code MD Editor

A rich Markdown editor extension for Visual Studio Code with split preview, [[wikilinks]], Mermaid diagrams, task checklists, a force-directed link graph, version diff, and LanguageTool grammar checking.

## Features

- **WYSIWYG Editing** — Edit markdown in a rich preview with contenteditable, or switch to split view or raw markdown mode.
- **Mermaid Diagrams** — `\`\`\`mermaid` code fences render as live diagrams in the WYSIWYG/split preview. Diagrams are read-only there (edit the source in Raw/Split mode). A dedicated split-view editor opens `.mmd`/`.mermaid` files directly, with **syntax highlighting**, **error-line marking**, **zoom and pan**, **PNG / print (Save as PDF) export**, and **authoring help** (template gallery, snippet palette, and node-ID completions) — all themed to match VS Code's light or dark theme.
- **3D Model Viewer** — open a `.gltf` file to get its JSON source alongside a live 3D preview rendered with three.js, with orbit, pan and zoom. The preview updates as you edit and keeps your camera position.
- **Word and Excel Viewers** — `.docx` and `.xlsx` files open in a read-only viewer: paged Word documents and a scrollable, styled Excel grid, themed to match VS Code. Nothing is ever written to the file.
- **Task Checklists** — GFM `- [ ] task` / `- [x] task` checkboxes render as clickable checkboxes in the preview and toggle directly in the markdown source. Handy for spec-driven workflows (e.g. GitHub Spec Kit `tasks.md` files).
- **Toolbar** — Quick-access buttons for bold, italic, headings, links, images, code blocks, lists, and blockquotes.
- **[[Wikilinks]]** — Link between markdown files using `[[filename]]` or `[[filename|display text]]` syntax (Obsidian-compatible) with autocomplete suggestions.
- **Markdown Links Sidebar** — File list showing all markdown files with their incoming/outgoing links, plus a "Show Graph" button.
- **Interactive Link Graph** — Full-screen force-directed graph with Obsidian-style controls (filters, display options, force tuning), drag-to-pin, and zoom.
- **LanguageTool Integration** — Grammar and spelling checking powered by LanguageTool, with inline highlights and quick-fix suggestions. Works with the free API or a Premium account.
- **Version Diff** — Compare your markdown file against previous git commits in a rendered diff viewer with green/red change highlighting. Fenced code blocks (including Mermaid diagrams) always diff as a whole block, never split mid-fence.
- **Rename Propagation** — Renaming a `.md`/`.markdown` file automatically updates all wikilink references across your workspace.

**Requires VS Code 1.95 or newer** (October 2024). The PDF viewer relies on browser features that older VS Code builds do not have.

## Installation

### From VS Code Marketplace

Search for **VS Code MD Editor** in the Extensions panel, or install from the command line:

```
code --install-extension advancer.vscode-md-editor
```

### From Source

```bash
git clone https://github.com/Advancer-Limited/vscode-md-editor.git
cd vscode-md-editor
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Usage

1. Open any `.md` file and select **"VS Code MD Editor"** from the editor picker (or right-click the file and choose **Open with VS Code MD Editor**).
2. Use the toolbar to format text, or write markdown directly in the textarea.
3. Type `[[` to get autocomplete suggestions for linking to other markdown files.
4. Open the **Markdown Links** sidebar to see backlinks and the link graph.
5. Press **Ctrl+F** (find) or **Ctrl+H** (find and replace) — **Cmd** on macOS — to search the document, with an optional case-sensitive match. In Edit mode it searches the rendered text; in Raw/Split it searches the markdown source.

### Mermaid Diagrams

Write a `\`\`\`mermaid` fenced code block and it renders as a live diagram wherever the preview is visible (WYSIWYG or Split). The rendered diagram is read-only — click into Raw or Split mode to edit its source, and the preview updates as you type. Invalid syntax shows an inline error without losing the last valid render.

Opening a `.mmd` or `.mermaid` file directly uses a dedicated split-view editor (source on the left, live diagram on the right) with:

- **Syntax highlighting** for Mermaid keywords, arrows, node shapes, edge labels and comments.
- **Error highlighting** — when a diagram fails to parse, the offending source line is marked alongside the error message.
- **Zoom and pan** — Ctrl/Cmd+scroll zooms about the pointer, drag to pan, and the toolbar has zoom in/out, 100%, and fit-to-view. Your view is kept as you type, so zooming into part of a large diagram doesn't reset on every edit.
- **Export as PNG** — choose a light or dark background; the light option re-renders for a white background so it stays readable in documents and slides.
- **Print / Save as PDF** — opens the diagram in your browser, where the print dialog's "Save as PDF" destination is available.

Diagrams follow your VS Code light or dark theme and re-render automatically when you switch themes.

### Task Checklists

`- [ ] some task` and `- [x] done task` lines render as checkboxes in the preview. Click a checkbox to toggle it — the change is written straight back to the markdown source as `[ ]`/`[x]`.

### Writing Mermaid Diagrams

The `.mmd` editor helps you write diagrams rather than just render them:

- **Template** — a searchable dropdown of 22 starter diagrams covering nearly every Mermaid diagram type (flowchart, sequence, class, state, ER, gantt, pie, mind map, user journey, git graph, kanban, timeline, quadrant chart, requirement diagram, C4 context, block, sankey, XY chart, radar, packet, architecture, treemap), each with generic example content (`Box 1`, `Task 2`...) obviously meant to be edited, and the first label pre-selected so you can type straight over it. Inserts at your cursor; if the cursor is in the middle of an existing diagram, you'll be asked to confirm first, since Mermaid only supports one diagram per file.
- **Snippet palette** — the buttons beside Template change with the diagram type you're writing: node shapes and link styles for flowcharts, `participant`/`loop`/`alt` for sequence diagrams, and so on.
- **Completions** — as you type, the editor offers the node IDs already in your diagram (press `Ctrl+Space` to summon them manually). This is the most useful one: in Mermaid a mistyped node ID doesn't produce an error, it quietly creates a stray disconnected node.

### 3D Models (`.gltf`)

Open a `.gltf` file and you'll get the JSON source on the left with a live 3D preview on the right. Drag to orbit, scroll to zoom, right-drag to pan. The preview updates as you edit and **keeps your camera position**, so you don't lose your place while tweaking a model. The toolbar has fit-to-view, reset, wireframe and grid toggles, plus an Update button (used automatically for files over 2 MB, where live updating is disabled).

Models with external `.bin` buffers and textures work as long as those files sit within your workspace folder. Binary `.glb` files aren't supported yet, nor are Draco/KTX2-compressed assets — those report a clear error rather than failing silently.

### Word and Excel viewers (`.docx`, `.xlsx`)

Opening a `.docx` or `.xlsx` file in VS Code shows it in a read-only viewer instead of the "cannot display binary file" message. The viewers never modify the file and never mark it as changed. Editing is coming in a later release.

**Word documents** are drawn as pages, on a themed background, with the document's own colours (a light page even in a dark theme, as a PDF viewer does). You see text and formatting, tables, pictures, headers and footers, footnotes and endnotes, and lists. There is a zoom control (50-200%, Fit width, Ctrl+wheel) and an **Open in Word** button. Use Ctrl+F for VS Code's find, and click `http`, `https` and `mailto` links to open them in your browser (internal `#bookmark` links scroll to their target).

**Excel workbooks** open in a spreadsheet grid with sheet tabs, row and column headers, the file's column widths, row heights, frozen panes and merged cells, and the file's fonts, fills, borders and number, date and currency formats. Formula cells show their saved result and the formula appears in the formula bar; a formula that has never been calculated shows its text marked "Not calculated". Select cells to see Sum, Average and Count in the status bar. Ctrl+F searches the current sheet or all sheets, Ctrl+C copies the selection as tab-separated text, Ctrl+click follows a hyperlink, and Ctrl+PageUp / Ctrl+PageDown switch sheets. Hidden sheets are listed in a menu, and cell notes appear as tooltips.

**Present but not shown.** Some content can't be drawn: tracked changes (the document is shown as if every change were accepted), comments, charts, SmartArt, embedded objects, equations, embedded HTML, macros, and pictures linked from the web in Word; and charts, images, shapes, pivot tables, sparklines, conditional formatting and data validation in Excel. A notice bar names what is there but not displayed. All of it stays in the file untouched; the viewer only reads.

**Limits.** Very large files are cut back: an Excel sheet over 500,000 cells shows its first 50,000 rows with a banner, and files over 250 MB are refused. Password-protected files, files that are really the older `.doc`/`.xls` format, Office lock files (`~$name.docx`), empty files and damaged files each show an explanation with an **Open in Word/Excel** button; the viewer never tries to repair or decrypt a file.

**Known limitations.**

- Word pages follow the document's explicit page and section breaks. The viewer does not re-paginate like Word, so page numbers and page counts can differ from Word.
- Word headings are displayed with the document's formatting, but are not yet announced as headings, with their level, by screen readers. This arrives with editing.
- Excel numbers and dates are formatted in US English regardless of your locale. Rotated text, gradient and pattern fills, rich text inside a cell, and zoom are not supported.
- `.doc`, `.xls`, `.xlsm`, `.csv`, `.pptx` and other Office formats are not handled.

**Switching to another editor.** The viewers become the default for `.docx` and `.xlsx`. To open a file with something else just once, right-click the tab and choose **Reopen Editor With...**, or right-click the file in the Explorer and choose **Open With...**; pick **Configure default editor for '*.docx'...** there to change it permanently. Or set it in `settings.json` (for example `"default"` for VS Code's built-in handling, or another extension's editor id):

```json
"workbench.editorAssociations": {
  "*.docx": "default",
  "*.xlsx": "default"
}
```

**Privacy and trust.** Documents are opened entirely on your machine; no content is uploaded and the viewer makes no network requests, so pictures linked from the web simply appear broken. Documents cannot run code (macros are never executed).

### Comparing Versions

Compare your markdown files against previous git commits:

- **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`):
  - **Compare with Previous Version** — Diff against the most recent commit that changed this file.
  - **Compare with Commit...** — Pick from a list of recent commits with hash, message, author, and date.
  - **Compare with Saved** — Diff your unsaved working changes against the file as it currently is on disk.
- **Right-click** any `.md`/`.markdown` file in the Explorer for quick access to diff commands.

The diff opens in a rendered webview panel with green highlighting for additions and red strikethrough for deletions. Fenced code blocks (including Mermaid diagrams) always diff as a single atomic block, never split across separate hunks.

## Commands

| Command | Description |
| ------- | ----------- |
| `Markdown Editor: Compare with Previous Version` | Diff against the last commit that changed this file |
| `Markdown Editor: Compare with Commit...` | Pick a commit from file history and diff against it |
| `Markdown Editor: Compare with Saved` | Diff working changes against the on-disk saved file |
| `Markdown Editor: Check Grammar with LanguageTool` | Run grammar and spelling check |
| `Markdown Editor: Open with VS Code MD Editor` | Open a `.md` file in the custom editor |
| `Markdown Editor: Show Link Graph` | Focus the Markdown Links sidebar |
| `Markdown Editor: Open Full Graph` | Open the full-screen force-directed link graph |

## Configuration

### LanguageTool Settings

Grammar checking works out of the box with the free LanguageTool API (1500 character limit per request). For unlimited checking, sign up for [LanguageTool Premium](https://languagetool.org/premium) and add your credentials:

| Setting | Default | Description |
|---------|---------|-------------|
| `vscodeMdEditor.languageTool.enabled` | `true` | Enable LanguageTool grammar checking |
| `vscodeMdEditor.languageTool.apiUrl` | `https://api.languagetoolplus.com/v2/check` | API endpoint (change for self-hosted) |
| `vscodeMdEditor.languageTool.apiKey` | `""` | Premium API key (leave empty for free tier) |
| `vscodeMdEditor.languageTool.username` | `""` | Premium username/email (required with API key) |
| `vscodeMdEditor.languageTool.language` | `"auto"` | Language code (e.g., `en-US`, `de-DE`) |
| `vscodeMdEditor.languageTool.motherTongue` | `""` | Your native language code for better error detection |
| `vscodeMdEditor.languageTool.checkDelayMs` | `1500` | Delay (ms) before triggering check after typing |

### Graph Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vscodeMdEditor.graph.defaultMode` | `"local"` | Default graph view: `local` or `global` |
| `vscodeMdEditor.graph.localDepth` | `1` | BFS depth for local graph (1-3 hops) |

### Office Viewer Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vscodeMdEditor.office.sheetAppearance` | `"theme"` | How Excel sheets are drawn: `theme` follows the VS Code color theme, `light` always shows the sheet on a light background as authored (applies to workbooks opened afterwards) |

## Contributing

Contributions are welcome! Please read the guidelines below before submitting a pull request.

### Getting Started

1. Fork the repository on GitHub.
2. Clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/vscode-md-editor.git
   cd vscode-md-editor
   npm install
   ```
3. Create a feature or fix branch from `develop`:
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```
4. Make your changes, then verify:
   ```bash
   npm run compile    # Type-check and build
   ```
5. Commit your changes with a clear message.
6. Push to your fork and open a Pull Request targeting `develop`.

### Branch Workflow

- **`master`** — Stable releases only. PRs from `develop` after testing.
- **`develop`** — Integration branch. All feature/fix PRs target this branch.
- **`feature/*`** / **`fix/*`** — Short-lived branches for individual changes.

### PR Guidelines

- Keep PRs focused on a single change or feature.
- Include a clear description of what changed and why.
- Ensure `npm run compile` passes before submitting.
- New features should follow existing patterns in the codebase.
- By submitting a PR, you agree to the [Contributor License Agreement](CLA.md).

## License

This project is licensed under the [MIT License](LICENSE).

Copyright (c) 2026 Advancer Limited
