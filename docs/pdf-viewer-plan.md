# PDF Viewer — Implementation Plan

Date: 2026-11-21 · Spec: `docs/pdf-viewer-spec.md` (all `§` references are to it; "Office plan" is `docs/office-viewers-plan.md`) · Starting branch: `feature/pdf-viewer-docs`

This plan slices the spec into work packages (PWPs). Each is sized for one implementation subagent run (≤ ~1,500 changed lines including tests) and names its files, dependencies, acceptance tests and implementer model. The spec says *what*; this document says *in what order, by whom, in which files, and how it is checked*. Where the two disagree, the spec wins and the plan gets fixed.

The plan is written for the recommended answers to the open questions (spec §16.2). §11 says what changes for each other answer. **Answered 2026-11-21:** recommended answers for Q1–Q6 and Q8; Q7 is **(b)** — PWP-02 raises `engines.vscode` and `@types/vscode` for the whole extension to the minimum spike S2 measures (see §11, row Q7), and the README states the new minimum.

---

## 1. Ground rules for every PWP

The orchestrator pastes this section into each brief. Rules 1, 2, 5–10 of the Office plan §1 apply unchanged (read first and load `LSP`; touch only the listed files; done means `check-types`, `compile` and `npm test` green; parallel WPs return `todo.md`/`log.md` entries instead of editing them; no commits or PRs unless told; refuse rather than guess; report honestly what was not verified). PDF-specific rules:

1. **`src/pdf/core/**` MUST NOT import `vscode`**, nor any npm package (`node:zlib` and `node:crypto` are allowed), nor anything outside `core/` except type-only imports from `../protocol.js`. Imports between source files use the `./x.js` suffix.
2. **No PDF library in the extension host.** `pdfjs-dist` is used only from `scripts/pdfjs-vendor-entry.js`, `media/` and tests. `@cantoo/pdf-lib` and `@hyzyla/pdfium` are devDependencies used only from `scripts/` and `tests/`.
3. **Tests**: `tests/pdf/<name>.test.mjs` through `tests/pdf/_helpers.mjs` (`core` = the test bundle, `fixture(name)`, `writeOut(test, case, bytes)` → `tests/.out/pdf/<test>/<case>.pdf`, `assertPrefix(out, base)`, `pdfjs()` = the legacy build loaded in Node, `skipUnlessNode22(t)`).
4. **No `innerHTML` with document-derived strings** in any `media/pdf*.js` (§12).
5. **The pdf.js version is changed only through spec §13.6.** Nobody runs `npm install pdfjs-dist` except PWP-02.
6. **Nothing reaches disk unverified.** Any code path that calls `workspace.fs.writeFile` on a document's URI goes through `verify.ts` or writes the loaded bytes themselves.

Model legend as in the Office plan: **Opus** = errors here corrupt files or need deep reasoning. **Sonnet** = mechanical or fully specified. **Fable** = independent review only (Gates P2 and P-final).

---

## 2. Work-package overview

`Par.` = parallel group: PWPs sharing a group label may run concurrently (disjoint files, each in its own worktree). A PWP also waits for everything in *Depends on*.

| ID | Title | Model | Depends on | Par. | PR | ~Lines |
|---|---|---|---|---|---|---|
| **Phase 0** | | | | | | |
| PWP-01 | Spikes S1–S8 | Opus | — | A1 | none (throwaway) | 700 |
| PWP-02 | Scaffolding, dependencies, bundles, vendor files | Sonnet | PWP-01 (S1, S2) | A2 | PR-P1 | 500 |
| PWP-03 | Fixtures and generators | Sonnet | PWP-02 | A3 | PR-P2 | 900 |
| **Phase 1 — viewer** | | | | | | |
| PWP-04 | Protocol (`src/pdf/protocol.ts`), view half frozen | Sonnet | PWP-01 | B1 | PR-P3 | 500 |
| PWP-05 | Host shell: read-only `PdfDocument`, provider, sniff, load errors, CSP | Opus | PWP-04, Office PR-3 | B2 | PR-P3 | 800 |
| PWP-06 | Shared chrome: `'pdf'` kind in `officeCommon` | Sonnet | Office PR-3 | B2 | PR-P3 | 150 |
| PWP-07 | View maths (`pdfViewMath.js`) | Sonnet | — | B2 | PR-P3 | 400 |
| PWP-08 | Viewer core (`pdfViewer.js/.css`): boot, pages, zoom, navigation, password, links, copy | Opus | PWP-05, 06, 07 | B3 | PR-P3 | 1,300 |
| PWP-09 | Sidebar (`pdfSidebar.js`): thumbnails, outline, attachments, properties | Sonnet | PWP-08 | B4 | PR-P4 | 1,000 |
| PWP-10 | Find bar (`pdfFind.js`) | Sonnet | PWP-08 | B4 | PR-P4 | 500 |
| PWP-11 | Notices, engine check, theming and accessibility pass, registration | Sonnet | PWP-09, 10 | B5 | PR-P4 | 600 |
| PWP-12 | Phase 1 docs, README, CHANGELOG, `docs/pdf-gate-checklist.md` | Sonnet | PWP-11 | B6 | PR-P5 | 350 |
| **Phase 2 — edit core** | | | | | | |
| PWP-13 | Extract `BinaryDocumentBase` from `officeDocument.ts` | Opus | Office PR-6…8 on `develop` | C1 | PR-P6 | 900 (mostly moved) |
| PWP-14 | Strict reader (`core/reader.ts`) | Opus | PWP-03 | C1 | PR-P7 | 1,400 |
| PWP-15 | Edit state and geometry (`core/state.ts`, `geometry.ts`) | Opus | PWP-04 | C1 | PR-P7 | 900 |
| PWP-16 | Classification (`core/classify.ts`) | Opus | PWP-14 | C2 | PR-P7 | 700 |
| PWP-17 | Storage adapter + writer contract tests | Opus | PWP-15 | C2 | PR-P7 | 800 |
| PWP-18 | Verifier (`core/verify.ts`) + negative tests | Opus | PWP-14, 16 | C3 | PR-P7 | 1,200 |
| PWP-19 | Writer service (`media/pdfWriter.js`) | Sonnet | PWP-08, 17 | C3 | PR-P8 | 400 |
| PWP-20 | Full `PdfDocument`: edits, undo, save, backup, revert, edit mode | Opus | PWP-13, 15, 16, 18, 19 | C4 | PR-P8 | 900 |
| PWP-21 | `scripts/verify-pdf-open.mjs`, PG6 helpers | Sonnet | PWP-03 | C1 | PR-P8 | 400 |
| **Phase 3 — annotations** | | | | | | |
| PWP-22 | Overlay (`pdfOverlay.js`) | Sonnet | PWP-20 | D1 | PR-P9 | 600 |
| PWP-23 | Highlight tool, colour, "highlight this match" | Sonnet | PWP-22 | D2 | PR-P9 | 500 |
| PWP-24 | Comments: box, Comments panel, edit/clear | Sonnet | PWP-22 | D2 | PR-P9 | 700 |
| PWP-25 | Select and delete, incl. pre-existing annotations (`noView`) | Opus | PWP-22 | D2 | PR-P9 | 600 |
| PWP-26 | Ink tool | Sonnet | PWP-23 | D3 | PR-P9 | 600 |
| **Phase 4 — forms and release** | | | | | | |
| PWP-27 | Form classification and field rules (core) | Opus | PWP-16 | E1 | PR-P10 | 700 |
| PWP-28 | Form verification rules + PG suites | Opus | PWP-18, 27 | E2 | PR-P10 | 600 |
| PWP-29 | Form UI wiring (`pdfForms.js`) | Opus | PWP-20, 27 | E2 | PR-P10 | 700 |
| PWP-30 | v1 release preparation | Sonnet | all above | E3 | PR-P11 | 300 |
| **Post-v1** | | | | | | |
| PWP-40 | Free text | Opus | v1 | F | own | — |
| PWP-41 | Organise pages → export to a new PDF | Opus | v1 | F | own | — |
| PWP-42 | Standalone notes, underline, strikeout (own object writer) | Opus | v1 | F | own | — |
| PWP-43 | Metadata; PDF files in wikilinks and graph | Sonnet | v1 | F | own | — |

