# PowerPoint Viewer — Implementation Plan

Date: 2026-11-21 · Spec: `docs/pptx-viewer-spec.md` (all `§` references are to it; "Office plan" is `docs/office-viewers-plan.md`, "PDF plan" is `docs/pdf-viewer-plan.md`) · Starting branch: `feature/pptx-viewer-docs`

This plan slices the spec into work packages (XWPs). Each is sized for one implementation subagent run (≤ ~1,500 changed lines including tests) and names its files, dependencies, acceptance tests and implementer model. The spec says *what*; this document says *in what order, by whom, in which files, and how it is checked*. Where the two disagree, the spec wins and the plan gets fixed.

The plan is written for the recommended answers to the open questions (spec §15.2). §11 says what changes for each other answer.

---

## 1. Ground rules for every XWP

The orchestrator pastes this section into each brief. Rules 1, 2 and 5–10 of the Office plan §1 apply unchanged (read first and load `LSP`; touch only the listed files; done means `check-types`, `compile` and `npm test` green; parallel WPs return `todo.md`/`log.md` entries instead of editing them; no commits or PRs unless told; refuse rather than guess; report honestly what was not verified). PowerPoint-specific rules:

1. **View only.** No XWP adds a code path that writes a document, fires a `CustomDocumentEditEvent`, or makes kind `'pptx'` editable. `editFlagFor('pptx')` is the constant `false`. Nothing under `core/pptx/` or in `src/office/pptx*.ts` imports `edits`, `save` or `saveErrors`.
2. **`src/office/core/pptx/**` MUST NOT import `vscode`**, nor any npm package, nor anything outside `core/` except type-only imports from `../../pptxProtocol.js`. Imports between source files use the `./x.js` suffix.
3. **Only `media/pptxAdapter.js` touches `PptxBundle`** (spec XD3). Every other `media/pptx*.js` file talks to the adapter's interface.
4. **No renderer in the extension host.** The renderer package is used only from `scripts/pptx-vendor-entry.js`, `media/` and `scripts/pptx-render-check.mjs`. `pptxgenjs` is a devDependency used only from `scripts/pptx-fixtures/`.
5. **No `innerHTML` with document-derived strings** in any `media/pptx*.js` (spec §11).
6. **Tests**: `tests/office/pptx<Name>.test.mjs` (core, through the Office core test bundle and `tests/office/_helpers.mjs`) and `tests/office/pptx<Name>.test.js` (webview, DOM shim with a stubbed `PptxBundle`).
7. **The renderer version changes only through spec §12.6.** Nobody runs `npm install` for it except XWP-02.
8. **Shared Office files** are changed only by XWP-04, additively, with the Office suite unchanged and green.

Model legend as in the Office plan: **Opus** = touches shared code, hostile input or the centre of the design. **Sonnet** = mechanical or fully specified. **Fable** = independent review only (Gate X1).

---

## 2. Work-package overview

`Par.` = parallel group: XWPs sharing a group label may run concurrently (disjoint files, each in its own worktree). An XWP also waits for everything in *Depends on*.

