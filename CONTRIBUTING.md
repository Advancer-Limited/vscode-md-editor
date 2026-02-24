# Contributing to VS Code MD Editor

Thank you for your interest in contributing! This document explains how to get started.

## Code of Conduct

Be respectful and constructive. We want this to be a welcoming project for everyone.

## How to Contribute

### Reporting Bugs

- Open an [issue](https://github.com/Advancer-Limited/vscode-md-editor/issues) with steps to reproduce.
- Include your VS Code version and OS.

### Suggesting Features

- Open an issue with a clear description of the feature and its use case.

### Submitting Code

1. **Fork** the repository on GitHub.
2. **Clone** your fork and install dependencies:
   ```bash
   git clone https://github.com/<your-username>/vscode-md-editor.git
   cd vscode-md-editor
   npm install
   ```
3. **Branch** from `develop`:
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-change   # or fix/my-fix
   ```
4. **Develop** your changes. The project structure:
   - `src/` — TypeScript extension source code
   - `media/` — Webview HTML, CSS, and JavaScript
   - `scripts/` — Build helper scripts
5. **Verify** your changes build cleanly:
   ```bash
   npm run compile
   ```
6. **Commit** with a clear, descriptive message.
7. **Push** to your fork and open a **Pull Request** targeting `develop`.

### PR Requirements

- Target the `develop` branch (not `master`).
- One logical change per PR.
- `npm run compile` must pass.
- Follow existing code style and patterns.
- Describe what you changed and why in the PR description.

## Development Setup

### Prerequisites

- Node.js 18+
- VS Code 1.85+

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Type-check and build |
| `npm run check-types` | TypeScript type-checking only |
| `npm run watch` | Build in watch mode |
| `npm run package` | Production build |
| `npm run lint` | Run ESLint |

### Testing Locally

Press `F5` in VS Code to launch the Extension Development Host with the extension loaded.

## Contributor License Agreement

By submitting a pull request, you agree to the [Contributor License Agreement](CLA.md). This grants Advancer Limited the right to use your contributions while you retain your copyright. The CLA Assistant bot will prompt you to sign on your first PR.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