v1 split: 14 Opus, 16 Sonnet; Fable for two review passes.

---

## 3. Branching, PRs, dependencies, shared files

### 3.1 Dependency on the Office work

The Office viewers are complete on local branches but not on `develop` (spec §2.2). The PDF work needs:

| PDF work | Needs on `develop` | Why |
|---|---|---|
| Phase 0 (PWP-01…03) | nothing | Spikes are throwaway; scaffolding and fixtures touch only PDF files and the shared build files. |
| Phase 1 (PWP-04…12) | Office **PR-3** (`officeCommon`, common protocol, provider base) | Chrome and common messages are reused. |
| Phase 2 onwards | Office **PR-6, PR-7, PR-8** (save pipeline, with Gate R2 passed) | PWP-13 refactors `officeDocument.ts`; it must not race with Office changes to that file. |

If Office PR-3 is not merged when Phase 0 ends, Phase 1 either waits or (question Q8 answer b) is cut from the Office branch tip and rebased when it merges. PWP-13 never starts before Office Gate R2 is recorded as passed.

### 3.2 Branch and PR strategy

As for Office: small PRs straight to `develop`, each either inert or user-complete; no long-lived branch. Incomplete features never reach users:

- The `customEditors` entry for `*.pdf` is added only by PWP-11, when the viewer is complete.
- `src/pdf/featureFlags.ts` (created by PWP-05) exports `PDF_FLAGS = { pdfEdit: false, pdfForms: false }`. With `pdfEdit` off the provider reports `canEdit: false`; with `pdfForms` off classification reports `forms.reason: 'flag-off'`. Each flag is flipped by the last commit of its phase's PR, after that phase's gate.

| PR | Branch | Contents | Releasable after merge? |
|---|---|---|---|
| PR-P0 | `feature/pdf-viewer-docs` | spec, plan (this PR). `docs/**` MUST be in `.vscodeignore` before any release: Office PR-0 adds the line; if PR-P0 merges first, add it here. | inert |
| PR-P1 | `feature/pdf-scaffold` | PWP-02 | inert (vendor files are in the VSIX but unreferenced) |
| PR-P2 | `feature/pdf-fixtures` | PWP-03 → **Gate P0** | inert |
| PR-P3 | `feature/pdf-viewer-core` | PWP-04…08 (provider not registered) | inert |
| PR-P4 | `feature/pdf-viewer-panels` | PWP-09…11 (registers the viewer) | yes — PDF viewer |
| PR-P5 | `feature/pdf-viewer-release-docs` | PWP-12 → **Gate P1** → **viewer-first release** (minor bump, usual bump PR and `develop` → `master`) | yes |
| PR-P6 | `feature/binary-editor-base` | PWP-13 (Office regression check) | yes (no visible change) |
| PR-P7 | `feature/pdf-edit-core` | PWP-14…18 | inert |
| PR-P8 | `feature/pdf-save` | PWP-19…21, highlight end to end behind the flag → **Gate P2 (Fable)** | yes (no visible change) |
| PR-P9 | `feature/pdf-annotations` | PWP-22…26, flip `pdfEdit` → **Gate P3** → optional release | yes — annotations |
| PR-P10 | `feature/pdf-forms` | PWP-27…29, flip `pdfForms` → **Gate P4** | yes — form filling |
| PR-P11 | `feature/pdf-v1-release` | PWP-30 → **Gate P-final (Fable)**, then bump PR and `develop` → `master` | v1 |

Every PR follows the project's self-review process before merge. Merge with `gh pr merge --admin` only when the user asks; otherwise hand off.

### 3.3 Shared files and who owns them

| File | Owner | Rule |
|---|---|---|
| `package.json`, `package-lock.json` | PWP-02 (dependencies, scripts); PWP-11 (`customEditors` entry, `defaultZoom`); PWP-20 (`startInEditMode`); PWP-23 (`highlightColor`, `annotationAuthor`) | All npm dependencies for v1 are added once, in PWP-02, with exact pins. |
| `esbuild.js`, `scripts/copy-vendor.js`, `.gitattributes`, `.gitignore`, `.vscodeignore`, `THIRD-PARTY-NOTICES.md` | PWP-02 only | These are also Office-owned files; PWP-02 runs after Office PR-0 is on `develop` or rebases onto it. |
| `src/extension.ts` | PWP-11 (one registration block after the Office ones) | |
| `media/officeCommon.js/.css`, `src/office/protocol.ts` (`kind` union) | PWP-06 only | Smallest possible change; Office tests stay green. |
| `src/office/officeDocument.ts`, `src/binaryEditor/**` | PWP-13 only | Frozen for PDF work afterwards; a needed change is a plan change. |
| `src/pdf/protocol.ts` | PWP-04; the edit half is confirmed (not redesigned) at the start of Phase 2 by the orchestrator | Frozen within a phase. |
| `src/pdf/core/index.ts` | PWP-02 writes the complete barrel over stub modules | Parallel WPs replace stubs, never the barrel. |
| `media/pdfViewer.js` | one PWP at a time (08, then 11); later features live in their own files and register through `PdfViewerShell.register*` hooks defined by PWP-08 | |
| `todo.md`, `log.md`, `CHANGELOG.md`, `README.md` | orchestrator at merge time; PWP-12 and PWP-30 for README/CHANGELOG | |