| ID | Title | Model | Depends on | Par. | PR | ~Lines |
|---|---|---|---|---|---|---|
| **Phase 0** | | | | | | |
| XWP-01 | Spikes S1–S5, incl. the library bake-off | Opus | Office PR-3 on `develop` | A1 | none (throwaway) | 600 |
| XWP-02 | Scaffolding: dependency, bundle, notices, stubs, limits | Sonnet | XWP-01 (S1, S2) | A2 | PR-X1 | 400 |
| XWP-03 | Fixtures and generators, PowerPoint COM script | Sonnet | XWP-02 | A3 | PR-X2 | 900 |
| **Phase 1 — host core** | | | | | | |
| XWP-04 | Shared widening: kind `'pptx'` in the Office core, document, load errors, chrome | Opus | Office PR-3 | B1 | PR-X3 | 400 |
| XWP-05 | Protocol (`pptxProtocol.ts`) | Sonnet | XWP-01 | B1 | PR-X3 | 350 |
| XWP-06 | Presentation model (`core/pptx/model.ts`) | Sonnet | XWP-03, 04 | B2 | PR-X3 | 600 |
| XWP-07 | Outline, notes, alt text (`core/pptx/outline.ts`) | Opus | XWP-03, 04, 05 | B2 | PR-X3 | 1,000 |
| XWP-08 | Render copy (`core/pptx/renderCopy.ts`) | Opus | XWP-03, 04 | B2 | PR-X3 | 600 |
| XWP-09 | Notices and feature census (`core/pptx/notices.ts`) | Sonnet | XWP-06, 07 | B3 | PR-X3 | 450 |
| XWP-10 | Host provider (`pptxEditorProvider.ts`), not registered | Opus | XWP-05…09 | B4 | PR-X3 | 600 |
| **Phase 2 — viewer** | | | | | | |
| XWP-11 | View maths (`pptxViewMath.js`) | Sonnet | XWP-05 | C1 | PR-X4 | 500 |
| XWP-12 | Renderer adapter (`pptxAdapter.js`) | Opus | XWP-02, 05 | C1 | PR-X4 | 800 |
| XWP-13 | Viewer shell (`pptxViewer.js/.css`): boot, both views, zoom, navigation, links, copy | Opus | XWP-10, 11, 12 | C2 | PR-X4 | 1,300 |
| XWP-14 | Panels (`pptxPanels.js`): thumbnail rail, outline tab, notes panel | Sonnet | XWP-13 | C3 | PR-X4 | 900 |
| XWP-15 | Find (`pptxFind.js`) | Sonnet | XWP-13 | C3 | PR-X4 | 500 |
| XWP-16 | Present mode (`pptxPresent.js`) | Sonnet | XWP-13 | C3 | PR-X4 | 300 |
| XWP-17 | Render check script (`scripts/pptx-render-check.mjs`) | Sonnet | XWP-08, 12 | C2 | PR-X4 | 400 |
| XWP-18 | Notices wiring, fonts, theming and accessibility pass | Sonnet | XWP-14, 15, 16 | C4 | PR-X5 | 500 |
| XWP-19 | Registration, README, CHANGELOG, `docs/pptx-gate-checklist.md`, release preparation | Sonnet | XWP-18 | C5 | PR-X5 | 400 |
| **Post-v1** | | | | | | |
| XWP-30 | Copy outline / slide as Markdown | Sonnet | v1 | D | own | — |
| XWP-31 | EMF/WMF and SmartArt previews through the PDF viewer's pdf.js | Opus | v1, PDF v1 | D | own | — |
| XWP-32 | Export current slide as PNG; notes formatting | Sonnet | v1 | D | own | — |
| XWP-33 | PowerPoint files in wikilinks and the graph | Opus | v1, Office WP-53 | D | own | — |

v1 split: 7 Opus, 12 Sonnet; Fable for one independent review pass.

---

## 3. Ordering, branching, PRs, shared files

### 3.1 Where this slots in (sequenced last)

By user decision PowerPoint is built **after** the Word, Excel and PDF viewers and their basic editing are complete. The whole programme, in order:

| Order | Stack | PRs | Ends with |
|---|---|---|---|
| 1 | **Office viewers and editing** (Office plan) | PR-0 … PR-15 | Gate R-final, Office v1 release |
| 2 | **PDF viewer and editing** (PDF plan); its Phase 0 may overlap the Office merges | PR-P0 … PR-P11 | Gate P-final, PDF v1 release |
| 3 | **PowerPoint viewer** (this plan) | PR-X0 … PR-X5 | Gate X2, PowerPoint viewer release |

Two things may happen earlier without breaking that order, because they are inert: **PR-X0** (these two documents) can merge at any time, and the user can run the PowerPoint fixture script and collect sample decks whenever convenient. No XWP starts before Gate P-final is recorded as passed.

Dependencies on other stacks:

| PowerPoint work | Needs on `develop` | Why |
|---|---|---|
| Everything from XWP-01 | Office **PR-2** and **PR-3** (core, `OfficeDocument` load path, provider base, common protocol, `officeCommon`) | The viewer is a third kind on that code. This is the only hard technical dependency. |
| XWP-04 | The Office and PDF stacks finished | XWP-04 edits files those stacks also edit (`package.ts`, `officeDocument.ts`, `officeCommon.js`, the `kind` unions); doing it last means it never races them. If PDF PR-P6 extracted `BinaryDocumentBase`, XWP-04 works against that shape. |
| XWP-31 (post-v1) | PDF v1 | Reuses the shipped pdf.js. |

