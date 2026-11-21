# PowerPoint Viewer — view only

Status: Draft for user decision (open questions in §15.2) · Date: 2026-11-21 · Branch: `feature/pptx-viewer-docs`
Audience: the user (decisions, risks) and the implementing agents (everything else). The work is sliced into tasks in `docs/pptx-viewer-plan.md`.

Conventions used here: **MUST / MUST NOT** are requirements. "**[Verified]**" means checked on the date above against the published package (installed into a scratch directory outside the repo, source read, and where stated run in headless Edge 157) or against this repo's worktrees. "**[Assumption]**" means not verified; each one is collected in §15.1 and most are closed by the Phase 0 spikes.

This document follows `docs/office-viewers-spec.md` (the Office spec) and `docs/pdf-viewer-spec.md` (the PDF spec) in structure. "Office §n" and "PDF §n" refer to those documents. PowerPoint files are OOXML packages like Word and Excel files, so this viewer is built on the Office core and chrome rather than beside them.

**User decisions already taken:** PowerPoint is **view only** — no editing of any kind, no save path, a file is never written. It is **sequenced last**: built after the Word, Excel and PDF viewers and their basic editing are complete (plan §3.1).

**Assumed defaults carried over from the Office and PDF decisions:** default editor for PowerPoint files; no network access; not switched on for users until its human gate passes; the same theming, accessibility and error-view conventions; spec and plan live in `docs/`.

---

## 1. Summary of decisions

| # | Decision | Choice |
|---|---|---|
| XD1 | Rendering approach | **An existing open-source renderer in the webview**, not an in-house one. Slides are drawn as HTML/SVG DOM, so text is real text (selectable, searchable, readable by a screen reader). |
| XD2 | Library | **`@aiden0z/pptx-renderer` 1.4.0** (Apache-2.0), pinned exactly, bundled into one IIFE. Runner-up: `@meshesha/pptxjs` 2.0.0 (MIT). The pick is confirmed by a bake-off on real PowerPoint files in the first spike, because the build starts months from now and both projects are young (§3.4). |
| XD3 | Isolation of the library | Exactly one webview file, `media/pptxAdapter.js`, touches the library. Everything else talks to the adapter. Swapping the library is one work package. |
| XD4 | Where code runs | As for Word (Office D4, D9): the **host** opens the package with the Office core, classifies it, extracts everything the viewer's own features need (slide list, text, notes, alt text, feature census) and prepares a render copy; the **webview** renders slides from that copy. |
| XD5 | Render copy | The webview never receives the original file. It receives a copy in which video, audio, embedded fonts, macros and embedded OLE payloads are replaced by empty entries (§6.4). The file on disk is never written. |
| XD6 | Document model | Reuse `OfficeDocument` and `OfficeEditorProviderBase` with a third kind, `'pptx'`, that is never editable. No save, backup, undo or edit-mode code is added or reachable. |
| XD7 | Own text model | Find, the outline, speaker notes, alt text and notices come from the **host's** reading of the slide XML with our lossless XML parser, not from the renderer. They keep working when a slide fails to render and survive a change of library. |
| XD8 | Nothing runs | Animations, transitions, timings, video, audio, macros, OLE objects, ActiveX and action buttons that run programs are never executed or played. Slides are shown in their final (all builds complete) state. |
| XD9 | Fonts | Embedded fonts are **not loaded**. Text uses installed fonts with a fallback table; a notice lists fonts that are missing (§7.9). |
| XD10 | Views | Slide view (thumbnail rail, one slide, notes panel), Scroll view (all slides, virtualised) and a simple Present mode that fills the editor (§7). |
| XD11 | File types | `.pptx`, `.ppsx`, `.potx` and their macro-enabled forms `.pptm`, `.ppsm`, `.potm`. Legacy `.ppt` is not claimed; a legacy or encrypted file with a new extension gets the shared error view (§8.3). |
| XD12 | Switching it on | The `customEditors` entry and the provider registration merge only after the human gate passes (§13, plan §3.2). A manifest contribution cannot be hidden by a runtime flag, so "flag off until the gate" is implemented as "not merged until the gate". |

Rejected (reasons in §3): an in-house renderer as the first choice, `pptx-preview`, PptxViewJS (canvas), `pptx-viewer`, `@jvmr/pptx-to-html`, `pptxtojson` plus our own drawing code, converting to PDF and reusing the PDF viewer, rendering in the extension host, loading embedded fonts, running media.

---

## 2. Context and constraints

### 2.1 This repo

- Extension host code is bundled by esbuild from `src/extension.ts` to `dist/extension.js`. Webview scripts in `media/` are plain JS loaded directly; vendor files are copied or bundled at build time and committed. ESM-only vendors are bundled into an IIFE by a separate esbuild context (precedent: `scripts/three-vendor-entry.js` → `media/three-bundle.js`).
- Webview assets MUST carry `?v=${Date.now()}`, a per-load nonce and a `default-src 'none'` CSP.
- Tests run with `node --test "tests/**/*.test.{js,mjs}"` after building a test bundle of the Office core. No CI runs them; Playwright is not a devDependency; webview JS is verified with a `node:vm` DOM shim. Anything needing a real webview is a human gate item.
- `engines.vscode` is `^1.85.0` on `develop` today (the PDF work may raise it; PDF spec Q7).
- Project rules: `todo.md` and `log.md` are maintained by the implementers; work goes through `feature/*` → `develop` PRs with self-review.

### 2.2 What is reused from the Office work

The Office code is on local branches, not on `develop`, as of this date **[Verified: `develop` has no `src/office/`; the most complete copy is the `VSMarkdownEditor-refs` worktree, branch `feature/office-xlsx-structure-ui`]**. By the time this work starts it will all be merged (sequenced last). The hard dependency is Office PR-2 and PR-3 (core, chrome, provider base).

