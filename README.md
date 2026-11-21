# MD Editor & Office Viewer: Markdown, Word, Excel, PDF

One extension for the documents you work with every day. Write rich **Markdown**, edit **Word** and **Excel** files, and read **PDFs** without leaving VS Code, with Mermaid diagrams, a 3D model viewer, grammar checking and a link graph built in.

## Highlights

- **Markdown, the way you want to work.** Edit in a rich WYSIWYG view, a split preview, or plain raw Markdown, with a formatting toolbar, task checklists, find and replace, and print to PDF.
- **Word documents (`.docx`).** View documents as pages, then edit text in paragraphs and table cells, apply bold, italic, underline, headings, lists and indentation, and save. Everything you do not touch stays exactly as it was.
- **Excel workbooks (`.xlsx`).** A real spreadsheet grid with sheet tabs and a formula bar. Edit cells, keep your formulas (with their saved results), enter dates, copy and paste, insert and delete rows and columns, and add, rename or delete sheets.
- **PDF viewer (`.pdf`).** Smooth scrolling, zoom, thumbnails, bookmarks, attachments, find, copy, password-protected files and document properties.
- **Mermaid diagrams.** Live diagrams inside Markdown, plus a dedicated editor for `.mmd` files with syntax highlighting, templates, zoom and PNG export.
- **3D models (`.gltf`).** Source on one side, an interactive 3D preview on the other.
- **Grammar and spelling.** Inline checking and one-click fixes, powered by LanguageTool.
- **Wikilinks and a link graph.** Link notes with `[[double brackets]]`, see backlinks, and explore your notes as an interactive graph.
- **Version comparison.** See what changed in a Markdown file against earlier Git versions.

## Getting started

1. Install the extension from the VS Code Marketplace, or run `code --install-extension advancer-limited.vscode-md-editor`.
2. Open a file. `.md`, `.markdown`, `.mmd`, `.mermaid`, `.gltf`, `.docx`, `.xlsx` and `.pdf` files open in this extension's editors automatically.
3. Word and Excel files open in **View** mode so that looking at a file never changes it. Click **Edit** in the toolbar (or press **Ctrl+E**, **Cmd+E** on macOS) to start editing, then save as usual with Ctrl+S.

The Activity Bar icon (the Advancer "A") opens the **MD & MMD Editor** sidebar, which lists your Markdown and Mermaid files, with backlinks and a button for the link graph.

**Requires VS Code 1.95 or newer.**

## How to use

### Markdown

Open any `.md` file. Use the toolbar for bold, italic, headings, links, images, code, lists and quotes, and switch between **Edit** (rich view), **Split** and **Raw** at any time.

- **Find and replace:** Ctrl+F to find, Ctrl+H to replace (Cmd on macOS), with a case-sensitive option, match count and Enter / Shift+Enter / F3 to step through matches.
- **Task checklists:** `- [ ]` and `- [x]` lines show as checkboxes. Click one to tick it; the Markdown is updated for you.
- **Print or save as PDF:** use the Print button on the toolbar.
- **Compare versions:** right-click a Markdown file in the Explorer, or use the Command Palette, and choose **Compare with Previous Version**, **Compare with Commit...** or **Compare with Saved**. Changes are highlighted in green and red on the rendered page.

### Wikilinks and the link graph

In the **Raw** or **Split** view, type `[[` to link to another Markdown file and pick it from the autocomplete list. In the **Edit** view, use the **Insert Link** button on the toolbar to choose the file. Use `[[file|display text]]` to show different text. Renaming a file updates its links across your workspace.

The **MD & MMD Editor** sidebar lists your Markdown files (with their incoming and outgoing links) and your Mermaid files. Its **Show Graph** button, or the **Open Full Graph** command, opens an interactive link graph with filters, display options and drag-to-pin.

### Word documents

Word files open as pages. Zoom from 50% to 200% (Ctrl+= and Ctrl+-, or Fit width), search with Ctrl+F, and click links to open them. Press **Edit** (Ctrl+E) to change the document:

- Click a paragraph, or a paragraph inside a table cell, and type.
- Ctrl+B, Ctrl+I and Ctrl+U for bold, italic and underline.
- Ctrl+Alt+1 to 6 for Heading 1 to 6, Ctrl+Alt+0 for normal text.
- Ctrl+Shift+8 for a bullet list, Ctrl+Shift+7 for a numbered list. Tab and Shift+Tab at the start of a list item change its level; in a table they move to the next or previous cell.
- Enter splits a paragraph; Shift+Enter inserts a line break.
- Undo and redo (Ctrl+Z, Ctrl+Y) work as they do anywhere else in VS Code.

