# Project Rules

## Tracking Files

- **todo.md** — Maintain a checklist of all planned activities. Mark items with `[x]` when done.
- **log.md** — Record details of actions as they happen (what was done, which files were changed, any issues encountered).

## Conventions

- This is a VS Code extension built with TypeScript + esbuild.
- Source code is in `src/`, webview assets in `media/`.
- Build with `npm run compile`. Type-check with `npm run check-types`.
- The extension uses a `CustomTextEditorProvider` for `.md` files with a webview (textarea + markdown-it preview).
- Webview communication uses typed message protocol defined in `src/types.ts`.

## Code Search: LSP first for symbols

The `LSP` tool is **deferred** — load it with `ToolSearch` for `LSP` at the **first symbol lookup of the session**, not eventually. The failure mode is drift, not disagreement: grep is already in context, so it stays the path of least resistance for the whole session unless LSP is loaded early.

**Use LSP when the question is about a symbol** — a function, type, class, method or interface:

- "where is this defined" → `goToDefinition`
- "who actually calls this" → `findReferences` / `incomingCalls`
- "what implements this interface" → `goToImplementation`
- "what's in this file" / "where does X live" → `documentSymbol` / `workspaceSymbol`
- "what type is this" → `hover`

**Keep grep for text-shaped searches**: prose, comments, docs, config values, log output, markdown, and deliberately-greppable lists you want to read as plain text.

Grep doesn't understand the symbol graph. It misses call sites that indirection creates (implicit interface implementations, inherited members, re-exports) and returns noise from strings and comments that happen to share a name. One `workspaceSymbol` call typically replaces several greps plus the follow-up reads needed to work out which hits were real. Grep is not obsolete — it's the right tool for plain text. This is a per-task judgment, not a blanket swap.

### What LSP covers in this repo

- **`src/**/*.ts` and `media/**/*.js`** — both, via the `typescript-lsp` plugin. The webview scripts get full symbol support, not just the extension host, and `findReferences` resolves across files workspace-wide.
- **`media/*.css` and `*.json` have no language server** (none exists in the official plugin marketplace), so selectors and config keys are grep-only by necessity.
- **`src/` ↔ `media/` communicate through `postMessage` string literals** (`'refresh'`, `'fileList'`) — a union type on the host side, plain strings in the webview. No symbol tool spans that boundary: use LSP for the host half and grep for the webview half.

## Git Workflow

This project uses a **master / develop / feature** branching model.

### Branches

- **master** — Production-ready code. Protected: requires PR, no direct push, no force push, no delete.
- **develop** — Integration branch. Protected: requires PR, no direct push, no force push, no delete.
- **feature/*** — Feature branches created from `develop`.
- **fix/*** — Bug-fix branches created from `develop`.

### Workflow

1. **New work**: Create a branch from `develop` using `feature/<name>` or `fix/<name>`.
2. **Develop**: Commit and push to the feature/fix branch.
3. **Merge to develop**: Open a PR from `feature/<name>` → `develop`. Merge after review.
4. **Release to master**: Open a PR from `develop` → `master`. Merge after review.

### PR Review Process (feature → develop)

Before merging any PR to `develop`, perform a self-review:

1. **Create the PR** from `feature/<name>` → `develop`.
2. **Review the diff** — read through all changed files in the PR using `gh pr diff`.
3. **Add review comments** on the PR for any issues found:
   - Bugs, logic errors, or edge cases
   - Code style / convention violations
   - Missing error handling or validation
   - Dead code, unused imports, or unnecessary complexity
   - Security concerns (XSS, injection, etc.)
   - Performance issues
4. **Fix all issues** — commit fixes to the feature branch and push. The PR updates automatically.
5. **Re-review** — verify all comments are addressed.
6. **Merge** only when the review is clean and `npm run compile` passes.

Use `gh pr review <number> --comment --body "..."` to add general comments, or `gh api` for inline file comments.

### Rules

- Never commit directly to `master` or `develop` — always use a PR.
- Always self-review PRs to `develop` before merging (see PR Review Process above).
- Keep feature branches short-lived and focused on a single concern.
- Delete feature/fix branches after merging.
- Use descriptive PR titles and include a summary of changes.

## Publishing

- VS Code Marketplace publisher name: `advancer-limited`
- Publish with: `npx @vscode/vsce publish -p <PAT>`
- PAT is stored in Azure Key Vault `kv-advancer-prod` (Azure subscription `Advancer`) as `vsce-marketplace-pat`
  - Fetch with: `az account set --subscription Advancer && az keyvault secret show --vault-name kv-advancer-prod --name vsce-marketplace-pat --query value -o tsv`
- The PAT must be created from the Azure DevOps account linked to the `advancer-limited` publisher, with **All accessible organizations** + **Marketplace: Manage** scope