---

## 4. Phase 0 — spikes, scaffolding, fixtures

### PWP-01 — Spikes (Opus) · first; S1 and S2 block PWP-02, S3 blocks Phase 2

**Why Opus:** outcomes change the architecture.

**Files (throwaway, never merged):** `spike/pdf/` on branch `spike/pdf-viewer` — its own `package.json`, a minimal extension with one custom editor for `*.pdf`, a webview that runs each experiment on open and reports to the host, which writes `spike/pdf/out/report.json`. Launch with an isolated profile as in the Office spikes (`log.md`, 2026-10-13 tip). The only repo files changed are `log.md` (the report) and, if an outcome requires it, the spec and this plan.

| # | Question (spec ref) | Method | Pass criterion | If it fails |
|---|---|---|---|---|
| S1 | pdf.js under the webview CSP (§12, assumptions 1, 2, 4) | Load the esbuild IIFE of the legacy build with the target CSP; create the worker from a blob and pass it as `workerPort`; render `basic`, `cjk`, `base14`, `jpx-jbig2`, an embedded-font file; run `PDFViewer` + `PDFFindController` with `GenericL10n`; collect `securitypolicyviolation` events and the network log | All pages render in a real worker (not the main-thread fallback); zero CSP violations; zero requests outside `cspSource`; then remove directives one at a time and record which are really needed | Worker: try pdf.js's own blob wrapper (`script-src` + `${cspSource}`), then the main-thread fallback with a "slow mode" notice. Bundle: load as a nonce'd module script. L10n: ship a static English bundle. Each fallback is a one-line spec edit to §12. |
| S2 | Minimum VS Code (§10.4, assumption 3) | Run S1 in portable VS Code builds going back from current until it fails; record Electron/Chromium and the first missing API | A definite minimum version and the feature-detect list | Report only; drives Q7 and the README. If the minimum is at or below 1.85 the engine check stays as a safety net. |
| S3 | Incremental output is valid and minimal (§3.2, §6.5, assumptions 5, 6) | For each editable fixture and the user's corpus: write a highlight, an ink, a highlight with comment, a deletion, and (forms fixtures) one value per field type through the adapter and `saveDocument()` in the webview; dump the appended revision; classify every new and superseded object; write twice and compare; open each output with PDFium, `@cantoo/pdf-lib`, `qpdf --check` (installed for the spike); **the user opens a sample of 12 in Acrobat Reader, Edge, Chrome, Firefox** | Prefix identity on all; one revision; object kinds fit a short allow-list (record it — it becomes PV4); deterministic apart from documented fields; no reader reports an error or repairs; Acrobat does not ask to save on close | Writer unusable for a class of files → that class is view-only (`unsupported-structure`), provided `basic`, `xref-stream`, `word`, `chrome` and `acrobat-forms` pass. If those fail: stop and re-plan Phase 2 around an own object writer on the strict reader (highlight, ink and field values without pdf.js; forms then need our own appearance streams — a larger Phase 4). |
| S4 | Limits and budgets (§9.3, assumption 11) | Time to first page and memory for 10 / 100 / 300 MB files; byte transfer cost; scroll frame times on `large.pdf`; writer time and peak memory at 10 / 50 / 100 MB; a throwaway tokeniser loop over a 100 MB file for the strict-reader budget | Within §9.3 | Lower the limits in `core/limits.ts` and the spec proportionally. |
| S5 | Appearance across readers (assumption 7) | The S3 outputs for highlight (each colour) and ink, screenshotted in each reader by the user | Highlights are translucent over text and ink is the right colour and width everywhere | Adjust colours/opacity in the adapter; if a reader ignores the appearance stream, document it. |
| S6 | Display hooks (§8.5–8.7, assumption 8) | Hide an existing annotation with `{ noView: true }` and re-render the page; observe form `change` events and read values from `annotationStorage`; write a value back and re-render | Each works inside `PDFViewer` without reloading the document | Hide: reload the page view, or mark the annotation "to be removed" with an overlay strike-through. Forms: read the DOM inputs directly. |
| S7 | Signed, encrypted, XFA facts (§9.1, 9.2, 7.6, assumptions 9, 10) | Password flow through `onPassword`; `getSignatures()` on the signed fixtures; our revision on a signed and on a certified file, opened in Acrobat by the user; ways to learn of XFA and JavaScript with `enableXfa: false` | Password flow works; signer facts available; Acrobat's wording recorded; a detection method for XFA/JS | No XFA detection → no XFA notice in the viewer (the file's own fallback page explains), and the host's classification still turns forms off. |
| S8 | Host-side pieces (§6.6) | 100 MB `Uint8Array` webview → host; save with the tab hidden (`retainContextWhenHidden`); save-on-close ordering (is the webview alive when `saveCustomDocument` runs from the close prompt?); backup at window close | Bytes arrive intact; hidden-tab and close-prompt saves get a writer reply | Close-prompt save without a webview → pre-materialise on the quiet period after every edit (already specified) and document the residual. |

Office spike S3 (Ctrl+Z inside a focused text input) applies unchanged and is not repeated.

**Needs the user:** about 30 minutes — the Acrobat/Edge/Chrome/Firefox openings for S3, S5 and S7, and ten everyday PDFs for the corpus.

**Acceptance:** a "PDF Phase 0 spike report" section in `log.md` with one row per item (result, numbers, evidence file), the decisions taken, and any spec/plan edits made.