Some parts of a document are shown but cannot be edited here: table structure, text boxes, headers and footers, footnotes, and hyperlink text. They are left untouched in the file. Content that cannot be drawn (such as charts, SmartArt and equations) is listed in a notice at the top, and it is always kept when you save. Use **Open in Word** for anything the editor cannot do.

### Excel workbooks

Workbooks open in a spreadsheet grid with sheet tabs, a formula bar, and the file's own fonts, colours, borders, merged cells and number, date and currency formats. Select cells to see Sum, Average and Count in the status bar. Press **Edit** (Ctrl+E) to change the workbook:

- Press F2, Enter, or just start typing to edit a cell. Enter and Tab commit and move; Esc cancels; Delete clears.
- Formulas stay formulas and keep their last calculated result. Type a date and it is stored as a real date.
- Copy and paste between cells and other applications (Ctrl+C, Ctrl+V).
- Right-click a row or column header to insert or delete rows and columns. Right-click a sheet tab to add, rename or delete a sheet.
- Ctrl+F searches the current sheet or all sheets. Ctrl+PageUp and Ctrl+PageDown switch sheets.

When you insert or delete rows, columns or sheets, the extension asks before making a change that cannot fully update everything that refers to it, such as charts and pivot tables. You can turn this prompt off in Settings. Deleting a sheet always asks.

Formulas are not recalculated here, so open the file in Excel to refresh results after changing values that formulas depend on.

### PDF files

PDFs open in a viewer that scrolls continuously and follows your VS Code theme.

- **Zoom** from 25% to 500%, Fit width, Fit page and Actual size (Ctrl+wheel, Ctrl+=, Ctrl+-, Ctrl+0).
- **Go to a page** with the page box (Ctrl+G). Rotate the view with **R** (the file is not changed).
- **Sidebar** (F4): thumbnails, the document's bookmarks and attached files, which you can save with **Save as...**. A document properties dialog shows the title, author and more.
- **Find** with Ctrl+F (Enter, Shift+Enter or F3 for next and previous), with match case and whole word options. **Copy** selected text with Ctrl+C.
- **Password-protected files** ask for the password. It is kept in memory only and is never stored.
- Links to web and mail addresses open in your browser; links inside the document jump to their target.

Scripts inside a PDF are never run. Scanned PDFs without a text layer can be read but not searched or copied from. Digital signatures are shown but not verified.

### Mermaid diagrams

In Markdown, a `mermaid` code fence renders as a live diagram in the Edit and Split views. Open a `.mmd` or `.mermaid` file for the dedicated editor: source on the left, diagram on the right.

- Syntax highlighting, and the line with an error is marked.
- Zoom and pan (Ctrl+scroll to zoom, drag to pan), fit to view, and export to PNG with a light or dark background, or print and save as PDF.
- A **Template** gallery of 22 starter diagrams, a snippet palette that changes with the diagram type, and completion of node names as you type (Ctrl+Space).

### 3D models

Open a `.gltf` file to see its JSON on the left and a live 3D view on the right. Drag to orbit, scroll to zoom, right-drag to pan. The view keeps your camera position as you edit, and the toolbar has fit, reset, wireframe and grid buttons. Models that use separate `.bin` or texture files work when those files are inside your workspace. Binary `.glb` files are not supported.

### Grammar and spelling