| Piece (Office worktree) | Reuse | How |
|---|---|---|
| `core/zip.ts` — bounded ZIP reader and writer, CRC, refusals (`zip64`, `encrypted`, `unsafe-name`, …) | **Shared, unchanged** | Reading the package; `writeZip` builds the render copy (§6.4). |
| `core/xml.ts` — lossless XML, DOCTYPE rejected, depth and attribute caps | **Shared, unchanged** | Reading `presentation.xml`, slides, notes, relationships. |
| `core/opc.ts` — content types, relationships, main-part discovery | **Shared, unchanged** | Slide order and every part lookup go through relationships, never through paths. |
| `core/package.ts` — `OfficePackage.open`, classification | **Shared, widened** | `OfficeKind` gains `'pptx'`; six presentation main-part content types; the extension table; a size rule (§8.2). |
| `core/sniff.ts` — lock file, empty, too large, OLE compound file (encrypted vs legacy) | **Shared, one line** | The legacy detail names the `PowerPoint Document` stream. |
| `core/limits.ts` | **Shared, extended** | PowerPoint thresholds added (§8.2). |
| `loadErrors.ts` — failure → error-view text | **Shared, widened** | "PowerPoint", ".ppt". |
| `officeDocument.ts` — read through `workspace.fs`, never throwing from `openCustomDocument`, load-error state, reload when the file changes on disk, lock-file notice, the pre-render DOCTYPE guard | **Shared, widened** | Kind `'pptx'`; the DOCTYPE guard covers it. All save, backup, undo and edit code stays unreachable because `editFlagFor('pptx')` is the constant `false`. |
| `officeEditorProviderBase.ts` — HTML with nonce and cache-busting, `localResourceRoots = [media]`, common messages, `allowedExternalLink`, `LINK_BLOCKED_NOTICE` | **Shared, unchanged** | `PptxEditorProvider` extends it and supplies its own CSP string (§11). With the edit flag off the base already presents a read-only provider to VS Code **[Verified in the source: `onDidChangeCustomDocument` is undefined when the kind's flag is off]**. |
| `protocol.ts` common messages, `OfficeNotice`, `OfficeError` | **Shared, one line** | `init.kind` gains `'pptx'`. PowerPoint messages live in `src/office/pptxProtocol.ts`. |
| `media/officeCommon.js/.css` — toolbar with roving tabindex, notices bar, error view, hint, live region | **Shared, small change** | A `'pptx'` kind: application name "PowerPoint"; Ctrl+E shows "PowerPoint files are view-only here" instead of the edit hint. The Edit button is already hidden when `canEdit` is false **[Verified in the source]**. |
| `core/xlsx/styles.ts` — theme colour scheme reading, `applyTint`, default Office theme | **Pattern, small reuse** | The renderer resolves theme colours itself. v1 uses the theme reader only for the background colour of unmounted thumbnail placeholders (§7.2). |
| `media/findBar.js` (`findMatches`, CSS Custom Highlight painting) | **Shared** | Find (§7.6). On `develop` today **[Verified]**. |
| Test harness: core test bundle, `tests/office/_helpers.mjs`, `_vscodeStub.cjs` | **Shared** | PowerPoint tests live in `tests/office/pptx*.test.{mjs,js}`. |
| Not used | — | `edits.ts`, `save.ts`, `saveErrors.ts`, validators, docx-preview, the grid, numfmt, `@borgar/fx`, all of `src/pdf/`. |

If PDF PR-P6 (extraction of `BinaryDocumentBase`) has merged, `OfficeDocument` is a subclass of it; nothing here changes, because this work uses only the load and reload half.

---

## 3. Rendering approach and library decision

### 3.1 The choice to make

A slide is a tree of absolutely positioned shapes: text boxes, preset and custom geometry, pictures, tables, charts, groups. What it looks like depends on three levels of inheritance (slide → layout → master → theme) for placeholders, text styles, colours and backgrounds. Two ways to draw it in a webview:

- **In-house**, on our OPC/XML core: full control, no third-party risk, but the work is large. The preset geometry catalogue alone is about 190 shapes defined by guide formulas; text needs the list-style cascade, autofit, bullets and numbering, tabs and vertical text; tables need the table-style cascade; fills need gradients, patterns and picture crops. The chosen library spends 738 KB of minified code on exactly this **[Verified]**. A credible in-house renderer limited to text, pictures, tables and common shapes is about 15–20 agent working days and would still look worse than the libraries on real decks.
- **An existing renderer**: someone else's fidelity work, at the price of a dependency that parses hostile input in the webview.

The Office work made the same choice for Word (docx-preview in the webview behind a host guard, Office D4) and kept in-house code for the parts where correctness is ours to guarantee. The same split is right here: there is no saving, so a renderer bug can misdraw a slide but cannot damage a file.

### 3.2 Candidates

All packages were installed into a scratch directory with `--ignore-scripts` and their distributed files read **[Verified]** unless a cell says otherwise.

| Package | Version · last publish | Licence | Output | Size | Dependencies | Findings |
|---|---|---|---|---|---|---|
| **`@aiden0z/pptx-renderer`** | 1.4.0 · 2026-10-18 (first release 2026-02; 15 releases) | Apache-2.0 | DOM (HTML + SVG; charts on canvas) | ES build 1.34 MB unminified; our IIFE measures **1,468 KB minified**: renderer 738 KB, ECharts + zrender 629 KB, JSZip 98 KB | `jszip`, `echarts` 6, `mtx-decompressor` (MPL-2.0, bundled in); optional peer `pdfjs-dist` | Text set with `textContent`; the one `innerHTML` with text escapes it first. No `eval`. ZIP limits, external-media blocking, embedded-font limits, lazy slides and media, windowed list, model-level text search, scaled thumbnails, per-node error events. Does **not** read speaker notes; sets no `alt` or ARIA on shapes. GitHub: 145 stars, 38 forks, one main author (322 of about 330 commits), CI and a visual-regression suite against PowerPoint exports. |
| **`@meshesha/pptxjs`** | 2.0.0 · 2026-11-20 (a TypeScript rewrite of PPTXjs; v1 last released 2022) | MIT | HTML strings inserted into the DOM; charts as SVG | UMD 366 KB minified, including an editor and exporters we would not use | `fflate` (already ours) | No `eval`. Reads notes and hidden slides; ARIA roles on slides; dependency-free charts; headless `renderToHtml` runs without a DOM. Builds HTML strings (document text is escaped by its XML reader); relies on inline `style` attributes and injects a `<style>` element. **One day old** as a release on the spec date. GitHub (whole project): 279 stars, 70 forks. |
| `pptx-preview` | 1.0.7 · 2025-10-17 | package says ISC; the README forbids publishing or modifying the source; GitHub reports no licence | DOM | UMD 1.36 MB | `echarts` 5 (whole), `lodash`, `uuid`, `jszip`, `tslib` | **Closed source**: only minified files are published and the README offers the source for payment. Run text is assigned with `innerHTML` and no escaping was found in the bundle, so slide text can inject markup. Rejected. |
| `pptxviewjs` (PptxViewJS) | 1.1.9 · 2026-03-22 | MIT | **Canvas** | 621 KB minified | peers `chart.js`, `jszip` | Canvas output means no text selection, no find highlighting and nothing for a screen reader. The bundle references a CDN URL for JSZip and YouTube URLs. Rejected. |
| `pptx-viewer` | 0.2.2 · 2026-04-13 | MIT | DOM | 110 KB | `fflate` | Small and young (8 stars, 22 open issues); README claims basic table styling and common charts only. Rejected for fidelity **[Assumption: not rendered here]**. |
| `@jvmr/pptx-to-html` | 1.1.2 · 2026-09-03 | MIT | HTML strings | 103 KB | `jszip` | Small converter. Rejected for fidelity **[Assumption: not rendered here]**. |
| `pptxtojson` | 3.0.0 · 2026-11-15 | MIT | JSON model (no renderer) | 449 KB | `jszip`, `txml`, `tinycolor2` | A parser only; all drawing would still be ours. Rejected. |
| PPTXjs v1 (`meshesha/PPTXjs` before the rewrite) | — | MIT | HTML strings via jQuery | — | jQuery, JSZip, FileReader.js, d3, nvd3, tinycolor (per the v2 changelog) | Superseded by the rewrite above. The npm name `pptxjs` is an unrelated empty placeholder. |

Not a JavaScript renderer, considered and rejected: **converting to PDF** (LibreOffice or PowerPoint) and showing it in the PDF viewer needs an installed application and a process launch per file, and loses notes and hidden-slide information; **a hosted conversion service** breaks the no-network rule.

### 3.3 Experiments

Run on 2026-11-21 in headless Microsoft Edge 157 from a `file://` page whose only scripts carried a nonce, with the deck embedded in the page (no fetch), on a three-slide deck generated with `pptxgenjs` 4.0.1 (title with `<b>` and `&` in its text, bullets, an `https:` link, a `javascript:` link, two preset shapes, a table, an embedded PNG with alt text, a bar chart, speaker notes, a hidden slide) **[Verified by experiment]**.

| Check | `@aiden0z/pptx-renderer` 1.4.0 (our esbuild IIFE) | `@meshesha/pptxjs` 2.0.0 (its UMD) |
|---|---|---|
| CSP `default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:` | all three slides rendered; **0 violations**; 0 resource requests | all three slides rendered; **0 violations**; 0 resource requests |
| Same without any `style-src` | renders; **1** violation (`style-src-attr`) — almost all styling goes through the CSSOM | renders; **71** violations (`style-src-attr`, `style-src-elem`) |
| Same without `blob:` in `img-src` | 1 violation: pictures are `blob:` URLs | not run (its picture was a `data:` URL) |
| Text containing `<b>…</b>` | shown literally; no `<b>` element created | shown literally; no `<b>` element created |
| `javascript:` link | no anchor created | anchor with an empty `href` |
| Chart | 1 `<canvas>` (ECharts) | SVG with `role="img"` |
| Picture alt text | not carried to the `<img>` | not carried to the `<img>` |
| Hidden slide | rendered; `hidden: true` in the model | rendered; `hidden` in the headless result |
| Speaker notes | not in the model | returned by `renderToHtml` |
| `eval` / `new Function` in the bundle | none reachable: one `new Function` in JSZip's `setImmediate` polyfill for a string argument (the same JSZip the Word viewer ships) | none |
| Embedded fonts off | `embeddedFontLimits: { maxFaces: 0 }` accepted | has no embedded-font loading |

A 300-slide, 4.4 MB synthetic deck was parsed with lazy slides and lazy media, its model searched (1,800 matches) and a thumbnail rendered, without error, by the first library. Its windowed list did not complete under headless virtual time (the `IntersectionObserver` never fired there), so **no timing from that run is used**; performance is measured in spike S4 in a real webview.

Not tested here, and the main remaining risk: **fidelity on decks made by PowerPoint itself**, by LibreOffice and by Google Slides. `pptxgenjs` output is simpler than real decks. This is spike S2.

### 3.4 Recommendation and decision rule

**Use `@aiden0z/pptx-renderer`, pinned exactly, behind an adapter.** Reasons, in order:

1. It builds DOM nodes and sets text with `textContent`, which matches this repo's rule against `innerHTML` with document-derived strings; the runner-up produces HTML strings and depends on its own escaping being complete.
2. It has nine months of releases, a regression suite measured against PowerPoint's own output, and documented support boundaries; the runner-up's rewrite was published the day before this spec.
3. It already has what large decks need: lazy parsing, windowed mounting, thumbnails as scaled DOM, limits for untrusted input.
4. Its needs under CSP are exactly the Office webview CSP (verified above).

What it costs: about 1.5 MB in the VSIX (ECharts is 0.63 MB of that), Apache-2.0 and MPL-2.0 notices to ship, and a dependency with one main author. What it lacks (notes, alt text, ARIA) is supplied by our own model (XD7), which we want regardless.

**The pick is re-confirmed at the start of the build (spike S2), not assumed.** Both candidates are rendered over the fixture set and the user's sample decks and compared with PowerPoint's own slide exports. The primary is kept unless the runner-up is clearly better on the user's decks *and* has by then at least three months of releases; a release younger than 14 days is never adopted. If both fail the acceptance bar of §13 Phase 0, the fallback is an in-house renderer limited to text, pictures, tables and common shapes, with a replanned schedule (plan §11). Because of XD3 and XD7 none of these outcomes changes the host code, the protocol or the viewer chrome.

Rules for the dependency: exact version pin; the bundle is built by our esbuild from the lockfile and committed; upgrades only through §12.6; the library's own navigation UI, external-media loading, embedded-font loading and PDF.js fallback are switched off.

### 3.5 Fidelity budget

What a user can expect. "Approximate" means recognisable and correctly placed but not pixel-equal to PowerPoint. The *Library* column is the library's own claim **[Verified in its README; behaviour on real decks is spike S2]**.

| Content | Result in v1 | Library |
|---|---|---|
| Slide size, background (solid, gradient, picture), layout and master shapes, `showMasterSp` | Renders | yes |
| Text boxes and placeholders: fonts, sizes, colours, bold/italic/underline/strike, super/subscript, alignment, indents, line spacing, bullets and numbering, tabs, vertical text, hyperlinks, inherited styles from layout/master/theme | Renders; wrapping can differ when a font is missing (§7.9) | yes |
| Text autofit (shrink on overflow, grow shape) | Approximate | "selected" cases |
| Preset shapes, connectors, arrows, callouts, flowchart shapes; custom geometry with numeric paths | Renders | yes |
| Custom geometry using symbolic guide formulas | May be misdrawn | not yet |
| Fills (solid, gradient, pattern, picture), outlines, dashes, arrowheads | Renders | yes |
| Shadows, reflection, glow, soft edges | Approximate or flat | partial |
| Pictures: PNG, JPEG, GIF, BMP, SVG, with crop and shape clipping | Renders | yes |
| Pictures: EMF, WMF, TIFF | **Placeholder** with the alt text, unless the file carries a bitmap preview | bitmap previews only (PDF.js fallback is off) |
| Tables, built-in and custom table styles, merged cells | Renders; unusual style combinations approximate | yes |
| Groups, rotation, flips | Renders | yes |
| Charts (bar, column, line, area, pie, doughnut, radar, scatter, bubble, stock, combos) | **Approximate**, drawn from the chart's cached data; 3D charts shown flat. A notice says charts are approximations. | ECharts |
| Other chart kinds (treemap, sunburst, waterfall, funnel, map: the `cx:` family) | **Placeholder** "Chart (not shown)" with alt text | no |
| SmartArt | Approximate, from the drawing PowerPoint cached in the file; **placeholder** when the cache is absent | fallback data |
| Equations | Simple ones render as MathML; others use the file's fallback picture | bounded subset |
| OLE objects (embedded Excel, Word, PDF…) | The file's preview picture if it is a bitmap; otherwise **placeholder** "Embedded object". Never opened or activated. | previews only |
| Video and audio | **Placeholder** "Video (not played)" / "Audio (not played)" over the poster frame when there is one. Never loaded (XD5) or played. | would play; switched off |
| 3D models, ink, Flash/ActiveX controls | **Placeholder** | no |
| 3D rotation, bevels, extrusion on shapes and text | Flat | partial |
| Animations, builds, transitions, timings, triggers, morph | **Never run.** Every shape is shown in place, as PowerPoint's Normal view shows it. A notice counts animated slides. | no |
| Slide numbers, dates, footers (field placeholders) | Render with the stored text; the slide-number field uses the deck's first slide number | yes |
| Speaker notes | Shown as plain text in the notes panel (ours, §7.4) | no (ours) |
| Comments, sections, custom shows, slide zoom links | Sections label the thumbnail rail; the rest are not shown; comments counted in a notice | ours / no |
| Macros | Never read. A notice says the file contains macros that are not run. | ours |

Every placeholder is a bordered box at the object's position with an icon, a label and the object's alt text or name, so nothing silently disappears. When the renderer itself reports a node or slide error, that shape or slide gets the same treatment and the per-slide text fallback of §7.1.

---

## 4. Architecture

```
src/office/
  core/pptx/              # NO 'vscode' import. Pure, node-testable. Reads only.
    model.ts              # presentation.xml -> slide list, order, hidden, size, first number, sections (§6.2)
    outline.ts            # per slide: title, text blocks in reading order, alt text, links, notes (§6.3)
    notices.ts            # feature census -> OfficeNotice[] and per-slide placeholder facts (§7.10)
    renderCopy.ts         # render-only copy of the package (§6.4)
    index.ts              # barrel, re-exported from core/index.ts as `pptx`
  pptxProtocol.ts         # PowerPoint message unions + validators (§5)
  pptxEditorProvider.ts   # viewType vscodeMdEditor.pptx; extends OfficeEditorProviderBase

scripts/pptx-vendor-entry.js   # re-exports what the adapter needs from the renderer
scripts/pptx-fixtures/         # fixture generators (§12.3)
scripts/pptx-render-check.mjs  # headless-browser check of every fixture under the production CSP (§12.4)

media/
  pptx-bundle.js          # esbuild IIFE, global `PptxBundle` (renderer + ECharts subset + JSZip)
  pptxAdapter.js          # the ONLY file that touches PptxBundle (XD3)
  pptxViewMath.js         # UMD, pure: fit/zoom, windows, slide-number parsing, find over the outline, font stacks
  pptxViewer.js / .css    # boot, toolbar, slide view, scroll view, zoom, keyboard, links, copy, state
  pptxPanels.js           # thumbnail rail, outline tab, notes panel
  pptxFind.js             # find bar over the outline; highlight in the mounted slide
  pptxPresent.js          # present mode
```

Build changes: `package.json` dependency `@aiden0z/pptx-renderer` (exact) and devDependency `pptxgenjs` (exact, fixtures only). `esbuild.js`: one webview context for `media/pptx-bundle.js` (as for three.js). `.gitattributes`: `media/pptx-bundle.js -text`; `tests/fixtures/pptx/** binary`. `THIRD-PARTY-NOTICES.md`: the renderer (Apache-2.0), Apache ECharts (Apache-2.0, with its NOTICE), zrender (BSD-3-Clause), `mtx-decompressor` (MPL-2.0, bundled inside the renderer although embedded fonts are off; source link as the renderer's own notices give it), the ECMA-376 geometry notice the renderer ships, JSZip (MIT option). `.vscodeignore`: `docs/**` and `spike/**` (added with this spec).

JSZip is already shipped as `media/jszip.min.js` for the Word viewer. Whether the bundle can use that copy instead of carrying a second one (−98 KB) is decided in scaffolding **[Assumption]**.

### 4.1 Contributions (`package.json`)

```jsonc
{ "viewType": "vscodeMdEditor.pptx", "displayName": "PowerPoint Viewer",
  "selector": [{ "filenamePattern": "*.pptx" }, { "filenamePattern": "*.ppsx" }, { "filenamePattern": "*.potx" },
               { "filenamePattern": "*.pptm" }, { "filenamePattern": "*.ppsm" }, { "filenamePattern": "*.potm" }],
  "priority": "default" }
```

Registration options: `retainContextWhenHidden: true`, `enableFindWidget: false` (slides are virtualised and notes are outside the slide DOM; own find, §7.6), `supportsMultipleEditorsPerDocument: false`.

Settings (under `vscodeMdEditor.pptx`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `defaultView` | `"slide"` \| `"scroll"` | `"slide"` | View a file opens in. |
| `showNotes` | boolean | `true` | Notes panel open in Slide view when the current slide has notes. |
| `showHiddenSlides` | boolean | `true` | Hidden slides appear (marked) in the rail and in Scroll view. Present mode always skips them. |

Commands: none beyond the editor toolbar. Telemetry: none.

---

## 5. Message protocol

Defined in `src/office/pptxProtocol.ts`. The Office rules apply (Office §5): host-owned monotonic `version`; the host validates every field of every inbound message and never throws on bad input; binary payloads travel as `Uint8Array` (Office spike S2 measured 20 MB in about 0.33 s). There are no edit messages.

```ts
export interface PptxSlideInfo {
  index: number;                 // 0-based position in presentation order
  hidden: boolean;               // p:sld/@show = "0"
  title: string;                 // from the outline; '' until its batch arrives
  section: string | null;        // section name when the deck has sections
  hasNotes: boolean;
}

export interface PptxDeckInfo {
  version: number;
  fileKind: 'presentation' | 'show' | 'template';   // pptx/pptm · ppsx/ppsm · potx/potm
  widthEmu: number; heightEmu: number;               // p:sldSz
  firstSlideNumber: number;                          // p:presentation/@firstSlideNum, default 1
  slides: PptxSlideInfo[];
  fonts: string[];                                   // typefaces named by the theme and the slides (for §7.9)
}

export type PptxBlock =
  | { kind: 'text'; role: 'title' | 'subtitle' | 'body' | 'other'; shapeId: number;
      paras: Array<{ level: number; text: string; links: Array<{ start: number; end: number; href: string }> }> }
  | { kind: 'table'; shapeId: number; rows: string[][] }
  | { kind: 'object'; shapeId: number;               // anything that is not text or a table
      what: 'picture' | 'chart' | 'smartart' | 'ole' | 'video' | 'audio' | 'model3d' | 'ink' | 'math' | 'other';
      name: string; alt: string; decorative: boolean };

export interface PptxSlideOutline {
  index: number; title: string;
  blocks: PptxBlock[];                               // shape-tree order = reading order (§9.2)
  notes: string[];                                   // paragraphs of the notes body
  animated: boolean; transition: boolean;
}

export type PptxToWebview = OfficeCommonToWebview
  | { type: 'pptxDeck'; deck: PptxDeckInfo }
  | { type: 'pptxRender'; version: number; bytes: Uint8Array }               // the render copy (§6.4)
  | { type: 'pptxOutline'; version: number; slides: PptxSlideOutline[]; done: boolean }   // in batches
  | { type: 'pptxStateChanged'; version: number };                           // reloaded from disk: request again

export type PptxToHost = OfficeCommonToHost
  | { type: 'pptxRequestDeck' }
  | { type: 'pptxFacts'; facts: PptxFacts };          // display only, never used for a decision

export interface PptxFacts { renderer: string; missingFonts: string[];
  failedSlides: number[]; failedShapes: number; }
```

`PPTX_PROTOCOL_LIMITS` (inbound): `renderer` ≤ 100 characters; ≤ 50 font names of ≤ 100 characters; ≤ 10,000 slide indexes, each < 100,000; `failedShapes` a non-negative integer. Outbound caps (host side, so a hostile file cannot flood the webview): a title ≤ 500 characters; a slide's outline text ≤ 200,000 characters and its notes ≤ 100,000 (truncated with an ellipsis and counted in a notice); the whole outline ≤ 32 MB, after which later slides carry titles only; ≤ 200 font names.

`init` (common) is sent with `kind: 'pptx'`, `canEdit: false`, `readOnlyReason: null`, `editMode: false`. `setEditMode` and `flushed` from the webview are ignored for this kind.

---

## 6. Document model (host)

### 6.1 Loading

`OfficeDocument` with kind `'pptx'` (XD6). Opening is the shared path: read through `workspace.fs`; `sniff` (lock file, empty, too large, OLE compound file); `OfficePackage.open` (ZIP refusals, required parts, main part found through `_rels/.rels`); the pre-render DOCTYPE guard over every XML part the renderer may read (Office §12 — the renderer parses XML with the webview's `DOMParser`, outside the host parser's DOCTYPE rejection **[Verified: the library uses `DOMParser`]**). Any failure becomes the shared error view (§8.3); `openCustomDocument` never throws.

Classification additions in `package.ts`: the main part's content type decides the kind and `fileKind`:

| Content type (main part) | Extension | `fileKind` |
|---|---|---|
| `…presentationml.presentation.main+xml` | `.pptx` | presentation |
| `…presentationml.slideshow.main+xml` | `.ppsx` | show |
| `…presentationml.template.main+xml` | `.potx` | template |
| `application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml` | `.pptm` | presentation |
| `application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml` | `.ppsm` | show |
| `application/vnd.ms-powerpoint.template.macroEnabled.main+xml` | `.potm` | template |

A package whose main part is a Word or Excel type under a PowerPoint extension (or the reverse) is refused as today ("File name says … but the package is …"). Strict OOXML presentations (the `purl.oclc.org` namespaces) are passed to the renderer if spike S2 shows it draws them; otherwise they get the error view with "Open in PowerPoint" **[Assumption]**. `viewOnlyReason` is irrelevant for this kind and is not shown.

The watcher-driven reload is the shared behaviour: when the file changes on disk the document reloads (there is never unsaved state to protect), `version` increases and the webview is sent `pptxStateChanged`; it keeps the current slide index and view where they still exist.

### 6.2 Presentation model (`core/pptx/model.ts`)

From `ppt/presentation.xml` (the main part, by relationship): the ordered slide list from `p:sldIdLst` (each `r:id` resolved through the part's relationships; a missing or external target drops that slide and adds a notice), slide size `p:sldSz`, `firstSlideNum`, sections (`p14:sectionLst` in the extension list, mapping slide ids to names), and the embedded-font list (names only, for the notice). Per slide, from the slide part's root element only: `show="0"` → hidden. Slide parts are parsed lazily and asynchronously (the shared 30 ms yield rule); the deck message is sent as soon as `presentation.xml` and the slide roots have been read, before any outline exists.

Caps: more than 5,000 slides → refuse as `too-large`; a `p:sldSz` outside 1–56 inches per side (PowerPoint's own range) → the default 13.333 × 7.5 inch size with a notice.

### 6.3 Outline, notes and alt text (`core/pptx/outline.ts`)

For each slide, a walk of its own shape tree (`p:cSld/p:spTree`) in document order, groups flattened in order, layout and master shapes excluded (their text is prompt text or decoration):

- **Text shapes** (`p:sp` with a `p:txBody`): paragraphs as plain text, with the paragraph level (`a:pPr/@lvl`), line breaks as `\n`, fields by their stored text, and the ranges of runs with `a:hlinkClick` whose relationship target is external (the `href` is carried as text; the host's allow-list is applied when it is clicked, §7.7). Role from the placeholder type: `title` and `ctrTitle` → title; `subTitle` → subtitle; `body`, `obj` and untyped placeholders → body; everything else → other. Empty placeholders are skipped.
- **Tables** (`a:tbl` in a graphic frame): cell text by row.
- **Everything else** becomes an `object` block: kind from the element or the graphic data URI (picture, chart, SmartArt, OLE, video and audio from the media extension elements, 3D model, ink, math), its name and its alt text (`p:cNvPr/@descr`, falling back to `@title`), and whether it is marked decorative.
- **Title**: the first title-role block's text; otherwise the first non-empty text line, truncated; otherwise "Slide N".
- **Notes**: the notes slide is found through the slide's relationship of type `notesSlide`; its text is the body placeholder's paragraphs (the slide-image and slide-number placeholders are ignored).
- **Animated / transition**: presence of `p:timing` with at least one effect, and of `p:transition`, including inside `mc:AlternateContent`.

`mc:AlternateContent` is read by taking the `mc:Fallback` branch for text and the `mc:Choice` branch only to classify the object kind. Text is never interpreted as markup anywhere downstream.

This model is deliberately independent of the renderer: it is the source of the slide titles, the Outline tab, find, notes, the accessible descriptions and the per-slide fallback.

### 6.4 Render copy (`core/pptx/renderCopy.ts`)

Before `pptxRender` is sent, the host builds a copy of the package with `writeZip` in which every entry of the following classes is **replaced by a zero-length entry of the same name** (so relationships still resolve) and every other entry is copied as raw bytes without recompression:

- audio and video (content types `audio/*`, `video/*`, and media targets of `video`, `audio` and `media` relationships);
- embedded fonts (`application/x-fontdata`, `.fntdata`, `.odttf`);
- macro storage and signatures (`vbaProject.bin`, `vbaProjectSignature*`), ActiveX binaries;
- embedded OLE payloads and embedded packages (targets of `oleObject` and `package` relationships under `ppt/embeddings/`), but not their preview pictures;
- custom XML data, thumbnails and printer settings.

Classes are decided from `[Content_Types].xml` and relationship types, not from paths. The result is verified with the shared reader (re-opens, same entry names, CRCs match) before it is sent; if building or verifying fails, the viewer shows the error view rather than falling back to the original bytes. The copy exists only in memory and is released once it has been posted to the webview; it is rebuilt if the webview asks again.

Why: the webview is the least-privileged place, and the best way to be sure it never plays media, loads a font file or sees a macro is not to give it one. It also cuts transfer and memory for video-heavy decks by the size of the videos.

**[Assumption, spike S3]**: the renderer tolerates zero-length media and font entries (with media and embedded fonts switched off it should never read them). Fallback if it does not: replace media with a 1×1 PNG only where the renderer insists on decoding, and drop the relationship in the copy's `.rels` for the rest.

---

## 7. Viewer features (v1)

### 7.1 Slides and views

- **Slide view** (default): thumbnail rail on the left, the current slide fitted in the main area, notes panel below it.
- **Scroll view**: all slides in one vertical list at a common width, virtualised: only slides near the viewport are mounted (at most 12 full-size slides in the DOM); the rest are placeholders of the right aspect ratio showing the slide number and title.
- The toolbar switches views; the choice is remembered per document for the session (`vscode.setState`). Nothing is written to the file or the workspace.
- Each slide is rendered at its intrinsic size and scaled with a CSS transform, so zooming does not re-lay out text.
- A slide that fails to render shows, in place, "This slide couldn't be displayed" and beneath it the slide's text from the outline (title as a heading, text blocks, table rows, "[Picture: alt text]" lines). The rest of the deck is unaffected.
- `.ppsx`/`.ppsm` open like any other deck (in the default view, not presenting) with the notice "This is a PowerPoint Show; it opens for viewing here." `.potx`/`.potm` open with "This is a PowerPoint template."

### 7.2 Thumbnail rail and Outline tab

A collapsible sidebar with two tabs (`role="tablist"`):

- **Slides**: one item per slide with its number and a scaled rendering, mounted lazily with an `IntersectionObserver`, at most 40 mounted; unmounted items show the number, the title and the slide background colour. Hidden slides are dimmed **and** labelled "Hidden" with a struck-through number. Section names appear as headings between groups. Click or Enter goes to the slide. Above 1,000 slides the rail shows numbers and titles only.
- **Outline**: the deck as text — per slide a heading "N. Title" (activates like a rail item) and the slide's text blocks, indented by level, with object lines such as "[Chart: Revenue by quarter]". This is the keyboard- and screen-reader-first route through a deck (§9.2) and works before and without any slide rendering.

### 7.3 Zoom and fit

Fit slide (default in Slide view), Fit width (default in Scroll view), and 25–400 % in the steps of `pptxViewMath.js`; Ctrl+wheel, pinch, Ctrl+= / Ctrl+-, Ctrl+0 for Fit. Above Fit the slide area scrolls in both directions.

### 7.4 Speaker notes

A panel under the slide in Slide view: the notes paragraphs as plain text in the editor font, themed, selectable, with its own scrollbar; a drag handle and `N` toggle its height between closed, a third and a half of the area. When the current slide has no notes it shows "No notes" at one line high. Notes formatting (bold, lists) is not reproduced in v1. In Scroll view notes are reached through the Outline tab (a "Notes" disclosure under each slide that has them).

### 7.5 Navigation and slide numbers

- Slide box "12 of 340" in the toolbar (accepts a number); previous/next buttons; keyboard in §9.3.
- "N of M" counts positions in presentation order, hidden slides included, as PowerPoint's own panel does. When `showHiddenSlides` is off, hidden slides are skipped by next/previous and not listed, and the box says "12 of 340 (3 hidden)".
- The number *printed on a slide* by a slide-number field is the stored field text, which reflects `firstSlideNumber`; it may differ from the position, as in PowerPoint.

### 7.6 Find

Own bar (Ctrl/Cmd+F, Enter / Shift+Enter, Esc) with match case and whole word, searching the host's outline: slide text, table cells, alt text and — with "Include notes", on by default — speaker notes. The count ("3 of 17") and the order come from the outline, so they do not depend on which slides are mounted; while outline batches are still arriving the count reads "more than N".

Going to a match shows its slide and paints the match in the mounted slide's text with the CSS Custom Highlight API (no DOM mutation), by locating the same text in the slide's DOM. When the text cannot be located there (it is alt text, or inside a chart or SmartArt), the shape or the whole slide is outlined instead and the live region says where the match is ("in alternative text of a picture"). A match in notes opens the notes panel and is highlighted there.

### 7.7 Copy and links

- **Copy**: mouse selection works on slide text, notes and the Outline tab; Ctrl+C sends the selection through `writeClipboard` (plain text). Toolbar overflow: "Copy slide text" and "Copy notes" (from the outline, so they work for unmounted slides).
- **External links** are never navigated by the webview. A capture-phase click handler on the slide container intercepts every anchor and the adapter replaces the library's `window.open` path; the target is sent as `openLink` and the host applies the shared allow-list (`http:`, `https:`, `mailto:`) and `vscode.env.openExternal`. Anything else — `file:`, UNC paths, "run program", "run macro", "open another presentation" and other `ppaction:` targets — is dropped with the shared "link was not opened" notice.
- **Links to slides** (next, previous, first, last, a specific slide) navigate inside the viewer.

### 7.8 Present mode

A simple slide show: the chrome is hidden and the current slide fills the editor area on a black backdrop, fitted and centred. It fills the *editor*, not the screen; VS Code's own full-screen and Zen mode make it fill the display. Started from the toolbar or `P`; Esc leaves it at the slide it reached.

Next: →, ↓, Space, PageDown, Enter, click. Previous: ←, ↑, PageUp, Backspace. Home/End. A number then Enter jumps. Hidden slides are skipped. After the last slide a black "End of slide show" page; one more step leaves the mode. No animations, transitions, timings, laser pointer, presenter view or second window. This is the first feature to cut if the schedule slips (Q3).

### 7.9 Fonts

- **Embedded fonts are not loaded** (XD9): font parsing is a classic attack surface, embedded PowerPoint fonts are obfuscated subsets with embedding restrictions, and the render copy does not even contain them.
- Text uses the typeface the file names when it is installed. `pptxViewMath.js` holds a small substitution table applied as a CSS font stack for common Office fonts that may be missing (for example Calibri → Carlito, Cambria → Caladea, Aptos → Segoe UI / system sans, Arial → Helvetica / Liberation Sans), ending in a generic family of the same class.
- After the first slide renders, the webview checks which named fonts are not installed (text-width comparison on a canvas, no network) and reports them in `pptxFacts`; the host shows one notice: "Fonts not installed: Aptos, Gill Sans MT (+3 more). Text may wrap differently from PowerPoint." If the file embeds fonts the notice adds that embedded fonts are not used.

### 7.10 Notices

Shown in the shared notices bar, built by `core/pptx/notices.ts` and updated from `pptxFacts`: show or template file · macros present ("macros are not run") · animations and transitions ("N slides have animations or transitions; they are not played") · video and audio ("N media clips are not played") · charts ("charts are drawn as approximations") · objects shown as placeholders, by kind and count · embedded objects · comments present (count; not shown) · missing fonts · links to other files or external pictures present (not loaded) · the file appears to be open in PowerPoint (shared lock-file notice; harmless here since nothing is saved) · large deck · slides or shapes the renderer could not draw (count, with "Open in PowerPoint").

### 7.11 Not in the viewer

Editing of any kind; saving; export to PDF or images; printing (use "Open in PowerPoint"); animations and transitions; media playback; presenter view; comments panel; slide sorter drag-and-drop; master/layout view; grid, guides and rulers; dark-mode recolouring of slides.

---

## 8. Special content, limits and errors

### 8.1 Never written

There is no code path from this viewer to `workspace.fs.writeFile` for the document's URI. The provider is registered read-only; the document is never dirty; the render copy lives in memory only.

### 8.2 Limits **[Assumption — tuned by spike S4]**

| Condition | Result |
|---|---|
| File > 250 MB, declared uncompressed total > 1 GB, any entry declared > 400 MB (the shared Office limits) | Refuse to open (error view, "Open in PowerPoint"). |
| More than 5,000 slides | Refuse to open (`too-large`). |
| Render copy > 150 MB after stripping (picture-heavy decks) | Opens with a "large presentation" notice; thumbnails show titles only; at most 6 slides mounted. |
| A slide part > 16 MB uncompressed, or more than 20,000 shapes in one slide | That slide is not rendered: "This slide is too complex to display", with its outline text. |
| More than 1,000 slides | Rail shows numbers and titles only. |
| Outline caps | §5. |
| Renderer's own limits | Set from the host's limits so the two readers agree: a deck the host accepted is not refused by the webview for size. Its guards on chart point counts and bitmap sizes stay at their defaults. |

Performance budgets on the reference machine: first slide visible ≤ 1.5 s for a 10 MB, 50-slide deck and ≤ 4 s for a 100 MB, 300-slide deck; going to an adjacent slide ≤ 150 ms; no frame over 100 ms while scrolling Scroll view (placeholders allowed for up to 300 ms); the complete outline of a 300-slide deck ≤ 2 s, without blocking the extension host for more than 50 ms at a time; webview memory ≤ 2 × the render copy + 300 MB; host memory ≤ file size + render copy during load, file size afterwards.

### 8.3 Error and special-case UX

All load problems render the shared error view (`loadError`) with a plain explanation, "Open in PowerPoint" and, where sensible, "Retry". Detection is the shared load classification; only the wording is new.

| Case | Detection | Message |
|---|---|---|
| Password-protected | OLE compound file with an `EncryptedPackage` stream | "This file is password-protected. Open it in PowerPoint to view it." No password prompt in v1. |
| Legacy format with a new extension | OLE compound file without it | "This looks like an older .ppt file saved with a .pptx name." |
| Office lock file | name starts with `~$` | "This is a temporary lock file created by PowerPoint, not a document." |
| Not a ZIP, truncated, bad CRC, malformed XML in a required part, DOCTYPE in a part | container, parser or guard error | "This file is damaged and can't be displayed." with the technical reason under "Details". Never repaired. |
| ZIP64, encrypted entries, unsupported compression, duplicate or unsafe names | ZIP reader | "This file uses a packaging feature this viewer doesn't support." |
| Not a presentation | main-part content type | "This file isn't a PowerPoint presentation." |
| Empty file | size 0 | "This file is empty." |
| Too large | §8.2 | "This file is too large to display here. Open it in PowerPoint to view it." |
| No slides | empty `p:sldIdLst` | An empty-state page "This presentation has no slides." (not an error). |
| Renderer fails to start or rejects the whole deck | adapter | The **text view**: every slide as its outline text, with a warning notice "Slides couldn't be drawn; showing their text." and "Open in PowerPoint". |
| A slide or shape fails | adapter events | §7.1, §3.5; counted in a notice. |
| File changed on disk | shared watcher | Silent reload (§6.1). |

Legacy `.ppt`, `.pps` and `.pot` files are not claimed by this editor; VS Code handles them as it does today.

---

## 9. Theming, accessibility, keyboard

### 9.1 Theming

- All chrome (toolbar, rail, outline, notes panel, find bar, notices, placeholders outside slides) uses `--vscode-*` variables and the `body.vscode-*` classes, like the other editors.
- **Slides keep their own colours.** They are never inverted or recoloured in dark themes: a slide's colours are part of its content. Slides sit on a themed backdrop; in high-contrast themes each slide and thumbnail gets a `--vscode-contrastBorder` outline, and the current thumbnail, find matches and focus ring use the theme's highlight tokens.
- Placeholders *inside* a slide (video, chart-not-shown, embedded object) use a neutral light style with a dark border so they read on any slide background; they carry text and an icon, never colour alone.

### 9.2 Accessibility

- **Reading order is the shape-tree order**, which is what PowerPoint's own Reading Order pane edits. The outline preserves it.
- Each slide container is `role="group"` with `aria-roledescription="slide"` and `aria-label="Slide 3 of 40: Quarterly results"` (plus ", hidden"). Slide changes are announced through the shared polite live region.
- The rendered slide exposes real text. The adapter adds what the library does not: `alt` on pictures and `role="img"` with `aria-label` on charts, SmartArt and placeholders, from the outline's object blocks matched by shape id; decorative objects get `alt=""`/`aria-hidden`. **[Assumption, spike S3]**: rendered DOM order follows shape-tree order and shapes can be matched to outline blocks. If either fails, the rendered slide is hidden from assistive technology (`aria-hidden`, its focusable elements removed from the tab order) and a visually hidden copy of the slide's outline takes its place.
- Whatever the outcome, the **Outline tab** is a complete, visible, keyboard-navigable text rendering of the deck with headings, levels, table rows, alt text, links and notes.
- Toolbar and sidebar follow the shared patterns (`role="toolbar"` with roving tabindex, `aria-pressed`, accessible names on icon buttons, `tablist`). The rail is a `listbox` with one tab stop.
- Every action has a keyboard route. `prefers-reduced-motion` (no smooth scrolling) and `forced-colors` are honoured.
- Stated in the README as a property of the file: decks without alt text or with a poor reading order read poorly here too.

### 9.3 Keyboard

Common: Ctrl/Cmd+F find · Ctrl/Cmd+C copy · Esc close find / leave Present · Ctrl/Cmd+E shows "PowerPoint files are view-only here".
Slides: PageDown / PageUp next / previous slide · → ↓ / ← ↑ the same when the slide is not scrolled (otherwise they scroll) · Home / End first / last · Ctrl/Cmd+G focus the slide box · Ctrl+= / Ctrl+- / Ctrl+0 zoom in / out / fit · F4 toggle the sidebar · `N` notes panel · `S` switch Slide / Scroll view · `P` Present.
Rail and Outline: arrows move, Enter goes to the slide, Home/End.
Single-letter shortcuts are active only while focus is in the slide area and not in a text input.

---

## 10. Settings, telemetry, privacy

Settings: §4.1. Telemetry: none. Nothing about a document leaves the machine. Workspace Trust: the viewer works in untrusted workspaces (it executes nothing from the workspace or the file); stated in the README.

---

## 11. Security

Presentations are untrusted input. The Office rules (Office §12) apply; what is specific:

- **CSP** (target; each directive is justified or removed by spike S1):
  `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource};`
  - `'unsafe-inline'` styles: the renderer has one inline `style` attribute path and the runner-up many **[Verified]**; this matches the Word webview.
  - `img-src blob: data:`: embedded pictures are shown through `blob:` URLs **[Verified]**.
  - No `connect-src`, `media-src`, `frame-src`, `worker-src`, `object-src`; no `'unsafe-eval'` and no `'wasm-unsafe-eval'`. The renderer needs none of them for what is enabled **[Verified by the 0-violation run]**. Without `media-src` no audio or video can load even if an element were created; without `connect-src` and with `img-src` limited to local, blob and data, linked pictures and any other remote reference cannot load.
- **Nothing from the file runs**: scripts run only with the nonce; macros, OLE, ActiveX and media bytes are not in the render copy (XD5); action settings that run programs or macros are dropped (§7.7).
- **Renderer switches**: external media `block`; PDF.js fallback off (it would need dynamic `import()` and blob workers); embedded fonts off (`maxFaces: 0`); its limits set (§8.2); its own navigation UI unused.
- **HTML construction**: our webview code builds DOM with `createElement`/`textContent`; no `innerHTML` with document-derived strings in any `media/pptx*.js`. The renderer's own output is the one exception, as docx-preview is for Word, and is contained by the CSP. The chosen library sets text through `textContent` **[Verified]**; if the runner-up is adopted instead, its HTML-string output is the reason the CSP and the link interception must not be relaxed.
- **Links**: §7.7. Never navigated by the webview; allow-list in the host.
- **XML**: DTDs rejected by the host parser and by the pre-render DOCTYPE guard for the parts the webview parses; no external entity or schema is fetched; relationship targets with `TargetMode="External"` are never dereferenced by the host.
- **ZIP**: shared size and ratio limits before inflating; entry names are opaque keys, never paths; nothing is extracted to disk.
- **Webview → host**: the only PowerPoint-specific inbound message is `pptxFacts`, validated and used for display only. Font names, titles and alt text are document-derived strings treated as text.
- **Host parsing** is the shared bounded ZIP and XML code plus read-only walks of slide XML. No third-party parser runs in the extension host.
- **Supply chain**: exact pin, lockfile integrity, the bundle built by our own esbuild and committed; a release is adopted only when at least 14 days old; the upgrade procedure of §12.6; the version recorded in `THIRD-PARTY-NOTICES.md`.

---

## 12. Testing strategy

### 12.1 Harness

- Core: `tests/office/pptx*.test.mjs` through the Office core test bundle (hence no `vscode` import under `core/pptx/`).
- Webview modules: `pptxViewMath.js` is UMD and required directly; DOM behaviour (`pptxViewer`, `pptxPanels`, `pptxFind`, `pptxPresent`, `pptxAdapter`) uses the `node:vm` DOM shim with a stubbed `PptxBundle`.
- Provider logic: the shared `_vscodeStub.cjs` approach.
- The renderer is browser-only and is **not** run by `npm test`. It is exercised by `scripts/pptx-render-check.mjs` (§12.4) and at the human gate.

### 12.2 Guarantees

| Id | Guarantee | Test |
|---|---|---|
| XG0 | Viewing never writes and never dirties: no `writeFile` to a document URI is reachable from the provider; no edit event is ever fired. | Provider test with the vscode stub over every fixture; a source check that `src/office/pptx*.ts` and `core/pptx/` do not reference `writeFile`, `edits` or `save`. |
| XG1 | Every fixture opens to a view or to the specified error view; none throws. | Per fixture: expected slide count, hidden flags, titles, notes, `fileKind`, or the expected load failure. |
| XG2 | The render copy is a valid package with the same entry names; stripped classes are empty; every other entry is byte-identical (raw compressed bytes and CRC). | Per fixture, with the shared ZIP reader. |
| XG3 | Document text is never markup: titles, text, alt text and notes containing `<img onerror>`, `</script>` and entity-like text arrive as the same characters in the outline and are rendered as text by every `media/pptx*.js` module. | Hostile-text fixture; DOM-shim assertions that only `textContent` receives it. |
| XG4 | Links: only `http:`, `https:`, `mailto:` reach `openExternal`; everything else produces the blocked-link notice. | Table-driven, including `ppaction:` targets, `file:`, UNC and `javascript:`. |
| XG5 | Bounded: the caps of §5 and §8.2 hold on hostile fixtures (huge slide count, deep nesting, a 50 MB text run, a lying ZIP size). | Core tests with generated inputs. |
| XG6 | No violation of the production CSP and no resource request for any fixture. | `pptx-render-check` and the gate. |

### 12.3 Fixtures (`tests/fixtures/pptx/`, committed, marked binary; README with one line per file)

**Generated by script, deterministic** (`scripts/pptx-fixtures/make-synthetic.mjs`, with `pptxgenjs` and hand-written XML through our own ZIP writer where a library cannot produce the case): `basic.pptx` (titles, bullets, shapes, table, picture with alt text, chart, notes, hidden slide, links of every kind) · `hostile-text.pptx` · `actions.pptx` (slide jumps, run-program and macro actions, `file:` and UNC links) · `external-image.pptx` (linked picture and linked video) · `no-slides.pptx` · `missing-slide.pptx` (a slide id whose part is absent) · `doctype.pptx` · `truncated.pptx`, `not-a-zip.pptx`, `empty.pptx`, `zip64.pptx` · `wrong-kind.pptx` (a Word package renamed) · `large.pptx` (300 slides) · `huge-slide.pptx` (one slide over the shape cap) — and `many-slides.pptx` (over 5,000) generated in test setup, not committed.

**Made by PowerPoint on the dev machine** — `scripts/pptx-fixtures/make-producers.ps1`, **run by the user** (PowerPoint COM automation): builds decks through the object model and saves them with "Save As" in each format, and for each also exports every slide as a PNG and the deck as a PDF into `tests/fixtures/pptx/expected/` as ground truth: `layouts.pptx` (one slide per built-in layout, placeholders filled and empty) · `text.pptx` (levels, bullets, numbering, autofit, columns, vertical text, tabs, fields) · `shapes.pptx` (every preset AutoShape, connectors, custom freeform, fills, lines, effects) · `tables.pptx` (table styles, merges, banding) · `charts.pptx` (one of each supported kind, one 3D, one of the newer kinds) · `smartart.pptx` · `pictures.pptx` (PNG, JPEG, SVG, EMF, cropped, recoloured) · `themes.pptx` (three built-in themes and variants, colour-map override) · `notes-sections.pptx` (notes, hidden slides, sections, first slide number 5) · `animations.pptx` (builds and transitions) · `media.pptx` (a short generated video and audio clip) · `ole.pptx` (embedded Excel sheet) · `embedded-fonts.pptx` · `show.ppsx`, `template.potx`, `macro.pptm` · `encrypted.pptx` (password `test`) · `legacy-renamed.pptx` (saved as `.ppt`, renamed).

**Supplied by the user** (listed `PENDING` until they arrive): `libreoffice.pptx` (Impress), `googleslides.pptx` (Google Slides download), optionally `keynote.pptx`, and ten everyday decks of the user's choosing for the spike corpus (not committed).

### 12.4 Renderer checks without a human

`scripts/pptx-render-check.mjs`: for each fixture, builds a static page carrying the production CSP as a `<meta>` policy, the bundle, the adapter and the fixture's render copy; opens it in headless Edge or Chrome; records CSP violations, resource requests, slide and shape errors, slide count and a screenshot of each slide to `tests/.out/pptx/png/` beside PowerPoint's export for eyeballing. This approach was used for the experiments in §3.3 **[Verified: it runs from `file://` with a nonce and reports violations]**; slides are rendered one at a time, not through the windowed list. It is a scripted pre-gate and pre-release step recorded in `log.md`, not part of `npm test` (it needs a browser).

### 12.5 Human gate checklist (outline; the full list is `docs/pptx-gate-checklist.md`, written in the plan's last work package in the style of `docs/office-gate-checklist.md`)

One sweep of the fixtures in an isolated Extension Development Host, numbered [must]/[nice] items, about 60 minutes:

1. **Open**: every fixture opens to the right view or error view; `.ppsx`, `.potx`, `.pptm` notices; encrypted, legacy, lock-file, damaged, empty.
2. **Fidelity**: side by side with PowerPoint (or its exported PNGs) for `layouts`, `text`, `shapes`, `tables`, `charts`, `smartart`, `pictures`, `themes`, `libreoffice`, `googleslides` and three of the user's own decks; each difference classed as acceptable, placeholder-as-specified or defect.
3. **Placeholders and "nothing runs"**: `animations`, `media`, `ole`, `macro`, `external-image`, `actions` show the specified placeholders and notices; nothing plays, opens or launches.
4. **Features**: rail, outline, notes, hidden slides, slide box, zoom and fit, both views, find (text, notes, alt text), copy, links (allowed, blocked, slide jumps), present mode.
5. **Security**: webview console shows no CSP violation and the network panel no request, for every fixture.
6. **Performance**: `large.pptx` and the user's largest deck against §8.2.
7. **Themes**: light, dark, both high-contrast; slides keep their colours.
8. **Keyboard and screen reader**: keyboard-only walkthrough; Narrator or NVDA through the Outline tab and one rendered slide.
9. **No writes**: `git status` clean afterwards; no document ever dirty.

### 12.6 Upgrading or replacing the renderer

Update the exact version (at least 14 days old; licence and bundled notices re-read) → rebuild the bundle and record its size → `npm test` (adapter tests with the stub) → `pptx-render-check` over all fixtures, compared with the previous screenshots → the gate's fidelity and security subset in a dev host → update `THIRD-PARTY-NOTICES.md`. A security release of the library is treated as a hotfix. Replacing the library is the same procedure plus a rewrite of `media/pptxAdapter.js`.

---

## 13. Phases and acceptance criteria

v1 is Phases 0–2. There is one release point, after the human gate.

**Phase 0 — spikes, scaffolding, fixtures** (no user-visible feature). Accept when the spike report in `log.md` answers S1–S5 (plan XWP-01) with evidence; the library pick is confirmed or changed by the bake-off, with the **acceptance bar**: on the PowerPoint-made fixtures and the user's ten decks, at least 90 % of slides judged "faithful or acceptable" by the user against PowerPoint's exports, no slide blank or unreadable without a specified placeholder, zero CSP violations; this spec is updated where an assumption failed; the dependency, bundle and fixtures are in place.

**Phase 1 — host core** (inert). Deliver §5, §6, §7.10 (host half), §8, the shared widening of §2.2 and the provider (not registered). Accept when XG0–XG5 pass on every fixture; the Office suite is unchanged and green; the independent review of Gate X1 is closed.

**Phase 2 — viewer.** Deliver §7, §9, §11 in the webview; registration; README and CHANGELOG; the gate checklist. Accept when: `pptx-render-check` is clean on every fixture (XG6); the human gate (§12.5) passes; no file is ever written and no document is ever dirty. Then the registration PR merges and the feature is released.

**Post-v1** (recommended order): "Copy deck outline as Markdown" and "Copy slide as Markdown" (nearly free from the outline; fits a Markdown editor) · EMF/WMF and SmartArt preview through the PDF viewer's pdf.js (already shipped by then) · export the current slide as PNG · notes formatting · comments panel · password prompt for encrypted files · PowerPoint files in wikilinks and the graph (`[[deck.pptx#3]]`, mirroring Office Phase 8) · stepping through builds in Present mode.

---

## 14. Explicit non-goals for v1 (consolidated)

Editing anything, including speaker notes · saving, Save As, export, conversion to or from other formats · printing · playing animations, transitions, timings, video or audio · running macros, OLE objects, ActiveX or action programs · loading embedded fonts · pixel parity with PowerPoint · presenter view, pointer tools, rehearsal · comments, revision comparison · legacy `.ppt/.pps/.pot` · password-protected files · OpenDocument `.odp`, Keynote files · the browser (web) extension host.

---

## 15. Assumptions, open questions and risks

### 15.1 Assumptions not verified (owner: Phase 0 unless noted)

1. The renderer draws decks made by PowerPoint, LibreOffice and Google Slides to the acceptance bar of §13 (S2). Verified so far only on a `pptxgenjs` deck.
2. The CSP of §11 holds in a real VS Code webview for the full fixture set, not only for the test deck in headless Edge (S1).
3. The library bundles and runs correctly as our esbuild IIFE inside a webview, including ECharts (S1). Bundling and a headless run are verified; the webview is not.
4. The renderer tolerates the render copy's zero-length media, font and OLE entries (S3).
5. Rendered DOM order follows shape-tree order and rendered shapes can be matched to outline blocks by shape id, so alt text and ARIA can be added (S3).
6. Text of a find match can be located in the mounted slide's DOM for highlighting in the common case (S3).
7. The limits and budgets of §8.2, and the behaviour of windowed mounting and scaled-DOM thumbnails on 300-slide decks in a webview (S4).
8. A canvas text-width comparison detects missing fonts reliably in a webview (S5).
9. Strict OOXML presentations are drawn by the renderer (S2); otherwise they get the error view.
10. The second copy of JSZip can be avoided by pointing the bundle at `media/jszip.min.js` (scaffolding).
11. Shipped size ≈ 1.5 MB (measured in scaffolding; the bundle alone measured 1,468 KB).
12. The `customEditors` contribution cannot be made conditional on a runtime flag (basis of XD12); `filenamePattern` matching of upper-case extensions behaves as for the Office viewers.
13. Desktop PowerPoint is installed on the gate machine and scriptable through COM (the Office spec records desktop Word and Excel as installed).
14. The Office work (PR-0 to PR-15) and the PDF work are merged before this build starts, in the shapes their specs describe; in particular `OfficeDocument`'s load path, the provider base and `officeCommon` keep the interfaces read here.
15. `pptx-viewer` and `@jvmr/pptx-to-html` were rejected on their documentation and size, not on a rendering run.

### 15.2 Open questions for the user

Only questions whose answer changes the plan. The plan is written for the recommended answers; plan §11 says what changes otherwise.

**Q1. How are slides drawn?**
(a) **Recommended:** an existing open-source renderer in the webview (`@aiden0z/pptx-renderer`, pinned), confirmed against `@meshesha/pptxjs` on your own decks in the first spike.
(b) Our own renderer on the Office core (text, pictures, tables, common shapes).
(c) No slide drawing: a text-only viewer (titles, text, notes).
*Trade-off:* (a) gives the best-looking result soonest and adds about 1.5 MB and a young third-party dependency, contained by a strict CSP and a render copy. (b) removes the dependency but costs about 3–4 more weeks and will look worse on real decks at first. (c) saves about a week and is not really a slide viewer.

**Q2. Which file types should it open by default?**
(a) **Recommended:** `.pptx`, `.ppsx`, `.potx` and the macro-enabled `.pptm`, `.ppsm`, `.potm` (macros are never read or run).
(b) `.pptx` only.
(c) None by default: offered under "Open With…" only.
*Trade-off:* viewing is harmless for all six, so (a) avoids dead ends; (b) and (c) are one-line changes.

**Q3. A simple "Present" mode in v1?**
(a) **Recommended:** yes — one slide filling the editor, arrow keys, Esc; no animations or presenter view. About half a day; the first thing dropped if time runs short.
(b) Leave it for later.

**Q4. How is it kept away from users until the human gate passes?**
(a) **Recommended:** the last PR, which registers the viewer, stays unmerged until the gate passes on its branch. `develop` never contains a half-checked viewer.
(b) Merge earlier as an "Open With…"-only option and promote it to default after the gate.
*Trade-off:* a viewer cannot be hidden behind a runtime flag the way the editing features are, because the registration is static manifest data. (a) keeps `develop` releasable at all times; (b) lets you try it from a normal build sooner but exposes it under "Open With…" in any hotfix release cut meanwhile.

### 15.3 Risks

- **A young dependency with one main author.** Mitigations: exact pin and committed bundle; one adapter file; our own text model so notes, find, outline and accessibility never depend on it; a named runner-up; Apache-2.0 allows a fork. Residual: an abandoned library means maintaining a fork or doing the swap.
- **Fidelity on real decks is unverified** until spike S2. Mitigations: the bake-off with an explicit bar; placeholders rather than silent omissions; "Open in PowerPoint" always one click away; the README states that this is a viewer, not PowerPoint.
- **The library landscape will have moved** by the time this is built (sequenced last). The first spike re-runs the candidate check from scratch; versions in this document are a starting point.
- **Third-party code parses hostile files in the webview.** Mitigations: strict CSP with no network, media, frames or eval; the render copy; the DOCTYPE guard; link interception; no host involvement beyond display-only facts.
- **Charts are approximations** and could mislead. Mitigated by a standing notice and "Open in PowerPoint".
- **Missing fonts change wrapping.** Mitigated by substitution stacks and a notice; embedded fonts stay off by decision.
- **Memory on large, picture-heavy decks**: the host holds the file and (briefly) the render copy; the webview holds the copy and decoded pictures. Limits in §8.2; lazy media in the renderer.
- **Extension size** grows by about 1.5 MB (ECharts is 0.63 MB of it).
- **Shared Office files are touched** (`package.ts`, `officeDocument.ts`, `officeCommon.js`, the `kind` unions). Small, additive changes, checked by the unchanged Office suite and by the independent review at Gate X1.
- **Becoming the default editor** for six PowerPoint extensions may collide with other installed viewers; VS Code then asks the user once. README and CHANGELOG call it out.