**Outcome (2026-11-21, branch `spike/pdf-viewer`, report in `log.md` there).** S1 pass (CSP tightened, `useWorkerFetch: false`). S2: minimum VS Code **1.95**; feature checks `Promise.withResolvers` and CSS `round()`. S3: automated part passes on 145 outputs and gives the PV3/PV4 lists now in spec §6.5; the reader openings are with the user (`spike/pdf/out/for-user/CHECKLIST.md`). S4: time budgets pass, memory budget restated, strict reader must be lazy (spec §9.3). S5: PDFium only; rest with the user. S6: partial — `noView` works only in `ENABLE_STORAGE` mode; two viewer modes and the overlay fallback (spec §8.5, §8.6). S7: automated part passes; Acrobat wording with the user. S8: pass. Consequences for later packages are written into them below, each marked *(spike)*. **The spike used synthetic fixtures only:** no Word-produced, Acrobat-produced or user-corpus file was run, so the S3 pass condition for `word` and `acrobat-forms` is still open and is re-checked in PWP-17/PWP-18 once PWP-03 has those fixtures.

### PWP-02 — Scaffolding (Sonnet)

**Files:** `package.json`/lock (*(spike)* `engines.vscode` and `@types/vscode` → `^1.95.0`, the minimum S2 measured, with the README line; dependency `pdfjs-dist@6.5.438`; devDependencies `@cantoo/pdf-lib@2.11.1`, `@hyzyla/pdfium@3.0.0`; all exact) · `scripts/pdfjs-vendor-entry.js` (imports the legacy display build, sets `globalThis.pdfjsLib`, re-exports it and the viewer components listed in spec §3.1) · `esbuild.js` (webview context → `media/pdfjs-bundle.js`, IIFE, global `PdfjsBundle`; test-bundle context `src/pdf/core/index.ts` → `tests/.build/pdf-core.cjs`, built by the existing `--test-bundle` path) · `scripts/copy-vendor.js` (worker → `media/pdfjs/pdf.worker.min.mjs`; `cmaps/`, `standard_fonts/`, `iccs/`, the three decoder `.wasm` files, `pdf_viewer.css`, `images/`, each with its `LICENSE*`; explicitly **not** `pdf.sandbox*`, `quickjs-eval.*`, `*_nowasm_fallback.js`) · `.gitattributes` · `THIRD-PARTY-NOTICES.md` (pdf.js section with every data-file licence) · `src/pdf/core/index.ts` barrel + one stub per module of spec §4 · `src/pdf/core/limits.ts` (spec §9.3, as adjusted by S4) · `tests/pdf/_helpers.mjs`, `tests/pdf/smoke.test.mjs` · `todo.md` (one checkbox per PWP and gate), `log.md`.

**Acceptance:** `compile`, `check-types`, `npm test` green; `npx @vscode/vsce ls` lists the bundle, the worker and the data directories and none of the excluded files; measured VSIX growth recorded in `log.md` (closes assumption 14); `dist/extension.js` size unchanged.

### PWP-03 — Fixtures and generators (Sonnet)

**Files:** `scripts/pdf-fixtures/make-synthetic.mjs` (everything "generated by script" in spec §13.3, with `@cantoo/pdf-lib` and hand-written object text where a library cannot produce the case: hybrid xref, broken xref, multi-revision, JavaScript and Launch actions) · `make-producers.ps1` (Word COM "Save as PDF"; Edge headless `--print-to-pdf`) · `make-signed.mjs` (throwaway self-signed certificate created at run time; no key is committed) · `tests/fixtures/pdf/*.pdf` + `README.md` (producer, recipe, what it exercises; passwords) · `tests/pdf/fixtures.test.mjs` (every named file exists; user-supplied ones in a `PENDING` list that warns; none over 5 MB) · `tests/pdf/fixturesOpen.test.mjs` (every non-error fixture opens in pdf.js under Node and reports the documented page count).

**Needs the user:** the `PENDING` files of spec §13.3. Phases 0–1 proceed without them; `acrobat-forms.pdf` is needed before Gate P4 and the signed/certified pair before Gate P3.

> **Gate P0** (after PR-P2): spike report complete; every failed assumption applied to the spec and this plan; open questions Q1–Q8 answered by the user and recorded in spec §16; fixtures present. Orchestrator self-review; no Fable pass.

---

## 5. Phase 1 — viewer

### PWP-04 — Protocol (Sonnet)
`src/pdf/protocol.ts` verbatim from spec §5, with runtime validators `parsePdfToHost(raw)` enforcing `PDF_PROTOCOL_LIMITS`; `src/types.ts` re-export under a "PDF Viewer Types" banner; `tests/pdf/protocol.test.mjs` (≥ 40 table-driven rejections; every shape in §5 accepted).

**Amendment 2026-11-21 (user-approved, view half):** `pdfLog` webview → host message (spec §5, §12): `protocol.ts` validator; the PWP-05 provider appends it to the output channel "VS Code MD Editor" (50 lines per load); the PWP-08 viewer posts it for CSP violations, worker fallback and failed pages.

### PWP-05 — Host shell (Opus)
**Why Opus:** lifecycle and CSP are where a mistake is invisible until a gate.
`src/pdf/core/sniff.ts`, `src/pdf/loadErrors.ts`, `src/pdf/featureFlags.ts`, `src/pdf/pdfDocument.ts` (read-only: bytes, disk stamp, watcher-driven reload when clean; **no parsing**), `src/pdf/pdfEditorProvider.ts` (extends the Office provider base; CSP string of spec §12 as finalised by S1; `pdfRequestDocument` → `pdfDocument`; `pdfFacts` → notices; `pdfSaveAttachment` → save dialog, base name only; link allow-list). Not registered yet.
**Acceptance (automated):** `sniff` and load-error tables; attachment-name sanitising; CSP string snapshot (no origin other than `cspSource`, no `unsafe-eval`). **Dev host (Gate P1):** error fixtures, `git:` side of a diff, reload on external change.

### PWP-06 — Shared chrome (Sonnet)
`media/officeCommon.js` (`'pdf'` kind: application name, read-only sentences of spec §5), `src/office/protocol.ts` (`kind` union and its validator), `tests/office/officeCommon.test.js` additions. Office tests green.

### PWP-07 — View maths (Sonnet)
`media/pdfViewMath.js` (UMD, pure): zoom step table and clamping, fit computations, page-box parsing (number or label), `mergeRects` (client rects → one quad per line), viewport ↔ page-space conversion helpers, thumbnail window. `tests/pdf/pdfViewMath.test.mjs`.

