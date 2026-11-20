# Office Viewers — Implementation Plan

Date: 2026-11-20 · Spec: `docs/office-viewers-spec.md` (all `§` references are to it) · Starting branch: `feature/office-viewers`

This plan slices the spec into work packages (WPs). Each WP is sized for one implementation subagent run (≤ ~1,500 changed lines including tests) and names its files, exported interfaces, dependencies, acceptance tests and implementer model. The spec says *what*; this document says *in what order, by whom, in which files, and how it is checked*. Where the two disagree, the spec wins and the plan gets fixed.

---

## 1. Ground rules for every WP

These apply to every implementing agent. The orchestrator pastes this section into each brief.

1. **Read first**: `CLAUDE.md`, the spec sections listed in the WP, this section, and the WP itself. Load the `LSP` tool before the first symbol lookup (project rule).
2. **Touch only the files the WP lists.** If another file needs to change, stop and report it; do not edit it. Shared files have exactly one owning WP per PR (§3.2 of this plan).
3. **`src/office/core/**` MUST NOT import `vscode`**, nor anything outside `core/` except the npm packages `fflate`, `numfmt`, `@borgar/fx` and **type-only** imports (`import type`) from `../protocol.js`, which are erased at build time (`protocol.ts` itself imports nothing but `core/types.ts`). Imports between source files use the `./x.js` suffix (repo convention).
4. **Tests**: `tests/office/<name>.test.mjs`, run by `npm test`. Core code is reached through the test bundle only: `const core = require('../.build/office-core.cjs')` via the helper in `tests/office/_helpers.mjs`. Edit tests write their outputs to `tests/.out/<test-name>/<case>.{docx,xlsx}` (git-ignored) so `scripts/verify-office-open.ps1` can open them in Word/Excel.
5. **Done means**: `npm run check-types`, `npm run compile` and `npm test` pass; the WP's named acceptance tests exist and pass; nothing outside the file list changed.
6. **Do not edit `todo.md`, `log.md` or `CHANGELOG.md`** when your WP runs in a parallel group. Return a ready-to-paste entry for each in your final report; the orchestrator appends them when it merges the group (this is how the project rule is kept without merge conflicts). A WP that runs alone edits them directly.
7. **Do not commit, push or open PRs** unless the brief says so. The orchestrator owns git.
8. **No `innerHTML` with document-derived strings** in any `media/docx*.js`, `media/xlsx*.js`, `media/officeCommon.js` (§12). Build DOM with `createElement`/`textContent`.
9. **Refuse rather than guess.** Any input the spec does not cover produces an error result or a read-only reason, never a best-effort write (§10.1).
10. **Report honestly**: list what was not verified (anything needing an Extension Development Host or desktop Office is not verifiable by a subagent and belongs in the gate checklist, §6).

Model legend: **Opus** = errors here corrupt files or need deep reasoning. **Sonnet** = mechanical or fully specified. **Fable** = review only, twice (gates R2 and R-final).

---

## 2. Work-package overview

`Par.` = parallel group: WPs sharing a group letter+number may run concurrently (disjoint files, each in its own git worktree). Groups run in the order listed; a WP also waits for everything in its *Depends on* column.

| ID | Title | Model | Depends on | Par. | PR |
|---|---|---|---|---|---|
| **Phase 0** | | | | | |
| WP-01 | Spikes: marker hook, byte transfer, Ctrl+Z, thresholds, bundle sizes, ESM imports | Opus | — | A1 | none (throwaway) |
| WP-02 | Scaffolding, dependencies, test bundle, housekeeping | Sonnet | — | A1 | PR-0 |
| WP-03 | Fixtures and fixture generators | Sonnet | WP-02 | A2 | PR-1 |
| WP-04 | ZIP container reader/writer (`core/zip.ts`) | Opus | WP-02 | A2 | PR-2 |
| WP-05 | Lossless XML (`core/xml.ts`) | Opus | WP-02 | A2 | PR-2 |
| WP-06 | OPC, `OfficePackage`, load classification | Opus | WP-03, 04, 05 | A3 | PR-2 |
| **Phase 1** | | | | | |
| WP-07 | Protocol contract freeze (`protocol.ts`, `types.ts`) | Sonnet | WP-01 | B1 | PR-3 |
| WP-08 | Host shell: read-only `OfficeDocument`, provider base, docx registration | Opus | WP-06, 07 | B2 | PR-3 |
| WP-09 | Common webview chrome (`officeCommon.js/.css`) | Sonnet | WP-07 | B2 | PR-3 |
| WP-10 | Word viewer (notices + `docxEditor.js/.css`) | Sonnet | WP-08, 09 | B3 | PR-3 |
| WP-11 | Xlsx read model (`workbook.ts`, `sheet.ts`, `sharedStrings.ts`) | Opus | WP-06 | B2 | PR-4 |
| WP-12 | Xlsx styles and display formatting (`styles.ts`, `format.ts`) | Sonnet | WP-06 | B2 | PR-4 |
| WP-13 | Grid maths (`xlsxGridMath.js`) | Sonnet | WP-07 | B2 | PR-4 |
| WP-14 | Xlsx provider view path + xlsx registration | Sonnet | WP-08, 11, 12 | B3 | PR-4 |
| WP-15 | Grid component (`xlsxGrid.js/.css`) | Sonnet | WP-09, 13 | B3 | PR-4 |
| WP-16 | Excel viewer shell (`xlsxEditor.js/.css`) | Sonnet | WP-14, 15 | B4 | PR-4 |
| WP-17 | Phase 1 docs, README, CHANGELOG, gate checklist run | Sonnet | WP-10, 16 | B5 | PR-5 |
| **Phase 2** | | | | | |
| WP-18 | Edits, undo/redo, serialise, verify, save core | Opus | WP-06 | C1 | PR-6 |
| WP-19 | Full `CustomEditorProvider`: save, backup, revert, edit mode | Opus | WP-08, 18 | C2 | PR-6 |
| WP-20 | Xlsx cell write, input classification, calc handling | Opus | WP-11, 12, 18 | C2 | PR-7 |
| WP-21 | Formula entry, `_xlfn`, shared-formula materialisation | Opus | WP-20 | C3 | PR-7 |
| WP-22 | Date style patch + xlsx validators | Opus | WP-21 | C4 | PR-7 |
| WP-23 | Xlsx editing wiring (host + cell editor UI) | Sonnet | WP-16, 19, 22 | C5 | PR-8 |
| WP-24 | `verify-office-open.ps1`, OpenXmlValidator script | Sonnet | WP-18 | C2 | PR-8 |
| **Phase 3** | | | | | |
| WP-25 | Docx block/segment model incl. table cells (`docx/model.ts`) | Opus | WP-18 | D1 | PR-9 |
| WP-26 | Docx styles + numbering, read side | Sonnet | WP-06 | D1 | PR-9 |
| WP-27 | Render copy + DOM mapping (`renderCopy.ts`, `docxMap.js`) | Opus | WP-25 | D2 | PR-9 |
| WP-28 | Paragraph writer (`paragraphWriter.ts`) | Opus | WP-25, 26 | D2 | PR-10 |
| WP-29 | Paragraph structure ops: split, merge, insert, remove | Opus | WP-28 | D3 | PR-10 |
| WP-30 | Styles and lists, write side | Opus | WP-29 | D4 | PR-10 |
| WP-31 | Docx validators + protection detection | Sonnet | WP-25 | D2 | PR-10 |
| WP-32 | Island DOM ↔ segments (`docxIsland.js`) | Opus | WP-07 | D1 | PR-11 |
| WP-33 | Docx provider edit path (host) | Sonnet | WP-19, 27, 30, 31 | D5 | PR-11 |
| WP-34 | Island controller and re-render scheduling (`docxEdit.js`) | Opus | WP-10, 27, 32, 33 | D6 | PR-11 |
| WP-35 | Word edit toolbar, shortcuts, CSS | Sonnet | WP-34 | D7 | PR-11 |
| **Phase 4** | | | | | |
| WP-36 | Reference shifting (`xlsx/refs.ts`) | Opus | WP-21 | E1 | PR-12 |
| WP-37 | Excel-produced goldens for structural ops | Sonnet | WP-03 | E1 | PR-12 |
| WP-38 | Insert/delete rows and columns, Tier A | Opus | WP-36, 37 | E2 | PR-13 |
| WP-39 | Tier B/C guards | Opus | WP-36 | E2 | PR-13 |
| WP-40 | Add / rename / delete sheet | Opus | WP-36 | E2 | PR-13 |
| WP-41 | Structure UI + host wiring | Sonnet | WP-23, 38, 39, 40 | E3 | PR-14 |
| WP-42 | v1 release preparation | Sonnet | all above | E4 | PR-15 |
| **Post-v1** | | | | | |
| WP-50 | Phase 5: Excel range/sheet → Markdown table | Sonnet | v1 | F | own |
| WP-51 | Phase 6: Word → Markdown | Sonnet | v1 | F | own |
| WP-52 | Phase 7: Markdown → Word | Opus | WP-51 | — | own |
| WP-53 | Phase 8a: Office files in index, resolution, rename | Opus | v1 | F | own |
| WP-54 | Phase 8b: autocomplete, graph, "Linked from" | Sonnet | WP-53 | — | own |

Model split in v1: 22 Opus, 20 Sonnet; Fable for two review passes only.

---

## 3. Branching, PRs, shared files

### 3.1 Branch and PR strategy

**Decision: merge small PRs straight to `develop`; do not stack on a long-lived `feature/office-viewers`.** Reasons: the project rule is short-lived, focused branches; every slice below is either inert (code not reachable from `src/extension.ts`, so the shipped bundle does not change) or user-complete; and a long-lived branch would have to absorb every unrelated `develop` change for weeks.

