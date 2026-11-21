# PDF Viewer — viewing with basic editing

Status: Draft for user decision (open questions in §16) · Date: 2026-11-21 · Branch: `feature/pdf-viewer-docs`
Audience: the user (decisions, risks) and the implementing agents (everything else). The work is sliced into tasks in `docs/pdf-viewer-plan.md`.

Conventions used here: **MUST / MUST NOT** are requirements. "**[Verified]**" means checked on the date above against the published package (installed into a scratch directory, source read, and where stated run under Node 24.13) or against this repo. "**[Assumption]**" means not verified; each one is collected in §16 and most are closed by the Phase 0 spikes.

This document follows `docs/office-viewers-spec.md` (the Office spec) in structure and reuses its host, save, undo and chrome design wherever it fits. "Office §n" refers to that document. The Office code is not on `develop` yet; §2.2 says what the PDF work needs from it and when.

**Assumed defaults carried over from the user's Office decisions — to be confirmed (§16):** registered as the default editor for `*.pdf`; opens in View mode with an explicit Edit toggle; no network access; feature flags stay off until the human gates pass; spec and plan live in `docs/`; viewer first, basic editing only.

---

## 1. Summary of decisions

| # | Decision | Choice |
|---|---|---|
| PD1 | Rendering engine | **pdf.js** (`pdfjs-dist` 6.5.438, Apache-2.0), legacy build, in the webview: display API + the `PDFViewer` components + its worker. Pinned exactly. |
| PD2 | Preservation strategy | **Incremental update only.** A save is the file exactly as loaded plus one appended revision. The original bytes (and therefore any signed byte ranges) are never rewritten. No full rewrite exists in v1. |
| PD3 | Writer | **pdf.js `saveDocument()`** run as a *writer service* on a fresh document instance in the webview's pdf.js worker, fed from host-owned edit state. It is the only library found that writes annotations and form values *with appearance streams* incrementally (§3.2). |
| PD4 | Verifier | **Own strict PDF object reader** in the host (`src/pdf/core/reader.ts`): cross-reference chain, object streams, dictionary tokeniser. It never writes. Every save is checked by it before a byte reaches disk (§6.5). No PDF library runs in the extension host. |
| PD5 | Edit state | **Host-owned, normalised** (`PdfEditState`): added annotations, removed annotation refs, form field values. The webview draws it as an overlay; the writer service serialises it. Empty state ⇒ the host writes the loaded bytes itself and no writer runs. |
| PD6 | Editor model | One `CustomEditorProvider<PdfDocument>` (binary custom document), `priority: "default"`, one webview per document. Undo/redo through `onDidChangeCustomDocument`. Save, backup, revert, conflict handling and in-place write reuse the Office implementation through a shared base extracted from it (§2.2). |
| PD7 | Default mode | Files open in **View** mode. Editing needs the **Edit** toggle. A file is never dirtied by looking at it; form fields are inert in View mode. |
| PD8 | v1 editing | Highlight selected text · comment on a highlight · freehand ink · delete markup annotations · fill AcroForm fields. Everything else is out (§8.1, §15). |
| PD9 | Active content | PDF JavaScript is never executed (the scripting sandbox is not shipped). XFA is not rendered. Launch/remote/file actions are dropped. No network. |
| PD10 | Encrypted files | Viewable after a password prompt in the webview; **view-only** in v1. The password never leaves the webview. |
| PD11 | Signed files | Signature metadata is listed as "not verified". Editing is allowed with a warning; incremental saving keeps the signed bytes intact. |
| PD12 | Page operations | None in v1 beyond rotating the *view*. Delete/reorder/merge/extract/persisted rotation are a post-v1 "export to a new file" feature (§14). |

Rejected outright (reasons in §3): PDFium/WASM as the renderer, MuPDF.js, commercial SDKs, `pdf-lib` (upstream) and `@cantoo/pdf-lib` as the runtime writer, running pdf.js in the extension host, pdf.js's own annotation-editor UI as the owner of edit state, full-rewrite saving.

---

## 2. Context and constraints

### 2.1 This repo

- Extension host code is bundled by esbuild from `src/extension.ts` to `dist/extension.js` (CJS, `platform: node`). Webview scripts in `media/` are plain JS loaded directly; vendor files are copied by `scripts/copy-vendor.js` and committed. ESM-only vendors are bundled into an IIFE by a separate esbuild context — precedent: `scripts/three-vendor-entry.js` → `media/three-bundle.js` **[Verified in `esbuild.js` on `develop`]**.
- Webview assets MUST carry `?v=${Date.now()}`, a per-load nonce and a `default-src 'none'` CSP.
- Tests run with `node --test "tests/**/*.test.{js,mjs}"`. No CI runs them; Playwright is not a devDependency; webview JS is verified with a `node:vm` DOM shim. Anything needing a real webview is a human gate item.
- `engines.vscode` is `^1.85.0`; desktop/remote extension host only.
- Project rules: `todo.md` and `log.md` are maintained by the implementers; work goes through `feature/*` → `develop` PRs with self-review.

### 2.2 What is shared with the Office work, and what is PDF-specific

The Office viewers (`.docx`/`.xlsx`) are built on branches that are **not merged to `develop` and not pushed** as of this date **[Verified: `develop` has no `src/office/`; the code is in the `VSMarkdownEditor-refs` worktree, branch `feature/office-xlsx-structure-ui`]**. The PDF work depends on them as follows.

| Piece (Office worktree) | Reuse | How |
|---|---|---|
| `media/officeCommon.js/.css` — toolbar (roving tabindex), notices bar, error view, hint, live region, Edit toggle | **Shared** | Used as is. Two small changes: a `'pdf'` kind (application name "a PDF reader", the PDF read-only sentences) and nothing else. Needed from Phase 1. |
| `src/office/protocol.ts` common messages (`init`, `loadError`, `editModeChanged`, `flushPendingEdits`, `notices`, `requestFailed`; `ready`, `setEditMode`, `flushed`, `openLink`, `openExternally`, `retry`, `writeClipboard`, `showAbout`), `OfficeNotice`, `OfficeError` | **Shared** | `init.kind` widened to include `'pdf'`. PDF-specific messages live in `src/pdf/protocol.ts`. |
| `allowedExternalLink`, `LINK_BLOCKED_NOTICE` (`officeEditorProviderBase.ts`) | **Shared** | Same allow-list: `http:`, `https:`, `mailto:`. |
| `officeEditorProviderBase.ts` — HTML with nonce and cache-busting, `localResourceRoots = [media]`, common message handling, panel state | **Shared** | PDF provider extends it; it supplies its own CSP string (§12), not `officeCsp`. |
| `officeDocument.ts` — disk stamp and disk base hash, external-change watcher, conflict modal, flush-before-save, in-place `workspace.fs.writeFile`, save-error mapping (`saveErrors.ts`), quiet-period backup and backup id format, hot-exit restore check, generation-guarded undo/redo, "saving: edits refused" guard, save test hooks | **Shared after extraction** | 1,112 lines today, bound to `OfficePackage` **[Verified]**. Plan PWP-13 extracts the format-neutral part into `src/binaryEditor/binaryDocumentBase.ts`; `OfficeDocument` and `PdfDocument` both derive from it. The Office test suite is the regression net. Needed from Phase 2. |
| `featureFlags.ts` pattern, `loadErrors.ts` pattern, `tests/office/_vscodeStub.cjs`, test-bundle approach | **Pattern reused** | PDF has its own files (`src/pdf/featureFlags.ts`, `loadErrors.ts`, `tests/pdf/`). |
| `core/zip.ts`, `core/xml.ts`, `OfficePackage`, edits/validators, docx-preview, the grid | **Not used** | PDF is not an OPC package. |
| PDF-specific | — | pdf.js integration and its CSP; the viewer UI (pages, sidebar, find); `PdfEditState`; the storage adapter; the writer service; the strict reader and verifier; PDF load/save error text; fixtures. |

Consequence for sequencing: Phase 1 (viewer) needs Office PR-3 on `develop`; Phase 2 (editing) needs Office PR-6 to PR-8 on `develop`. See plan §3 and question Q8.

---

## 3. Library decisions

Sizes are of the published files on 2026-11-21 **[Verified]** unless marked.