### PWP-08 — Viewer core (Opus)
**Why Opus:** the pdf.js boot sequence, worker and virtualisation are the centre of the viewer.
`media/pdfViewer.js`, `media/pdfViewer.css`, `tests/pdf/pdfViewer.test.js` (DOM shim, stubbed `PdfjsBundle`). Covers spec §7.1, §7.3, §7.5, §9.1, §9.4 (viewing rows): engine check hook; worker from blob via `workerPort` with fallback detection; `getDocument` options (`disableRange`, `disableStream`, `disableAutoFetch`, `enableXfa: false`, *(spike)* `useWorkerFetch: false`, data URLs under `media/pdfjs/`); *(spike)* bytes arrive as a plain `Uint8Array` (the host must not post a `Buffer`); no `l10n` option is passed to `PDFViewer`; `annotationMode: ENABLE_STORAGE` in View mode; documents are destroyed through `loadingTask.destroy()`; every `securitypolicyviolation` event is reported to the host log; no inline `style` attributes or injected `<style>` in our own DOM (the CSP has no `'unsafe-inline'`); `PDFViewer` + `PDFLinkService` + `EventBus`; toolbar through `OfficeCommon.toolbar`; zoom, page box, rotate view; password box; click interception → `openLink`; copy → `writeClipboard`; per-page render-error placeholder; `vscode.setState`; defines `PdfViewerShell.registerPanel / registerTool / registerToolbarItems / onPagesRendered` for later PWPs.
**Acceptance:** `getDocument` is called with exactly the specified options (asserted object); `enableScripting` absent/false; external link click posts `openLink` and prevents navigation; `javascript:`/`file:`/Launch are dropped; password retry and cancel paths; state restore.

### PWP-09 — Sidebar (Sonnet) · PWP-10 — Find (Sonnet)
`media/pdfSidebar.js` (+ CSS): spec §7.2; lazy thumbnails with the `pdfViewMath` window; outline as `role="tree"` with arrow-key navigation; attachments; properties dialog. `media/pdfFind.js`: spec §7.4 over `PDFFindController`. DOM-shim tests for keyboard behaviour, `textContent`-only rendering of document strings (an outline title containing `<img onerror>` stays text), count and wrap announcements.