Nothing in v1 needs the Office save pipeline or anything in `src/pdf/`.

### 3.2 Branch and PR strategy

As for Office and PDF: small PRs straight to `develop`, each either inert or user-complete; no long-lived branch. **The viewer reaches users only after its human gate** (spec XD12): the `customEditors` entry and the registration in `src/extension.ts` exist only in PR-X5, and PR-X5 is merged only after Gate X2 passes on its branch. Everything merged before that is unreachable code plus unreferenced files in `media/`.

| PR | Branch | Contents | Releasable after merge? |
|---|---|---|---|
| PR-X0 | `feature/pptx-viewer-docs` | spec, plan, `.vscodeignore` lines (this PR) | inert |
| PR-X1 | `feature/pptx-scaffold` | XWP-02 | inert (bundle in the VSIX, unreferenced) |
| PR-X2 | `feature/pptx-fixtures` | XWP-03 → **Gate X0** | inert |
| PR-X3 | `feature/pptx-core` | XWP-04…10 → **Gate X1 (Fable independent review)** before merge | inert (provider not registered; Office behaviour unchanged) |
| PR-X4 | `feature/pptx-viewer` | XWP-11…17 | inert (not registered) |
| PR-X5 | `feature/pptx-viewer-release` | XWP-18, 19: registration, docs → **Gate X2 (human)** on the branch → merge → **release** (minor bump PR, `develop` → `master`, publish) | yes — PowerPoint viewer |

Every PR follows the project's self-review process before merge. Merge with `gh pr merge --admin` only when the user asks; otherwise hand off.

### 3.3 Shared files and who owns them

| File | Owner | Rule |
|---|---|---|
| `package.json`, `package-lock.json` | XWP-02 (dependencies); XWP-19 (`customEditors` entry, the three settings) | Both npm packages are added once, in XWP-02, with exact pins. |
| `esbuild.js`, `.gitattributes`, `THIRD-PARTY-NOTICES.md` | XWP-02 only | |
| `.vscodeignore` | PR-X0 (`docs/**`, `spike/**` after `scripts/**`; the Office and PDF branches add the same two lines) | No later change expected. |
| `src/office/core/package.ts`, `sniff.ts`, `limits.ts`, `core/index.ts`, `src/office/officeDocument.ts`, `loadErrors.ts`, `featureFlags.ts`, `protocol.ts` (`kind` union), `media/officeCommon.js` | XWP-04 only | Additive; Office tests unchanged and green; frozen for PowerPoint work afterwards. |
| `src/office/pptxProtocol.ts`, `src/types.ts` re-export | XWP-05 | Frozen after XWP-05; a change is a spec §5 change made by the orchestrator between groups. |
| `src/office/core/pptx/index.ts` | XWP-02 writes the complete barrel over stub modules | Parallel XWPs replace stubs, never the barrel. |
| `media/pptxViewer.js` | XWP-13, then XWP-18 | Panels, find and present live in their own files and register through `PptxShell.register*` hooks defined by XWP-13. |
| `src/extension.ts` | XWP-19 (one registration block after the Office and PDF ones) | |
| `todo.md`, `log.md`, `CHANGELOG.md`, `README.md` | orchestrator at merge time; XWP-19 for README/CHANGELOG | |

---

## 4. Phase 0 — spikes, scaffolding, fixtures

### XWP-01 — Spikes (Opus) · first; S1 and S2 block XWP-02

**Why Opus:** S2 picks the library and S3 can change the render-copy and accessibility design.

**Files (throwaway, never merged):** `spike/pptx/` on branch `spike/pptx-viewer` — its own `package.json`, a minimal extension with one custom editor for `*.pptx`, a webview that runs each experiment on open and reports to the host, which writes `spike/pptx/out/report.json` and per-slide screenshots. Launch with an isolated profile as in the Office spikes (`log.md`, 2026-10-13 tip). The only repo files changed are `log.md` (the report) and, if an outcome requires it, the spec and this plan.

**Start by repeating spec §3.2 from scratch** — the candidates' current versions, licences, publish dates and any new entrants — because months will have passed since the spec was written.