| Library | Version | Licence | Runs in | Size shipped | Used for |
|---|---|---|---|---|---|
| pdfjs-dist | 6.5.438 (exact) | Apache-2.0 | webview + its worker | display + viewer components bundle = 702 KB minified as an esbuild IIFE **[Measured, spike S1]** (sources: `legacy/build/pdf.min.mjs` 538 KB, `legacy/web/pdf_viewer.mjs` 485 KB unminified; the viewer components read the display API from `globalThis.pdfjsLib`, which the bundle entry sets); worker `legacy/build/pdf.worker.min.mjs` 1.33 MB; `pdf_viewer.css` 169 KB | rendering, text layer, find, links, forms UI, incremental writing |
| pdf.js data files (in the same package) | — | CMaps: Adobe, BSD-3-Clause · standard fonts: Foxit (BSD-3-Clause) and Liberation (SIL OFL 1.1) · `openjpeg.wasm` BSD-2-Clause · `jbig2.wasm` PDFium, BSD-3-Clause · `qcms_bg.wasm` MIT · ICC profile | worker | cmaps 1.5 MB · standard_fonts 0.82 MB · three wasm files 0.42 MB · iccs 20 KB | CJK text, non-embedded base-14 fonts, JPEG 2000 / JBIG2 images, colour management |
| @cantoo/pdf-lib | 2.11.1 | MIT | **dev only** | not shipped | fixture generation; independent re-read in tests |
| @hyzyla/pdfium | 3.0.0 | MIT (PDFium: BSD-3-Clause/Apache-2.0) | **dev only** | not shipped | independent open/render check in tests (Chrome's engine) |

Runtime additions are pdf.js only. Total VSIX growth ≈ 5.2 MB **[Assumption, from the sizes above]**; mermaid alone is 5.5 MB today. Apache-2.0 requires shipping the licence and notices: `THIRD-PARTY-NOTICES.md` (created by the Office work) gains a pdf.js section listing each bundled data file's licence; the `LICENSE*` files beside the wasm, CMap and font files are copied with them.

Not shipped from `pdfjs-dist`: `pdf.sandbox*.mjs` and `wasm/quickjs-eval.*` (the JavaScript sandbox, §12), `image_decoders/`, source maps, the non-legacy builds, `*_nowasm_fallback.js`.

### 3.1 Renderer (PD1)

**pdf.js** is the renderer of Firefox; it is maintained by Mozilla, permissively licensed, pure JS + small WASM decoders, and brings a selectable/searchable text layer, a structure-tree layer for screen readers, link handling, form widgets and page virtualisation.

Facts relied on **[Verified in the 6.5.438 package]**:

- ESM only (`.mjs`). The worker file has no static imports; its one dynamic import loads the `*_nowasm_fallback.js` decoders when WebAssembly is unavailable.
- When `workerSrc` is cross-origin (it is, in a webview), pdf.js creates the worker from a blob wrapper (`await import("<url>")`, `type: "module"`); if the worker fails to start it silently falls back to running the worker code on the main thread. A caller can instead pass a ready `Worker` through `GlobalWorkerOptions.workerPort`.
- Neither `eval` nor `new Function` appears in the display or worker builds. WebAssembly is used for JPEG 2000, JBIG2 and colour management (`useWasm`, `wasmUrl`).
- CMaps, standard fonts, ICC profiles and wasm are loaded by URL (`cMapUrl`, `standardFontDataUrl`, `iccUrl`, `wasmUrl`) through `fetch`, in the worker when `useWorkerFetch` is on, or through a replaceable `BinaryDataFactory`. **`useWorkerFetch: false` is required here** **[Measured, spike S1, 2026-11-21]**: a worker created from a blob is not served by the webview's resource service worker, so its own fetches of CMaps, fonts and wasm fail or never settle (`cjk` and `base14` timed out, `jpx-jbig2` failed); with `useWorkerFetch: false` the main thread fetches them and all load.
- The viewer components build exports `PDFViewer`, `PDFPageView`, `PDFFindController`, `PDFLinkService`, `EventBus`, `TextLayerBuilder`, `AnnotationLayerBuilder`, `StructTreeLayerBuilder`, `GenericL10n` and others. There is no thumbnail or outline component in it; those are ours.
- Scripting exists only behind `PDFScriptingManager` plus the separate sandbox bundle; `PDFViewer`'s `enableScripting` defaults to `false`.
- Document API used here: `getOutline`, `getAttachments`, `getMetadata`, `getPermissions`, `getPageLabels`, `getSignatures`, `hasJSActions`, `getFieldObjects`, `getData`, `saveDocument`, `isPureXfa`; `loadingTask.onPassword`.
- An existing annotation is hidden at render time when `annotationStorage` holds `{ noView: true }` for its id (`Annotation.mustBeViewed`) — **only when the viewer runs with `annotationMode: AnnotationMode.ENABLE_STORAGE` (3)** **[Measured, spike S6, 2026-11-21]**. In `ENABLE_FORMS` (2, the default) and `ENABLE` (1) the flag has no effect on the canvas. In every mode the annotation layer's own DOM element (`section[data-annotation-id]`) stays and must be hidden by us; `{ hidden: true }` does nothing. See §8.6.
- The legacy build polyfills recent additions (`Math.sumPrecise`, `Uint8Array.fromBase64`, iterator helpers, `URL.parse`, …) but calls `Promise.withResolvers` unpolyfilled (30 uses in the display build). It therefore needs a Chromium that has it; VS Code 1.85, this extension's stated minimum, predates that. **[Measured, spike S2, 2026-11-21]** VS Code 1.85.2 (Chromium 114) and 1.87.2 (Chromium 118) fail with `Promise.withResolvers is not a function`. 1.88–1.94 (Chromium 120–124) load and render the canvas in a real worker but the text layer is collapsed (every span at the same position, up to 1,062 px off), because `setLayerDimensions` sizes the layers with CSS `round()` and has no fallback; Chromium gained `round()` in 125. **The minimum is VS Code 1.95** (Electron 32, Chromium 128), the first release on a Chromium ≥ 125. See §10.4 and Q7.
- Other API facts found by the spikes **[Measured, spike S1, S6, 2026-11-21]**: the host must post a plain `Uint8Array` (a Node `Buffer` arrives in the webview as `{ type: 'Buffer', data: [...] }`); a document is destroyed through `loadingTask.destroy()` (there is no `doc.destroy()`); `PDFViewer` creates its own `GenericL10n` when none is passed and translates without any fetch, whereas a caller-supplied `l10n` is not applied to the page views; `canvas.toBlob` is idle-scheduled and can take seconds (use `toDataURL` for thumbnails); `PageViewport` has `convertToViewportPoint` but no `convertToViewportRectangle`; pdf.js's own `workerSrc` path silently ends in the main-thread fake worker under the §12 CSP, which is why `workerPort` is used; a minimised window gets no animation frames, so no page paints until it is restored (writer calls still work).

Integration choice: use the `PDFViewer` component (virtualised page list, zoom, rotation, text/annotation/structure layers, find controller, link service) and write only the toolbar, sidebar, find bar, password prompt and edit overlay ourselves. Building on the bare display API would re-implement virtualisation, text-layer alignment and find for no gain. The components are distributed officially but with weaker API-stability promises than the display API, hence the exact pin and the upgrade procedure in §13.6.

Alternatives considered:

- **PDFium compiled to WASM** (e.g. `@embedpdf/pdfium` 2.15.1, MIT wrapper **[Verified licence/version only]**): Chrome's renderer, excellent fidelity, and it can also write. But it is a bare rasteriser: text selection, find, accessibility tree, link and form layers would all be ours, or come from a younger, framework-oriented viewer project. Larger binary, canvas-only output. Kept as a **dev-only independent reader** instead.
- **MuPDF.js** (`mupdf` 1.28.6): AGPL-3.0-or-later **[Verified]** — incompatible with shipping inside an MIT extension without a commercial licence.
- **Commercial SDKs** (Nutrient/PSPDFKit, Apryse): licence cost and terms.
- **Chromium's built-in PDF plugin in an iframe**: plugins are not available in VS Code webviews **[Assumption]**, and it would give no control over links, scripts or theming.
- **Rendering through a service**: privacy.

### 3.2 Writer and preservation (PD2, PD3)

The requirement, as for Office, is that everything the editor does not understand survives a save unchanged. For PDF the format itself offers the mechanism: an **incremental update** appends new and replacement objects, a new cross-reference section and a trailer whose `/Prev` points at the previous one. Nothing before the append point changes, which makes the preservation claim a byte-prefix comparison and keeps digital-signature byte ranges intact.

Full rewrite (parse everything, serialise everything) was rejected for v1: it re-emits every object through a library's model, discards linearisation and the revision history, always breaks signatures, and has no cheap proof of "nothing else changed".

Candidates were tested on 2026-11-21 by installing them into a scratch directory and running them under Node 24.13 on two synthetic two-page files with a text field (one with a classic cross-reference table, one with object and cross-reference streams) **[Verified by experiment]**:

| | pdf.js `saveDocument()` | `@cantoo/pdf-lib` 2.11.1 `load({ forIncrementalUpdate })` + `save()` | `pdf-lib` 1.17.1 (upstream) |
|---|---|---|---|
| Output starts with the original bytes | yes | yes | no incremental mode exists (not in its API); 1.17.1 was published in November 2021 |
| No edits ⇒ original bytes | yes (returns the loaded bytes) | **no** — appends ~277 bytes | — |
| Form field fill | value **and** regenerated appearance | value only: `updateFieldAppearances` is forced off in incremental mode, the stale appearance stream is kept | — |
| New annotations | first-class: Highlight, Ink, FreeText, Stamp, with appearance streams; comment text through a Popup; structure-tree update for tagged files | no annotation API; dictionaries and appearance streams would be hand-built | — |
| Deleting an existing annotation | yes (`{ deleted: true }` by id) | by hand | — |
| Cross-reference kind of the increment | matches the base (`useXrefStream` when the base uses one) | does not match by default: wrote an xref *stream* onto a table-based file, and with `useObjectStreams: false` an xref *table* onto a stream-based file | — |
| Objects superseded for a one-field edit | (measured in spike S3) | the catalog was rewritten although unchanged | — |
| Encrypted input | encrypts new objects (`createCipherTransform` on write) | `password` option exists; not tested | cannot open |
| Maintainer | Mozilla; this is Firefox's "save" path | a company fork of an unmaintained project; its README describes incremental mode as "designed to be used for pdf signing" | unmaintained |

pdf.js is therefore the writer. Cross-reading worked in both directions (each library opened the other's output and saw the field value / rotation).

**Where the writer runs.** In the webview's pdf.js worker, on a *fresh* document instance created from `getData()` of the viewed document, with its `annotationStorage` populated from the host's edit state by the storage adapter (§6.4). Reasons:

- pdf.js detects Node with `!(process.versions.electron && process.type && process.type !== "browser")` **[Verified]**; the extension host is an Electron utility process, so pdf.js would take its browser path there and fail. A forked plain-Node child would work but needs Node ≥ 22.13 (`engines` of `pdfjs-dist`) and has no canvas: in the Node experiment pdf.js warned "OffscreenCanvas is not supported, annotation may not render correctly" when generating text appearances. The browser worker is the environment pdf.js is built and tested for.
- The webview is the least-privileged place to parse hostile input.

The price is that the bytes to be saved come from the webview. The host therefore treats them as untrusted and proves, with its own code, that they are the loaded file plus a well-formed, minimal, inert revision (§6.5). It also means a save needs a live webview; §6.6 covers the cases where there is none.

Alternatives considered for ownership of edit state: **pdf.js's own annotation editors** (`AnnotationEditorLayer`/`AnnotationEditorUIManager`, enabled through `PDFViewer.annotationEditorMode`). They give a finished editing UI, but the state and an independent undo stack would live inside pdf.js; bridging that to VS Code's undo/dirty model means patching `addCommands` and neutralising its keyboard handling, there is no supported way to restore editors from saved state, and every pdf.js upgrade (which security fixes will force) would re-open that integration. Host-owned state keeps the coupling to three small, testable things: the display/viewer API, the `noView` storage hook, and the serialised storage entries for three annotation kinds and form values (§6.4).

### 3.3 Verifier (PD4)

A small strict reader written for this purpose rather than a library, for the reasons the Office work wrote its own ZIP and XML code: it must refuse rather than recover, it must be bounded against hostile input because it runs in the extension host, and it must be an implementation *independent* of the writer it checks. Scope: header and `startxref`; classic cross-reference tables and cross-reference streams; the `/Prev` chain; object streams; a tokeniser for PDF objects (dictionaries, arrays, names, numbers, strings, references) that skips stream bodies by `/Length`; `node:zlib` for FlateDecode (no dependency). Out of scope: encryption (encrypted files are view-only), content streams, fonts, repair of damaged cross-references (such a file is not editable), hybrid-reference files (`/XRefStm`; not editable).

Risk accepted: new parsing code (~800 lines). It never writes a byte of the saved file; its failure mode is refusing to edit or save a valid file, never corrupting one.

---

## 4. Architecture

```
src/pdf/
  core/                 # NO 'vscode' import anywhere under core/. Pure, node-testable.
    sniff.ts            # header/EOF/size checks before anything else (§9.4)
    reader.ts           # strict object reader (§3.3)
    classify.ts         # editability of a file: reasons, form/XFA/signature facts (§6.2)
    state.ts            # PdfEditState, deltas, apply/invert, validation, canonical order (§6.3)
    geometry.ts         # quads -> rect and outlines, ink bounds, page-box checks
    storageAdapter.ts   # PdfEditState -> pdf.js annotationStorage entries (§6.4)
    verify.ts           # the save checks PV1-PV6 (§6.5)
    limits.ts           # thresholds (§9.3)
    index.ts            # barrel; entry point of the test bundle
  protocol.ts           # PDF message unions + validators (§5)
  pdfDocument.ts        # extends the shared BinaryDocumentBase (§6.1)
  pdfEditorProvider.ts  # viewType vscodeMdEditor.pdf
  featureFlags.ts       # PDF_FLAGS = { pdfEdit, pdfForms }
  loadErrors.ts         # failure -> error-view text (§9.4)
src/binaryEditor/
  binaryDocumentBase.ts # extracted from src/office/officeDocument.ts (§2.2)

scripts/pdfjs-vendor-entry.js           # re-exports what the webview needs from the legacy build

media/
  pdfjs-bundle.js                        # esbuild IIFE, global `PdfjsBundle` (display + viewer components)
  pdfjs/pdf.worker.min.mjs               # copied
  pdfjs/cmaps/, standard_fonts/, wasm/, iccs/, pdf_viewer.css, images/   # copied, with their LICENSE files
  pdfViewer.js / pdfViewer.css           # boot, PDFViewer wiring, toolbar, password prompt, links
  pdfViewMath.js                         # UMD, pure: zoom steps, page-number parsing, rect merging (node-testable)
  pdfSidebar.js                          # thumbnails, outline, comments, attachments, properties
  pdfFind.js                             # find bar over PDFFindController
  pdfOverlay.js                          # draws PdfEditState over the pages (Phase 3)
  pdfTools.js                            # highlight / comment / ink / select-delete tools (Phase 3)
  pdfForms.js                            # form value observation and locking (Phase 4)
  pdfWriter.js                           # writer service (Phase 2)
```

Build changes: `package.json` dependency `pdfjs-dist` (exact); devDependencies `@cantoo/pdf-lib`, `@hyzyla/pdfium` (exact). `esbuild.js`: one webview context for `media/pdfjs-bundle.js` (as for three.js) and one test-bundle context `src/pdf/core/index.ts` → `tests/.build/pdf-core.cjs`. `scripts/copy-vendor.js`: copy the worker and the data directories. `.gitattributes`: `media/pdfjs/** -text` and binary markers; `tests/fixtures/pdf/** binary`. `.vscodeignore`: nothing new beyond the Office additions (`docs/**`).

### 4.1 Contributions (`package.json`)

```jsonc
{ "viewType": "vscodeMdEditor.pdf", "displayName": "PDF Viewer",
  "selector": [{ "filenamePattern": "*.pdf" }], "priority": "default" }
```

Registration options: `retainContextWhenHidden: true`, `enableFindWidget: false` (the page list is virtualised; own find, §7.4), `supportsMultipleEditorsPerDocument: false`.

Settings (all under `vscodeMdEditor.pdf`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `startInEditMode` | boolean | `false` | Open editable files with Edit already on. |
| `defaultZoom` | `"auto"` \| `"page-width"` \| `"page-fit"` \| `"actual"` | `"auto"` | Initial zoom. |
| `highlightColor` | `"yellow"` \| `"green"` \| `"blue"` \| `"pink"` \| `"red"` | `"yellow"` | Colour of new highlights and ink. |
| `annotationAuthor` | string | `""` | Written as the author (`/T`) of new annotations. Empty writes no author: nothing identifying the user is added to a file unless they ask. |

Commands: none in v1 beyond what the editor toolbar offers. Telemetry: none.

Another installed extension may also claim `*.pdf` with default priority (PDF viewers are among the most installed VS Code extensions); VS Code then asks the user to choose. README and CHANGELOG MUST call this out (Q4).

---

## 5. Message protocol

Defined in `src/pdf/protocol.ts`. The Office rules apply unchanged (Office §5): host-owned monotonic `version`; every edit request carries `requestId` and `baseVersion` and is answered exactly once; the host validates every field of every inbound message and never throws on bad input; binary payloads travel as `Uint8Array` (Office spike S2 measured 20 MB in ≈ 0.33 s).

```ts
export type PdfReadOnlyReason =
  | 'view-mode' | 'non-writable-scheme' | 'too-large'
  | 'encrypted'               // §9.1
  | 'unsupported-structure'   // the strict reader refused the file (§3.3, §6.2)
  | 'engine-too-old';         // §10.4

export type PdfColor = 'yellow' | 'green' | 'blue' | 'pink' | 'red';
export interface PdfObjRef { num: number; gen: number; }      // an object in the loaded file

// Geometry is in PDF user space of the page (points, origin bottom-left, unrotated).
export type PdfAnnotSpec =
  | { kind: 'highlight'; localId: number; page: number; quads: number[];   // 8 numbers per quad
      color: PdfColor; comment: string }
  | { kind: 'ink'; localId: number; page: number; paths: number[][];       // x,y pairs per stroke
      color: PdfColor; width: 1 | 2 | 4; comment: string };

export type PdfFieldValue = string | boolean | string[];       // text | checkbox/radio widget | choice

export type PdfEditOp =
  | { op: 'addAnnotation'; spec: PdfAnnotSpec }
  | { op: 'updateAnnotation'; localId: number; patch: { comment?: string; color?: PdfColor } }  // session-created only
  | { op: 'removeAnnotation'; target: { localId: number } | { ref: PdfObjRef } }
  | { op: 'setFields'; values: Array<{ ref: PdfObjRef; value: PdfFieldValue }> };

export interface PdfStateView {                                 // what the webview draws
  version: number;
  annots: Array<PdfAnnotSpec & { createdAt: string }>;
  removed: PdfObjRef[];
  fields: Array<{ ref: PdfObjRef; value: PdfFieldValue }>;
}

export interface PdfEditInfo {                                  // result of classification (§6.2)
  deletable: PdfObjRef[];                                       // existing markup annotations
  forms: { editable: boolean; reason?: 'flag-off' | 'xfa' | 'none'; lockedFields: PdfObjRef[] };
  signed: boolean;
}

export type PdfToWebview = OfficeCommonToWebview
  | { type: 'pdfDocument'; generation: number; version: number; bytes: Uint8Array }  // the bytes of this generation
  | { type: 'pdfState'; state: PdfStateView }
  | { type: 'pdfEditInfo'; info: PdfEditInfo }
  | { type: 'pdfEditResult'; requestId: number; ok: true; state: PdfStateView }
  | { type: 'pdfEditResult'; requestId: number; ok: false; error: OfficeError }
  | { type: 'pdfWrite'; requestId: number; generation: number; version: number;
      storage: Array<[key: string, entry: unknown]> }           // produced by storageAdapter (§6.4)
  | { type: 'pdfSaveAttachmentResult'; requestId: number; ok: boolean };

export type PdfToHost = OfficeCommonToHost
  | { type: 'pdfRequestDocument' }
  | { type: 'pdfFacts'; facts: PdfFacts }                       // display only, never used for a decision
  | { type: 'pdfLog'; level: 'info' | 'warn' | 'error';        // amendment 2026-11-21, see below
      code: 'csp-violation' | 'worker-fallback' | 'page-render-failed'; detail?: string }
  | { type: 'pdfEdit'; requestId: number; baseVersion: number; edit: PdfEditOp }
  | { type: 'pdfWriteResult'; requestId: number; ok: true; bytes: Uint8Array; observed: PdfObserved }
  | { type: 'pdfWriteResult'; requestId: number; ok: false; message: string }
  | { type: 'pdfSaveAttachment'; requestId: number; name: string; bytes: Uint8Array };

export interface PdfFacts { pageCount: number; encrypted: boolean; hasText: boolean; hasJavaScript: boolean;
  hasXfa: boolean; attachmentCount: number;
  signatures: Array<{ signer: string; reason: string; time: string }>; }
export interface PdfObserved { pageCount: number; annotsPerPage: number[];
  fields: Array<{ ref: PdfObjRef; value: PdfFieldValue }>; }
```

`PDF_PROTOCOL_LIMITS` (single source of truth for the inbound validators): page index < 100,000; ≤ 5,000 quads per highlight; ≤ 500 strokes per ink annotation and ≤ 4,000 points per stroke; every coordinate finite and within ±100,000; comment ≤ 32,767 characters; ≤ 2,000 fields per `setFields`; a text value ≤ 100,000 characters; attachment ≤ 250 MB; `pdfWriteResult.bytes` ≤ the loaded size + 64 MB; `pdfLog.detail` ≤ 2,000 characters.

**`pdfLog` (amendment to the frozen view half, 2026-11-21, approved by the user).** The first draft of the view protocol had no way for the webview to report a CSP violation or the pdf.js worker falling back to the main thread, so both were visible only in the webview console (`shell.diagnostics()`). `pdfLog` is a webview → host message with a fixed `code` set (`csp-violation`, `worker-fallback`, `page-render-failed`; adding a code is a spec change), a `level` enum and an optional `detail` of at most 2,000 characters. The validator rejects any other level, code or an over-long `detail`, strips query strings and fragments from anything URL-like in `detail` and replaces control characters (so a `detail` cannot forge a log line). The webview puts nothing document-derived into it beyond a CSP violation's violated directive and blocked URI (query and fragment removed), a page number, and an error name. It is never answered and never shown to the user (§12).

`localId` is generated by the webview and checked for uniqueness by the host; the creation time and the annotation's unique name are assigned by the host.

---

## 6. Document model, edits and saving

### 6.1 Document

`PdfDocument extends BinaryDocumentBase` (the shared base keeps Office §6.1 behaviour: `uri`, `version`, `generation`, `diskStamp`, disk base with SHA-256, reading through `workspace.fs`, never throwing from `openCustomDocument`, the external-change watcher, `non-writable-scheme`). PDF-specific members:

- `base: Uint8Array` — the bytes of this generation: the file as loaded, as reloaded, or the backup bytes after a hot-exit restore. They do not change when the document is saved.
- `state: PdfEditState` — §6.3. Empty on every load.
- `info: PdfClassification | null` — filled on first use (§6.2).
- `materialised: { version, bytes } | null` — the last verified writer output, kept for backups and for saving without a webview (§6.6).

The host does **not** parse the PDF to show it. Opening runs only `sniff` (§9.4); the webview gets the bytes and pdf.js does the rest.

### 6.2 Edit mode and classification

`init.canEdit` is true when `PDF_FLAGS.pdfEdit` is on, the scheme is writable, the file is within the edit limit (§9.3) and the webview reported a capable engine (§10.4). The Edit toggle (Ctrl/Cmd+E) is then shown, off by default.

The first time Edit is turned on for a generation the host runs `classify(base)` with the strict reader (budget: 2 s per 100 MB, yielding every ~30 ms; a progress hint is shown after 300 ms):

- The cross-reference chain resolves, the catalog and page tree are readable, no `/Encrypt`, no `/XRefStm` → editable. Otherwise the toggle springs back with `encrypted` or `unsupported-structure` and the sentence for that reason.
- It collects: page object refs and boxes; for each page the refs and subtypes of its annotations (the **deletable** set is the existing Highlight, Underline, StrikeOut, Squiggly, Text, Ink and FreeText annotations and their Popups); the AcroForm dictionary, whether it has `/XFA`, and per terminal field its type, flags and widgets; whether any signature field is signed and any `/Perms` (DocMDP) entry.
- Result → `pdfEditInfo`. If the file is signed the warning of §9.2 is shown once.

In View mode every editing gesture shows the one-line hint "Press Edit (Ctrl+E) to make changes" and does nothing else (Office §6.4).

### 6.3 Edit state, undo, redo

```ts
interface PdfEditState {
  added: Map<number, PdfAnnotRecord>;       // by localId; record = spec + createdAt + uniqueName
  removed: Set<string>;                     // "num gen" of existing annotations
  fields: Map<string, PdfFieldValue>;       // "num gen" of the widget (checkbox/radio) or field
}
```

An edit is a reversible **delta**: a list of `{ slot, key, before, after }` over those three maps, applied atomically. Undo applies the delta in reverse. Because the state is normalised, history does not accumulate in the file: adding an annotation and deleting it again leaves no trace, and any sequence that returns the state to empty makes the next save byte-identical to the loaded file (PG2, by construction — the writer is not asked).

Rules (host, `core/state.ts`):

- `addAnnotation`: geometry validated against the page's boxes from classification; highlights need ≥ 1 quad; ink needs ≥ 1 stroke of ≥ 2 points. At most 10,000 added annotations.
- `updateAnnotation`: session-created annotations only.
- `removeAnnotation`: a `localId` removes the record; a `ref` MUST be in the deletable set. Removing a markup annotation removes its Popup with it.
- `setFields`: each ref MUST be a fillable field or widget per classification (§8.5). Setting a field back to the value it had when the generation was loaded removes the key instead of storing it (the webview sends the loaded value with the first change to a field; it is used only for this comparison).
- An operation that changes nothing records no edit and fires no event.

Everything else is the shared base's behaviour (Office §6.3): one `CustomDocumentEditEvent` per applied edit with a label, generation-guarded closures ("Can't undo: the file was reloaded from disk"), refusal of edits/undo/redo while a save is in progress, the save point being the state that was serialised.

Labels: "Highlight", "Draw", "Edit Comment", "Change Colour", "Delete Annotation", "Fill Form Field".

In-progress input (an open comment box, an ink stroke being drawn, typing in a form field) is not on the VS Code undo stack; it becomes one edit on commit. Ctrl+Z inside an open text box is the browser's native undo, with the same capture-phase handling and the same fallback as Office §6.3 (its spike S3 result applies here unchanged).

### 6.4 Storage adapter and writer service

`core/storageAdapter.ts` turns a `PdfEditState` into the list of `annotationStorage` entries pdf.js's writer consumes **[field names read from the 6.5.438 worker source (`createNewDict`/`createNewAppearanceStream` of the Highlight and Ink annotations, `saveNewAnnotations`, the `deleted` handling); a text field value and a new annotation were saved this way in the Node experiment. The format is internal to pdf.js, which is why the version is pinned, the adapter has contract tests, and §13.6 exists]**:

| State | Storage entry |
|---|---|
| highlight | key `pdfjs_internal_editor_{n}`: `{ annotationType: 9, pageIndex, rect, rotation: 0, color: [r,g,b], opacity: 1, quadPoints, outlines, date, user?, popup?: { contents } }` — `outlines` are the quads as closed polygons; pdf.js fills them with a Multiply blend in the appearance stream |
| ink | `{ annotationType: 15, pageIndex, rect, rotation: 0, color, opacity: 1, thickness, paths: { lines, points }, date, user?, popup? }` |
| removed annotation | key `pdfjs_internal_editor_{n}` (**not** the annotation id): `{ id, deleted: true, pageIndex, popupRef }` — `popupRef` is the id of its Popup, or `''`; the writer then frees both. An entry keyed by the bare annotation id is silently ignored: 0 bytes appended, the annotation stays **[Measured, spike S3, 2026-11-21]** |
| field value | key = the annotation id (`"12R"`; `"12R3"` when the generation is not 0): `{ value }` — text: string; checkbox: boolean; radio: one boolean per widget; choice: the export value. When a text value is written back into the *viewed* document's storage (undo/redo/revert, §8.5) it must be `{ value, formattedValue }`, otherwise the input keeps showing the old text **[Measured, spike S6, 2026-11-21]** |

Entries are emitted in canonical order (page, then creation time, then `localId`) and every date comes from the state, so the writer's input is a pure function of the state.

Determinism of the output **[Measured, spike S3, 2026-11-21]**: for annotation-only edits on a file without a trailer `/ID` the output is byte-identical across runs. Otherwise three things vary: the second `/ID` element (an MD5 that includes the current time; its literal-string escaping can change the length by a byte or two); the `/M` of every rewritten widget (the current time, not a date from the state); and everything in an encrypted file (not editable here anyway). `materialised` is therefore keyed by `(generation, version)` and never compared byte-for-byte with a second write.

Writer service (`media/pdfWriter.js`), on `pdfWrite`:

1. `data = await viewedDocument.getData()`; open a **fresh** document from it with the same options as the viewer (same worker).
2. Apply the entries with `annotationStorage.setValue`; `out = await doc.saveDocument()`.
3. Open `out` as a third, throwaway document and collect `observed` (page count, annotation count per page, value of each field in the request).
4. Destroy both documents; reply `pdfWriteResult` with `out` and `observed`. Any exception → `ok: false`.

The viewed document's own `annotationStorage` is never used for saving; it only carries `noView` flags and live form inputs.

### 6.5 Save pipeline

1. Flush (shared; Office §6.5 step 1).
2. Conflict check against `diskStamp` (shared; Overwrite / Revert / Cancel).
3. **Serialise.** State empty → the bytes are `base`; skip to step 5. `materialised.version === version` → reuse. Otherwise post `pdfWrite` and wait (timeout 10 s + 0.2 s per MB).
4. **Verify (MUST pass before writing)** — `core/verify.ts`, all in the host:

   | Id | Check |
   |---|---|
   | PV1 | **Prefix identity.** `out.length > base.length` and the first `base.length` bytes equal `base`. |
   | PV2 | **Revision structure.** The last `startxref` points into the appended region at a cross-reference section of the same kind as the base's; its trailer has `/Prev` equal to the base's last `startxref` value, the same `/Root`, the same `/Info` (a reference, or the same direct dictionary copied inline when the base has it inline), `/Size` ≥ the base's, the same first `/ID` element when the base has one (the second may differ), no `/Encrypt`, and no key other than `/Size /Root /Info /ID /Prev` (plus `/Type /W /Index /Length /Filter` on a cross-reference stream, which pdf.js writes as an ordinary uncompressed object); the file ends with `%%EOF`. Exactly one revision was appended. **[Measured, spike S3, 2026-11-21]** on 145 outputs from 16 fixtures. |
   | PV3 | **Entries.** Every in-use entry of the new section points inside the appended region at an `N G obj` header with the matching number; no object-stream entries. Free entries: object 0, plus exactly the annotations (and their Popups) that the request removes — pdf.js writes `0000000000 00001 f` for each **[Measured, spike S3, 2026-11-21]**; a free entry for any other object fails the check. |
   | PV4 | **Object allow-list** **[Measured, spike S3, 2026-11-21]**, the lists below are what pdf.js 6.5.438 wrote for 145 outputs (16 fixtures: classic and stream xref, object streams, tagged, multi-revision, signed, certified, forms, JavaScript). Every *new* object (number ≥ the base's `/Size`) is one of: (a) an annotation dictionary `/Subtype /Highlight` with keys from `Type Subtype CreationDate Rect F Border Rotate QuadPoints C CA T AP Contents Popup` (`/AP` holds `/N` only); (b) `/Subtype /Ink`, the same keys with `InkList` and `BS` (`/W`) instead of `QuadPoints`; (c) `/Subtype /Popup` with `Type Subtype Open Rect Parent`; (d) a form XObject stream with keys from `Type Subtype FormType BBox Length Resources`, where `Resources` is an inline dictionary holding only `ExtGState` (inline, `BM /Multiply`) or `Font` (references to fonts that exist in the base); (e) the cross-reference stream. No separate ExtGState, font, font-descriptor, array or structure-tree object was written, so none is allowed. Every *superseded* object (number < the base's `/Size`) is read in its base version through the strict reader and MUST be of the same kind, with differences only in: page → `/Annots` (written as an inline array of references); field → `/V`; widget or merged field/widget → `/V`, `/AS`, `/AP`, `/M`, and inside `/MK` only the removal of `/R 0`. The catalog, the AcroForm dictionary and the structure tree were never superseded (also not for the tagged `chrome` file: pdf.js only touches the structure tree for entries carrying `accessibilityData`, which the adapter never sends), so superseding them fails the check. **Comparison is by decoded value, not by token**: pdf.js re-serialises the whole dictionary of a superseded object, so strings change form (hexadecimal ↔ literal, escapes, UTF-16BE) while meaning the same; names, references, numbers and strings are compared after decoding, key order is ignored. Anything outside these lists fails the save. The lists come from synthetic fixtures only; PWP-18 re-runs the classification on the user's corpus and on Word- and Acrobat-produced files before they are frozen. |
| PV5 | **Inert.** No new object, and no changed key of a superseded object (an unchanged `/AA` or `/A` that a rewritten widget carries over from the base is not a finding — seen on the `js` fixture), contains `/JS`, `/JavaScript`, `/Launch`, `/URI`, `/GoToR`, `/GoToE`, `/SubmitForm`, `/ImportData`, `/OpenAction`, `/AA`, `/A`, `/EmbeddedFile`, `/EmbeddedFiles`, `/RichMedia` or `/Filespec`. |
   | PV6 | **Expectations.** `observed.pageCount` equals the base's; per page, annotation count = classified count + added − removed (Popups counted); each requested field reads back the requested value; the appended size is ≤ 64 KB + 16 × the serialised size of the state. |

   On failure: abort, write nothing, show "Save failed an internal consistency check — your file on disk was not changed", with the Office "Save a copy of diagnostics" action (check ids and object numbers, no document content).
5. `vscode.workspace.fs.writeFile(uri, bytes)` in place, with the shared error mapping and its trade-off (Office §6.5 step 5; §9.4 here for the PDF wording).
6. Update `diskStamp`; keep `base` and `state` as they are; `materialised = { version, bytes }`.

Sizes and times **[Measured, spike S3, S4, 2026-11-21]**: 0.8–2.4 KB appended per simple edit, about 5 KB for eight annotations; `saveDocument()` 1–90 ms on small files and 257 ms on a 100 MB file.

Saving twice in a session therefore never stacks revisions from that session: each save is `base` + one revision for the *current* state, and may be shorter than the previous one. Across sessions each editing session that saves adds one revision.

`saveCustomDocumentAs`: same pipeline to `destination`; with an empty state the loaded bytes are written verbatim (PG0). `revertCustomDocument`: reload from disk, new generation, empty state.

### 6.6 Backup, hot exit and saving without a webview

`backupCustomDocument` reuses the shared quiet-period logic (750 ms, at most 10 s, cancelled backups write nothing). Its payload is the **verified materialised bytes** for the current `(generation, version)` — produced by step 3–4 above, cached in `materialised` — and its id is the shared format carrying the disk base. With an empty state the payload is `base`.

Restoring opens the backup bytes as the new generation's `base` with an **empty** state; VS Code restores the dirty flag. Saving then writes those bytes (no writer needed), and further edits append a second revision on top. The "changed on disk while VS Code was closed" check and its conflict modal are the shared behaviour (Office §6.2). The undo stack does not survive a restart (acceptable, as for Office).

No webview is needed to save when the state is empty or `materialised` is current — this covers a restored dirty document whose tab has not been shown yet. Otherwise a save or backup that cannot reach the webview (panel disposed, no `pdfWriteResult` in time) fails safely: nothing is written, the document stays dirty, and the message is "Couldn't save: the PDF engine didn't respond. Your file on disk was not changed. Try again." A backup in that situation is rejected, so VS Code keeps the previous one.

**[Measured, spike S8, 2026-11-21]** With `retainContextWhenHidden: true` a hidden tab's webview answers `pdfWrite` as fast as a visible one (10–16 ms on a small file), for saves and for backups. Without it the webview of a hidden tab is destroyed, `postMessage` resolves `false` and no reply comes — the registration option is therefore required, not a convenience. Save from the close prompt ("Save" in *Do you want to save the changes…*): `saveCustomDocument` runs while the panel is still alive, for an active tab, for a hidden tab (VS Code reveals it first) and for a window close; the writer replied in 14–28 ms in each case and the panel was disposed only after the save returned. Window close 50 ms after an edit with hot exit on: no `backupCustomDocument` call was observed before shutdown, so an edit younger than the backup delay is covered only by the previous backup — the residual the pre-materialisation rule already accepts. A 100 MB `Uint8Array` crosses webview → host intact (SHA-256 equal) in 0.8–0.9 s and host → webview in about 1.0 s; 200 MB in 1.5–1.7 s.

---

## 7. Viewer features (v1)

### 7.1 Pages

- Continuous vertical scroll of all pages, rendered by `PDFViewer`: only pages near the viewport hold a canvas; others are sized placeholders. Page size, rotation (`/Rotate`), crop box and page labels are honoured by pdf.js.
- Zoom: Automatic, Actual size, Fit page, Fit width, and 25–500 % in the steps of `pdfViewMath.js`; Ctrl+wheel, pinch, Ctrl+= / Ctrl+-, Ctrl+0. Canvas size is capped (pdf.js `maxCanvasPixels`); beyond the cap pages are scaled with CSS.
- Navigation: page box ("12 of 340", accepts a number or a page label), previous/next, Home/End, PageUp/PageDown, arrow keys, Space.
- Rotate view clockwise/counter-clockwise: all pages, this session only, never saved, never dirties the document.
- State kept per document for the session (scroll position, zoom, rotation, sidebar) through `vscode.setState`; nothing is written to the file or the workspace.

### 7.2 Sidebar

Collapsible, tabs as `role="tablist"`: **Thumbnails** (rendered lazily with an `IntersectionObserver`, one at a time, at most 200 kept; click or Enter goes to the page) · **Outline** (bookmarks from `getOutline()` as a `role="tree"`; a tab shown only when present) · **Comments** (every annotation that has text, existing and new, grouped by page; Enter goes to it; in Edit mode it is also where comments are edited and annotations deleted from the keyboard) · **Attachments** (only when `getAttachments()` returns any: name and size, "Save as…" through a host save dialog; never opened, never executed).

"Document properties" (toolbar overflow): title, author, subject, keywords, creator, producer, created/modified, PDF version, page count, page size, file size, tagged, encrypted, signatures.

### 7.3 Text selection and copy

pdf.js text layer; normal mouse selection; Ctrl+C sends the selection through `writeClipboard` (plain text). Select All selects the text of rendered pages only (a limitation of virtualised text layers; stated in the README). A file whose first pages contain no text (a scan) gets the notice "This PDF has no text layer (it looks like a scan). Selecting and searching text aren't available."

Permission flags of encrypted files (no-copy, no-print) are **not** enforced, as in pdf.js's own default; editing such files is refused for a different reason (§9.1).

### 7.4 Find

Own bar (Ctrl/Cmd+F, Enter / Shift+Enter, Esc) driving `PDFFindController`: match case, whole words, highlight all, "3 of 17" count, wrap-around announcement. pdf.js extracts page text lazily, so results on long documents arrive progressively; the count says "more than N" until the scan completes.

### 7.5 Links

- Internal destinations (outline entries, link annotations, named destinations): handled in the webview by `PDFLinkService`.
- External: never navigated by the webview. Clicks are intercepted and sent as `openLink`; the host applies the shared allow-list (`http:`, `https:`, `mailto:`) and opens with `vscode.env.openExternal`. Anything else, including `file:`, remote-file (GoToR), Launch and `javascript:` actions, is dropped with the shared "link was not opened" notice.

### 7.6 Notices

Shown in the shared notices bar from `pdfFacts`: encrypted · signed (count; "signatures are not verified here") · contains JavaScript ("scripts in this PDF are not run"; detected with `getJSActions()` returning non-null, or a field object carrying actions — **not** `hasJSActions()`, which also returned true for the signed and certified fixtures that contain no script **[Measured, spike S7, 2026-11-21]**) · XFA form ("this form was made with Adobe LiveCycle (XFA) and can't be shown or filled here"; detected with `enableXfa: false` through `(await getMetadata()).info.IsXFAPresent`, which also gives `IsAcroFormPresent` and `IsSignaturesPresent` **[Measured, spike S7, 2026-11-21]**) · no text layer · attachments present · large file · file open elsewhere is **not** detectable for PDF (no lock file convention) and is not attempted.

### 7.7 Not in the viewer

Printing (use "Open externally"; see §15), presentation mode, two-page spreads, layers (optional content) panel, measuring tools, per-page rotation, text reflow, dark-mode page inversion.

---

## 8. Editing (v1)

### 8.1 Candidates, ranked, and the v1 cut

| Rank | Feature | Value | Risk / cost | Decision |
|---|---|---|---|---|
| 1 | Highlight selected text | The core review action | Low: no fonts, writer support verified | **v1** |
| 2 | Comment attached to a highlight (popup note) | Review needs words | Low: `popup.contents` in the writer | **v1** |
| 3 | Delete a markup annotation (own or pre-existing) | Without it mistakes are permanent | Low: writer support verified; hidden with `noView` | **v1** |
| 4 | Fill AcroForm fields | The most common "edit a PDF" task | Medium: appearance generation is pdf.js's; no scripts run, so calculated fields go stale | **v1**, own flag and gate |
| 5 | Freehand ink | Marks, ticks, a drawn signature | Low–medium: pointer handling; not keyboard-drawable | **v1**, last in line (first to cut) |
| 6 | Free text ("typewriter") | Fills non-form PDFs | Medium: writer supports it, but text appearance depends on fonts (non-Latin text uses a non-embedded fallback) and it needs a move/resize UI | v1.1 |
| 7 | Standalone sticky note; underline / strikeout | Familiar from Acrobat | The pdf.js writer cannot create them **[Verified: only FreeText, Highlight, Ink, Stamp, Signature]**; needs our own object writer | post-v1 |
| 8 | Move/resize; edit pre-existing annotations | Polish | Medium | post-v1 |
| 9 | Rotate (saved), delete, reorder, extract pages; insert pages from another PDF | Document assembly | High: not expressible as a pdf.js incremental update; full rewrite; breaks signatures; "deleted" content must really be gone | post-v1, as export to a **new** file (§14) |
| 10 | Metadata (title, author) | Low demand | Info dictionary and XMP must stay consistent | post-v1 |

Out of scope and not planned (§15): editing page text or images, redaction, OCR, flattening, signing, stamps/images, form design, encryption changes.

### 8.2 Highlight

- With text selected on one or more pages in Edit mode: toolbar **Highlight** (or `H`). The selection's client rectangles are merged per line (`pdfViewMath.mergeRects`) and converted to page user space with the page viewport; one annotation per page touched.
- Keyboard route (no mouse): Find → "Highlight this match" on the current result.
- Colour: the toolbar swatch (five colours; names announced, not colour alone).
- Written as a real Highlight annotation with quad points, an appearance stream and a creation date; other readers can show, edit and delete it.

### 8.3 Comments

- A highlight or ink annotation may carry a comment. "Add comment" (toolbar, context menu, Comments panel, `C`) opens a small text box anchored to the annotation; Ctrl+Enter or leaving the box commits, Esc cancels.
- Comments of session-created annotations can be edited and cleared. Comments of pre-existing annotations are shown read-only.

### 8.4 Ink

- **Draw** tool (`D`): pointer strokes on the page under the pointer; pen, mouse and touch through Pointer Events; width 1, 2 or 4 pt; strokes are simplified (Ramer–Douglas–Peucker, 0.5 pt) before commit. Leaving the tool, switching page or Enter commits the strokes as one annotation; Esc discards them.
- Not operable from the keyboard (inherent); everything else in the editor is.

### 8.5 Form filling (flag `pdfForms`)

- In Edit mode, when the document has fillable fields, the viewer is built with `annotationMode: ENABLE_FORMS`; pdf.js draws HTML inputs over text, checkbox, radio, dropdown and list fields. In View mode, and for documents without fillable fields, the viewer is built with `annotationMode: ENABLE_STORAGE`: fields show their stored appearance on the canvas and there are no inputs at all. Switching mode means constructing a second `PDFViewer` on the same loaded document; that took about 0.5 s on the forms fixture and needs no reload **[Measured, spike S6, 2026-11-21]**.
- `pdfForms.js` listens for `input` and `change` in the capture phase on the annotation layer (both fire for text, checkbox, radio, combo and list), reads the new value with `annotationStorage.getRawValue(id)`, and posts `setFields`. On undo/redo/revert it writes the host's values back with `setValue` (text as `{ value, formattedValue }`, §6.4) and re-renders the page; removing every entry returns the storage to size 0 and the inputs to the loaded values. `annotationStorage.onSetModified` is not usable as a change signal (never called in the spike). A read-only field's input is `disabled` by pdf.js; `inert` on the layer works for locking everything **[Measured, spike S6, 2026-11-21]**.
- The host accepts a value only for a terminal field that classification found fillable: type text/button/choice; not read-only (`Ff` bit 1); no rich-text value (`/RV`); text within `MaxLen`; a choice among the options unless the field is an editable combo. Signature fields are never touched. Locked fields are disabled in the UI with their reason as `title`/`aria-describedby`.
- **No scripts run.** A form with JavaScript actions (formatting, validation, calculation) gets a persistent notice in Edit mode: "This form uses scripts. They are not run here: calculated totals and automatic formatting will not update." Values are stored as typed.
- **XFA.** If the AcroForm has `/XFA`, form filling is off for the document (`forms.reason: 'xfa'`): Acrobat reads such forms from the XFA data, which this editor does not write. Annotations remain available.
- Appearances are generated by pdf.js at save; `NeedAppearances` is not relied on. Known appearance defect **[Measured, spike S3, 2026-11-21]**: for a multi-line text field with automatic font size, PDFium draws pdf.js's regenerated appearance as one oversized line (the value itself is correct and readable by other libraries). Gate P4 checks this field kind in Acrobat; if it shows there too, multi-line auto-size fields are locked with a reason.

### 8.6 Selecting and deleting

Select tool (`V`, the default in Edit mode): click or Tab to an annotation (ours, or one in the deletable set); Delete/Backspace or the context menu (Shift+F10) removes it. A removed pre-existing annotation is listed under "Removed" in the Comments panel until saved, where it can be restored (= undo). How it leaves the page depends on the viewer's annotation mode **[Measured, spike S6, 2026-11-21]**: with `ENABLE_STORAGE` (documents without fillable fields) `{ noView: true }` plus a page re-render removes it from the canvas and `remove()` of the entry brings it back exactly; with `ENABLE_FORMS` (forms being filled) `noView` has no effect, so the overlay draws a "to be removed" strike-through box over it instead. In both modes `pdfOverlay.js` hides the annotation layer's own `section[data-annotation-id]` element, which pdf.js leaves in place.

**Deletion is not erasure.** With incremental saving the earlier revision, including a removed annotation's text, remains in the file. The first deletion in a session shows this once: "Removed annotations stay recoverable in the file's history. This is not redaction." (§15.)

### 8.7 Overlay

`pdfOverlay.js` draws the state over each rendered page as SVG in page coordinates (highlights as Multiply-blended polygons, ink as paths, a comment marker), rebuilt from `pdfState`. It is an approximation of the final appearance streams; what other readers show is what pdf.js writes at save, checked at the gates (plan Gate P3).

---

## 9. Special content, limits and errors

### 9.1 Encrypted files

pdf.js asks through `onPassword`; the webview shows a password box in the page area (masked input, "Incorrect password" on retry, Cancel → error view with "Open externally"). The password is held only in webview memory for the life of the tab; it is not sent to the host, logged or stored. Files that open with an empty user password open without a prompt. **[Measured, spike S7, 2026-11-21]** `onPassword` is called with reason 1 (`NEED_PASSWORD`) and then 2 (`INCORRECT_PASSWORD`) on each wrong attempt; cancelling rejects the loading task with `PasswordException` "No password given". All encrypted files are view-only (`encrypted`): the strict reader does not decrypt, and permission bits would need a policy (Q6).

### 9.2 Digital signatures

`getSignatures()` supplies signer name, reason, location and time, the filter/sub-filter, the byte range, `coversWholeDocument` and `modificationsAfterSignature` (true/0 before our save, false/1 after it) **[Measured, spike S7, 2026-11-21]** for the notice and the properties dialog, always labelled "not verified" — no certificate chain or digest is checked in v1. A signed file can be edited. The first time Edit is turned on: "This PDF is digitally signed. Changes are added after the signed content, which stays intact, but readers will report that the document was changed after signing, and a certified document may show as invalid." Signed bytes are preserved by PV1.

### 9.3 Limits **[Measured, spike S4, 2026-11-21 — limits unchanged, memory budget restated]**

| Condition | Result |
|---|---|
| File > 500 MB | Refuse to open (error view, "Open externally"). |
| File > 150 MB | Opens with a "large file" notice; thumbnails are not pre-rendered. |
| File > 100 MB, or > 20,000 pages | View-only (`too-large`). |
| Strict reader caps: > 5,000,000 cross-reference entries; object nesting > 200; a `/Prev` chain longer than 2,000 revisions or with a cycle; an object stream inflating to > 64 MB; a dictionary > 4 MB of tokens | Not editable (`unsupported-structure`). |
| Writer result larger than the loaded size + 64 MB | Save fails verification. |

Performance budgets on the reference machine, with what S4 measured in VS Code 1.147 (image-heavy synthetic files; occlusion throttling disabled for the run; the machine was in normal use, so times are upper estimates):

| Budget | Measured | |
|---|---|---|
| First page visible ≤ 1 s for a 10 MB file | 0.59–0.78 s from `resolveCustomEditor` (transfer 0.09–0.14 s) | pass |
| First page ≤ 3 s for 100 MB | 1.39–1.76 s (transfer 0.86–1.06 s); 300 MB: 3.85 s (transfer 3.0 s) | pass |
| No frame over 100 ms while scrolling a 500-page document | at 3,000 px/s: median 8.3 ms, p99 17 ms, max 75 ms; at 12,000 px/s: p99 33 ms, max 50 ms; none over 100 ms | pass |
| Placeholders ≤ 300 ms | after a scrollbar jump the visible pages were rendered in 102 ms median, 152 ms max (12 jumps). During continuous scrolling the probe recorded no samples, so that part is not measured | pass (jumps only) |
| Save of a 100 MB file ≤ 4 s end to end | writer service 1.79 s: `getData` 0.22, fresh open 0.13, `saveDocument` 0.26, read-back 0.13, transfer to host 1.06; plus host prefix compare 29 ms and SHA-256 148 ms. Disk write and PV2–PV6 not included (they work on the appended ~1 KB and the superseded objects). 50 MB: 1.0 s; 10 MB: 0.19 s | pass |
| Host verification ≤ 0.5 s | prefix compare of 100 MB: 29 ms; parsing a 357,040-entry classic cross-reference table and checking every `N G obj` header: 31 ms | pass, on one condition (below) |
| Turning Edit on ≤ 2 s per 100 MB | not measured end to end (the strict reader does not exist yet); see the condition below | open |
| Webview memory ≤ 3 × file size + 300 MB | **viewing: about 1 × file size + 200 MB** (100 MB file: 297 MB working set; 300 MB file: 498 MB). **During a save the webview process peaks at about 8 × file size + 180 MB** (10 MB: 295 MB; 50 MB: 543 MB; 100 MB: 975 MB), falling back afterwards | viewing passes; save peak does not |

Decisions from S4:

- **Limits stay as in the table above.** Times are well inside budget at the 100 MB edit limit.
- **Memory budget restated:** viewing ≤ 1.5 × file size + 300 MB; transient peak during save ≤ 9 × file size + 300 MB in the webview process. The plan's stated fallback (lower the limits proportionally) would put the edit limit near 25 MB to keep the old 3 × figure at save time; that was judged too low for a transient peak, but it is the alternative if a hard memory ceiling is preferred (`core/limits.ts` is one constant). **This is a judgement call for the user to confirm.** The writer service must release each copy as early as it can (destroy the fresh document before the read-back, transfer buffers instead of cloning); the spike's writer did not, so 8 × is an upper figure.
- **Other processes also grow with the file**, because webview messages pass through the workbench window and the extension host keeps `base`: for a 300 MB file the extension host grew by about 2 × file size and the workbench renderer peaked about 2 × file size higher during transfer. This is why the refuse limit stays at 500 MB.
- **The strict reader must be lazy.** A throwaway tokeniser over every object of a 107 MB file with 357,039 small objects (12.1 million tokens) took 7.7 s (8.1 s when yielding every 30 ms, 246 slices); image-heavy files of 100–300 MB took 1–4 ms because stream bodies are skipped by `/Length`. `classify` and `verify` therefore read the cross-reference chain and only the objects they need (catalog, page tree, annotations, AcroForm fields, superseded and new objects); they never scan the whole body. Under that rule the 2 s per 100 MB budget for Edit is expected to hold **[Assumption — check in PWP-14 and PWP-16]**.

Host-side work over 2 MB yields to the event loop every ~30 ms.

### 9.4 Error and special-case UX

All load problems render the shared error view (`loadError`) with a plain explanation, "Open externally" and, where sensible, "Retry".

| Case | Detection | Message |
|---|---|---|
| Empty file | size 0 | "This file is empty." |
| Not a PDF | no `%PDF-` in the first 1,024 bytes | "This file isn't a PDF." |
| Too large | §9.3 | "This file is too large to open here (N MB)." |
| Damaged | pdf.js `InvalidPDFException` or any load rejection | "This file is damaged and can't be displayed." with the technical reason under "Details". pdf.js's own recovery of broken cross-references is allowed for *viewing*; such a file is not editable. |
| Password needed | `onPassword` | §9.1 |
| A page fails to render | render error | That page shows "This page couldn't be displayed"; the rest of the document works. |
| Viewer engine can't start | §10.4 | "The PDF viewer needs a newer version of VS Code." |
| Save: file in use / locked | write error (shared mapping) | "Couldn't save: the file is in use by another program. Close it there and save again, or use Save As." Stays dirty. |
| Save: other failure | write error | Shared wording, incl. "The file on disk may be incomplete." Stays dirty. |
| Changed on disk | shared conflict check | Overwrite / Revert / Cancel. |
| Verification failure | §6.5 | "Save failed an internal consistency check — your file on disk was not changed." |
| Writer unavailable | §6.6 | "Couldn't save: the PDF engine didn't respond. Your file on disk was not changed. Try again." |

Never dropped: nothing in the loaded file is ever removed or rewritten (PD2). Where an edit cannot be expressed within §6.5 it is refused with a reason.

---

## 10. Theming, accessibility, keyboard

### 10.1 Theming

- All chrome (toolbar, sidebar, find bar, notices, password box, dialogs) uses `--vscode-*` variables and the `body.vscode-*` classes, like the other editors. pdf.js's own CSS variables are mapped onto them.
- **Pages stay as authored**: white paper with the document's colours, on a themed backdrop, as for Word documents (Office §11.1). Pages are not inverted in dark themes. In high-contrast themes each page gets a `--vscode-contrastBorder` outline, and selection, find matches and the focus ring use the theme's highlight tokens.
- Nothing relies on colour alone: annotation colours are named in labels; locked fields and removed annotations carry text.

### 10.2 Accessibility

- pdf.js's text layer plus its structure-tree layer expose tagged PDFs' headings, lists, tables and figure alt text to screen readers; untagged files expose text in content order. This is stated in the README as a property of the file.
- Page containers are `role="region"` with `aria-label="Page N of M"`; the page box and zoom announce changes through the shared polite live region; find announces "3 of 17" and wrap-around.
- Toolbar and sidebar follow the shared patterns (`role="toolbar"` with roving tabindex, `aria-pressed` toggles, accessible names on icon buttons; `tablist`, `tree`).
- Form inputs keep pdf.js's labels (field tooltip `/TU` or name).
- Every action has a keyboard route, with one exception stated in the UI: freehand drawing.
- `prefers-reduced-motion` (no smooth scrolling) and `forced-colors` are honoured.

### 10.3 Keyboard

Common: Ctrl/Cmd+E Edit · Ctrl/Cmd+S save · Ctrl/Cmd+Z / Y undo/redo · Ctrl/Cmd+F find · Ctrl/Cmd+C copy · Esc cancel/close.
View: arrows, PageUp/PageDown, Space/Shift+Space, Home/End (first/last page), Ctrl+= / Ctrl+- / Ctrl+0 zoom, `R` / Shift+`R` rotate view, F4 toggle sidebar, Ctrl/Cmd+G go to page.
Edit: `V` select · `H` highlight selection · `D` draw · `C` comment · Delete remove · Shift+F10 context menu · Tab / Shift+Tab through annotations and form fields in page order.
Single-letter shortcuts are active only while focus is in the page area and not in a text input.

### 10.4 Engine check

Before loading pdf.js the webview checks for the features the pinned build needs **[Measured, spike S2, 2026-11-21]**:

- `typeof Promise.withResolvers === 'function'` (missing below Chromium 119: VS Code 1.85–1.87 fail here);
- `CSS.supports('width', 'round(down, 10.5px, 1px)')` (missing below Chromium 125: VS Code 1.88–1.94 render pages but the text layer is misplaced, so selection, find highlights and text-anchored highlights would be wrong);
- `typeof WebAssembly === 'object'`, `typeof OffscreenCanvas === 'function'`, and a module `Worker` created from a blob (constructed in a `try`; all present in every build tested, kept as a safety net).

If one is missing it posts the facts and shows the "needs a newer version of VS Code" error view; nothing else in the extension is affected.

**Measured minimum: VS Code 1.95** (October 2024; Electron 32.2.1, Chromium 128). Tested with the full S1 set (seven files, real worker, zero CSP violations, same find counts as current): 1.85.2 and 1.87.2 fail to load; 1.88.1, 1.89.1, 1.90.2, 1.92.2 and 1.94.2 fail the text-layer check; 1.95.3, 1.96.4, 1.97.2, 1.98.2, 1.99.3 and 1.100.3 pass, with text spans within 2 px of VS Code 1.147. 1.91 and 1.93 were not run; they sit between two failing releases on the same Chromium (122 and 124). By Q7 (b), `engines.vscode` and `@types/vscode` become `^1.95.0` in PWP-02 and the README states it. Features that are absent in 1.95 and did not matter: CSS `sign()`, `Error.isError`, `RegExp.escape` (also absent in 1.100, which passes).

---

## 11. Settings, telemetry, privacy

Settings: §4.1. Telemetry: none. Nothing about a document leaves the machine; diagnostics contain check ids and object numbers only. Workspace Trust: the viewer works in untrusted workspaces (it executes nothing from the workspace or the file); declare this in the README.

---

## 12. Security

PDF files are untrusted input, and PDF is a more hostile format than OOXML: it can carry scripts, launch actions, embedded files and malformed structures aimed at parsers.

- **CSP** **[Measured, spike S1, 2026-11-21]** — final, after removing each directive in turn on seven files (`basic`, `cjk`, `base14`, `jpx-jbig2`, `chrome`, `annotated`, `forms`) in VS Code 1.147; with it every page renders in a real dedicated worker, with zero `securitypolicyviolation` events and zero requests outside the webview resource origin:
  `default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};`
  - Removed from the earlier target because the result was identical without them (same canvas hashes, no violations): `'unsafe-inline'` in `style-src` (pdf.js styles through the CSSOM; our own webview code must do the same — no `style=""` attributes and no injected `<style>`), `blob:` in `img-src`, `blob:` and `data:` in `font-src` (embedded fonts are loaded through `FontFace` from buffers, which `font-src` did not block). The webview reports any `securitypolicyviolation` to the host log (`pdfLog`, §5: written to the extension's output channel "VS Code MD Editor", at most 50 lines per document load, never a toast) so that a file outside the tested set which needs one of them is noticed at Gate P1 rather than silently degraded; re-adding a source is then a one-line change. The earlier, wider target also passed and is the fallback.
  - `style-src ${cspSource}`: `pdf_viewer.css` and our stylesheets. `img-src ${cspSource}`: `loading-icon.gif` and the annotation icons of `pdf_viewer.css`; `data:`: needed by the forms fixture. `font-src ${cspSource}`: the standard-font substitutes (`LiberationSans` for the base-14 file).
  - `'wasm-unsafe-eval'`: the JPEG 2000, JBIG2 and colour-management decoders (without it the JPX/JBIG2 file fails; the `*_nowasm_fallback.js` decoders cannot load under this policy and are not shipped). No `'unsafe-eval'`; pdf.js needs none **[Verified: no `eval`/`new Function` in the build]**.
  - `worker-src blob:`: the worker is created from a blob made of the worker file's text, and handed to pdf.js through `workerPort` (so pdf.js's silent main-thread fallback can be detected and reported instead of hidden: it is logged to the same output channel as a `worker-fallback` line, and a page that fails to render as `page-render-failed`).
  - `connect-src ${cspSource}`: `fetch` **from the main thread** of the worker text, CMaps, standard fonts, ICC profile and wasm from the extension's own `media/pdfjs/` (`useWorkerFetch: false`, §3.1). `webview.cspSource` serves only `localResourceRoots` (= `media/`), so this grants no network access. No other origin is listed anywhere.
  - No `frame-src`, no `object-src`, no `form-action`.
- **No script execution from documents.** `pdf.sandbox` and `quickjs-eval` are not shipped; `PDFScriptingManager` is never constructed; `enableScripting` stays `false`. Document, page, field and annotation JavaScript actions are inert. Their presence is a notice.
- **No XFA rendering** (`enableXfa: false`): XFA is turned into HTML from document content; the attack surface is not worth it for a format Adobe has deprecated.
- **No network.** Range/stream loading is off (`disableRange`, `disableStream`, `disableAutoFetch`); the document arrives as bytes from the host. Remote resources referenced by a file cannot load under the CSP.
- **Links and actions**: §7.5. Launch, GoToR, SubmitForm, ImportData and JavaScript actions are never followed.
- **Attachments**: listed, saved only through an explicit Save dialog, never opened or executed.
- **HTML construction**: our webview code builds DOM with `createElement`/`textContent`; no `innerHTML` with document-derived strings in any `media/pdf*.js`. pdf.js's own layers are its responsibility and are contained by the CSP.
- **Webview → host**: all messages validated (§5). The outline, field names, signer names and attachment names are document-derived strings: the host treats them as text only and never as paths; an attachment's suggested file name is reduced to its base name.
- **Saved bytes come from the webview** and are therefore untrusted: §6.5 PV1–PV6. Even a fully compromised renderer can at worst append a revision that passes the allow-list and the inert check; it cannot alter the original bytes, and the original is recoverable from any saved file by truncating it at the previous length.
- **Host parsing** is limited to `sniff` at open and the strict reader at first Edit and at save, both bounded (§9.3). No third-party PDF parser runs in the extension host.
- **Passwords** stay in the webview (§9.1).
- **pdf.js security updates** are applied through the upgrade procedure of §13.6; the pinned version is recorded in `THIRD-PARTY-NOTICES.md`.

---

## 13. Testing strategy

### 13.1 Harness

- Core: `tests/pdf/*.test.mjs` through the test bundle `tests/.build/pdf-core.cjs` (same mechanism as the Office core; hence no `vscode` import under `core/`).
- Writer contract tests load `pdfjs-dist/legacy/build/pdf.mjs` **in Node** and run adapter → `saveDocument()` → verifier end to end. This works under Node ≥ 22.13 **[Verified on 24.13: form value and annotation saved incrementally; pdf.js warns that it has no canvas, so text appearance streams may differ from the webview's]**; on older Node these tests skip with a visible message. Structure, prefix identity and the verifier are asserted here; appearance fidelity is a gate item.
- Webview modules: pure ones (`pdfViewMath.js`, geometry) are UMD and required directly; DOM behaviour uses the `node:vm` shim with a stubbed `PdfjsBundle`.
- Provider logic: the shared `_vscodeStub.cjs` approach.
- Nothing automated runs pdf.js inside a real webview. CSP, rendering, the worker and the password flow are human gate items, prepared by the spike extension's self-reporting runs (plan PWP-01).

### 13.2 Guarantees (the definition of "not corrupting")

| Id | Guarantee | Test |
|---|---|---|
| PG0 | A document with no edits is never dirty; Save and Save As with an empty state write the loaded bytes. | Byte comparison, every fixture. |
| PG1 | **Prefix identity**: every saved file starts with the exact loaded bytes. | Every operation × every editable fixture. |
| PG2 | **Undo identity**: any edit sequence that returns the state to empty saves byte-identically to the loaded file, including after intermediate saves. | Per operation; seeded random sequences of 200 operations. |
| PG3 | **One revision, minimal touch**: exactly one appended revision; superseded objects are within the allow-list for the operation, with only the allowed keys changed. | PV2–PV4 asserted per operation with the expected object set. |
| PG4 | **State-determined output**: equal states produce identical bytes (possibly excepting the trailer's second `/ID` element **[Assumption]**). | Write twice, compare. |
| PG5 | **Inert**: a save never introduces actions, scripts or embedded files. | PV5, plus negative tests feeding the verifier tampered increments. |
| PG6 | **Semantic validity**: independent readers open the result and see the intended annotations and values, the same page count and the same text on untouched pages. | pdf.js (Node), PDFium (WASM), `@cantoo/pdf-lib`; optional `qpdf --check`. |

The verifier itself is tested negatively: hand-built increments that change a byte of the prefix, point `/Prev` elsewhere, add a second revision, supersede a content stream, change `/Contents` or `/MediaBox` of a page, add `/OpenAction`, add an annotation with `/A`, or use an object stream MUST each fail the named check.

### 13.3 Fixtures (`tests/fixtures/pdf/`, committed, marked binary; README with one line per file)

Generated by script (`scripts/pdf-fixtures/`), deterministic: `basic.pdf` (text, two pages, classic xref table) · `xref-stream.pdf` (object and cross-reference streams) · `multi-revision.pdf` (three incremental revisions) · `outline.pdf` (nested bookmarks, named destinations, internal and external links, a `javascript:` and a Launch link) · `forms.pdf` (text incl. multiline/MaxLen/comb/read-only, checkbox, radio group, dropdown, list, a signature field) · `forms-js.pdf` (calculation and format scripts) · `annotated.pdf` (existing Highlight, Underline, Text note, Ink, FreeText, Link, each with Popup where applicable) · `rotated.pdf` (pages with `/Rotate` 90/180/270, mixed sizes, crop boxes) · `attachments.pdf` · `encrypted-user.pdf`, `encrypted-owner.pdf` (password `test`) · `scanned.pdf` (image-only pages) · `cjk.pdf` (non-embedded CJK font, exercises CMaps) · `base14.pdf` (non-embedded standard fonts) · `jpx-jbig2.pdf` (exercises the wasm decoders) · `tagged.pdf` (structure tree) · `js-openaction.pdf` (document-level script that would be visible if run) · `truncated.pdf`, `not-a-pdf.pdf`, `empty.pdf`, `broken-xref.pdf` (viewable through pdf.js recovery, not editable) · `hybrid-xref.pdf` · `large.pdf` (2,000 pages) — and `huge.pdf` (over the edit limit) generated in test setup, not committed.

From real producers: `word.pdf` (Word "Save as PDF" through COM, tagged) · `chrome.pdf` (Edge/Chrome headless `--print-to-pdf`) · `signed.pdf` (signed in test setup with a throwaway self-signed certificate) · and, supplied by the user (listed `PENDING` until they arrive): `acrobat-forms.pdf`, `acrobat-annotated.pdf`, `acrobat-signed.pdf`, `certified.pdf` (DocMDP no-changes), `linearized.pdf`, `xfa.pdf`, `scanner.pdf`, `latex.pdf`, and ten everyday PDFs of the user's choosing for the spike corpus (not committed).

### 13.4 Verifying in real readers

1. **Automated, in `npm test`**: PG6 with pdf.js, PDFium and `@cantoo/pdf-lib` over every file the edit tests write to `tests/.out/pdf/`.
2. **Scripted, before each release PR** — `scripts/verify-pdf-open.mjs`: the same three readers plus `qpdf --check` when `qpdf` is on `PATH` (recommended, not required); renders page 1 of each output with PDFium to `tests/.out/pdf/png/` for eyeballing. Recorded in `log.md`.
3. **Manual checklist** (plan §9 and the gate checklists; human): open edited outputs in Adobe Acrobat Reader, Edge, Chrome, Firefox and, if available, macOS Preview: no error or repair message, **no "save changes?" prompt when closing in Acrobat** (its sign that it repaired the file), highlights/ink/comments present and editable, form values shown, signed fixture reports "changed after signing" rather than "invalid". Acrobat Reader has no automation interface; this cannot be scripted.

### 13.5 Viewer checks

Per fixture: opens to a correct view or the specified error view; no CSP violations in the webview console; no network request; the document is not dirty. Theme sweep (light, dark, both high-contrast), keyboard-only walkthrough, screen-reader spot check (Narrator or NVDA) on `tagged.pdf`. These are Gate P1 items.

### 13.6 Upgrading pdf.js

The pin moves only through: update the exact version → `npm test` (adapter contract and PG suites catch a changed storage format or writer behaviour) → re-run spike S1's CSP page and the Gate P1 smoke subset in a dev host → update `THIRD-PARTY-NOTICES.md`. A pdf.js security release is treated as a hotfix.

---

## 14. Phases and acceptance criteria

v1 is Phases 0–4. Phase 1 is a release point on its own (viewer first).

**Phase 0 — spikes and scaffolding** (no user-visible feature). Accept when the spike report in `log.md` answers S1–S8 (plan PWP-01) with evidence and this spec is updated where an assumption failed; dependencies, bundles and fixtures are in place.

**Phase 1 — viewer.** Deliver §7, §9 (viewing parts), §10, §12; provider registered as default for `*.pdf`. Accept when: every fixture opens to a correct view or the specified error view and none throws; `outline`, `forms` (read-only), `annotated`, `rotated`, `cjk`, `jpx-jbig2`, `encrypted-*`, `scanned` render correctly against Chrome side by side; find, copy, links, sidebar, zoom and rotation work; no CSP violation and no network request for any fixture; `js-openaction.pdf` runs nothing; scrolling `large.pdf` meets §9.3; themes, keyboard and screen-reader checks logged; no file is ever written and no document is ever dirty.

**Phase 2 — edit core** (flags off). Deliver the shared base extraction, §6 in full, the strict reader, the adapter, the writer service and the verifier, with highlight as the first operation end to end behind the flag. Accept when: PG0–PG6 pass for highlight add/remove on every editable fixture; every negative verifier test fails the named check; the Office suite is unchanged and green after the extraction; save, Save As, revert, hot exit, conflict, locked file and verification failure (test hook) are exercised in a dev host and leave the disk file untouched on failure.

**Phase 3 — annotations.** Deliver §8.2–8.4, §8.6, §8.7. Accept when: PG0–PG6 pass for each operation; the Gate P3 reader checklist passes; flag `pdfEdit` flipped.

**Phase 4 — forms.** Deliver §8.5. Accept when: PG0–PG6 pass for each field type on `forms.pdf` and `acrobat-forms.pdf`; locked, XFA and scripted cases behave as specified; filled values display in Acrobat, Chrome and Firefox without a repair prompt; flag `pdfForms` flipped.

**Post-v1** (recommended order): free text · **Organise pages → export to a new PDF** (rotate, delete, reorder, extract, insert from another PDF; candidate engine pdf.js `extractPages`, which exists in 6.5.438 **[Verified in the API typings; behaviour not evaluated]**; always a new file, never in place, so byte-identity and signatures are not in question and "deleted" pages are really absent) · standalone notes, underline, strikeout (own object writer on top of the strict reader) · metadata · editing encrypted files · signature verification · printing · range loading for very large files · PDF files in wikilinks and the graph (`[[paper.pdf]]`, mirroring Office Phase 8).

---

## 15. Explicit non-goals for v1 (consolidated)

Editing page content (text, images) — PDF has no paragraph model; content streams position glyphs individually and fonts are subsetted, so "edit the text" is a research-grade feature, not a basic one · **redaction** — hiding is not removing, and incremental saving keeps old revisions; offering it would be a security promise the design cannot keep · OCR · flattening annotations or forms into page content · creating, certifying or validating digital signatures · stamps, images, shapes, free text, sticky notes, underline, strikeout · moving or resizing annotations · page operations and saved rotation · metadata editing · changing or removing passwords; editing encrypted files · running PDF JavaScript; XFA forms · creating new PDFs; converting to or from other formats · compression, linearisation, PDF/A · printing · web (browser) extension host.

---

## 16. Assumptions, open questions and risks

### 16.1 Assumptions not verified (owner: Phase 0 unless noted)

1. ~~pdf.js's worker starts and renders under the §12 CSP in a VS Code webview with the worker supplied through `workerPort` from a blob; wasm decoders, CMaps, standard fonts and embedded fonts load without CSP violations (S1).~~ **Confirmed by S1**, with `useWorkerFetch: false` and a tighter CSP (§12).
2. ~~The legacy build bundles into an IIFE with esbuild (S1).~~ **Confirmed by S1** (702 KB minified). The bundle contains pdf.js's never-called `import()` loader for the scripting sandbox; the sandbox file is not shipped.
3. ~~The minimum VS Code version on which the pinned build runs (S2).~~ **Measured by S2: 1.95** (§10.4).
4. ~~`PDFViewer` and `GenericL10n` run without the full pdf.js viewer application and without fetching locale files (S1).~~ **Confirmed by S1**, provided no `l10n` object is passed to `PDFViewer`.
5. pdf.js's incremental output for our three operation kinds, on every editable fixture and the user's corpus, opens in Acrobat Reader, Edge, Chrome, Firefox and Preview without repair; and the objects it supersedes fit an allow-list as tight as PV4 describes (S3). **Partly confirmed by S3:** the allow-list is tighter than first written (§6.5), and PDFium, `@cantoo/pdf-lib`, pdf.js under Node and `qpdf --check` accept all 145 outputs of the synthetic fixtures. **Still open:** the openings in Acrobat Reader, Edge, Chrome and Firefox (checklist `spike/pdf/out/for-user/CHECKLIST.md` on branch `spike/pdf-viewer`), the user's own corpus, and Word- and Acrobat-produced files, none of which were available to the spike.
6. ~~Its output is deterministic given dates from the state, apart possibly from the trailer `/ID` (S3).~~ **Corrected by S3:** also the `/M` of rewritten widgets varies (§6.4).
7. Highlights and ink written by pdf.js look the same in Acrobat, Chrome, Firefox and Preview (S5). **Confirmed for PDFium only** (Chrome's engine: five colours translucent over text, ink colour and width right); the other readers are on the user checklist.
8. ~~The `noView` hook hides an existing annotation after a page re-render inside `PDFViewer`; form inputs report changes in a way `pdfForms.js` can observe; values can be written back on undo (S6).~~ **Partly confirmed by S6:** forms yes; `noView` only in `ENABLE_STORAGE` mode, which has no form inputs — hence the two viewer modes of §8.5 and the overlay fallback of §8.6.
9. A signed, non-certified file plus our revision is reported by Acrobat as "signed, with later changes"; a certified no-changes file as invalid or disallowed (S7). **Still open** (needs Acrobat; files 11 and 12 of the user checklist). pdf.js itself reports `modificationsAfterSignature: 1` for both.
10. ~~XFA presence, JavaScript presence and signatures can be obtained in the webview for notices without enabling XFA rendering (S7).~~ **Confirmed by S7** (§7.6: not through `hasJSActions()`).
11. ~~The limits and budgets of §9.3 (S4).~~ **Measured by S4** (§9.3): times pass, the memory budget is restated, the Edit-on budget waits for the real reader.
12. Extracting `BinaryDocumentBase` from `officeDocument.ts` is behaviour-preserving for Office (plan PWP-13; the Office test suite is the check).
13. VS Code webviews cannot host Chromium's PDF plugin (not relied upon; stated only as a rejected alternative).
14. Shipped size ≈ 5.2 MB (measured by PWP-02).
15. Adobe Acrobat Reader is available on the gate machine; desktop Word and Edge are (Office spec §16 item 10).

### 16.2 Open questions for the user

**Answered by the user on 2026-11-21:**

| Q | Decision |
|---|---|
| Q1 | (b) annotations (highlight, comment on a mark, ink, delete) **plus** AcroForm form filling |
| Q2 | (a) viewer-only release after Gate P1; editing follows behind flags |
| Q3 | (a) no page operations in v1; post-v1 as "Organise pages → save as a new PDF" |
| Q4 | (a) default editor for `.pdf` (`priority: "default"`) |
| Q5 | (a) real, removable annotations only; no flattening |
| Q6 | (a) signed files editable with a warning; password-protected files view-only |
| Q7 | **(b) raise the minimum VS Code version for the whole extension** to the version spike S2 measures — **1.95** (§10.4) — (`engines.vscode` and `@types/vscode` bump to `^1.95.0` in PWP-02). The §10.4 feature check stays as a safety net. This is the only answer that differs from the recommendation. |
| Q8 | (a) merge the Office viewer and save PRs first; PDF Phase 0 (spikes, scaffolding, fixtures) runs in parallel |

The questions as asked are kept below for the record.

**Q1. Which editing features are in v1?**
(a) Annotations only: highlight, comment, ink, delete.
(b) **Recommended:** (a) plus filling form fields.
(c) (b) plus free text and "organise pages" export.
*Trade-off:* (a) saves about three working days but leaves out the most common reason people want to edit a PDF. (c) adds about two weeks and the two riskiest features (font-dependent text appearance; whole-file rewriting).

**Q2. Ship the viewer on its own first?**
(a) **Recommended:** yes — release after Gate P1, editing follows behind flags.
(b) No — one release when editing is done.
*Trade-off:* (a) gets a useful viewer out about two weeks earlier and gathers real-file feedback before the editing gates; it means one extra release cycle.

**Q3. Page operations (rotate and save, delete, reorder, merge, extract)?**
(a) **Recommended:** not in v1; afterwards as "Organise pages → save as a new PDF".
(b) In v1, in place.
(c) In v1, as export to a new file.
*Trade-off:* in-place page changes cannot be done as an append-only update with the chosen writer, would break every signature, and leave "deleted" pages recoverable in the file. Export to a new file avoids all three but is a separate feature of roughly 1.5 weeks.

**Q4. Become the default editor for `.pdf`?**
(a) **Assumed (as for Office):** yes, `priority: "default"`.
(b) Offer it under "Open With…" only (`priority: "option"`).
*Trade-off:* PDF viewer extensions are very widely installed; with (a) users who have one get a "which editor?" prompt once. (b) is invisible until chosen.

**Q5. Annotations as real, removable annotations — or flattened into the page?**
(a) **Recommended:** real annotations only (other readers can edit and remove them; the original content is untouched).
(b) Also offer "flatten on save" later.
*Trade-off:* flattening rewrites page content and cannot be undone or verified by prefix comparison; it is listed as a non-goal unless you want it.

**Q6. Signed and password-protected files?**
(a) **Recommended:** signed → editable with a warning (signed bytes stay intact; readers report "changed after signing"); password-protected → view only.
(b) Signed → view only as well.
(c) Also allow editing password-protected files (about one more week: the verifier must decrypt, and permission bits need a policy).

**Q7. Minimum VS Code version?** The PDF engine needs a newer VS Code than the extension's current minimum (1.85); the exact version is measured in the first spike.
(a) **Recommended:** keep the extension's minimum; on older VS Code the PDF viewer shows "needs a newer version of VS Code" and everything else works.
(b) Raise the minimum for the whole extension.

**Q8. Order relative to the Office work?** PDF reuses the Office toolbar/notices code (viewer) and save/undo code (editing), which are not merged to `develop` yet.
(a) **Recommended:** merge the Office viewer and save PRs first; the PDF spikes, scaffolding and fixtures run in parallel meanwhile.
(b) Start PDF now by branching from the Office branches (faster start, but the PDF PRs cannot merge until Office does, and rebases are likely).
(c) PDF first, with its own copies of the shared code, merged later (duplication of the most delicate code; not recommended).

### 16.3 Risks

- **The writer runs in the webview.** A save depends on a live webview and on bytes produced outside the host. Mitigations: host-side verification that proves the original is untouched and the addition is minimal and inert; the materialised cache; fail-safe behaviour when the engine does not answer. Residual: a rare "couldn't save, try again".
- **Coupling to pdf.js internals** (viewer components, storage-entry format). Mitigations: exact pin, adapter contract tests in Node, a written upgrade procedure. Residual: a pdf.js security release can cost a day of adaptation.
- **Own strict reader** is new parsing code in the host. Mitigations: it never writes; bounded; refuses on anything unusual; negative tests. Residual: some valid-but-unusual files are view-only.
- **PV4's allow-list may prove too tight or too loose** once real files are measured (tagged PDFs make pdf.js update the structure tree). The spike sets it from evidence; a file outside it is view-only rather than loosely verified.
- **Forms without scripts**: calculated and formatted fields will be wrong after filling. Mitigated by a notice; inherent without a script engine, which is deliberately absent.
- **Appearance differences** between our overlay and the saved result, and between readers. Mitigated by gate checks; the overlay is declared an approximation.
- **Files grow** by one revision per editing session and deleted annotations remain in history. Stated in the UI and README; "organise pages → new file" later doubles as a way to write a clean copy.
- **Memory**: the file is held by the host, the webview and the worker, and twice more during a write. Limits in §9.3.
- **Extension size** grows by about 5 MB.
- **Becoming the default `.pdf` editor** collides with popular viewer extensions (Q4).
- **Minimum VS Code version** for this feature is above the extension's (Q7).
- **Dependency on unmerged Office work** (Q8).
