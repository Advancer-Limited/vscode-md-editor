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
