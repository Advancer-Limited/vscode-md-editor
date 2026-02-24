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

## Askance — Tool Call Oversight

This project uses [Askance](https://askance.app) for AI tool call interception and approval management.

**How it works:**
- All tool calls are intercepted by Askance hooks and evaluated against policy rules managed via the dashboard
- Safe operations (reads, searches) are auto-approved; risky operations require human approval
- When a tool call is gated for approval, use `mcp__askance__wait` to wait for the decision
- Use `mcp__askance__check_instructions` periodically to check for operator instructions

**Important:**
- If a tool call returns `pending` status with an `approval_id`, call `mcp__askance__wait` with that ID before retrying
- Do NOT bypass or work around gated tool calls — they require human approval
- The operator may send instructions via the dashboard; check for them using the MCP tools