Checking runs automatically as you type in the Markdown editor, with inline highlights and quick fixes. Run **Markdown Editor: Check Grammar with LanguageTool** from the Command Palette to check on demand. The free service checks up to 1,500 characters at a time; add a [LanguageTool Premium](https://languagetool.org/premium) account (or your own LanguageTool server) in Settings for more.

## Choosing a different editor for a file type

You decide which editor opens each kind of file.

- **Everything in one place:** run **Markdown Editor: Choose Editors for Office and PDF Files...** from the Command Palette. For Word, Excel and PDF files, pick this extension, VS Code's default editor, or automatic selection.
- **Just this once:** right-click the tab and choose **Reopen Editor With...**, or right-click the file in the Explorer and choose **Open With...**.
- **By hand:** set `workbench.editorAssociations` in your settings, for example:

```json
"workbench.editorAssociations": {
  "*.docx": "default",
  "*.xlsx": "default",
  "*.pdf": "default"
}
```

## Settings

Open Settings and search for **VS Code MD Editor**.

### Word, Excel and PDF

| Setting | Default | What it does |
| ------- | ------- | ------------ |
| `vscodeMdEditor.office.startInEditMode` | `false` | Open Word and Excel files with Edit already on. When off, files open in View mode and Edit (Ctrl+E) turns editing on. |
| `vscodeMdEditor.office.confirmStructuralEdits` | `true` | Ask before inserting or deleting Excel rows, columns or sheets when the change cannot fully update charts, pivot tables or drawings. Deleting a sheet always asks. |
| `vscodeMdEditor.office.sheetAppearance` | `theme` | `theme` draws Excel sheets to match your VS Code theme; `light` always shows a light sheet, as authored. Applies to workbooks opened afterwards. |
| `vscodeMdEditor.pdf.defaultZoom` | `auto` | Zoom when a PDF opens: `auto`, `page-width`, `page-fit` or `actual`. A zoom you set while viewing is remembered for that tab. |

### Grammar checking

| Setting | Default | What it does |
| ------- | ------- | ------------ |
| `vscodeMdEditor.languageTool.enabled` | `true` | Turn grammar and spelling checking on or off. |
| `vscodeMdEditor.languageTool.language` | `auto` | Language to check, such as `en-US` or `de-DE`, or `auto` to detect it. |
| `vscodeMdEditor.languageTool.motherTongue` | empty | Your first language, for better detection of common mistakes. |
| `vscodeMdEditor.languageTool.checkDelayMs` | `1500` | How long to wait after you stop typing before checking. |
| `vscodeMdEditor.languageTool.apiUrl` | `https://api.languagetoolplus.com/v2/check` | LanguageTool address. Change it to use your own server. |
| `vscodeMdEditor.languageTool.apiKey` | empty | LanguageTool Premium API key. |
| `vscodeMdEditor.languageTool.username` | empty | LanguageTool Premium account email (needed with an API key). |

### Notes and graph

| Setting | Default | What it does |
| ------- | ------- | ------------ |
| `vscodeMdEditor.exclude` | `node_modules`, `.git`, `.claude/worktrees` | Folders the file lists and the link graph should ignore. Your `files.exclude` and `search.exclude` settings are respected too. |

## Commands

Open the Command Palette (Ctrl+Shift+P, Cmd+Shift+P on macOS) and type **Markdown Editor**.

| Command | What it does |
| ------- | ------------ |
| Choose Editors for Office and PDF Files... | Pick which editor opens Word, Excel and PDF files |
| Open with VS Code MD Editor | Open a Markdown file in this editor |
| Set VS Code MD Editor as Default for .md and .markdown Files | Make this the default Markdown editor |
| Check Grammar with LanguageTool | Check the current document now |
| Compare with Previous Version / Compare with Commit... / Compare with Saved | Show what changed in a Markdown file |
| Show Link Graph | Show the MD & MMD Editor sidebar |
| Open Full Graph | Explore your notes as an interactive graph |

## Privacy

- **Your files stay on your machine.** Word, Excel and PDF files are opened and saved locally. Nothing is uploaded.
- **The viewers load nothing from the internet.** Pictures that a document links from the web will not appear.
- **Scripts in documents never run.** Macros in Office files and JavaScript in PDFs are never executed.
- **Grammar checking sends the text being checked** to the LanguageTool service (or the server you set). Turn it off with `vscodeMdEditor.languageTool.enabled`, or point it at your own server, if your documents are sensitive.

## Requirements

VS Code 1.95 (October 2024) or newer.

## Support and feedback

Found a problem or have an idea? Please [open an issue](https://github.com/Advancer-Limited/vscode-md-editor/issues). Include your VS Code version and, if you can, a sample file. See the [change log](CHANGELOG.md) for what is new in each release.

Want to build the extension or contribute? See [CONTRIBUTING.md](https://github.com/Advancer-Limited/vscode-md-editor/blob/master/CONTRIBUTING.md).

## Licence

Released under the [MIT License](LICENSE). Copyright (c) 2026 Advancer Limited.