| # | Question (spec ref) | Method | Pass criterion | If it fails |
|---|---|---|---|---|
| S1 | The renderer under the real webview CSP (§11, assumptions 2, 3) | Load the esbuild IIFE in a VS Code webview with the target CSP; render the generated fixtures; collect `securitypolicyviolation` events and the network log; then remove directives one at a time | Zero violations, zero requests; the minimal directive set recorded | Add only the directive shown to be needed, with its reason, to spec §11; a need for `'unsafe-eval'` or `connect-src` to a remote origin disqualifies the library. |
| S2 | **Bake-off and fidelity** (§3.4, assumptions 1, 9) | Render every PowerPoint-made fixture, the LibreOffice and Google Slides files and the user's ten decks with the primary and the runner-up; screenshot each slide beside PowerPoint's exported PNG; **the user rates a sample of about 60 slides** as faithful / acceptable / wrong; tabulate by content type | The spec §13 acceptance bar; a recorded pick with reasons; the fidelity table of spec §3.5 corrected from evidence | Primary fails, runner-up passes and is ≥ 3 months old → swap (adapter only). Both fail → stop; re-plan Phase 2 around an in-house renderer (§11) and ask the user. |
| S3 | Render copy, DOM mapping, find highlight (§6.4, §9.2, §7.6; assumptions 4, 5, 6) | Feed the chosen renderer a copy with zero-length media, font, OLE and macro entries; compare rendered DOM order with shape-tree order on `shapes`, `layouts`, `tables`; try matching rendered nodes to shape ids; locate outline text in the DOM and paint it with the Highlight API | Renders identically to the original apart from media; a usable shape-id match; highlights land on the text | Copy: use the fallback of spec §6.4. Mapping: take the `aria-hidden` + outline route of spec §9.2. Highlight: shape-level outline only. |
| S4 | Limits and budgets (§8.2, assumption 7) | `large.pptx` and the user's largest deck in the webview: time to first slide, slide-switch time, scroll frame times with windowed mounting, thumbnail cost at 40 mounted, webview memory; host time for the model and a throwaway outline walk; 100 MB `Uint8Array` transfer | Within spec §8.2 | Lower the mounted-slide and thumbnail caps and the limits in `core/limits.ts` and the spec proportionally; rail falls back to titles sooner. |
| S5 | Fonts (§7.9, assumption 8) | Canvas width comparison for installed and absent font names in the webview; substitution stacks on `text.pptx` and `embedded-fonts.pptx` | Absent fonts detected with no false positives on installed ones; no font file is requested | Drop the "fonts not installed" list and keep a generic notice when the file names non-standard fonts. |

**Needs the user:** about 40 minutes — rating the S2 sample and supplying the ten decks.

**Acceptance:** a "PowerPoint Phase 0 spike report" section in `log.md` with one row per item (result, numbers, evidence file), the library decision, and any spec/plan edits made.

### XWP-02 — Scaffolding (Sonnet)