- `feature/office-viewers` (the current branch) carries **PR-0**: the two docs plus WP-02. It is then deleted.
- Every later PR is its own `feature/office-<slug>` branch cut from `develop` at the time the group starts.
- WPs that run in parallel each work in their own git worktree on `feature/office-<slug>-wpNN`; the orchestrator merges them into the PR branch (file sets are disjoint by construction) and appends their `todo.md`/`log.md` entries.
- **Incomplete features never reach users**, because a hotfix release may be cut from `develop` at any time:
  - `package.json` `customEditors` entries are added only by the WP that makes that viewer complete (docx: WP-10's PR-3; xlsx: PR-4). Before that, `.docx`/`.xlsx` behave as today.
  - `src/office/featureFlags.ts` (created by WP-08) exports `OFFICE_FLAGS = { xlsxEdit: false, docxEdit: false, xlsxStructure: false }`. The provider reports `canEdit: false` for a kind whose flag is off and rejects structural ops when `xlsxStructure` is off. Each flag is flipped to `true` by the last PR of its phase (PR-8, PR-11, PR-14), after the phase gate.

| PR | Branch | Contents | Releasable after merge? |
|---|---|---|---|
| PR-0 | `feature/office-viewers` | spec, plan, WP-02 | inert |
| PR-1 | `feature/office-fixtures` | WP-03 (binary fixtures; review the generators and README, not the bytes) | inert |
| PR-2 | `feature/office-core` | WP-04, 05, 06 → **Gate R0** | inert |
| PR-3 | `feature/office-word-viewer` | WP-07, 08, 09, 10 | yes (Word viewer) |
| PR-4 | `feature/office-excel-viewer` | WP-11–16 | yes (both viewers) |
| PR-5 | `feature/office-viewers-docs` | WP-17 → **Gate R1** → optional release (minor bump) | yes |
| PR-6 | `feature/office-save` | WP-18, 19 (flags off) | yes (no visible change) |
| PR-7 | `feature/office-xlsx-cells` | WP-20, 21, 22 (flags off) | yes (no visible change) |
| PR-8 | `feature/office-xlsx-edit-ui` | WP-23, 24, flip `xlsxEdit` → **Gate R2 (Fable)** | yes (Excel cell editing) |
| PR-9 | `feature/office-docx-model` | WP-25, 26, 27 | yes (no visible change) |
| PR-10 | `feature/office-docx-write` | WP-28, 29, 30, 31 | yes (no visible change) |
| PR-11 | `feature/office-docx-edit-ui` | WP-32–35, flip `docxEdit` → **Gate R3** → optional release | yes (Word editing) |
| PR-12 | `feature/office-xlsx-refs` | WP-36, 37 | yes (no visible change) |
| PR-13 | `feature/office-xlsx-structure` | WP-38, 39, 40 | yes (no visible change) |
| PR-14 | `feature/office-xlsx-structure-ui` | WP-41, flip `xlsxStructure` → **Gate R4** | yes |
| PR-15 | `feature/office-v1-release` | WP-42 → **Gate R-final (Fable)**, then the usual bump PR and `develop` → `master` | v1 |

Every PR follows the project's self-review process (`gh pr diff`, review comments, fixes, re-review, `npm run compile` green) before merge. Merge with `gh pr merge --admin` only when the user asks; otherwise hand off.

### 3.2 Shared files and who owns them

| File | Owner per PR | Rule |
|---|---|---|
| `package.json`, `package-lock.json` | PR-0: WP-02 (all dependencies, scripts). PR-3: WP-08 (docx `customEditors` entry). PR-4: WP-14 (xlsx entry, `sheetAppearance`). PR-6: WP-19 (`startInEditMode`). PR-14: WP-41 (`confirmStructuralEdits`). | All npm dependencies for v1 are added once, in WP-02, with exact pins. Nobody else runs `npm install <pkg>`. |
| `esbuild.js`, `scripts/copy-vendor.js`, `.gitignore`, `.gitattributes`, `.vscodeignore` | WP-02 only | Later WPs that add vendored or generated files list them in their report; none are expected. |
| `src/extension.ts` | WP-08 (docx registration), WP-14 (xlsx registration), WP-19 (switch to `registerCustomEditorProvider` options for editable providers, if any change is needed) | Each adds one block after step 2c, labelled 2d / 2e. |
| `src/types.ts`, `src/office/protocol.ts` | WP-07 only | **Frozen after WP-07.** A needed change is a plan/spec change: the orchestrator edits spec §5 and `protocol.ts` together, between groups, never inside a parallel WP. |
| `src/office/core/index.ts` | WP-02 only | Written once as a complete barrel of namespace re-exports over stub modules (see WP-02), so parallel WPs fill in their own module files and never touch the barrel. |
| `src/office/core/xlsx/ops.ts`, `core/docx/ops.ts` | WP-20 / WP-29 create them with dispatch to every later module's function, backed by stub modules that return `{ ok: false, error: { code: 'blocked', message: 'Not available yet' } }` | Later WPs replace only their own module. |
| `media/xlsxEditor.js`, `media/docxEditor.js` | one WP at a time (the table in §2 keeps writers of the same file in different groups) | Edit-mode code goes in separate files (`xlsxCellEditor.js`, `docxEdit.js`) to keep this true. |
| `todo.md`, `log.md`, `CHANGELOG.md`, `README.md` | orchestrator at merge time; WP-17 and WP-42 for README/CHANGELOG | Ground rule 6. |

---

## 4. Phase 0 — spike and core

### WP-01 — Spikes (Opus) · first, blocks contract freeze

**Why Opus:** the outcomes change the architecture; the agent has to judge evidence, not just collect it.

**Goal:** close the assumptions in §16 (1–5, 9) with evidence before anything depends on them.

**Files (throwaway, never merged):** everything under `spike/office/` on branch `spike/office-viewers` — its own `package.json` (so it can install `docx-preview@0.4.1`, `jszip@3.10.2`, `fflate`, `numfmt`, `@borgar/fx`, `mammoth`, `docx` without touching the repo's manifest), a minimal extension (`extension.js`, one `CustomEditorProvider` for `*.docx`, one webview), and `make-inputs.ps1`, a short COM script that writes the spike's input documents (`basic`, `rich`, `fields`, `anchors`, `tables`, a ~300-page `large.docx`, a 200,000-cell `large.xlsx`). WP-03 later formalises that script; the spike copy is disposable. The only repo files this WP changes are `log.md` (the report) and, if an outcome requires it, this plan and the spec.

**How it runs unattended:** the spike extension auto-runs each experiment when its editor opens and the host writes `spike/office/out/report.json`. Launch with an isolated profile (see the dev-host tip in `log.md`, 2026-10-13): `code --extensionDevelopmentPath=spike/office --user-data-dir=<tmp> --extensions-dir=<tmp> <input file>`, then poll for the report. Item S3 needs real key presses and is done by the user from a five-line script the WP prints.

| # | Question (spec ref) | Method | Pass criterion | If it fails |
|---|---|---|---|---|
| S1 | Marker bookmarks map every editable paragraph (§8.2, assumption 3), **including paragraphs in table cells, nested tables, and body paragraphs split by a page break** | Inject `__vsmd_s_/e_` bookmarks with a quick JSZip + string splice (spike quality), render with the §7.1 options, count `span#__vsmd_s_{id}`/`_e_{id}` pairs and apply the §8.2 same-cell rule | 100 % of injected pairs found, start and end in the same cell context, on every input; no visible layout difference against an un-injected render (compare page count and each page's `offsetHeight`) | **Fallback 1**: vendor a patched docx-preview that stamps `data-block` on each rendered `<p>` from a marker the render copy puts on the `w:p` (add WP-27a, Opus, ~300 lines + `media/docx-preview.vsmd.js`; state the modification in `THIRD-PARTY-NOTICES.md` as Apache-2.0 requires). **Fallback 2** (only if 1 is impractical): separate host-drawn "Edit view"; re-plan Phase 3 UI WPs 34–35 before starting them. |
| S2 | `Uint8Array` in `postMessage` reaches the webview as a typed array, and what a 20 MB payload costs (§5, assumption 1) | Post 1, 20 and 60 MB arrays; record `instanceof`, round-trip time, host RSS delta | Arrives as `Uint8Array`/`ArrayBuffer`; 20 MB < 1.5 s | Use base64 in `docxRender` (protocol field becomes `bytesB64: string`; WP-07 writes whichever won); lower the docx "large document" threshold if 20 MB > 3 s. |
| S3 | Ctrl+Z / Ctrl+Y stay local to a focused contenteditable or `<input>` in a custom-editor webview (§6.3, assumption 2) | Capture-phase `keydown` listener on `document` calling `stopPropagation()` (not `preventDefault()`); user types, presses Ctrl+Z, the page logs whether native undo happened and the host logs whether its `undo` callback fired | Native undo happens **and** the host callback does not fire, on Windows (and macOS if available) | Adopt the documented fallback: Ctrl+Z cancels the in-progress edit and undoes the last committed one. WP-34 and WP-23 then implement a small local snapshot stack only if the user asks for it. Record the result in §16. |
| S4 | docx-preview render time and memory for `large.docx`; host parse time and memory for `large.xlsx` (§10.2, assumption 4) | Timings in the report; parse with a throwaway tokenizer loop equivalent in cost to WP-05's | Render < 10 s, parse of the 200k-cell sheet < 3 s, host RSS growth < 400 MB | Lower the §10.2 thresholds proportionally (they live in `core/limits.ts`, one edit) and say so in the spec. If parse > 10 s, schedule the worker-thread item (§10.2) into Phase 1 as a new WP. |
| S5 | Bundle sizes: host bundle growth with `fflate` + `numfmt` + `@borgar/fx`; `mammoth` and `docx` (assumption 5) | `esbuild --bundle --minify --metafile` on a three-line entry per case | v1 host growth ≤ 400 KB minified; Phases 6–7 ≤ 2 MB | Report only; post-v1 WPs 51–52 decide (lazy `import()` split is the escape hatch). |
| S6 | `tsc --noEmit` accepts `import … from 'numfmt'`, `'@borgar/fx'`, `'@borgar/fx/xlsx'` under this repo's `tsconfig.json` (assumption 9) | Copy `tsconfig.json`, type-check a five-line file | No TS1479/TS7016 errors | WP-02 changes `tsconfig.json` to `"module": "ESNext"`, `"moduleResolution": "Bundler"` (esbuild already does the real resolution; existing `./x.js` imports stay valid) and proves `npm run check-types` and `npm test` are still green. If that breaks anything, isolate the two packages behind `core/vendor.ts` using `require()` with hand-written `.d.ts` shims. |
| S7 | The API surface this plan assumes exists: `numfmt.format`, `isDateFormat`, `dateToSerial`; `@borgar/fx` `tokenize`, `parse`, `parseA1Ref`, `stringifyA1Ref`, and the `xlsx` entry | Call each once | All present and behaving as §9 needs | Adjust the signatures in WP-12, 21, 36 before those WPs start. |

**Acceptance:** a "Phase 0 spike report" section in `log.md` with one row per item (result, numbers, evidence file), the decision taken, and any plan/spec edits made. S1 on `libreoffice.docx`/`googledocs.docx` is re-run when the user supplies those files and MUST be green before group D starts.

**Size:** ~500 lines of throwaway code.

### WP-02 — Scaffolding, dependencies, test bundle, housekeeping (Sonnet)

**Why Sonnet:** mechanical configuration with exact instructions.

**Files:**
- `package.json` / `package-lock.json`: dependencies, **exact pins, no caret**: `fflate@0.8.3`, `numfmt@4.1.4`, `@borgar/fx@5.1.3`, `docx-preview@0.4.1`, `jszip@3.10.2`. devDependencies: `saxes@6.0.0`, `exceljs@4.4.0`. Scripts: `"test": "node esbuild.js --test-bundle && node --test \"tests/**/*.test.{js,mjs}\""`.
- `esbuild.js`: third context `office-core-test` — entry `src/office/core/index.ts`, `outfile: 'tests/.build/office-core.cjs'`, `format: 'cjs'`, `platform: 'node'`, `sourcemap: true`, `minify: false`. With `--test-bundle` build **only** this context and exit; without it, behaviour is unchanged (the test bundle is not built by `compile`/`package`/`watch`).
- `scripts/copy-vendor.js`: add `docx-preview/dist/docx-preview.min.js` → `media/docx-preview.min.js` and `jszip/dist/jszip.min.js` → `media/jszip.min.js`. Commit the copied files.
- `.gitattributes`: `media/docx-preview.min.js -text`, `media/jszip.min.js -text`, `tests/fixtures/office/** binary`.
- `.gitignore`: `tests/.build/`, `tests/.out/`, `spike/`.
- `.vscodeignore`: add `docs/**`, `spike/**`, `THIRD-PARTY-NOTICES.md` is **not** ignored. (`tests/**` and `scripts/**` are already ignored, which covers fixtures and generators — state this in the PR description.) Verify with `npx @vscode/vsce ls` that no `docs/`, `tests/`, `spike/` or `scripts/` path is listed and that the two new vendor files and `THIRD-PARTY-NOTICES.md` are.
- `THIRD-PARTY-NOTICES.md` (new, repo root): one section per vendored or bundled library with name, version, licence, copyright line, licence text or link — the five new ones plus the existing `markdown-it`, `turndown`, `force-graph`, `mermaid`, `three`. docx-preview's Apache-2.0 text is included in full. JSZip is taken under MIT (say so).
- `src/office/core/index.ts`: the complete barrel, written once:
  `export * as types from './types.js'; export * as zip from './zip.js'; export * as xml from './xml.js'; export * as opc from './opc.js'; export * as pkg from './package.js'; export * as sniff from './sniff.js'; export * as edits from './edits.js'; export * as save from './save.js'; export * as limits from './limits.js'; export * as docx from './docx/index.js'; export * as xlsx from './xlsx/index.js';`
  plus `core/docx/index.ts` (`model`, `styles`, `numbering`, `renderCopy`, `paragraphWriter`, `ops`, `stylesWrite`, `validate`, `protection`, `notices`) and `core/xlsx/index.ts` (`types`, `workbook`, `sheet`, `sharedStrings`, `styles`, `format`, `view`, `find`, `notices`, `input`, `ops`, `calc`, `sharedFormula`, `xlfn`, `stylesWrite`, `refs`, `structure`, `guards`, `sheetsOps`, `validate`, `markdown`) in the same namespace style, and a stub file `export {};` for every module named. Parallel WPs replace stubs; they never edit a barrel.
- `src/office/core/limits.ts`: the §10.2 numbers as one exported `const LIMITS` object (values possibly adjusted by WP-01 S4).
- `src/office/core/types.ts`: the three shared types copied verbatim from spec §5 — `ReadOnlyReason`, `OfficeNotice`, `OfficeError` — so the core never waits for `protocol.ts` (WP-07 re-exports them from here).
- `src/office/core/xlsx/types.ts`: the declarations two parallel WPs (11 and 12) both need, exactly as written in WP-11 (`CellValue`, `CellRead`, `Range`) plus `ColInfo { min: number; max: number; widthChars: number | null; hidden: boolean; styleIndex: number | null }`, `RowInfo { heightPt: number | null; hidden: boolean; styleIndex: number | null }`, `TableInfo { part: string; name: string; ref: Range; headerRows: number; totalsRows: number }`.
- `tests/office/_helpers.mjs`: `core` (the required bundle), `fixture(name): Uint8Array`, `allFixtures(kind?)`, `writeOut(testName, caseName, bytes)`, `assertBytesEqual(a, b, msg)`, `commonAffixes(a, b)` (prefix/suffix lengths, for G4), `entryTable(bytes)` (name → `{ crc, compressedBytes, cdRecordBytes }`, for G3 — implemented with the core reader once WP-04 lands; until then it throws "not available").
- `tests/office/smoke.test.mjs`: the bundle loads and `core.limits.LIMITS` is defined.
- `tsconfig.json`: only if WP-01 S6 says so.
- `todo.md`: extend the existing "2026-11-20 Office viewers/editors" section — under each phase line add one checkbox per WP and per gate (ids from §2). `log.md`: entry for this WP.

**Depends on:** nothing (S6's outcome is applied as a follow-up commit if WP-01 finishes later).
**Acceptance:** `npm run compile`, `npm run check-types`, `npm test` green; `vsce ls` check above recorded in `log.md`; `dist/extension.js` size unchanged (nothing imports the new code yet).
**Size:** ~450 lines.

### WP-03 — Fixtures and generators (Sonnet)

**Why Sonnet:** scripted authoring from an explicit list; no design decisions.

**Files:**
- `scripts/office-fixtures/make-word.ps1`, `make-excel.ps1`: drive desktop Word/Excel through COM to author every "real Office" fixture in §13.4, deterministically (fixed text, no dates from `Now()`). Includes the new `tables.docx` and passwords for `encrypted.*` (password `test`, recorded in the README).
- `scripts/office-fixtures/make-synthetic.mjs`: Node script for the generated ones — `inline-strings.xlsx`, `no-shared-strings.xlsx`, `prefixed-namespaces.xlsx`, `no-date-style.xlsx`, `no-date-style-nocount.xlsx`, `no-styles.xlsx`, `data-descriptors.xlsx` (JSZip `streamFiles: true` sets general-purpose bit 3), `zip64.xlsx` (take `basic.xlsx` and insert a ZIP64 end-of-central-directory record and locator before the EOCD), `truncated.docx` (first 60 % of `basic.docx`), `legacy-renamed.docx` (Word COM `SaveAs` format 0, renamed), `external-image.docx` (a picture with `TargetMode="External"` pointing at `http://127.0.0.1:9/x.png`, for the CSP/no-network check), `localised-de.synthetic.docx` (`basic.docx` with heading style ids rewritten to `berschrift1…` in `styles.xml` and `document.xml`). `huge.xlsx` is **not** committed: export `makeHugeXlsx(dir)` for tests to call.
- `tests/fixtures/office/*.docx|*.xlsx`, `tests/fixtures/office/README.md` (one line per file: producer, how made, what it exercises), `tests/fixtures/office/expected/styles.pdf` (Excel `ExportAsFixedFormat` of `styles.xlsx`, the visual reference for Gate R1).
- `tests/office/fixtures.test.mjs`: every file named in §13.4 exists (user-supplied ones are listed in a `PENDING` array that prints a warning instead of failing) and no committed fixture exceeds 5 MB.

**Needs the user:** `libreoffice.docx`, `libreoffice.xlsx`, `googledocs.docx`, `googlesheets.xlsx`, and a real German-Word `localised-de.docx`. The README gives exact recipes (open `basic.*` in the other producer, save/export). Until they arrive the synthetic German file stands in and the four producer files are `PENDING`.

**Depends on:** WP-02. **Acceptance:** the test above; both PowerShell scripts re-run cleanly and reproduce the files (content-equal when unzipped; byte equality is not expected from Office). **Size:** ~1,100 lines of script.

### WP-04 — ZIP container (Opus)

**Why Opus:** a wrong offset corrupts every saved file.

**Spec:** §3.2, §10.2, §10.3, §12 (ZIP), G1, G3. **Files:** `src/office/core/zip.ts`, `tests/office/zip.test.mjs`.

```ts
export type ZipRefusal = 'not-zip' | 'truncated' | 'zip64' | 'multi-disk' | 'encrypted' | 'unsupported-compression'
  | 'duplicate-name' | 'unsafe-name' | 'overlap' | 'too-large' | 'bad-crc' | 'bad-data';
export class ZipError extends Error { readonly code: ZipRefusal; readonly entryName?: string; }
export interface ZipEntry { readonly name: string; readonly method: 0 | 8; readonly flags: number; readonly crc32: number;
  readonly compressedSize: number; readonly uncompressedSize: number; readonly dosTime: number; readonly dosDate: number;
  readonly extent: readonly [number, number];      // local header start .. next local header / CD start
  readonly cdRecord: readonly [number, number]; }  // this entry's central-directory record
export interface ZipArchive { readonly bytes: Uint8Array; readonly entries: readonly ZipEntry[]; readonly comment: Uint8Array; }
export interface ZipLimits { maxFileBytes: number; maxTotalUncompressed: number; maxEntryUncompressed: number; }
export function readZip(bytes: Uint8Array, limits: ZipLimits): ZipArchive;             // throws ZipError; inflates nothing
export function inflateEntry(zip: ZipArchive, entry: ZipEntry): Uint8Array;            // verifies CRC-32, throws 'bad-crc'
export type ZipWriteItem = { keep: ZipEntry } | { replace: ZipEntry; data: Uint8Array } | { add: string; data: Uint8Array };
export function writeZip(zip: ZipArchive, items: ZipWriteItem[]): Uint8Array;          // items in output order; omitted = removed
export function rawDeflate(data: Uint8Array, level: 1 | 6): Uint8Array;
export function rawInflate(data: Uint8Array, expectedSize?: number): Uint8Array;
export function crc32(data: Uint8Array): number;
```

**Acceptance tests** (names are the `test()` titles):
- `G1: forced rewrite of every fixture is byte-identical` (all `keep`).
- `G1 holds for data-descriptor entries` (`data-descriptors.xlsx`).
- `refuses zip64 | encrypted entry | method 9 | duplicate names differing by case | overlapping extents | '..' and absolute names | declared size over limits | not a zip | truncated` — one test each, asserting `ZipError.code`; the encrypted/overlap/method cases are built in-test by patching bytes of `basic.xlsx`.
- `inflate detects a flipped data bit (bad-crc)`.
- `replace: only the replaced entry's bytes differ; all other extents and CD records identical except offsets`.
- `add appends after existing entries with the 1980-01-01 timestamp; omit removes; archive comment preserved`.
- `output of writeZip is accepted by fflate.unzipSync and by JSZip` (independent readers).
- `limits are checked from the central directory before any inflation` (a zip-bomb header with tiny data).

**Depends on:** WP-02. **Parallel with:** WP-03, WP-05. **Size:** ~600 source + ~500 test lines.

### WP-05 — Lossless XML (Opus)

**Why Opus:** the foundation of "only the targeted element is rewritten"; subtle offset and namespace handling.

**Spec:** §3.3, §6.3 (node paths), §10.2 (chunked parse), §12 (XML), G2, G4. **Files:** `src/office/core/xml.ts`, `tests/office/xml.test.mjs`.

```ts
export class XmlError extends Error { readonly code: 'doctype' | 'malformed' | 'encoding'; readonly offset: number; }
export interface XmlAttr { readonly rawName: string; readonly ns: string; readonly local: string; value: string; /* decoded */ readonly raw: string; }
export interface XmlElement { readonly type: 'el'; readonly ns: string; readonly local: string; readonly rawName: string;
  attrs: XmlAttr[]; children: XmlNode[]; parent: XmlElement | null; }
export interface XmlText { readonly type: 'text' | 'cdata' | 'comment' | 'pi'; readonly raw: string; parent: XmlElement | null; }
export type XmlNode = XmlElement | XmlText;
export interface XmlDoc { readonly root: XmlElement; }                      // prolog/epilog kept internally
export function decodePart(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'utf-16'; bom: boolean };
export function encodePart(text: string, bom: boolean): Uint8Array;          // UTF-8 only
export function parseXml(text: string): XmlDoc;
export function parseXmlAsync(text: string, yieldEveryMs?: number): Promise<XmlDoc>;   // yields to the event loop (§10.2)
export function serialize(node: XmlDoc | XmlNode): string;                   // unmodified node => its source slice
export function parseFragment(doc: XmlDoc, xml: string): XmlNode[];          // parsed with the root's namespace bindings in scope
export function replaceNode(target: XmlNode, xml: string): XmlNode[];        // marks ancestors modified
export function insertAt(parent: XmlElement, childIndex: number, xml: string): XmlNode[];  // no whitespace added
export function removeAt(parent: XmlElement, childIndex: number): string;    // returns removed source; never merges text nodes
export function setAttr(el: XmlElement, ns: string, local: string, value: string | null): void;  // rewrites only the start tag
export function pathOf(node: XmlNode): number[];                             // child-node indexes from root (all node kinds)
export function nodeAt(doc: XmlDoc, path: readonly number[]): XmlNode | undefined;
export function child(el: XmlElement, ns: string, local: string): XmlElement | undefined;
export function childrenOf(el: XmlElement, ns: string, local: string): XmlElement[];
export function attr(el: XmlElement, ns: string, local: string): string | undefined;   // ns '' = unqualified
export function textContent(el: XmlElement): string;
export function qname(doc: XmlDoc, ns: string, local: string): string | undefined;     // prefix bound at the root, else undefined
export function escapeText(s: string): string; export function escapeAttr(s: string): string;
export function stripIllegalXmlChars(s: string): string;
```

**Acceptance tests:**
- `G2: serialize(parse(x)) === x for every XML part of every fixture` (iterate entries ending `.xml`/`.rels`/`.vml` through `core.zip`; needs WP-04 — until it lands, run against a checked-in directory of five extracted parts under `tests/fixtures/office/parts/`, and switch on in WP-06).
- `rejects <!DOCTYPE anywhere in the prolog`; `decodes only the five predefined entities and numeric references`; `unknown entity is malformed`.
- `matches by namespace URI with x: prefixes` (`prefixed-namespaces.xlsx` sheet part) and `with a default namespace`.
- `replaceNode: text outside the replaced element is byte-identical` (G4 helper), `nested modification keeps untouched descendants' slices`.
- `insertAt then removeAt restores the exact source`; `removeAt then insertAt at the same path restores the exact source, including surrounding whitespace` (pretty-printed input).
- `setAttr preserves attribute order, quote style and other attributes' raw text`.
- `preserves XML declaration, comments, PIs, CDATA, CRLF line endings, a BOM`.
- `UTF-16 part decodes and is flagged`.
- `parseXmlAsync yields at least once on a 5 MB input and equals parseXml`.
- `agrees with saxes on element/attribute sequence for every fixture part` (independent parser).
- `escape/strip helpers` (C0 controls removed; `]]>` safe).

**Depends on:** WP-02. **Parallel with:** WP-03, WP-04. **Size:** ~800 source + ~600 test lines.

### WP-06 — OPC, OfficePackage, load classification (Opus)

**Why Opus:** part-graph and dirty-tracking errors surface later as corrupt saves.

**Spec:** §4, §6.1, §8.1/§9.1 (main-part discovery, view-only reasons), §10.2, §10.3. **Files:** `core/opc.ts`, `core/package.ts`, `core/sniff.ts`, `tests/office/package.test.mjs`, `tests/office/sniff.test.mjs`.

```ts
// sniff.ts
export type LoadFailure = 'empty' | 'lock-file' | 'encrypted-ole' | 'legacy-ole' | 'damaged' | 'unsupported-packaging' | 'too-large';
export class OfficeLoadError extends Error { readonly failure: LoadFailure; readonly detail: string; }
export function sniff(fileName: string, bytes: Uint8Array): LoadFailure | null;       // pre-ZIP checks
// opc.ts
export interface Relationship { id: string; type: string; target: string; external: boolean; }
export function partNameFromTarget(sourcePart: string, target: string): string;
export function relsPartFor(part: string): string;                                     // 'xl/workbook.xml' -> 'xl/_rels/workbook.xml.rels'
export function readRelationships(p: OfficePackage, part: string): Relationship[];     // part '' = package root
export function contentTypeOf(p: OfficePackage, part: string): string | undefined;     // Override, then Default by extension
export function mainPart(p: OfficePackage): { name: string; contentType: string };
// package.ts
export type OfficeKind = 'docx' | 'xlsx';
export class OfficePackage {
  static open(fileName: string, bytes: Uint8Array): OfficePackage;                     // throws OfficeLoadError
  readonly kind: OfficeKind; readonly originalBytes: Uint8Array; readonly viewOnlyReason: ReadOnlyReason | null;
  partNames(): string[]; has(part: string): boolean;                                   // case-insensitive lookup, original case kept
  bytes(part: string): Uint8Array; text(part: string): string;
  xml(part: string): XmlDoc; xmlAsync(part: string): Promise<XmlDoc>;                  // lazy, cached
  touch(part: string): void;                                                           // mark an XML part modified
  setPart(part: string, data: Uint8Array | null): void;                                // create / replace / delete a whole part
  touchedParts(): string[];
  serialize(opts?: { force?: boolean }): Uint8Array;                                   // no touched parts and !force => originalBytes itself
}
```
`ReadOnlyReason` comes from `core/types.ts`. `viewOnlyReason` covers `strict-ooxml`, `utf16-part`, `unsupported-xml-layout`, `too-large` (document-level), and a non-`main+xml` content type (reported as `strict-ooxml` for Strict namespaces, `unsupported-xml-layout` for macro/template types).

**Acceptance tests:** `G1 via OfficePackage.serialize({force:true}) on every fixture`; `G0: serialize() with nothing touched returns the original bytes object`; `G2 across every fixture part` (switches on the full run promised in WP-05); `main part found through _rels/.rels, not by path` (a fixture copy with the main part renamed in-test); `classifies encrypted.docx/.xlsx, legacy-renamed.docx, ~$lock name, 0-byte file, truncated.docx, zip64.xlsx` → expected `LoadFailure`; `Strict namespace → strict-ooxml view-only` (patched in-test); `touch + serialize changes exactly that entry (G3)`; `setPart add/delete round-trips through readZip`.

**Depends on:** WP-03, 04, 05. **Size:** ~700 source + ~450 test lines.

> **Gate R0** (after PR-2): self-review of zip/xml/package against §3.2–3.3 line by line; G1/G2 green on every available fixture; WP-01 report complete; open items from the report applied to plan and spec. No Fable pass here — the core is reviewed again, with its first real consumers, at R2.

---

## 5. Phase 1 — viewers

### WP-07 — Protocol contract freeze (Sonnet)

**Why Sonnet:** transcription of §5 into types.

**Files:** `src/office/protocol.ts` (verbatim from §5, §5.1, §5.2, with S2's outcome applied to `docxRender`; `ReadOnlyReason`, `OfficeNotice`, `OfficeError` are re-exported from `./core/types.js` rather than redeclared), `src/types.ts` (new banner "Office Viewer Types", `export * from './office/protocol.js'`), `tests/office/protocol.test.mjs` (a type-level smoke test: the file strips and imports under Node; exhaustive `switch` helper functions `isOfficeToHost(msg)` compile).

Also exports the runtime validators the host uses on every inbound message (§5 "never trusts the webview"):
```ts
export function parseCommonToHost(raw: unknown): OfficeCommonToHost | null;
export function parseDocxToHost(raw: unknown): DocxToHost | null;     // structural checks only: types, integer-ness, array caps
export function parseXlsxToHost(raw: unknown): XlsxToHost | null;     // ranges ordered and non-negative, cells ≤ 10,000, strings ≤ 32,767 chars
```
**Acceptance:** `rejects non-integer ids, negative ranges, oversized arrays, unknown type/op` (table-driven, ≥ 40 cases); `accepts every message shape in §5`. **Depends on:** WP-01 (S2). **Size:** ~600 lines.

### WP-08 — Host shell (Opus)

**Why Opus:** the custom-document lifecycle is new to this repo and everything later hangs off it.

**Spec:** §2, §4.1, §6.1, §6.2 (`resolveCustomEditor` row), §10.3, §12. **Files:** `src/office/officeDocument.ts`, `src/office/officeEditorProviderBase.ts`, `src/office/docxEditorProvider.ts` (skeleton that WP-10 completes), `src/office/featureFlags.ts`, `src/office/loadErrors.ts` (maps `LoadFailure` → the §10.3 title/detail/actions text), `src/extension.ts` (step 2d), `package.json` (docx `customEditors` entry only).

```ts
export class OfficeDocument implements vscode.CustomDocument {
  static create(uri: vscode.Uri, kind: OfficeKind, backupId: string | undefined): Promise<OfficeDocument>;  // never throws for bad content
  readonly uri: vscode.Uri; readonly kind: OfficeKind;
  pkg: OfficePackage | null; loadError: { title: string; detail: string; actions: Array<'openExternally' | 'retry'> } | null;
  version: number; generation: number; diskStamp: { mtime: number; size: number } | null;
  readOnlyReason: ReadOnlyReason | null; notices: OfficeNotice[];
  readonly onDidChangeState: vscode.Event<{ kind: 'reloaded' | 'notices' }>;
  reload(): Promise<void>; dispose(): void;
}
export abstract class OfficeEditorProviderBase implements vscode.CustomReadonlyEditorProvider<OfficeDocument> {
  protected abstract readonly kind: OfficeKind;
  protected abstract scripts(): string[]; protected abstract styles(): string[]; protected abstract bodyHtml(): string;
  protected abstract csp(webview: vscode.Webview, nonce: string): string;
  protected abstract onReady(doc: OfficeDocument, panel: vscode.WebviewPanel): void;
  protected abstract onMessage(doc: OfficeDocument, panel: vscode.WebviewPanel, raw: unknown): void;   // kind-specific messages
  protected post(panel: vscode.WebviewPanel, msg: DocxToWebview | XlsxToWebview): void;
}
```
The base handles `ready`, `openLink` (http/https/mailto only), `openExternally`, `retry`, `writeClipboard`, `showAbout`, the external-change watcher, the sibling `~$` lock-file notice, HTML with nonce + `?v=${Date.now()}` + `localResourceRoots = [media]`. Registered in Phase 1 as a read-only provider with `retainContextWhenHidden: true`, `enableFindWidget: true` (docx), `supportsMultipleEditorsPerDocument: false`.

**Acceptance (automated):** `tests/office/loadErrors.test.mjs` — every `LoadFailure` has the §10.3 message. **Acceptance (dev host, logged at Gate R1):** opening each error fixture shows the error view and "Open in Word"; opening the `git:` side of a diff is read-only; changing the file on disk while clean reloads. **Depends on:** WP-06, 07. **Size:** ~900 lines.

### WP-09 — Common webview chrome (Sonnet)

**Why Sonnet:** UI and CSS to an existing house style.

**Spec:** §6.4 (hint text), §10.3, §11. **Files:** `media/officeCommon.js` (global `OfficeCommon`), `media/officeCommon.css`, `tests/office/officeCommon.test.js` (DOM shim, as `tests/findBar.test.js`).

```js
OfficeCommon.init({ vscode, onEditModeToggle, onMessage }) // wires 'message', posts 'ready'
OfficeCommon.toolbar(container, items)   // role=toolbar, arrow-key roving tabindex, aria-pressed toggles
OfficeCommon.setInit(initMsg)            // Edit toggle visibility, read-only reason text, notices
OfficeCommon.showNotices(notices) · showError(loadErrorMsg) · hint(text) · announce(text) // polite live region
OfficeCommon.READ_ONLY_TEXT              // ReadOnlyReason -> sentence
```
**Acceptance:** `toolbar arrow keys move focus and wrap`, `Edit toggle hidden when canEdit is false and shows the reason`, `notices render with textContent only (no HTML injection from a <b> payload)`, `error view exposes the allowed actions`, `Ctrl+E posts setEditMode`. Theme tokens only (`--vscode-*`); `prefers-reduced-motion` and `forced-colors` blocks present. **Depends on:** WP-07. **Parallel with:** WP-08, 11, 12, 13. **Size:** ~700 lines.

### WP-10 — Word viewer (Sonnet)

**Why Sonnet:** option-passing around a library, well specified in §7.1.

**Files:** `core/docx/notices.ts` (`detectDocxNotices(pkg): OfficeNotice[]` — relationship-type and element-name scan per §7.1), `src/office/docxEditorProvider.ts` (view path: `docxRequestRender` → `docxRender` with the **original** bytes and `blocks: []`; CSP per §12), `media/docxEditor.js`, `media/docxEditor.css`, `tests/office/docxNotices.test.mjs`, `tests/office/docxViewer.test.js` (DOM shim with a stubbed `docx.renderAsync`).

Covers: the exact `renderAsync` options of §7.1; zoom (50–200 %, Fit width, Ctrl+wheel, Ctrl+=/−); page count; link interception; render-failure error view; paper-on-backdrop theming and high-contrast outline (§11.1).

Deliberate Phase 1 limitation: heading `role`/`aria-level` (§8.2, §11.2) arrive with the block list in WP-27/WP-33; until then headings are exposed only as docx-preview renders them. Note it in the README section.

**Acceptance:** `notices list tracked changes, comments (count), macros, altChunk, charts, equations for the matching fixtures`; `renderAsync is called with renderAltChunks:false, breakPages:true, renderChanges:false…` (assert the whole options object); `clicking http link posts openLink and prevents navigation; javascript: and file: are dropped; #anchor scrolls`; `render rejection shows the error view`. **Depends on:** WP-08, 09. **Size:** ~900 lines.

### WP-11 — Xlsx read model (Opus)

**Why Opus:** the row/cell index built here is the structure every later patch writes through.

**Spec:** §9.1, §9.2, §10.2. **Files:** `core/xlsx/workbook.ts`, `core/xlsx/sheet.ts`, `core/xlsx/sharedStrings.ts`, `tests/office/xlsxRead.test.mjs`.

```ts
// workbook.ts
export interface SheetEntry { id: number; name: string; part: string | null; kind: 'worksheet' | 'chartsheet' | 'other';
  state: 'visible' | 'hidden' | 'veryHidden'; rId: string; fileSheetId: number; }
export class Workbook { static load(pkg: OfficePackage): Workbook;
  readonly date1904: boolean; readonly structureLocked: boolean; sheets: SheetEntry[];
  sheet(id: number): Promise<Sheet>;            // parses on first use (xmlAsync), cached
  sharedString(i: number): string; }
// sheet.ts
export type CellValue = { k: 'n'; v: number } | { k: 's'; v: string } | { k: 'b'; v: boolean } | { k: 'e'; v: string } | { k: 'z' };
export interface CellRead { r: number; c: number; value: CellValue; styleIndex: number; formula?: string; shared?: { si: number; master: boolean; ref?: string };
  arrayRef?: string; hasCachedValue: boolean; rich: boolean; cm: boolean; vm: boolean; }
export class Sheet { readonly part: string; readonly readOnlyReason: ReadOnlyReason | null; readonly truncatedAtRow: number | null;
  dimensions(): { rows: number; cols: number };
  cell(r: number, c: number): CellRead | undefined; cellsIn(range: Range): CellRead[];
  rowNode(r: number): XmlElement | undefined; cellNode(r: number, c: number): XmlElement | undefined;   // for the write side
  cols(): ColInfo[]; rowInfo(r: number): RowInfo | undefined; merges(): Range[]; pane(): { frozenRows: number; frozenCols: number };
  hyperlinks(): Map<string, string>; tables(): TableInfo[]; rebuildIndex(): void; }
export type Range = readonly [r0: number, c0: number, r1: number, c1: number];   // 0-based inclusive
export function a1ToRc(ref: string): [number, number]; export function rcToA1(r: number, c: number): string;
```
**Acceptance:** `reads every c/@t kind from basic.xlsx with the values ExcelJS reports` (cross-check, all cells); `shared strings: rich runs concatenated, rPh ignored`; `inline-strings.xlsx and no-shared-strings.xlsx read`; `prefixed-namespaces.xlsx reads identically to its unprefixed twin`; `sheet without r attributes → unsupported-xml-layout`; `protected-sheet.xlsx → protected; protected-structure.xlsx → structureLocked only`; `date1904 flag`; `chartsheet entry has kind chartsheet and no part parse`; `large.xlsx index builds within the WP-01 S4 budget`; `over-limit sheet (makeHugeXlsx) → workbook view-only, truncatedAtRow 50000`. **Depends on:** WP-06. **Size:** ~900 source + ~450 test lines.

### WP-12 — Xlsx styles and display formatting (Sonnet)

**Why Sonnet:** table lookups and a library wrapper, each rule spelled out in §7.2/§9.2/§11.1.

**Files:** `core/xlsx/styles.ts`, `core/xlsx/format.ts`, `tests/office/xlsxStyles.test.mjs`, `tests/office/xlsxFormat.test.mjs`.

```ts
export class StyleTable { static load(pkg: OfficePackage, stylesPart: string | null, themePart: string | null): StyleTable;
  readonly xfCount: number; numFmtId(styleIndex: number): number; formatCode(styleIndex: number): string;
  isDateStyle(styleIndex: number): boolean; isTextStyle(styleIndex: number): boolean; isPercentStyle(styleIndex: number): boolean;
  dto(styleIndex: number): XlsxStyle; }                                    // theme+tint and indexed palette resolved to #rrggbb
export function displayString(value: CellValue, formatCode: string, date1904: boolean): { text: string; color?: string };
export function editSeed(cell: CellRead, styles: StyleTable, date1904: boolean): string;   // §9.3 seeding rules
export function unitsToPx(colWidthChars: number): number; export function pointsToPx(pt: number): number;
```
**Acceptance:** `theme colour + tint matches the values Excel shows for styles.xlsx` (expected hex table in the test, taken from `expected/styles.pdf` by hand once); `indexed palette`; `border styles map to CSS`; `built-in ids 0–49 and custom codes format like Excel for the table in basic.xlsx` (expected strings captured by `make-excel.ps1` into `tests/fixtures/office/expected/basic-display.json` via `Range.Text`); `[Red] section yields a colour`; `1904 dates`; `isDateFormat drives kind 'd'`; `editSeed: ISO for dates, full precision for numbers, '=' + formula`. **Depends on:** WP-06 (shared declarations come from `core/xlsx/types.ts`, written by WP-02, so this runs in parallel with WP-11). **Size:** ~800 lines.

### WP-13 — Grid maths (Sonnet)

**Why Sonnet:** pure arithmetic with a complete list of functions and cases.

**Files:** `media/xlsxGridMath.js` (UMD, pure, pattern of `media/gltfViewerMath.js`), `tests/office/xlsxGridMath.test.mjs`.

Exports: `buildAxis(count, defaultPx, overrides, hidden)` → `{ offsetOf(i), indexAt(px), total }` (prefix sums, binary search); `visibleWindow(scroll, viewport, axes, frozen, overscan)`; `requestRanges(window, maxCells=20000)`; `mergeAt(merges, r, c)`; `moveActive(state, key, modifiers, meta, isEmpty)` (arrows, Tab, Enter, Home/End, Ctrl+arrows data-edge jump, Page keys, Shift-extend, Ctrl+A); `selectionStats(cells)` (Sum/Average/Count); `toTsv(cells, range)`.
**Acceptance:** one test per export, including hidden rows/cols, frozen panes, merged-cell navigation, and the 20,000-cell request cap. **Depends on:** WP-07. **Size:** ~700 lines.

### WP-14 — Xlsx provider view path (Sonnet)

**Why Sonnet:** DTO building and message glue over the finished read model.

**Files:** `src/office/xlsxEditorProvider.ts`, `core/xlsx/notices.ts` (`detectSheetNotices(wb, sheet): OfficeNotice[]`), `core/xlsx/find.ts` (`findInWorkbook(wb, query, matchCase, sheetId): Promise<{ matches; truncated }>`), `core/xlsx/view.ts` (`sheetMeta(wb, sheet, styles): XlsxSheetMeta`, `cellWindow(wb, sheet, styles, range, staleAll): { cells: XlsxCell[]; styles: Record<number, XlsxStyle> }`, `toTsv(wb, sheet, styles, range): string`), `src/extension.ts` (step 2e), `package.json` (xlsx `customEditors` entry, `vscodeMdEditor.office.sheetAppearance`), `tests/office/xlsxProviderLogic.test.mjs`.

Handles `xlsxRequestSheetMeta`, `xlsxRequestCells` (builds `XlsxCell[]` + the style table subset), `xlsxFind` (≤ 1,000 matches), `xlsxCopy` (TSV; Markdown hidden until WP-50), `xlsxRequestCellInput`. All message handling goes through `parseXlsxToHost` then range clamping; out-of-range → error result. The pure pieces live in `core/xlsx/view.ts`, `find.ts` and `notices.ts` so they are bundle-testable; the provider file is glue.

**Acceptance:** `cell window DTOs for styles.xlsx match expected JSON`; `find is capped and reports truncated`; `meta has merges, frozen panes, hidden rows/cols, min 100x26`; `notices name charts, images, pivot, sparklines, CF, DV for features.xlsx`; `stale responses carry the version they were built for`. **Depends on:** WP-08, 11, 12. **Size:** ~900 lines.

### WP-15 — Grid component (Sonnet)

**Why Sonnet:** DOM, CSS and ARIA work against the frozen protocol and WP-13's maths; no file is written.

**Files:** `media/xlsxGrid.js` (global `XlsxGrid`), `media/xlsxGrid.css`, `tests/office/xlsxGrid.test.js` (DOM shim).

`XlsxGrid.create(container, { math, onRequestCells, onActiveChange, onSelectionChange, onEditGesture, onContextMenu, sheetAppearance })` → `{ setMeta(meta), setCells(batch), invalidate(scope), getSelection(), setActive(r, c), focus(), destroy() }`. Virtualised DOM rows, sticky headers, frozen panes, merged cells, hidden-row markers, cell styling from `XlsxStyle`, the §11.1 contrast rule (automatic colour on fills; explicit colour below 3:1), the §11.2 ARIA model (`role=grid`, `aria-activedescendant`, live-region text via callback). No editing — it reports gestures.

**Acceptance:** `renders only the visible window plus overscan`, `recycles on scroll`, `ARIA attributes on grid/row/cell/headers`, `discards a batch for a superseded version`, `contrast rule picks black/white on fills`, `no innerHTML` (grep assertion in the test). **Depends on:** WP-09, 13. **Size:** ~1,300 lines.

### WP-16 — Excel viewer shell (Sonnet)

**Why Sonnet:** toolbar/tab/status-bar wiring.

**Files:** `media/xlsxEditor.js`, `media/xlsxEditor.css`, `tests/office/xlsxEditorShell.test.js`.

Sheet tabs (`tablist`, hidden-sheets menu, chartsheet placeholder), formula bar (read-only here), status bar, find bar (own UI; `xlsxFind`), copy (Ctrl+C → `xlsxCopy`), hyperlink Ctrl+click, comment tooltip + corner marker, per-sheet notices, Ctrl+PageUp/Down, context-menu scaffold (Shift+F10) with only "Copy" enabled. Exposes `window.XlsxShell = { grid, state, registerCellEditor(fn), registerMenuItems(fn) }` — the two hooks WP-23 and WP-41 plug into without editing this file's core.

**Acceptance:** `tab switch requests meta then cells`, `find navigates across sheets`, `status bar sums numeric selection`, `formula bar shows formula for f cells and the stale marker text`, `chartsheet tab shows the placeholder`. **Depends on:** WP-14, 15. **Size:** ~1,200 lines.

### WP-17 — Phase 1 docs and gate run (Sonnet)

**Why Sonnet:** documentation.

**Files:** `README.md` (new "Word and Excel viewers" section: what renders, what does not, default-editor behaviour and how to switch back via `workbench.editorAssociations`, untrusted-workspace statement, privacy statement), `CHANGELOG.md`, `todo.md`, `log.md`.
Then prepares the Gate R1 checklist (§6 below) as a filled-in table in `log.md` for the user/orchestrator to execute in an Extension Development Host. **Size:** ~250 lines.

---

## 6. Review gates

Each gate is a stop: nothing from the next phase merges until it is recorded in `log.md` as passed. Items marked **(human)** need an Extension Development Host or desktop Office and cannot be done by a subagent.

| Gate | After | Checks |
|---|---|---|
| **R0** | PR-2 | See end of §4. |
| **R1** | PR-5 | Phase 1 acceptance in §14 of the spec. Automated: all tests. **(human)**: every fixture opens to a view or the right error view; `rich.docx` visual check; `styles.xlsx` against `expected/styles.pdf`; scroll `large.xlsx`; light, dark, HC dark, HC light; keyboard-only walkthrough; Narrator/NVDA spot check; webview console shows no CSP violation on any fixture; `external-image.docx` makes no request (devtools Network); no fixture becomes dirty. Code review: `/code-review` on PR-3 and PR-4 diffs. |
| **R2** | PR-8 | **Fable review pass** over `core/zip.ts`, `xml.ts`, `package.ts`, `edits.ts`, `save.ts`, `xlsx/{sheet,input,ops,calc,sharedFormula,stylesWrite,validate}.ts`, `officeDocument.ts` — brief: "find any path that writes a file differing from the original outside the declared edit, or that writes without verification". Then Phase 2 acceptance: G0/G3/G4/G5/G6 suites green; **(human)** save, save as, revert, hot exit, undo to clean, conflict modal, locked-file save (file open in Excel), verification-failure hook; `verify-office-open.ps1` green on `tests/.out/**`; edited workbooks recalculate in Excel. Only then flip `xlsxEdit`. |
| **R3** | PR-11 | Phase 3 acceptance incl. the table-cell bullet. `/code-review` (high) on PR-10 and PR-11. **(human)** typing-latency and caret check on `large.docx`; comment still attached in Word after editing `anchors.docx`; table text edit in `tables.docx` opens in Word with the table intact; `verify-office-open.ps1`. S1 confirmed on the user-supplied LibreOffice/Google files. Then flip `docxEdit`. |
| **R4** | PR-14 | Phase 4 acceptance: Tier B refusal tests, Tier C confirmations **(human)**, golden comparison green, `verify-office-open.ps1`. `/code-review` (high) on PR-13. Then flip `xlsxStructure`. |
| **R-final** | PR-15 | **Fable review pass** over the complete `src/office/**` diff against `develop` at the pre-office commit, focused on §10.1 "never drop" and §12 security. The §13.5 manual checklist (§10 of this plan). Definition of done (§11). |

---

## 7. Phase 2 — save pipeline and Excel cell editing

### WP-18 — Edits, undo/redo, serialise, verify (Opus)

**Why Opus:** this is the save path; D11 lives here.

**Spec:** §6.3 (incl. node paths and `generation`), §6.5 steps 3–4, §13.2, §13.3 ("Both"). **Files:** `core/edits.ts`, `core/save.ts`, `core/opc.ts` (**extend** with writers — WP-06 is merged by now, single writer), `tests/office/edits.test.mjs`, `tests/office/save.test.mjs`, `tests/office/_roundtrip.mjs` (shared G3/G4/G5 assertion helpers every later WP uses).

```ts
// edits.ts
export type PartChange =
  | { kind: 'node'; part: string; path: number[]; before: string; after: string }      // '' = absent (insert / remove)
  | { kind: 'attr'; part: string; path: number[]; ns: string; local: string; before: string | null; after: string | null }
  | { kind: 'part'; part: string; before: Uint8Array | null; after: Uint8Array | null };  // stored raw-deflated level 1
export interface OfficeEdit { label: string; changes: PartChange[]; notices?: OfficeNotice[]; }
export function applyEdit(pkg: OfficePackage, edit: OfficeEdit): void;      // atomic: on any failure, already-applied changes are rolled back
export function invertEdit(edit: OfficeEdit): OfficeEdit;
export class EditBuilder { constructor(pkg: OfficePackage, label: string);  // applies as it records, so later steps see earlier ones
  replaceNode(part: string, node: XmlNode, xml: string): XmlNode[]; insertAt(part: string, parent: XmlElement, index: number, xml: string): XmlNode[];
  removeNode(part: string, node: XmlNode): void; setAttr(part: string, el: XmlElement, ns: string, local: string, value: string | null): void;
  setPart(part: string, data: Uint8Array | null): void; notice(n: OfficeNotice): void;
  finish(): OfficeEdit | null;                                               // null when nothing changed
  abort(): void; }                                                           // roll everything back
// opc.ts additions (each takes an EditBuilder)
export function addOverride(b, part, contentType): void; export function removeOverride(b, part): void;
export function addRelationship(b, sourcePart, type, target): string /* rId */; export function removeRelationship(b, sourcePart, rId): void;
// save.ts
export type Validator = (pkg: OfficePackage, touched: string[]) => string[];           // messages; [] = ok
export interface VerifyFailure { part?: string; message: string; }
export function serializeAndVerify(pkg: OfficePackage, validators: Validator[], hooks?: { corrupt?(bytes: Uint8Array): Uint8Array }):
  { ok: true; bytes: Uint8Array } | { ok: false; failures: VerifyFailure[] };
export const packageValidator: Validator;   // overrides + internal relationship targets resolve; no orphan parts created
```
The `attr` change kind (spec §6.3) lets `cellXfs/@count`, `mergeCells/@count`, `dimension/@ref` and friends change without rewriting their (large) elements, which is what G4 demands.

**Acceptance:** `node replace/insert/remove and attr changes apply and invert to byte-identical parts (G5)` on pretty-printed and single-line parts; `part create/delete inverts`; `applyEdit is atomic: a failing third change leaves the package byte-identical`; `stale before-text is refused`; `finish() returns null for a no-op`; `serializeAndVerify: clean package → original bytes (G0)`; `one touched part → only that entry differs (G3)`; `corrupt hook → ok:false and no bytes returned`; `dangling Override / relationship target fails packageValidator`; `seeded random sequence of 200 synthetic edits with undo/redo interleaved ends byte-identical after full undo`. **Depends on:** WP-06. **Size:** ~800 source + ~600 test lines.

### WP-19 — Full CustomEditorProvider (Opus)

**Why Opus:** undo/dirty/backup semantics against VS Code's contract; mistakes lose user data.

**Spec:** §6 in full, §10.3 (save errors). **Files:** `src/office/officeDocument.ts`, `src/office/officeEditorProviderBase.ts` (becomes `CustomEditorProvider<OfficeDocument>`), `src/office/saveErrors.ts`, `src/extension.ts` (only if registration options change), `package.json` (`vscodeMdEditor.office.startInEditMode`), `tests/office/saveErrors.test.mjs`.

Adds to `OfficeDocument`: `applyEdit(edit): void` (apply, bump `version`, fire the `CustomDocumentEditEvent` with generation-guarded `undo`/`redo` closures, labels from §6.3), `save(target, cancellation)`, `backup(destination)`, `revert()`, serialisation cache keyed by `version`, `editMode`, `flush()` (the `flushPendingEdits`/`flushed` handshake, 1,500 ms timeout), conflict modal, verification-failure message with "Save a copy of diagnostics", error mapping for `EBUSY`/`EPERM`/`EACCES`/`NoPermissions`/`Unavailable`. Exposes `protected validators(): Validator[]` and `protected beforeFirstSerialize(b: EditBuilder)` hooks for the kind-specific providers. Honour `OFFICE_FLAGS`.

**Acceptance (automated):** error mapping table. **Acceptance (human, Gate R2):** the list in R2. Because there is no automated VS Code harness, the WP MUST keep `officeDocument.ts` logic thin and put anything testable in `core/save.ts` or `saveErrors.ts`. **Depends on:** WP-08, 18. **Size:** ~900 lines.

### WP-20 — Xlsx cell write, input classification, calc handling (Opus)

**Why Opus:** first code that rewrites user spreadsheets.

**Spec:** §9.3 (all rows except formula and the date *style*), §9.5 last bullet, §6.5 "Xlsx-only". **Files:** `core/xlsx/input.ts`, `core/xlsx/sheet.ts` (**extend**: write primitives), `core/xlsx/ops.ts`, `core/xlsx/calc.ts`, stubs it must keep compiling against (`sharedFormula.ts`, `stylesWrite.ts`, `structure.ts`, `guards.ts`, `sheetsOps.ts` — replace WP-02's `export {}` with typed stubs matching the signatures given in WP-21/22/38/39/40), `tests/office/xlsxInput.test.mjs`, `tests/office/xlsxCellEdit.test.mjs`.

```ts
// input.ts
export type Classified = { kind: 'clear' } | { kind: 'text'; text: string } | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean } | { kind: 'date'; serial: number; withTime: boolean } | { kind: 'formula'; text: string /* no '=' */ };
export function classifyInput(input: string, ctx: { isPercentStyle: boolean; isTextStyle: boolean; date1904: boolean }): Classified;
export function numberToXml(n: number): string;                              // shortest round-trip
// sheet.ts additions
writeCell(b: EditBuilder, r: number, c: number, content: { t?: string; s?: number; inner: string } | null): void;  // creates row/cell in order
isReadOnlyCell(r: number, c: number): boolean;                                 // §9.3 'ro' rules
// ops.ts
export type OpResult = { ok: true; edit: OfficeEdit | null; invalidate: 'cells' | 'sheet' | 'workbook'; sheetId?: number; range?: Range; confirm?: string[] }
                     | { ok: false; error: OfficeError };
export function applyXlsxEdit(wb: Workbook, pkg: OfficePackage, op: XlsxEditOp, opts: { confirmed: boolean }): Promise<OpResult>;
// calc.ts
export function ensureFullCalcOnLoad(b: EditBuilder, wb: Workbook): void;     // idempotent; sets calcPr, drops calcChain + rel + Override
```
`setCells`: classify → for `formula` call `sharedFormula`/formula entry (stub until WP-21 returns `blocked`); for `date` call `stylesWrite.dateStyleFor` (stub until WP-22 returns "store serial, keep `s`"). Paste is `setCells` with many cells (≤ 10,000; refuse on any read-only cell). `clearCells`. The first value/structure edit of a session adds `ensureFullCalcOnLoad` to the same edit.

**Acceptance:** `classifyInput` table (≥ 60 rows: every §9.3 line, `'`-prefix, `1e5`, `.5`, `5.`, `12%` in/out of a percent cell, `true`, ISO dates valid/invalid/out of range, Text-formatted cell); per input kind on `basic.xlsx`: **G3** touched set = `{sheet}` (+ `workbook.xml`, its rels, `[Content_Types].xml`, minus `xl/calcChain.xml` on the first edit), **G4** difference confined to the one `c` (or new `row`), **G5** undo byte-identity, **G6** ExcelJS reads the expected value; `new cell inherits row/column style`; `clear keeps a styled c, removes an unstyled one`; `rich-text cell becomes plain inlineStr, s kept`; `rows and cells inserted in order, including before the first and after the last`; `paste 3x3 is one edit; paste onto a table header is refused and changes nothing`; `calcPr created in schema position when absent; fullCalcOnLoad set once`; `works on prefixed-namespaces.xlsx, inline-strings.xlsx, libreoffice.xlsx`; `seeded 200-op random setCells/clear sequence on basic.xlsx and formulas.xlsx: full undo is byte-identical`. **Depends on:** WP-11, 12, 18. **Size:** ~900 source + ~650 test lines.

### WP-21 — Formula entry and shared formulas (Opus)

**Why Opus:** an invalid or mistranslated formula makes Excel report the workbook as corrupt, or silently computes the wrong cells.

**Spec:** §9.4, §9.5 (first four bullets). **Files:** `core/xlsx/sharedFormula.ts`, `core/xlsx/refs.ts` (first slice), `core/xlsx/xlfn.ts` (the `_xlfn.` function-name list), `tests/office/xlsxFormula.test.mjs`.

```ts
// refs.ts (slice 1)
export function validateFormula(text: string): { ok: true } | { ok: false; position: number; message: string };
export function translateFormula(text: string, dRow: number, dCol: number): string;     // relative refs only; preserves all other text
export function addXlfnPrefixes(text: string): string; export function stripXlfnPrefixes(text: string): string;
// sharedFormula.ts
export function setFormula(b: EditBuilder, sheet: Sheet, r: number, c: number, text: string): OfficeError | null;   // removes <v>
export function materialiseGroup(b: EditBuilder, sheet: Sheet, si: number): void;
export function materialiseAll(b: EditBuilder, sheet: Sheet): void;                     // used by structural ops
```
**Acceptance:** `unparseable formula is rejected with a position and nothing is written`; `edited formula cell has no <v>, t removed`; `editing a dependant replaces only its f`; `editing/clearing a master materialises every dependant with the correct translated text` (expected strings captured from Excel into `tests/fixtures/office/expected/formulas-shared.json` by `make-excel.ps1`); `translateFormula leaves $-anchored parts, strings, sheet names and structured refs untouched`; `_xlfn prefix added for XLOOKUP, LET, FILTER… and stripped for display; list covers the names in expected/xlfn-names.json`; G3–G6 for formula entry. **Depends on:** WP-20. **Size:** ~700 source + ~450 test lines.

### WP-22 — Date style patch and xlsx validators (Opus)

**Why Opus:** the only write to `styles.xml`; a wrong index silently restyles other cells.

**Spec:** §9.3.1, §13.3 (xlsx + styles rules). **Files:** `core/xlsx/stylesWrite.ts`, `core/xlsx/validate.ts`, `tests/office/xlsxDateStyle.test.mjs`, `tests/office/xlsxValidate.test.mjs`.

```ts
export function dateStyleFor(b: EditBuilder, styles: StyleTable, baseStyleIndex: number, withTime: boolean,
  cache: Map<string, number>): { styleIndex: number } | { fallback: 'text'; notice: OfficeNotice };
export const xlsxValidator: Validator;     // every §13.3 xlsx rule; styles rules when xl/styles.xml is touched
```
Algorithm exactly as §9.3.1: effective-format gate (General only), target = copy of base `xf` with `numFmtId` 14/22 and `applyNumberFormat="1"`, reuse-before-append, append as last child via `insertAt` + `attr` change on `count`, 65,490 cap, fallbacks. `StyleTable` must be refreshed after the append (add `StyleTable.reload()` call site here; WP-12's class already reloads from the part).

**Acceptance** (these are the Phase 2 date criteria in spec §14):
- `date in a General cell: v is the serial, s points at an xf with numFmtId 14; ExcelJS reads a Date`
- `date-time uses numFmtId 22`
- `touched set is exactly {sheet, xl/styles.xml} (G3); every pre-existing xf byte-identical and at the same index; only cellXfs/@count and the appended xf differ (G4)`
- `styled General cell keeps fontId/fillId/borderId/alignment`
- `second date in a like-styled cell appends nothing; existing Excel-written date xf is reused`
- `date-formatted, currency-formatted target: styles.xml untouched, serial stored; Text-formatted target: stored as text`
- `no-date-style-nocount.xlsx: no count attribute is invented`
- `no-styles.xlsx: falls back to text with the notice`
- `date1904.xlsx stores the 1904 serial; 1900-02-28 and 1899 dates are text`
- `paste of 50 dates over two base styles appends exactly two records`
- `undo restores styles.xml byte for byte (G5)`
- validators: one failing synthetic input per rule (rows out of order, `s` ≥ `cellXfs` count, overlapping merges, two shared masters, unparseable `<f>`, calcChain present after formula edit, `count` mismatch, moved `xf`…) plus `every fixture and every tests/.out workbook from WP-20/21 passes`.

**Depends on:** WP-21. **Size:** ~600 source + ~600 test lines.

### WP-23 — Xlsx editing wiring (Sonnet)

**Why Sonnet:** glue and UI over finished, tested core functions.

**Files:** `src/office/xlsxEditorProvider.ts` (handle `xlsxEdit` → `applyXlsxEdit` → `doc.applyEdit` → `xlsxEditResult`; `stale` flag on all formula cells and the banner once any edit exists; `validators()` returns `[packageValidator, xlsxValidator]`; undo/redo/revert → `xlsxStateChanged`), `media/xlsxCellEditor.js` (registered through `XlsxShell.registerCellEditor`: F2/Enter/typing-replaces, Enter/Tab commit-and-move, Esc cancel, Delete clear, Ctrl+V paste, formula-bar editing, rich-text hint, View-mode hint, error display for rejected formulas, in-progress edit discarded on `xlsxStateChanged`, Ctrl+Z handling per WP-01 S3, `flushPendingEdits`), `media/xlsxEditor.css` (editor styles only), `tests/office/xlsxCellEditor.test.js`. Final commit of PR-8 flips `OFFICE_FLAGS.xlsxEdit` after Gate R2.

**Acceptance:** `typing in View mode shows the hint and posts nothing`; `Enter commits with baseVersion and moves down`; `stale result triggers a refetch`; `Esc posts nothing`; `flushPendingEdits commits then answers flushed`; `paste splits TSV and posts one setCells`. **Depends on:** WP-16, 19, 22. **Size:** ~1,000 lines.

### WP-24 — Office verification scripts (Sonnet)

**Why Sonnet:** a scripted COM loop specified in §13.5.

**Files:** `scripts/verify-office-open.ps1` (§13.5 layer 1: iterate `tests/.out/**`, Word `Documents.Open(…, OpenAndRepair:=$false, ReadOnly:=$true)`, Excel `Workbooks.Open(…, CorruptLoad:=0)`, non-zero exit on any failure, quits the COM apps in `finally`; for workbooks with a sibling `<name>.expect.json` read back the listed cells after recalculation), `scripts/validate-openxml/` (a `dotnet` file-based script using `DocumentFormat.OpenXml` `OpenXmlValidator`; optional layer 2), `tests/office/README.md` (how to run both). `_helpers.mjs` `writeOut` gains an optional `expect` argument that writes the `.expect.json`.
**Acceptance:** run against the WP-20–22 outputs; results pasted into `log.md`. **Parallel with:** WP-19, 20. **Size:** ~350 lines.

---

## 8. Phase 3 — Word editing

Table-cell editing (decision Q3) is part of every WP below, not a separate one: the model's container abstraction makes a cell paragraph the same object as a body paragraph.

### WP-25 — Docx block and segment model (Opus)

**Why Opus:** misclassifying content as editable is how fields, comments and tracked changes get destroyed.

**Spec:** §8.1 (containers, table-cell rules), §8.3 (classification table), §10.2. **Files:** `core/docx/model.ts`, `tests/office/docxModel.test.mjs`.

```ts
export interface Container { readonly el: XmlElement; /* w:body or w:tc */ readonly tableBlockId: number | null; readonly row: number; readonly col: number; }
export interface Block { readonly id: number; readonly el: XmlElement; readonly kind: 'paragraph' | 'opaque'; readonly container: Container;
  readonly isTable: boolean; lockReason?: DocxBlockInfo['lockReason']; }
export type Segment = { kind: 'text'; id: number; text: string; run: XmlElement; rPr: XmlElement | null; pieces: XmlElement[]; wholeRun: boolean }
  | { kind: 'atom'; id: number; atomType: ...; label: string; nodes: XmlNode[] }
  | { kind: 'anchor'; id: number; node: XmlNode; pairKey?: string; role?: 'start' | 'end' }
  | { kind: 'disposable'; nodes: XmlNode[] };
export class DocxModel { static load(pkg: OfficePackage): DocxModel;
  readonly mainPart: string; readonly viewOnlyReason: ReadOnlyReason | null;
  blocks(): Block[];                              // every container, document order
  block(id: number): Block | undefined;
  siblings(b: Block): { prev: Block | null; next: Block | null };          // same container only
  segments(b: Block): Segment[];                  // classification; throws never — unknown content sets lockReason
  refresh(): void;                                // after an edit: re-walk, keep ids for surviving nodes, new ids for new nodes
  tableCensus(): string; }                        // counts + concatenated tblPr/tblGrid/trPr/tcPr text, for the validator
```
Ids are held in a `WeakMap<XmlElement, number>`; `refresh()` never reuses a number.

**Acceptance:** `body paragraphs, tables and sectPr of basic/rich.docx classify as expected (snapshot of kind/lockReason per block)`; `tables.docx: cell paragraphs are blocks with parentId/cell; nested table cells are containers; vMerge continuation → merged-cell; restart and gridSpan cells editable; content-control row not descended; tracked row → tracked-changes`; `multi-run.docx: tab/br/noBreakHyphen/softHyphen map into text; mixed run splits into segments sharing rPr`; `fields.docx: same-paragraph complex field is one atom labelled with its result; TOC paragraphs → multi-paragraph-field`; `anchors.docx: bookmark and comment range markers are anchors with pair keys`; `tracked.docx: w:ins/w:del/rPrChange lock`; `unknown child element locks with unknown-content`; `proofErr and lastRenderedPageBreak are disposable`; `refresh keeps ids of untouched blocks`; `> 20,000 blocks → too-large`. **Depends on:** WP-18. **Size:** ~900 source + ~500 test lines.

### WP-26 — Docx styles and numbering, read side (Sonnet)

**Why Sonnet:** lookup chains fully specified in §8.3/§8.6. **Files:** `core/docx/styles.ts`, `core/docx/numbering.ts`, `tests/office/docxStylesRead.test.mjs`.

```ts
export class DocxStyles { static load(pkg, mainPart): DocxStyles; readonly part: string | null;
  defaultParagraphStyleId(): string | null; headingStyleId(level: number): string | null;   // by w:name 'heading N', else outlineLvl
  listParagraphStyleId(): string | null; styleInfo(pStyleId: string | null): DocxBlockInfo['style'];
  effectiveToggles(pStyleId: string | null, rPr: XmlElement | null): { b: boolean; i: boolean; u: boolean };
  inheritedToggles(pStyleId: string | null, rStyleId: string | null): { b: boolean; i: boolean; u: boolean };   // styles only, no direct rPr
  runCss(rPr: XmlElement | null): DocxRunCss; styleNumPr(pStyleId: string | null): { numId: number; ilvl: number } | null; reload(): void; }
export class DocxNumbering { static load(pkg, mainPart): DocxNumbering; readonly part: string | null;
  listInfo(numId: number, ilvl: number): DocxBlockInfo['list']; maxAbstractNumId(): number; maxNumId(): number;
  findOwnAbstract(kind: 'bullet' | 'number'): number | null; reload(): void; }
```
**Acceptance:** `localised-de (real or synthetic): Heading 1–3 found by name, never by id`; `outlineLvl fallback`; `effective bold through basedOn chains and docDefaults; w:b w:val="0|false|off" is off`; `list kind for bullet/decimal/roman/other`; `no-heading-styles.docx and no-numbering.docx load with nulls`; `numPr via paragraph style`. **Depends on:** WP-06. **Parallel with:** WP-25, 32. **Size:** ~750 lines.

### WP-27 — Render copy and DOM mapping (Opus)

**Why Opus:** if a marker leaks into a save or a mapping is wrong, edits land in the wrong paragraph.

**Spec:** §8.2 (incl. the same-cell rule). **Files:** `core/docx/renderCopy.ts`, `media/docxMap.js` (UMD, pure DOM), `tests/office/renderCopy.test.mjs`, `tests/office/docxMap.test.js`. (If WP-01 chose Fallback 1, this WP also owns the patched vendor file and the marker becomes an attribute; the public functions below keep their signatures.)

```ts
export function buildRenderCopy(pkg: OfficePackage, model: DocxModel): { bytes: Uint8Array; markedBlockIds: number[] };
```
```js
DocxMap.mapBlocks(root, blockInfos) // -> { byId: Map<number, HTMLElement[]>, missing: number[] }; sets data-block, role=heading/aria-level
DocxMap.blockOf(node)               // nearest data-block id or null
```
Implementation rule: the copy is produced by string-splicing marker XML into the serialised main part and writing a zip with one replaced entry — it MUST NOT touch the live `XmlDoc` or `pkg` (assert `pkg.touchedParts()` is unchanged and `serialize()` still returns the original bytes).

**Acceptance:** `copy differs from the original only in the main part; live package untouched`; `one marker pair per editable paragraph in body and cells; none in merged-cell paragraphs; ids from 2,000,000,000 and unique against existing bookmark ids`; `copy passes the lossless parser and saxes`; `mapBlocks: page-break-split body paragraph gets both <p>; a table between the halves is not claimed; cell paragraphs map within their td; nested-table paragraphs map to the inner cell; start/end in different cells → missing` (DOM shim trees hand-built to mirror docx-preview output captured in WP-01); `docx validator rejects a package containing __vsmd_`. **Depends on:** WP-25. **Size:** ~650 lines.

### WP-28 — Paragraph writer (Opus)

**Why Opus:** run preservation and the never-drop rule; the highest-risk Word code.

**Spec:** §8.4 rules 1–8. **Files:** `core/docx/paragraphWriter.ts`, `tests/office/paragraphWriter.test.mjs`.

```ts
export const RPR_ORDER: readonly string[]; export const PPR_ORDER: readonly string[];      // full schema sequences
export function buildParagraphXml(model: DocxModel, styles: DocxStyles, block: Block, items: DocxCommitItem[],
  opts?: { pPrXml?: string; keepIds?: boolean }): { xml: string; changed: boolean; reinsertedAtoms: boolean } | OfficeError;
export function commitParagraph(b: EditBuilder, model: DocxModel, styles: DocxStyles, blockId: number, items: DocxCommitItem[]): OpOutcome;
export function setToggle(rPrXml: string | null, which: 'b' | 'i' | 'u', on: boolean, inheritedOn: boolean, doc: XmlDoc): string;
export function upsertPPrChild(pPrXml: string | null, childLocal: string, xml: string | null, doc: XmlDoc): string;   // schema order
```
**Acceptance** (each also asserts G3 = `{main part}`, G4 confined to the `w:p`, G5): `unchanged commit → no edit`; `text edit in one run of multi-run.docx: every other run's XML slice byte-identical incl. rsid attributes`; `partial-selection bold splits one run into three with copied rPr`; `bold off inside a Heading writes w:b w:val="0" and bCs`; `underline keeps an existing non-none w:u value`; `rPr children emitted in schema order whatever the source order`; `tab and newline become w:tab / w:br; leading/trailing spaces get xml:space="preserve"`; `src:null run has no rPr`; `atoms and anchors re-emitted verbatim at committed positions`; `select-all-and-type over an image keeps the image and raises the notice`; `dropped bookmark pair re-inserted start before end` (`anchors.docx`); `w14:textId removed on change, paraId kept`; `illegal XML chars stripped`; `same tests on a cell paragraph of tables.docx: the rest of the table byte-identical`; `locked block is refused`. **Depends on:** WP-25, 26. **Size:** ~900 source + ~700 test lines.

### WP-29 — Paragraph structure operations (Opus)

**Why Opus:** section breaks, anchors and the cell-must-end-with-a-paragraph rule are all ways to produce a file Word repairs.

**Spec:** §8.5 incl. the Containers bullet. **Files:** `core/docx/ops.ts`, typed stub for `stylesWrite.ts`, `tests/office/docxStructure.test.mjs`.

```ts
export type OpOutcome = { ok: true; edit: OfficeEdit | null; changedBlockIds: number[]; focus?: { blockId: number; at: 'start' | 'end' | number } }
                      | { ok: false; error: OfficeError };
export function applyDocxEdit(ctx: { pkg: OfficePackage; model: DocxModel; styles: DocxStyles; numbering: DocxNumbering }, op: DocxEditOp): OpOutcome;
export function blockInfos(ctx): DocxBlockInfo[];        // incl. removable, parentId, cell
```
Implements `commitParagraph` (delegates), `splitParagraph`, `mergeWithPrevious`, `insertParagraphAfter`, `removeParagraph`; dispatches `setStyle`/`setList`/`setListLevel` to `stylesWrite.ts`.

**Acceptance:** `split: pPr copied, sectPr stays on the second half, no paraId/textId/rsid on the new p`; `split at end honours w:next and drops numPr`; `Enter in an empty list item removes numbering instead`; `merge keeps the first pPr; refused when the first has sectPr, a neighbour is locked/opaque, or the neighbour is in another container`; `remove: refused with atoms, sectPr, last paragraph; anchors move to the next sibling paragraph (or previous)`; **cells:** `split inside a cell adds a p to that tc only`; `only paragraph of a cell not removable`; `cell's last p after a nested table not removable`; `Backspace-merge at the first paragraph of a cell is refused`; `insertParagraphAfter(nested table) inserts in the holding cell`; `insertParagraphAfter(null)` and after a body table; `table census unchanged after every cell operation`; G3–G5 per op; `seeded 200-op random sequence over basic.docx and tables.docx undoes to identical bytes`. **Depends on:** WP-28. **Size:** ~800 source + ~650 test lines.

### WP-30 — Styles and lists, write side (Opus)

**Why Opus:** creates parts, relationships and numbering definitions; id and ordering mistakes corrupt the document.

**Spec:** §8.6. **Files:** `core/docx/stylesWrite.ts`, `tests/office/docxStylesWrite.test.mjs`.

```ts
export function setStyle(b: EditBuilder, ctx, blockIds: number[], style: 'normal' | { heading: 1|2|3|4|5|6 }): OfficeError | null;
export function setList(b: EditBuilder, ctx, blockIds: number[], list: 'none' | 'bullet' | 'number'): OfficeError | null;
export function setListLevel(b: EditBuilder, ctx, blockIds: number[], delta: 1 | -1): OfficeError | null;
```
**Exact markup created by this editor** (spec §8.6 delegates it here). `w:` stands for whatever prefix the target part's root binds to the WordprocessingML namespace; everything is emitted on one line with no whitespace between elements; `{D}` is the default paragraph style id (`w:style[@w:type="paragraph"][@w:default="1"]`), and the `w:basedOn`/`w:next` elements are omitted when there is none.

- Heading *N* (appended as the last child of `w:styles`; `w:styleId` `Heading{N}`, or `Heading{N}_2`, `_3`… if taken):
  `<w:style w:type="paragraph" w:styleId="Heading{N}"><w:name w:val="heading {N}"/><w:basedOn w:val="{D}"/><w:next w:val="{D}"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{B}" w:after="0"/><w:outlineLvl w:val="{N-1}"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/>{I}<w:sz w:val="{S}"/><w:szCs w:val="{S}"/></w:rPr></w:style>`
  with `{B}` = 240 for level 1, 40 otherwise; `{S}` (half-points) = 32, 26, 24, 22, 22, 22 for levels 1–6; `{I}` = `<w:i/><w:iCs/>` for levels 4 and 6, empty otherwise.
- List Paragraph (`w:styleId` `ListParagraph`, suffixed if taken):
  `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="{D}"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>`
- Abstract numbering, nine levels `k` = 0…8, `{A}` = max `w:abstractNumId` + 1 (0 if none), inserted after the last existing `w:abstractNum` (or as the first child after any `w:numPicBullet`):
  `<w:abstractNum w:abstractNumId="{A}"><w:multiLevelType w:val="hybridMultilevel"/><w:name w:val="VSMDBullet"/>{levels}</w:abstractNum>` with level
  `<w:lvl w:ilvl="{k}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="{G}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720*(k+1)}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="{F}" w:hAnsi="{F}" w:hint="default"/></w:rPr></w:lvl>`
  where (`{G}`, `{F}`) cycles by `k mod 3`: (U+F0B7, `Symbol`), (`o`, `Courier New`), (U+F0A7, `Wingdings`).
  `VSMDNumber` is the same shape with `<w:numFmt w:val="{decimal|lowerLetter|lowerRoman by k mod 3}"/><w:lvlText w:val="%{k+1}."/>` and no `w:rPr`.
- Concrete numbering, `{M}` = max `w:numId` + 1 (1 if none), inserted after the last `w:num` (before `w:numIdMacAtCleanup` if present):
  bullets (one shared): `<w:num w:numId="{M}"><w:abstractNumId w:val="{A}"/></w:num>`;
  each new numbered list: `<w:num w:numId="{M}"><w:abstractNumId w:val="{A}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`.
- A missing numbering part is created as `numbering.xml` beside the main part: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + CRLF + `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">…</w:numbering>`; relationship type `http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering`, target `numbering.xml`; content type `application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml`. A missing styles part is **not** created: heading/list operations return `blocked` ("This document has no style sheet").
- List joining looks only at sibling blocks in the same container (a list in a table cell never joins one outside it).

**Acceptance:** `setStyle replaces only w:pStyle; creates pPr as first child when absent; Normal removes it`; `heading style created in no-heading-styles.docx matches the markup above character for character and is found again by name on reload`; `existing localised heading style is reused, not duplicated`; `bullets join an adjacent Word list (same numId/ilvl)`; `new numbered list gets a new num with startOverride; second separate list restarts at 1`; `numbering.xml, relationship and Override created from nothing (no-numbering.docx); touched set asserted exactly (G3)`; `abstractNums precede nums after insertion`; `list off: numPr removed, or numId 0 when inherited from the style; List Paragraph pStyle removed`; `level change clamps 0–8`; `list inside a table cell`; G5 for every op incl. part creation; every output passes `docxValidator` and saxes. **Depends on:** WP-29. **Size:** ~800 source + ~600 test lines.

### WP-31 — Docx validators and protection (Sonnet)

**Why Sonnet:** a checklist of independent rules from §13.3; a missed rule weakens a safety net but writes nothing.

**Files:** `core/docx/validate.ts` (`docxValidator: Validator` — every §13.3 docx rule incl. the `w:tc` and table-census rules; takes the load-time census from the model), `core/docx/protection.ts` (`detectProtection(pkg): { readOnlyReason: 'protected' | 'tracked-changes-on' | null }` per §8.7), `tests/office/docxValidate.test.mjs`.
**Acceptance:** one failing synthetic input per rule; every docx fixture passes; `protected.docx → protected`; `tracked.docx → tracked-changes-on`. **Parallel with:** WP-27, 28. **Size:** ~600 lines.

### WP-32 — Island DOM ↔ segments (Opus)

**Why Opus:** this walker decides what text is committed; a miss here deletes user text or formatting.

**Spec:** §8.4 first paragraph. **Files:** `media/docxIsland.js` (UMD, no globals beyond `document` passed in), `tests/office/docxIsland.test.js` (DOM shim).

```js
DocxIsland.build(doc, segments, paragraphEl)      // fills paragraphEl: span[data-seg], chips[data-atom], span[data-anchor]
DocxIsland.read(paragraphEl)                      // -> DocxCommitItem[] (merges adjacent equal (src,b,i,u); <br> -> '\n'; nbsp handling)
DocxIsland.splitAt(paragraphEl, range)            // -> { before: DocxCommitItem[], after: DocxCommitItem[] }
DocxIsland.toggle(paragraphEl, range, 'b'|'i'|'u')// splits spans, flips data-b/i/u, returns new range
DocxIsland.caretAtStart(paragraphEl, range) / caretAtEnd(...) / setCaret(paragraphEl, at)
```
**Acceptance:** `build then read is the identity for every segment list in the WP-25 snapshots`; `text typed in a span, before the first span, after the last, between two chips, and in an empty paragraph gets the documented src`; `browser-inserted <b>/<i>/<font>/<div> wrappers and stray <br> are normalised`; `chips and anchors survive and keep order; a deleted chip is simply absent (host re-inserts)`; `toggle on a partial selection yields three items`; `splitAt keeps atoms on the correct side`; `pasted HTML is reduced to text`. **Depends on:** WP-07 only — **parallel with WP-25/26**. **Size:** ~600 source + ~500 test lines.

### WP-33 — Docx provider edit path (Sonnet)

**Why Sonnet:** message glue over tested core functions.

**Files:** `src/office/docxEditorProvider.ts`: `docxRequestRender` now sends the render copy + `blockInfos`; `docxRequestBlockModel`; `docxEdit` → `applyDocxEdit` → `doc.applyEdit` → `docxEditResult` (full block list, `changedBlockIds`, `focus`); `docxStateChanged` on undo/redo/revert/reload with `model.refresh()` and `styles/numbering.reload()`; `validators()` = `[packageValidator, docxValidator]`; protection → `readOnlyReason`; the "Edit anyway (changes will not be tracked)" modal, once per open. `tests/office/docxProviderLogic.test.mjs` for any pure helper extracted to `core/docx/notices.ts`.
**Depends on:** WP-19, 27, 30, 31. **Size:** ~500 lines.

### WP-34 — Island controller and re-render scheduling (Opus)

**Why Opus:** caret stability and never losing an in-progress edit; the project has been bitten here before (`wysiwyg-cursor-fix` memory).

**Spec:** §8.8, §6.3 last paragraph, §6.4. **Files:** `media/docxEdit.js` (global `DocxEdit`, initialised by `docxEditor.js` through one added line owned by this WP), `media/docxEditor.js` (that line + swapping `renderAsync` output through `DocxMap`), `tests/office/docxEdit.test.js`.

Behaviour: open island on click (request block model → `DocxIsland.build`), commit on blur / block change / 1.5 s idle (without rebuilding the island DOM) / `flushPendingEdits`; optimistic split/merge DOM updates with ids from `docxEditResult`; detached re-render and swap only when no island is open, 2 s after last focus or immediately after style/list/undo/redo/revert, restoring scroll to the block nearest the viewport top; cancel the in-progress edit with the §6.3 message on `docxStateChanged`; ArrowUp/Down across blocks in document order (crossing into and out of cells); Tab/Shift+Tab per §11.3 (list level, else next/previous **cell**, else tab; Ctrl+Tab inserts a tab); Enter in a cell splits within the cell; lock tooltips via `aria-describedby`; Ctrl+Z per WP-01 S3.

**Acceptance (DOM shim, fake timers):** `no render call while an island has focus`; `idle commit does not replace island nodes (node identity asserted)`; `stale result → refetch and reopen`; `docxStateChanged with an open island discards and announces`; `swap keeps scroll anchor`; `Tab in a cell commits and focuses the next cell's first editable block; at the last cell nothing happens`; `Backspace at start posts mergeWithPrevious only when the previous sibling is in the same container`. **(human, R3)**: caret never jumps on `large.docx`. **Depends on:** WP-10, 27, 32, 33. **Size:** ~1,200 lines.

### WP-35 — Word edit toolbar, shortcuts, CSS (Sonnet)

**Why Sonnet:** toolbar and keybinding wiring.

**Files:** `media/docxEditor.js` (toolbar items via `OfficeCommon.toolbar`: B/I/U with `aria-pressed`, style picker, Bullets, Numbering, Outdent, Indent; §11.3 Word shortcuts; context menu with Shift+F10 equivalents of hover actions: "Insert paragraph after", "Remove paragraph"), `media/docxEditor.css` (hover outline, lock styling, chips, table-cell focus ring), `tests/office/docxToolbar.test.js`. Last commit of PR-11 flips `OFFICE_FLAGS.docxEdit` after Gate R3.
**Acceptance:** `Ctrl+B toggles through DocxIsland.toggle and updates aria-pressed`; `style picker posts setStyle for the caret block`; `toolbar disabled in View mode and on locked blocks`; `Ctrl+Alt+1…6, Ctrl+Shift+7/8 map correctly`. **Depends on:** WP-34. **Size:** ~700 lines.

---

## 9. Phase 4 — Excel structure

### WP-36 — Reference shifting (Opus)

**Why Opus:** a wrong shift is silent semantic damage — formulas that still calculate, on the wrong cells.

**Spec:** §9.6 first paragraph, §9.7 (rename/delete rewriting). **Files:** `core/xlsx/refs.ts` (extend), `tests/office/xlsxRefs.test.mjs`.

```ts
export interface StructuralShift { sheetName: string; axis: 'row' | 'col'; at: number; count: number; /* >0 insert, <0 delete */ }
export function shiftFormula(text: string, shift: StructuralShift, formulaSheetName: string): { text: string; changed: boolean; has3dSpanning: boolean };
export function shiftSqref(sqref: string, shift): string | null;          // null = every range deleted
export function shiftRange(ref: string, shift): string | '#REF!';
export function renameSheetInFormula(text: string, oldName: string, newName: string): string;
export function deleteSheetInFormula(text: string, name: string): string;  // -> #REF!
export function formulaMentionsSheet(text: string, name: string): boolean;
export function quoteSheetName(name: string): string;
```
**Acceptance:** the reference-shifting list in spec §14 Phase 4, as a table-driven test of ≥ 120 cases (relative/absolute/mixed; grow, shrink, `#REF!`; whole rows/columns; quoted names with `'` doubled; refs inside string literals untouched; structured and external refs untouched; unqualified refs only on the edited sheet; 3-D detection), plus `all non-reference text is preserved character for character` (property test: shifting by 0 is the identity on every formula in every fixture). **Depends on:** WP-21. **Size:** ~600 source + ~600 test lines.

### WP-37 — Excel-produced goldens (Sonnet)

**Why Sonnet:** scripted COM dump.

**Files:** `scripts/office-fixtures/make-goldens.ps1` — for each case in `tests/fixtures/office/goldens/cases.json` (fixture, sheet, op, index, count) perform the same operation in Excel through COM and dump, per sheet, every formula, merge range, table ref, defined name, CF/DV range and autofilter ref to `goldens/<case>.json`; the committed `cases.json` (≥ 20 cases: start/middle/end rows and columns on `formulas`, `tables`, `features`, `styles`) and outputs; `tests/office/_goldens.mjs` (loader + comparer). This automates the "prepared once by hand" comparison of §14.
**Depends on:** WP-03. **Parallel with:** WP-36. **Size:** ~450 lines.

### WP-38 — Insert/delete rows and columns, Tier A (Opus)

**Why Opus:** rewrites whole sheets and every dependent range in the workbook.

**Spec:** §9.6 Tier A. **Files:** `core/xlsx/structure.ts`, `tests/office/xlsxStructure.test.mjs`.
`export function insertOrDelete(b: EditBuilder, wb: Workbook, sheet: Sheet, axis: 'row' | 'col', at: number, count: number): Promise<void>;` — materialise shared formulas first; rewrite the sheet as a whole-`part` change (renumbering touches every row), other sheets' formulas and `definedNames` as `node` changes, tables as `attr` changes; calc handling.
**Acceptance:** each Tier A item has a test; G3 with the touched set computed by the test (edited sheet, sheets with qualifying references, `workbook.xml` when names shift, table parts); G5; G6 (ExcelJS loads; validators pass); golden comparison for all WP-37 cases; `new rows/columns are empty and unstyled`; `spans removed on column ops`; `mergeCells count corrected / element removed when empty`. **Depends on:** WP-36, 37. **Size:** ~1,000 source + ~500 test lines.

### WP-39 — Tier B/C guards (Opus)

**Why Opus:** a missed Tier B condition lets WP-38 produce a file Excel repairs.

**Spec:** §9.6 Tier B, Tier C; §9.7 confirmations. **Files:** `core/xlsx/guards.ts`, `tests/office/xlsxGuards.test.mjs`.
`export function checkStructuralOp(wb, pkg, op: XlsxEditOp): Promise<{ blocked?: string; confirm?: string[] }>;` — pure inspection, never mutates.
**Acceptance:** one test per Tier B bullet proving refusal **and** an unchanged package (bytes compared); one per Tier C bullet proving the confirmation text names the affected content; `confirmed: true` proceeds. **Parallel with:** WP-38, 40. **Size:** ~600 source + ~450 test lines.

### WP-40 — Add, rename, delete sheet (Opus)

**Why Opus:** part-graph surgery (exclusive-children deletion, `localSheetId` renumbering).

**Spec:** §9.7. **Files:** `core/xlsx/sheetsOps.ts`, `tests/office/xlsxSheets.test.mjs`.
`addSheet`, `renameSheet`, `deleteSheet` (each `(b, wb, …) => OfficeError | null`), `validateSheetName(name, existing)`. New worksheet part: XML declaration + CRLF + `<worksheet xmlns="…/spreadsheetml/2006/main"><sheetData/></worksheet>`, using a prefix instead when the workbook's existing sheets do.
**Acceptance:** `add: part, sheet element, rel, Override; touched set exact; default name first unused`; `rename: validation table (length, forbidden chars, apostrophes, History, case-insensitive duplicate); formulas and names rewritten with quoting`; `delete: exclusive children removed, shared ones kept; localSheetId decremented; activeTab clamped; references → #REF!; refused for last visible sheet / pivot source / chartsheet`; `structureLocked workbook refuses all three`; G3, G5 (incl. part restoration), G6. **Parallel with:** WP-38, 39. **Size:** ~800 source + ~500 test lines.

### WP-41 — Structure UI and wiring (Sonnet)

**Why Sonnet:** menus and modals over finished core functions.

**Files:** `src/office/xlsxEditorProvider.ts` (guard → modal confirmation (default Cancel; delete-sheet modal always) → `applyXlsxEdit({confirmed:true})`; honours `confirmStructuralEdits`), `media/xlsxStructureUi.js` (via `XlsxShell.registerMenuItems`: header menus Insert/Delete rows/columns, tab menu Add/Rename/Delete, inline rename input, blocked-reason announcements), `package.json` (`confirmStructuralEdits`), `tests/office/xlsxStructureUi.test.js`. Last commit of PR-14 flips `xlsxStructure` after Gate R4.
**Depends on:** WP-23, 38, 39, 40. **Size:** ~700 lines.

### WP-42 — v1 release preparation (Sonnet)

**Why Sonnet:** documentation and packaging checks.

`README.md` (editing sections, limitations list from §9.5/§9.6/§8.8, "Excel will offer to save on close"), `CHANGELOG.md` (call out becoming the default editor for `.docx`/`.xlsx`), `THIRD-PARTY-NOTICES.md` re-checked against `package-lock.json`, `vsce ls` re-check, the manual checklist (§10) filled in, `todo.md`/`log.md`. Version bump and publish follow the existing release flow (separate bump PR; check the Marketplace version first). **Size:** ~300 lines.

---

## 10. Per-release manual checklist (§13.5 layer 3)

Run before each release PR that changes editing behaviour; record in `log.md`.

1. `npm test`; then `scripts/verify-office-open.ps1` — zero failures.
2. Optional: `scripts/validate-openxml` over `tests/.out/**`.
3. Open three edited outputs of each kind in desktop Word/Excel: no repair prompt, edits present, untouched content visually unchanged.
4. Same files in Word/Excel for the web and in LibreOffice (if available), and macOS Quick Look (if available).
5. In an Extension Development Host with an isolated profile: open, edit, save, reopen each of `basic`, `rich`, `tables`, `anchors` (docx) and `basic`, `formulas`, `tables`, `features` (xlsx); undo to clean; hot-exit restore.
6. Theme sweep (light, dark, both high-contrast) and a keyboard-only pass of one edit per editor.

---

## 11. Definition of done for v1

- [ ] Gates R0–R4 and R-final recorded as passed in `log.md`; WP-01 report present; every §16 assumption marked verified or replaced.
- [ ] `npm run check-types`, `npm run compile`, `npm test` green on `develop`.
- [ ] G0–G6 suites green for every operation in §6.3's label list, on every fixture they apply to, including the user-supplied LibreOffice and Google files (no `PENDING` fixtures left).
- [ ] Date entry (§9.3.1) and table-cell text editing (§8.1) acceptance bullets of spec §14 pass.
- [ ] `verify-office-open.ps1` green on all `tests/.out/**`; manual checklist (§10) done.
- [ ] Every fixture opens to a view or the specified error view; no fixture is dirtied by viewing.
- [ ] No CSP violations; `external-image.docx` makes no network request.
- [ ] `OFFICE_FLAGS` all `true`; the three settings exist with the §4.1 defaults.
- [ ] `vsce ls`: no `docs/`, `tests/`, `scripts/`, `spike/`; `THIRD-PARTY-NOTICES.md` and the two vendor files present; all five runtime dependencies pinned exactly.
- [ ] README and CHANGELOG describe the viewers, the editing limits, and the default-editor change.
- [ ] `todo.md` fully ticked for Phases 0–4; spec updated wherever implementation diverged.
- [ ] Two Fable review passes (R2, R-final) done and their findings closed or explicitly deferred with the user's agreement.

---

## 12. Post-v1 (coarse)

| WP | Scope (spec §14) | Files | Model | Notes |
|---|---|---|---|---|
| WP-50 | Phase 5: "Copy as Markdown table", "Convert Sheet to Markdown…" | `core/xlsx/markdown.ts` (pure: escaping, alignment, header synthesis, 5,000-row cap), `xlsxEditorProvider.ts`, `media/xlsxEditor.js` menu item, `package.json` command, tests | Sonnet | One run (~500 lines). First, as decided (Q6). |
| WP-51 | Phase 6: Word → Markdown | `src/office/convert/docxToMarkdown.ts`, `package.json` (command, explorer menu, `mammoth` dependency), reuse `media/turndownTableRules.js` logic host-side, output channel, tests on `basic`/`rich`/`localised-de` | Sonnet | Check bundle size from WP-01 S5; load mammoth with dynamic `import()` if > 500 KB. |
| WP-52 | Phase 7: Markdown → Word | `src/office/convert/markdownToDocx.ts` (`docx` dependency), command, tests incl. round trip through WP-51 and `docxValidator` | Opus | Token-to-document mapping with real numbering and styles; output must pass `verify-office-open.ps1`. Likely two runs (core mapping; tables/images/lists). |
| WP-53 | Phase 8a: index, resolution, rename propagation | `src/wikilink/fileIndexService.ts`, `resolveWikilinkTarget`, `renamePropagation.ts`, `src/types.ts` (`FileEntry.kind`), tests | Opus | Touches the shared backlink index; must not change the meaning of any existing link. |
| WP-54 | Phase 8b: autocomplete badge, graph node kind + filter, "Linked from" in the viewers | `media/editor.js`, `media/graph.js`, `media/fullGraph.js`, `graphDataService.ts`, viewers' toolbars | Sonnet | No sidebar tab (Q7). |

WP-50, 51 and 53 are independent and may run in parallel after v1.

---

## 13. Items that need the user

1. **Fixtures** (WP-03): `libreoffice.docx`, `libreoffice.xlsx`, `googledocs.docx`, `googlesheets.xlsx`, and a real German-Word `localised-de.docx`. Recipes will be in `tests/fixtures/office/README.md`. Needed before Gate R3 at the latest; Phase 0–2 proceed without them.
2. **WP-01 S3** needs about five minutes of real key presses in a dev host.
3. **Every gate's (human) items** (§6) — an Extension Development Host session per gate; R2–R4 also need desktop Word/Excel, which is installed on this machine.
4. **Merges**: each PR is self-reviewed and handed over unless the user asks for `gh pr merge --admin`.
5. **Release points**: after Gate R1 (viewers only), R3 (plus editing) or only at R-final — the plan supports all three; the user picks.
