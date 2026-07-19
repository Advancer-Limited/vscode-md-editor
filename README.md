# VS Code MD Editor

A rich Markdown editor extension for Visual Studio Code with split preview, [[wikilinks]], Mermaid diagrams, task checklists, a force-directed link graph, version diff, and LanguageTool grammar checking.

## Features

- **WYSIWYG Editing** — Edit markdown in a rich preview with contenteditable, or switch to split view or raw markdown mode.
- **Mermaid Diagrams** — `\`\`\`mermaid` code fences render as live diagrams in the WYSIWYG/split preview. Diagrams are read-only there (edit the source in Raw/Split mode). A dedicated split-view editor opens `.mmd`/`.mermaid` files directly, with **syntax highlighting**, **error-line marking**, **zoom and pan**, and **PNG / print (Save as PDF) export** — all themed to match VS Code's light or dark theme.
- **Task Checklists** — GFM `- [ ] task` / `- [x] task` checkboxes render as clickable checkboxes in the preview and toggle directly in the markdown source. Handy for spec-driven workflows (e.g. GitHub Spec Kit `tasks.md` files).
- **Toolbar** — Quick-access buttons for bold, italic, headings, links, images, code blocks, lists, and blockquotes.
- **[[Wikilinks]]** — Link between markdown files using `[[filename]]` or `[[filename|display text]]` syntax (Obsidian-compatible) with autocomplete suggestions.
- **Markdown Links Sidebar** — File list showing all markdown files with their incoming/outgoing links, plus a "Show Graph" button.
- **Interactive Link Graph** — Full-screen force-directed graph with Obsidian-style controls (filters, display options, force tuning), drag-to-pin, and zoom.
- **LanguageTool Integration** — Grammar and spelling checking powered by LanguageTool, with inline highlights and quick-fix suggestions. Works with the free API or a Premium account.
- **Version Diff** — Compare your markdown file against previous git commits in a rendered diff viewer with green/red change highlighting. Fenced code blocks (including Mermaid diagrams) always diff as a whole block, never split mid-fence.
- **Rename Propagation** — Renaming a `.md`/`.markdown` file automatically updates all wikilink references across your workspace.

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