**Files:** `package.json`/lock (dependency: the renderer chosen by S2, exact; devDependency `pptxgenjs`, exact) · `scripts/pptx-vendor-entry.js` · `esbuild.js` (webview context → `media/pptx-bundle.js`, IIFE, global `PptxBundle`, minified; JSZip pointed at the shipped `media/jszip.min.js` if that works, spec assumption 10) · `media/pptx-bundle.js` (built, committed) · `.gitattributes` · `THIRD-PARTY-NOTICES.md` (the list in spec §4, re-read from the installed package's own notices) · `src/office/core/pptx/index.ts` barrel + one stub per module of spec §4, re-exported from `core/index.ts` as `pptx` · `tests/office/pptxSmoke.test.mjs` · `todo.md` (one checkbox per XWP and gate), `log.md`.

**Acceptance:** `compile`, `check-types`, `npm test` green; `npx @vscode/vsce ls` lists the bundle and none of `docs/`, `spike/`, `scripts/`, `tests/`; measured VSIX growth recorded in `log.md` (closes assumption 11); `dist/extension.js` size unchanged; the bundle contains no reachable `eval`.

### XWP-03 — Fixtures and generators (Sonnet)

**Files:** `scripts/pptx-fixtures/make-synthetic.mjs` (everything "generated by script" in spec §12.3) · `make-producers.ps1` (PowerPoint COM: builds each deck through the object model, "Save As" in each format including `.ppsx`, `.potx`, `.pptm`, password-protected and legacy `.ppt`, and exports every slide as PNG and each deck as PDF to `expected/`; closes PowerPoint when done; **run by the user**) · `tests/fixtures/pptx/*` + `README.md` (producer, recipe, what it exercises, passwords) · `tests/office/pptxFixtures.test.mjs` (every named file exists; producer-made and user-supplied ones in a `PENDING` list that warns; none over 5 MB except `large.pptx`).

**Needs the user:** run `make-producers.ps1` once (about 15 minutes, PowerPoint must be installed); supply `libreoffice.pptx`, `googleslides.pptx` and the ten decks. XWP-01 S2 needs the producer fixtures, so in practice the script is written first and run before the spike's bake-off.

> **Gate X0** (after PR-X2): spike report complete; library decision recorded; every failed assumption applied to the spec and this plan; open questions Q1–Q4 answered by the user and recorded in spec §15.2; fixtures present. Orchestrator self-review; no Fable pass.

---

## 5. Phase 1 — host core

### XWP-04 — Shared widening (Opus)
**Why Opus:** it edits the files that decide what the Office editors may save.
`core/package.ts` (`OfficeKind` + `'pptx'`; the six main-part content types and `fileKind`; `EXT_KIND` for the six extensions; "not a presentation" refusal), `core/sniff.ts` (legacy detail), `core/limits.ts` (spec §8.2), `officeDocument.ts` (kind accepted; DOCTYPE guard applies; no other branch changes), `loadErrors.ts` ("PowerPoint", ".ppt"), `featureFlags.ts` (`editFlagFor('pptx')` → `false`, typed so it cannot be flipped by adding a flag), `protocol.ts` (`init.kind`), `media/officeCommon.js` (application name; view-only hint for Ctrl+E), tests added to `package.test.mjs`, `sniff.test.mjs`, `loadErrors.test.mjs`, `officeCommon.test.js`.
**Acceptance:** every existing Office test passes unmodified; classification table for the six types, the wrong-kind cases and the encrypted, legacy, lock-file, empty and damaged fixtures; a test that a `'pptx'` document reports `canEdit: false` whatever the Office flags are.

### XWP-05 — Protocol (Sonnet)
`src/office/pptxProtocol.ts` verbatim from spec §5 with `parsePptxToHost(raw)` enforcing `PPTX_PROTOCOL_LIMITS`; `src/types.ts` re-export under a "PowerPoint Viewer Types" banner; `tests/office/pptxProtocol.test.mjs` (table-driven rejections; every shape accepted).

### XWP-06 — Presentation model (Sonnet)
`core/pptx/model.ts`, tests. Spec §6.2: slide order through relationships, hidden flags, size and its fallback, first slide number, sections, embedded-font names, missing-slide handling, the 5,000-slide cap; asynchronous with the shared yield rule. Acceptance per fixture: expected slide count, order, hidden set, size, sections.

### XWP-07 — Outline, notes, alt text (Opus)
**Why Opus:** it is the source of find, accessibility and the fallback view, over hostile XML.
`core/pptx/outline.ts`, tests. Spec §6.3 in full, with the outbound caps of spec §5; batches of slides with yields. Acceptance: expected titles, block lists, notes and object kinds for every fixture (the producer-made ones against a hand-checked `expected/outline/*.json`); `hostile-text.pptx` round-trips characters exactly (XG3); caps hold on generated oversize inputs (XG5); never blocks the event loop over 50 ms on `large.pptx`.

### XWP-08 — Render copy (Opus)
**Why Opus:** it writes a ZIP; a wrong class rule either leaks what must be withheld or breaks rendering.
`core/pptx/renderCopy.ts`, tests. Spec §6.4 as finalised by S3: classes from content types and relationship types; `writeZip` with raw copies; verification with the shared reader. Acceptance: XG2 on every fixture; `media`, `macro`, `ole`, `embedded-fonts` copies contain no bytes of the stripped entries; the original bytes are never mutated; failure to build yields an error result, never the original.

### XWP-09 — Notices (Sonnet)
`core/pptx/notices.ts`, tests. Spec §7.10 (host half): census from the model and outline; merge of `pptxFacts`; fixed wording table. Acceptance: the expected notice codes per fixture.

### XWP-10 — Host provider (Opus)
**Why Opus:** lifecycle and CSP are where a mistake is invisible until the gate.
`src/office/pptxEditorProvider.ts`, `tests/office/pptxProvider.test.mjs` (vscode stub). Extends the provider base; the CSP string of spec §11 as finalised by S1; `pptxRequestDeck` → `pptxDeck`, `pptxRender` (render copy), `pptxOutline` batches; `pptxFacts` → notices; reload → `pptxStateChanged`; link allow-list through the base. **Not registered.**
**Acceptance (automated):** XG0 (no write, no edit event, source check), XG1 through the provider, XG4; CSP snapshot (no origin other than `cspSource`, no `unsafe-eval`, no `connect-src`/`media-src`/`frame-src`); stale-version and bad-message handling.

> **Gate X1 — core (Fable independent review, before PR-X3 merges).** Fable reviews the PR-X3 diff — the shared widening, `core/pptx/*`, `pptxProtocol.ts`, `pptxEditorProvider.ts` — against spec §5, §6, §8 and §11, given the code and the spec, not the authors' conclusions. Brief: "find any way a PowerPoint file can become editable or be written; any way the Office editors' behaviour changes; any document-derived string that could reach the webview as markup or the host as a path; any unbounded work on hostile input; anything withheld classes of the render copy could miss." Findings closed or deferred with the user's agreement. Automated: XG0–XG5 green; Office suite unchanged and green. No human dev-host items: nothing is reachable yet.

---

## 6. Phase 2 — viewer

### XWP-11 — View maths (Sonnet)
`media/pptxViewMath.js` (UMD, pure): zoom steps and clamping, fit computations from slide size, mounted-slide and thumbnail windows, slide-box parsing, hidden-slide stepping, find over outline batches (reusing `findMatches` semantics: match case, whole word, snippets, ordering, "more than N"), font substitution stacks, missing-font decision from width samples. `tests/office/pptxViewMath.test.mjs`.

### XWP-12 — Renderer adapter (Opus)
**Why Opus:** the single point of contact with third-party code that parses hostile input.
`media/pptxAdapter.js`, `tests/office/pptxAdapter.test.js` (stubbed `PptxBundle`). Interface: `open(bytes, options)` → `{ slideCount, width, height }`; `mountSlide(index, element)` → handle with `ready` and `dispose`; `mountThumbnail(index, element, width)`; `dispose()`; events `slideError`, `shapeError`. Fixed options: external media blocked, PDF.js off, embedded fonts off, limits from the host, lazy slides and media, no library UI. Post-processing of each mounted slide: media elements replaced by placeholders; alt text and ARIA from outline blocks (or the spec §9.2 fallback, per S3); anchors neutralised and routed to a callback; `window.open` replaced; slide-jump callbacks.
**Acceptance:** the options object passed to the library is asserted exactly; a mounted slide containing `<video>`, `<a href>` and a `tabindex` span comes out with placeholder, intercepted link and labels; errors from the stub become events, never exceptions; `dispose` releases every handle.

### XWP-13 — Viewer shell (Opus)
**Why Opus:** boot sequence, virtualisation and state are the centre of the viewer.
`media/pptxViewer.js`, `media/pptxViewer.css`, `tests/office/pptxViewer.test.js`. Spec §7.1, §7.3, §7.5, §7.7, §8.3 (viewer rows): `init` → `pptxRequestDeck`; deck, render and outline handling in any arrival order; Slide and Scroll views with the windows of XWP-11; zoom and fit; slide box; keyboard of spec §9.3; link clicks → `openLink` or in-viewer navigation; copy → `writeClipboard`; "Copy slide text" / "Copy notes"; per-slide failure view and the whole-deck text view; `pptxStateChanged` reload keeping position; `vscode.setState`; defines `PptxShell.registerPanel / registerToolbarItems / onSlideChange / onSlideMounted`.
**Acceptance:** DOM-shim tests for each of the above with a fake adapter; no document string reaches `innerHTML` (XG3); external link click posts `openLink` and prevents navigation.

### XWP-14 — Panels (Sonnet) · XWP-15 — Find (Sonnet) · XWP-16 — Present (Sonnet) · XWP-17 — Render check (Sonnet)
`media/pptxPanels.js` (+ CSS): spec §7.2, §7.4 — rail as a `listbox` with lazy thumbnails, hidden and section marking, the titles-only mode; Outline tab; notes panel with its three heights. `media/pptxFind.js`: spec §7.6 over XWP-11's matcher; Highlight API painting; shape or slide outline fallback; notes matches. `media/pptxPresent.js`: spec §7.8. Each with DOM-shim tests for keyboard behaviour, announcements and `textContent`-only rendering. `scripts/pptx-render-check.mjs`: spec §12.4 — per fixture a static page with the production CSP, the bundle, the adapter and the render copy (built through the core test bundle); headless Edge or Chrome found on `PATH` or the usual install locations; JSON report and screenshots under `tests/.out/pptx/`; non-zero exit on any violation, request or unexpected error.

### XWP-18 — Notices, fonts, theming, accessibility (Sonnet)
`media/pptxViewer.js` (missing-font check and `pptxFacts`; failure counts), `media/pptxViewer.css` and panel CSS (theme tokens, high-contrast outlines, `forced-colors`, `prefers-reduced-motion`, in-slide placeholder style), slide `role`/labels and live-region announcements (spec §9.2), settings read (`defaultView`, `showNotes`, `showHiddenSlides`).

### XWP-19 — Registration, docs, release preparation (Sonnet)
`package.json` (`customEditors` entry with the six patterns; three settings), `src/extension.ts` (registration with `retainContextWhenHidden: true`, `enableFindWidget: false`, `supportsMultipleEditorsPerDocument: false`), `README.md` (PowerPoint viewer section: what it shows; what is a placeholder; nothing runs; view only; fonts; default-editor note), `CHANGELOG.md`, `THIRD-PARTY-NOTICES.md` re-checked against the lockfile, `vsce ls` re-check, `docs/pptx-gate-checklist.md` in the style of `docs/office-gate-checklist.md` from the outline in spec §12.5, `todo.md`/`log.md`.

> **Gate X2 — viewer (human, about 60 minutes, on the PR-X5 branch before it merges).** First, scripted: `npm test` and `node scripts/pptx-render-check.mjs` green, recorded in `log.md`. Then `docs/pptx-gate-checklist.md` in an isolated Extension Development Host: every fixture opens to the right view or error view; fidelity side by side with PowerPoint for the listed fixtures and three of the user's decks; placeholders and "nothing runs" on `animations`, `media`, `ole`, `macro`, `external-image`, `actions`; rail, outline, notes, hidden slides, zoom, both views, find, copy, links, present; webview console shows no CSP violation and the network panel no request for every fixture; `large.pptx` against the budgets; light, dark and both high-contrast themes; keyboard-only walkthrough; Narrator or NVDA on the Outline tab and one slide; `git status` clean afterwards and no document ever dirty; Word and Excel viewers spot-checked for regressions from XWP-04. `/code-review` on the PR-X4 and PR-X5 diffs. Result recorded in `log.md`. **Pass → merge PR-X5 → release.**

---

## 7. Release point

One release, after Gate X2: PR-X5 merges, then the usual flow — check the Marketplace version, a version-bump PR (minor: a new user-facing viewer and a new default editor for six extensions) with CHANGELOG to `develop`, `develop` → `master`, publish from `master`. If other unreleased work is on `develop` it ships in the same release.

---

## 8. Estimates and parallelism

Effort is implementation plus self-review by agents, in working days of orchestrated time; human time is the user's. Most uncertain where the spike could change the design (the adapter and Phase 2).

| Phase | XWPs | Agent effort | User time | Can run in parallel |
|---|---|---|---|---|
| 0 | 01–03 | 2–3 days | 15 min (fixture script) + 40 min (rating the bake-off) + supplying decks | The fixture script (part of XWP-03) is written and run first; then XWP-01; then 02 → rest of 03. |
| 1 | 04–10 | 3–4 days | none (Gate X1 is a Fable review) | B1: XWP-04, 05 together. B2: XWP-06, 07, 08 together. |
| 2 | 11–19 | 4–5 days | Gate X2: 60 min | C1: XWP-11, 12 together. C3: XWP-14, 15, 16 together; XWP-17 alongside XWP-13. |
| **Total v1** | 19 | **about 9–12 working days** | about 2 hours | |

Critical path: (fixture script) → XWP-01 → 02 → 04 → 07 → 10 → 13 → 14 → 18 → 19 → Gate X2.

Phase 1 does not depend on which library S2 picks, so it can start as soon as S1 and S3 have reported, while the bake-off rating is still with the user.

---

## 9. Per-release manual checklist

Before each release PR that changes PowerPoint behaviour or the renderer version; recorded in `log.md`.

1. `npm test`; `node scripts/pptx-render-check.mjs` — zero failures; screenshots compared with the previous run for `layouts`, `text`, `shapes`, `charts`.
2. Isolated dev host: open `basic`, `layouts`, `charts`, `media`, `macro`, `encrypted`, `large`; both views, find, notes, present.
3. Webview console: no CSP violation; network: no request.
4. Theme sweep and a keyboard-only pass.
5. `git status` clean; nothing dirty.

---

## 10. Definition of done for v1

- [ ] Gates X0, X1 and X2 recorded as passed in `log.md`; spike report present with the library decision; every spec §15.1 assumption marked verified or replaced; Q1–Q4 recorded as decisions.
- [ ] `check-types`, `compile`, `npm test` green on `develop`; the Office and PDF suites unchanged and green.
- [ ] XG0–XG5 green on every fixture with no `PENDING` fixture left; XG6 green in `pptx-render-check`.
- [ ] Every fixture opens to a view or the specified error view; no document is ever dirty; no code path writes a PowerPoint file.
- [ ] Only `media/pptxAdapter.js` references `PptxBundle`; the renderer is pinned exactly; `THIRD-PARTY-NOTICES.md` current.
- [ ] `vsce ls`: the bundle present; no `docs/`, `tests/`, `scripts/` or `spike/`.
- [ ] README and CHANGELOG describe the viewer, its limits (view only, placeholders, nothing runs, fonts) and the default-editor change.
- [ ] `todo.md` fully ticked for Phases 0–2; spec updated wherever implementation diverged.
- [ ] The Fable review at X1 done and its findings closed or explicitly deferred with the user's agreement.

---

## 11. What changes if the open questions are answered differently, or the spike fails

| Question | Other answer | Effect on this plan |
|---|---|---|
| Q1 | (b) in-house renderer | XWP-12 becomes a renderer on the host model instead of an adapter: new XWPs for the shape tree with placeholder inheritance, text layout, preset geometry, tables and theme colours (reusing `core/xlsx/styles.ts` colour handling), each Opus; charts and SmartArt become placeholders; no bundle, no notices; + about 15–20 days; a second Fable gate for the renderer. Host core, protocol and chrome are unchanged. |
| Q1 | (c) text-only | Drop XWP-02's bundle, XWP-08, 12, 17 and the rail thumbnails; the Outline becomes the main view; − about 4 days. |
| Q2 | (b) `.pptx` only / (c) "Open With…" only | One-line changes in XWP-19 (selector list or `"option"`), README wording. Classification still recognises all six types. |
| Q3 | (b) no Present mode | Drop XWP-16 (− 0.5 day). |
| Q4 | (b) merge early as "Open With…" only | XWP-19's registration moves into PR-X4 with `priority: "option"`; PR-X5 flips it to `"default"` after Gate X2; README says "preview" meanwhile. |
| Spike S2 | the runner-up wins | XWP-02 pins it instead; XWP-12 is written against it (HTML-string output: the adapter inserts it into a detached container first and applies the same post-processing); spec §11 notes stay as written. No schedule change. |
| Spike S2 | both fail | As Q1 (b), after asking the user. |
| Spike S3 | render copy not tolerated | Spec §6.4 fallback in XWP-08 (+ 0.5 day). |

---

## 12. Items that need the user

1. **Answers to Q1–Q4** (spec §15.2) — before Gate X0. They can be given now; the build itself waits for the Office and PDF stacks.
2. **Run `scripts/pptx-fixtures/make-producers.ps1`** once (PowerPoint COM, about 15 minutes) when XWP-03 delivers it.
3. **Files**: `libreoffice.pptx`, `googleslides.pptx`, optionally a Keynote export, and ten everyday decks for the spike corpus (not committed).
4. **Rate the bake-off sample** (XWP-01 S2): about 40 minutes.
5. **Gate X2**: about 60 minutes in an Extension Development Host with desktop PowerPoint available for side-by-side checks.
6. **Merges**: each PR is self-reviewed and handed over unless the user asks for `gh pr merge --admin`. PR-X5 merges only after Gate X2.
7. **Release** after Gate X2.
