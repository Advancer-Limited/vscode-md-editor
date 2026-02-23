# VS Code MD Editor

A rich Markdown editor extension for Visual Studio Code with split preview, [[wikilinks]], backlink panel, force-directed link graph, and LanguageTool grammar checking.

## Features

- **Split Editor** — Write markdown in a textarea with live preview side-by-side, or switch to editor-only or preview-only mode.
- **Toolbar** — Quick-access buttons for bold, italic, headings, links, images, code blocks, lists, and blockquotes.
- **[[Wikilinks]]** — Link between markdown files using `[[filename]]` or `[[filename|display text]]` syntax with autocomplete suggestions.
- **Backlink Panel** — See all files that link to the currently active document, with context snippets.
- **Link Graph** — Interactive force-directed graph showing connections between your markdown files. Toggle between local (focused on current file) and global views.
- **LanguageTool Integration** — Grammar and spelling checking powered by LanguageTool, with inline diagnostics and quick-fix suggestions.
- **Rename Propagation** — Renaming a `.md` file automatically updates all wikilink references across your workspace.

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

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `vscodeMdEditor.languageTool.enabled` | `true` | Enable LanguageTool grammar checking |
| `vscodeMdEditor.languageTool.apiUrl` | `https://api.languagetoolplus.com/v2/check` | LanguageTool API endpoint |
| `vscodeMdEditor.languageTool.apiKey` | `""` | Premium API key (leave empty for free tier) |
| `vscodeMdEditor.languageTool.language` | `"auto"` | Language code (e.g., `en-US`, `de-DE`) |
| `vscodeMdEditor.languageTool.checkDelayMs` | `1500` | Delay before triggering grammar check after typing |
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