### PWP-11 — Notices, engine check, theming, accessibility, registration (Sonnet)
`media/pdfViewer.js` (engine check of spec §10.4 with S2's list; `pdfFacts`; scanned-file detection), `media/pdfViewer.css` (theme tokens, high-contrast outline, `forced-colors`, `prefers-reduced-motion`), page `role`/labels and live-region announcements (§10.2), `package.json` (`customEditors` entry, `defaultZoom`), `src/extension.ts` (registration with `retainContextWhenHidden: true`, `enableFindWidget: false`, `supportsMultipleEditorsPerDocument: false`).

### PWP-12 — Phase 1 docs and gate checklist (Sonnet)
`README.md` (PDF viewer section: what it shows, what it does not — printing, scripts, XFA; minimum VS Code; default-editor note), `CHANGELOG.md`, `docs/pdf-gate-checklist.md` in the style of `docs/office-gate-checklist.md`: one sweep of the fixtures with numbered [must]/[nice] items and time estimates for Gates P1, P3 and P4.

> **Gate P1 — viewer (human, about 75 minutes).** In an isolated Extension Development Host: every fixture opens to the right view or error view (spec §14 Phase 1 list); side-by-side comparison with Chrome for `outline`, `annotated`, `rotated`, `cjk`, `jpx-jbig2`, `word`, `chrome`; password prompt (wrong, right, cancel); find, copy, links (allowed, blocked), sidebar, zoom, rotate; webview console shows no CSP violation and the network panel no request for every fixture; `js-openaction.pdf` and `forms-js.pdf` run nothing; `large.pdf` scroll budget; light, dark and both high-contrast themes; keyboard-only walkthrough; Narrator or NVDA on `tagged.pdf`; `git status` clean afterwards (no file dirtied or written). Result recorded in `log.md`. **Then the viewer-first release** (question Q2): bump PR, `develop` → `master`, publish.

---

## 6. Phase 2 — edit core

### PWP-13 — Extract the shared base (Opus)
**Why Opus:** it moves the code that decides whether a user's file is overwritten.
`src/binaryEditor/binaryDocumentBase.ts` (disk stamp and base, watcher, conflict modal, flush targets, in-place write and error mapping, quiet-period backup and backup id, restore check, generation guard, saving guard, test hooks — everything in spec §2.2's "shared after extraction" row), `src/office/officeDocument.ts` (now a subclass supplying load/serialise/verify and the Office-specific notices). **No behaviour change.** Acceptance: the entire Office suite passes unmodified (in particular `saveProvider`, `saveErrors`, `saveAsync`, `saveBlocking`, `hostShell`); a diff review shows moved, not rewritten, logic; Office Gate R2's dev-host save items re-run once and logged.

### PWP-14 — Strict reader (Opus)
**Why Opus:** it is the independent check on every save.
`src/pdf/core/reader.ts`, `tests/pdf/reader.test.mjs`. Exports: `openPdf(bytes, limits)` → `{ revisions, trailer, size, xrefKind, resolve(num, gen), objectText(num, gen) }`; `tokenise`, `parseObject` (dictionary/array/name/number/string/ref trees with source spans; streams skipped by `/Length`); `PdfReadError` with codes (`no-header`, `no-startxref`, `bad-xref`, `prev-cycle`, `hybrid`, `encrypted`, `objstm`, `too-large`, `malformed`). Acceptance: resolves every object of every non-error fixture and agrees with `@cantoo/pdf-lib` on each object's dictionary keys; refuses `broken-xref`, `encrypted-*`, `truncated` with the named code; caps of spec §9.3 each have a test (a `/Prev` cycle, a lying `/Length`, an inflating object stream, deep nesting); a 100 MB synthetic file is read within the S4 budget and never blocks the event loop over 50 ms. **Hybrid xref (user decision 2026-11-21):** hybrid-reference sections (`/XRefStm`, Word) are read per spec §3.3 (kind `hybrid`; `word.pdf` and `hybrid-xref.pdf` agree with pdf-lib and pdf.js); the code `hybrid` now means a malformed or ambiguous hybrid section only. *(spike)* The reader is lazy: it parses the cross-reference chain and resolves objects on demand, and has no code path that tokenises the whole body (S4: 7.7 s for a 107 MB file of 357,039 small objects, against 31 ms for its cross-reference table); the acceptance file for this is an object-dense one (`big-objs-100.pdf` of the spike's generator), not an image-heavy one.

### PWP-15 — Edit state and geometry (Opus)
`core/state.ts`, `core/geometry.ts`, tests. Spec §6.3: deltas, apply/invert, normalisation ("set back to loaded value removes the key"; add-then-remove leaves nothing), validation, canonical ordering; quads → rect and outline polygons, ink bounds, page-box checks. Acceptance: seeded random sequences of 200 operations with interleaved undo/redo always reach the same state as replaying the surviving operations; any sequence ending at "all undone" yields the empty state.

### PWP-16 — Classification (Opus)
`core/classify.ts`, tests. Spec §6.2: editability and reason (well-formed hybrid-xref files — `word`, `hybrid-xref` — are editable since the 2026-11-21 decision; `PdfStructureFacts.xrefKind` gains `'hybrid'`); pages with boxes; per-page annotation refs and subtypes (deletable set, Popups); AcroForm facts stubbed as "forms off" until PWP-27; signature and `/Perms` facts. Acceptance per fixture: the expected reason or the expected counts.

### PWP-17 — Storage adapter and writer contract tests (Opus)
`core/storageAdapter.ts`, `tests/pdf/writerContract.test.mjs`. State → entries (spec §6.4). *(spike)* Removal entries are keyed `pdfjs_internal_editor_{n}` and carry `popupRef`; a contract test asserts that a removal really shortens `/Annots` (a wrongly keyed entry is ignored without any error). Outputs are not compared byte-for-byte across runs (`/ID` and widget `/M` vary). The contract tests run the pinned pdf.js in Node: adapter → `saveDocument()` → assert PG1, one revision, and that pdf.js, PDFium and `@cantoo/pdf-lib` each see the annotation with the right subtype, rectangle, colour and comment. These are the tests that fail first when pdf.js is upgraded.

### PWP-18 — Verifier (Opus)
`core/verify.ts`, `tests/pdf/verify.test.mjs`. PV1–PV6 exactly as spec §6.5 (on a hybrid base PV2 expects a plain classic table without `/XRefStm`: `tests/pdf/hybridWrite.test.mjs`), with the allow-lists recorded by S3 as data tables in the module. *(spike)* Superseded objects are compared by decoded value, not by token; free cross-reference entries are accepted only for the annotations and Popups the request removes; before the tables are frozen the classification script of the spike (`spike/pdf/analyse-s3.mjs`, branch `spike/pdf-viewer`) is re-run on the `word`, `acrobat-*` and user-corpus fixtures, which the spike did not have. Acceptance: every writer-contract output passes; every negative case of spec §13.2 fails with the named check id; diagnostics contain ids and object numbers only.

### PWP-19 — Writer service (Sonnet) · PWP-21 — Reader scripts (Sonnet)
`media/pdfWriter.js` (spec §6.4 steps 1–4; DOM-shim test with a stubbed bundle for sequencing, timeouts and error replies). `scripts/verify-pdf-open.mjs` and the PG6 helper in `tests/pdf/_readers.mjs`.

### PWP-20 — Full `PdfDocument` (Opus)
`src/pdf/pdfDocument.ts`, `src/pdf/pdfEditorProvider.ts`, `package.json` (`startInEditMode`), `tests/pdf/saveProvider.test.mjs` (vscode stub, fake writer). Spec §6.1–6.6: lazy classification on first Edit; `pdfEdit` handling; edit events and labels; save pipeline with verification; materialised cache; backup/restore; revert; fail-safe when the writer does not answer; signed-file warning. Highlight is wired end to end (posting a hard-coded test highlight from a dev command behind the flag is enough; the real tool is PWP-23).
**Acceptance (automated):** PG0–PG3 through the provider with a fake writer that replays contract-test outputs; a fake writer returning tampered bytes never reaches `writeFile`; timeout path; restore path. **Dev host (Gate P2).**

> **Gate P2 — edit core (Fable independent review + human, about 45 minutes).** Fable reviews `reader.ts`, `verify.ts`, `state.ts`, `storageAdapter.ts`, `pdfDocument.ts` and the base extraction against spec §6 and §12 line by line, with the code and not the author's conclusions; findings closed or deferred with the user's agreement. Human, in a dev host with `pdfEdit` switched on locally: save, Save As, undo to clean, revert, hot exit (kill the window, restore dirty state, save), conflict modal, save with the file locked by another program, verification failure through the corrupt-save hook — each leaves the disk file untouched on failure; the saved highlight opens in Acrobat Reader and Chrome. Office editors re-checked for save/undo regressions after PWP-13.

---

## 7. Phases 3 and 4 — annotations, forms, release

### PWP-22 — Overlay (Sonnet)
`media/pdfOverlay.js` (+ CSS): SVG layer per rendered page from `pdfState`, re-attached through `onPagesRendered`; hit targets with accessible names ("Highlight, yellow, page 3, comment: …"); focus order in page order.

### PWP-23 — Highlight (Sonnet) · PWP-24 — Comments (Sonnet) · PWP-25 — Select/delete (Opus) · PWP-26 — Ink (Sonnet)
`media/pdfTools.js` split by registration hook: highlight from selection and from the current find match, colour swatch, settings `highlightColor`/`annotationAuthor` (spec §8.2); comment box and the Comments panel with edit/clear and the "Removed" list (§8.3, §7.2); select tool, Delete, context menu, hiding of pre-existing annotations (*(spike)* `noView` + page re-render in `ENABLE_STORAGE` mode, the overlay "to be removed" box in `ENABLE_FORMS` mode, and in both the annotation layer's own `section` element hidden by us) and the one-time "not erased" notice (§8.6) — Opus because it touches existing content; ink with Pointer Events and stroke simplification (§8.4). Each has DOM-shim tests for its keyboard paths and its `pdfEdit` messages, and PG suites (PG0–PG6) for its operations on every editable fixture.

> **Gate P3 — annotations (human, about 60 minutes).** With `pdfEdit` on locally: each tool on `basic`, `word`, `chrome`, `tagged`, `multi-revision`, `signed`; keyboard-only highlight through Find; then `scripts/verify-pdf-open.mjs` green, and the outputs opened in **Acrobat Reader, Edge, Chrome, Firefox** (macOS Preview if available): no error or repair, no save prompt on closing in Acrobat, annotations present, selectable and deletable there, comment text shown; `signed.pdf`/`acrobat-signed.pdf` report "changed after signing"; a file annotated in Acrobat can have that annotation deleted here and the result reopens in Acrobat. Theme and screen-reader spot checks of the tools. Pass → flip `pdfEdit` → optional release.

### PWP-27 — Form classification and rules (Opus) · PWP-28 — Form verification (Opus) · PWP-29 — Form UI (Opus)
`core/classify.ts` (field tree, types, flags, widgets, `/XFA`, `/RV`, locked set), `core/state.ts` (value rules of spec §8.5), `core/verify.ts` (field/widget/AcroForm rows of PV4, read-back in PV6), `media/pdfForms.js` (change observation, lock display, write-back on undo/redo, script notice; *(spike)* rebuilds the viewer with `annotationMode: ENABLE_FORMS` when Edit is turned on for a document with fillable fields, listens for `input`/`change` in the capture phase, reads `annotationStorage.getRawValue`, writes text back as `{ value, formattedValue }`; script presence comes from `getJSActions()`/field actions, not `hasJSActions()`). Gate P4 additionally checks a multi-line auto-size text field in Acrobat (PDFium shows pdf.js's regenerated appearance as one oversized line). All Opus: field semantics are where a silent wrong value would come from. PG suites per field type on `forms.pdf` and `acrobat-forms.pdf`; refusal tests for read-only, signature, rich-text, over-length and XFA cases.

**PWP-27 as built (2026-11-21).** `classify(bytes, { forms })` (the flag is passed in; default off = `flag-off`, facts still collected) → `forms.fields: PdfFieldFact[]`, `context.fields` (widget key → `PdfFieldRule` from `state.fieldRule`) and `context.locked` (widget/field key → `PdfFieldLockReason`); `state.planEdit` refuses a locked widget with `field-locked` and its `FIELD_LOCK_MESSAGES` sentence, applies the text/choice value rules and sets radio groups whole (spec §8.5). **Decision (orchestrator, conservative): fields with `/AA` (on the field, an ancestor or a widget, or a widget `/A`) and fields in `/CO` are NOT fillable (`scripts`, `calculated`); `ACROFORM_SUPERSEDE_RULE` stays `null`.** Also locked: base `/NeedAppearances true`, password, multi-widget text/choice/checkbox, choice with `/I`, and malformed structures (full list in spec §8.5). Tests: `tests/pdf/formFields.test.mjs` (per-field table for `forms.pdf`/`forms-js.pdf` cross-checked against pdf.js widgets; value rules; synthetic locks; every fillable widget of `forms.pdf` through the real pdf.js writer and `verifySave`).

**For PWP-28.** (1) Keep the AcroForm row refused; a text value the field's font cannot encode still makes pdf.js add `/NeedAppearances true` (refused at save — decide whether to pre-check or word the failure). (2) `/I` is locked rather than allowed in PV4; allowing it means adding `I` to the field/widget supersede keys. (3) The writer-contract `contextFrom` derives fields from pdf.js; switch it to `classify(…, { forms: true })`. **For PWP-29.** The protocol's `lockedFields: PdfObjRef[]` carries no reason; the UI needs one (`FIELD_LOCK_MESSAGES`) — amend `PdfEditInfo.forms` (e.g. `lockedFields: Array<{ ref, reason }>`). Radio ops must carry every widget of the group (pdf.js writes all siblings on change; read each with `getRawValue`). A document whose fields are all locked (e.g. `forms-js.pdf`) gets `reason: 'none'`, so there is no forms mode in which to show reasons — consider a notice.

**PWP-28 as built (2026-11-21).** `verify.ts` field rows: role-based keys (`FIELD_SUPERSEDE_KEYS`; only requested widgets and their terminal field node — no longer every `/Parent` ancestor), written `/V`, `/AS`, `/I` checked against the request from the bytes (`value-mismatch`), a fresh own appearance for every rewritten text/choice widget and each new form used once (`appearance-missing`, `ap-target`), `/NeedAppearances`-only AcroForm supersession named `need-appearances` (row stays `null`), requested fields must be fillable in the classification (`request-invalid`); `SAVE_REFUSED_MESSAGE`, `FIELD_APPEARANCE_MESSAGE`, `verifyFailureMessage(result)` for PWP-20/29. `PdfFieldRule` carries `spec` and `field` (terminal field key). Decisions: (1) unencodable values are refused at verification with the specific message (spec §8.5); (2) `/I` unlocked on merged field/widgets (pdf.js rewrites it; verified), locked elsewhere (stale); radio groups cannot be cleared (pdf.js leaves `/V`). Tests: `tests/pdf/formsPg.test.mjs` (every fillable type of `forms.pdf` + synthetic merged text, Unicode, multi-select with/without `/I`, single list with `/I`, editable combo, NoToggleToOff radio, merged/separate checkboxes, inline AcroForm; real `media/pdfWriter.js` service → `verifySaveSync` → `assertPg6` + pdf.js/pdf-lib field agreement → undo → original bytes; PG0, PG2 across saves, PG4; tampered value, extra field, borrowed/shared `/AP`, AcroForm), field-row negatives in `verify.test.mjs`; writer contract uses `classify(…, { forms: true })`. Outputs `tests/.out/pdf/forms/`. Known limit: two widgets of the same size whose new appearances are swapped are not detected (appearance content is not parsed).

> **Gate P4 — forms (human, about 45 minutes).** Fill every field type in `forms.pdf` and `acrobat-forms.pdf`, save, reopen here and in Acrobat Reader, Chrome and Firefox: values shown, no repair or save prompt, the file can be filled further in Acrobat; undo to clean restores the original bytes (compare hashes); `forms-js.pdf` has no fillable field (every field carries scripts or is calculated: locked, PWP-27 decision) and its fields keep their values; `xfa.pdf` has form filling off with the stated reason. Pass → flip `pdfForms`.

### PWP-30 — v1 release preparation (Sonnet)
README (editing sections; limitations: no scripts, deletion is not erasure, files grow per session, no page operations), CHANGELOG, `THIRD-PARTY-NOTICES.md` re-checked against the lockfile, `vsce ls` re-check, `docs/pdf-gate-checklist.md` filled in, `todo.md`/`log.md`.

> **Gate P-final (Fable).** Independent review of everything since P2 plus a whole-feature pass against spec §12 (security) and §13.2 (guarantees); `npm test` and `verify-pdf-open` green on `develop`; all gates recorded. Then the usual bump PR and `develop` → `master`.

---

## 8. Estimates and parallelism

Effort is implementation plus self-review by agents, in working days of orchestrated time; human time is the user's. These are estimates, most uncertain where a spike could change the design (Phase 2).

| Phase | PWPs | Agent effort | User time | Can run in parallel |
|---|---|---|---|---|
| 0 | 01–03 | 2–3 days | 30 min (reader checks) + supplying files | PWP-01 alone first; then 02 → 03. All of Phase 0 can run **while the Office PRs are being merged**. |
| 1 | 04–12 | 4–5 days | Gate P1: 75 min | B2: PWP-05, 06, 07 together. B4: PWP-09, 10 together. |
| 2 | 13–21 | 5–6 days | Gate P2: 45 min | C1: PWP-13, 14, 15, 21 together (disjoint files). C2: 16, 17. C3: 18, 19. |
| 3 | 22–26 | 3–4 days | Gate P3: 60 min | D2: PWP-23, 24, 25 together. |
| 4 | 27–30 | 3 days | Gate P4: 45 min | E2: PWP-28, 29 together. |
| **Total v1** | 30 | **about 17–21 working days** | about 4.5 hours | Viewer-first release after about 7–8 days. |

Critical path: PWP-01 → 02 → 05 → 08 → 11 → (Gate P1) → 14 → 18 → 20 → (Gate P2) → 22 → 25 → (Gate P3) → 29 → (Gate P4).

---

## 9. Per-release manual checklist

Before each release PR that changes PDF behaviour; recorded in `log.md`.

1. `npm test` (on Node ≥ 22.13 so the writer contract tests run); `node scripts/verify-pdf-open.mjs` — zero failures.
2. Open three edited outputs in Acrobat Reader, Chrome and Firefox: no error, no repair, no save prompt on close; edits present.
3. Isolated dev host: open, edit, save, reopen `basic`, `word`, `forms`, `signed`; undo to clean; hot-exit restore.
4. Webview console: no CSP violation; network: no request.
5. Theme sweep and a keyboard-only pass of one edit.

---

## 10. Definition of done for v1

- [ ] Gates P0–P4 and P-final recorded as passed in `log.md`; spike report present; every spec §16.1 assumption marked verified or replaced; Q1–Q8 recorded as decisions.
- [ ] `check-types`, `compile`, `npm test` green on `develop`; Office suite unchanged and green.
- [ ] PG0–PG6 green for every operation label of spec §6.3 on every editable fixture, with no `PENDING` fixture left.
- [ ] Every negative verifier test fails its named check.
- [ ] Every fixture opens to a view or the specified error view; none is dirtied by viewing; no CSP violation; no network request; no script from a file runs.
- [ ] `PDF_FLAGS` both `true`; the four settings exist with the spec §4.1 defaults.
- [ ] `vsce ls`: bundle, worker and data files present with their licences; no sandbox, QuickJS, fallback decoders, `docs/`, `tests/`, `scripts/` or `spike/`; `pdfjs-dist` pinned exactly; `THIRD-PARTY-NOTICES.md` current.
- [ ] README and CHANGELOG describe the viewer, the editing limits, the default-editor change and the minimum VS Code version.
- [ ] `todo.md` fully ticked for Phases 0–4; spec updated wherever implementation diverged.
- [ ] Two Fable review passes (P2, P-final) done and their findings closed or explicitly deferred with the user's agreement.

---

## 11. What changes if the open questions are answered differently

| Question | Other answer | Effect on this plan |
|---|---|---|
| Q1 | (a) annotations only | Drop Phase 4's PWP-27…29 and Gate P4 (−3 days); `pdfForms` flag and the field rows of PV4 are not built. |
| Q1 | (c) plus free text and organise pages | Add PWP-40 and PWP-41 to v1 with their own gate (+ about 10 days). |
| Q2 | (b) single release | PR-P5 does not trigger a release; nothing else moves. |
| Q3 | (b)/(c) page operations in v1 | PWP-41 joins v1 (+ about 7 days) with a spike on `extractPages`; (b) additionally needs a full-rewrite save path, new guarantees and a spec revision — not recommended. |
| Q4 | (b) not default | One-word change in PWP-11 (`"option"`), README wording. |
| Q5 | (b) flatten later | No v1 change; a post-v1 item. |
| Q6 | (b) signed view-only | Classification returns a read-only reason; the warning text goes. (c) editing encrypted files: + about 5 days in Phase 2 (decryption in the strict reader, password passed to the host, permission policy). |
| Q7 | (b) raise the minimum | `engines.vscode` and `@types/vscode` bump in PWP-02 (to `^1.95.0`, measured by S2); the engine check remains as a safety net. |
| Q8 | (b) stack on Office branches | PR-P3 onwards are cut from the Office tips and rebased at merge. (c) own copies: PWP-13 is replaced by a copy and a later de-duplication task. |

---

## 12. Items that need the user

1. **Answers to Q1–Q8** (spec §16.2) — before Gate P0.
2. **Files**: ten everyday PDFs for the spike corpus; the `PENDING` fixtures of spec §13.3 (`acrobat-forms`, `acrobat-annotated`, `acrobat-signed`, `certified`, `linearized`, `xfa`, `scanner`, `latex`).
3. **Adobe Acrobat Reader installed** on the gate machine (free); Edge, Chrome and Firefox.
4. **Spike reader checks** (PWP-01: S3, S5, S7): about 30 minutes — prepared: 12 files and a numbered checklist in `spike/pdf/out/for-user/` on branch `spike/pdf-viewer` (worktree `VSMarkdownEditor-pdfspike`). Also still wanted from item 2: the ten everyday PDFs and Word-/Acrobat-produced files, which the spike could not generate.
5. **Each gate's human items**: P1 75 min, P2 45 min, P3 60 min, P4 45 min.
6. **Merging the Office PRs** that the PDF phases depend on (§3.1), and each PDF PR — self-reviewed and handed over unless the user asks for `gh pr merge --admin`.
7. **Release points**: after Gate P1 (viewer), optionally after P3 (annotations), and at P-final.
