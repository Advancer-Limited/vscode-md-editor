# Office Viewers — Word (.docx) and Excel (.xlsx) viewing with basic editing

Status: Approved for implementation (user decisions Q1–Q7 recorded in §16) · Date: 2026-11-20 · Branch: `feature/office-viewers`
Audience: the user (decisions, risks) and the implementing agents (everything else). The work is sliced into tasks in `docs/office-viewers-plan.md`.

Conventions used here: **MUST / MUST NOT** are requirements. "**[Verified]**" means checked against the published package or this repo on the date above. "**[Assumption]**" means not verified; each one is collected in §16 and most are closed by the Phase 0 spike.

---

## 1. Summary of decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Preservation strategy (both formats) | **Patch the original OOXML package.** Unchanged ZIP entries are copied as raw bytes (not recompressed). Inside a touched XML part, only the targeted element is rewritten; the rest of the part's text is byte-identical. No parse/serialise library ever owns the file. |
| D2 | ZIP | Own small OPC container reader/writer (`src/office/core/zip.ts`) using **fflate 0.8.x** (MIT) only for raw inflate/deflate (fflate 0.8.3 exports no CRC-32; `zip.ts` carries its own table-driven `crc32`). |
| D3 | XML | Own **lossless XML tree** (`src/office/core/xml.ts`): every node remembers its exact source slice; `serialize(parse(x)) === x`. Rejects `<!DOCTYPE` outright. No XML dependency at runtime. |
| D4 | Word rendering | **docx-preview 0.4.x** (Apache-2.0) + **JSZip 3.10.x** (MIT option of its dual licence), in the webview. |
| D5 | Word editing | Host-owned block/segment model over `word/document.xml`; the webview edits **one paragraph at a time** ("edit island") inside the docx-preview output. Mapping from rendered DOM to source paragraphs is by marker bookmarks injected into a **render-only copy**. |
| D6 | Excel rendering | Own virtualised DOM grid in the webview, fed windows of cells by the host. Display strings produced in the host with **numfmt 4.x** (MIT). |
| D7 | Excel editing | Host patches `sheetN.xml` / `workbook.xml` directly. Edited strings are written as **inline strings**; `sharedStrings.xml` is never modified. `styles.xml` is modified in exactly one way: appending a date cell format when a date is typed into a General cell (§9.3.1). Formula tokenising/reference shifting with **@borgar/fx 5.x** (MIT). No calc engine. |
| D8 | Editor model | Two `CustomEditorProvider<OfficeDocument>` registrations (binary custom documents), `priority: "default"`, one webview per document. Undo/redo through `onDidChangeCustomDocument` edit events. Backup = fully serialised package. |
| D9 | Where code runs | All parsing, patching, formatting and saving in the **extension host**. Webviews render and collect input only. |
| D10 | Default mode | Files open in **View** mode. Editing requires an explicit **Edit** toggle. A file is never dirtied by looking at it. |
| D11 | Save safety | Every save is **verified in memory before any byte is written** (re-read own output, CRC every entry, re-parse every touched part). Verification failure aborts the save and leaves the file on disk untouched. |

Rejected outright (reasons in §3): ExcelJS, SheetJS CE, `docx` (for editing), mammoth (for viewing), contenteditable over the whole rendered document, HyperFormula.

---

## 2. Context and constraints from this repo

- Extension host code is bundled by esbuild from `src/extension.ts` to `dist/extension.js` (CJS, `platform: node`). Webview scripts in `media/` are plain JS loaded directly; vendor UMD files are copied by `scripts/copy-vendor.js` and are **committed** (see `.gitattributes`).
- Webview assets MUST carry `?v=${Date.now()}` on script and CSS URIs, a per-load nonce (`getNonce()` in `src/utils.ts`), and a `default-src 'none'` CSP. Pattern: `src/gltfEditorProvider.ts` `getHtmlForWebview`.
- **Correction to the brief:** `GltfEditorProvider` is a `CustomTextEditorProvider` over the JSON text of `.gltf`; `.glb` is explicitly out of its scope. It is the right precedent for registration, HTML/CSP/cache-busting and toolbar markup, but **not** for binary documents. The Office editors are this repo's first `CustomEditorProvider` (binary) and need their own save/undo/backup design (§6). None of the `applyingEdits` / `lastAppliedText` / `editAck` machinery applies.
- Message protocols are discriminated unions in `src/types.ts`. Office messages go in a new `src/office/protocol.ts` (the unions are large) and are re-exported from `src/types.ts` under a new "Office Viewer Types" banner.
- Tests run with `node --test "tests/**/*.test.{js,mjs}"`; `.mjs` tests import a single TypeScript source file directly (Node strips types). That only works for modules with no relative imports, because sources import siblings as `./x.js`. The Office core is multi-module, so it is tested through a bundle (§13.1).
- No CI runs tests (only `.github/workflows/cla.yml`). Playwright is not a devDependency. Webview JS is verified with a `node:vm` DOM shim (precedent: `tests/findBar.test.js`).
- `engines.vscode` is `^1.85.0`; the extension has `main` only (desktop/remote extension host, no web extension).
- Project rules: `todo.md` and `log.md` MUST be maintained by the implementers; work goes through `feature/*` → `develop` PRs with self-review.

---

## 3. Library decisions

Sizes are of the published files on 2026-11-20 **[Verified]** unless marked.

| Library | Version | Licence | Runs in | Size | Used for |
|---|---|---|---|---|---|
| fflate | 0.8.3 | MIT | host | ~9 KB minified (inflateSync/deflateSync) | raw DEFLATE |
| docx-preview | 0.4.1 | Apache-2.0 | webview | 75 KB (`dist/docx-preview.min.js`, UMD, global `docx`) | Word rendering |
| jszip | 3.10.2 | MIT OR GPL-3.0-or-later (we take **MIT**) | webview | 98 KB (`dist/jszip.min.js`, global `JSZip`) | required by docx-preview |
| numfmt | 4.1.4 | MIT | host | ~170 KB unminified CJS; 96 KB minified (measured Phase 0 S5) | Excel number-format codes, date serials |
| @borgar/fx | 5.1.3 | MIT | host | ~93 KB unminified; 32 KB minified (measured Phase 0 S5) | formula tokenise/parse, A1 ref parse/stringify (`@borgar/fx/xlsx` entry for file-style refs) |
| mammoth | 1.13.x | BSD-2-Clause | host | est. 0.5–0.8 MB bundled **[Assumption]** | Phase 6 only (Word → Markdown) |
| docx | 9.x | MIT | host | est. 0.5–1 MB bundled **[Assumption]** | Phase 7 only (Markdown → Word) |

All are compatible with an MIT extension. Apache-2.0 (docx-preview) requires shipping its licence/notice: add a `THIRD-PARTY-NOTICES.md` at the repo root listing every vendored/bundled library (it does not exist today; the existing vendored libs should be listed too).

### 3.1 Why "patch the original package" (D1)

The hard requirement is that everything the editor does not understand survives a save unchanged. A parse/serialise library can only write what its object model captured.

- **ExcelJS 4.4.0** (MIT): rewrites the whole workbook from its model. Drops or damages what the model lacks — pivot tables, slicers, most chart/drawing detail, VBA, extLst features, some conditional-format types. Last published 2024-12; 21 MB unpacked. Confidence that it is lossy on round trip: **high**.
- **SheetJS CE** (`xlsx`, Apache-2.0): the Community Edition write path does not write cell styles (styling is a Pro feature), so a save would strip formatting. The npm registry copy is frozen at 0.18.5; current builds are distributed from the vendor's own CDN, which is an awkward supply chain for a Marketplace extension. Confidence on "CE write drops styles": **high**; I did not re-test the current CDN build.
- **docx 9.x** (MIT): a generator. It builds new documents and has a template "patcher", but cannot load an arbitrary document into an editable model. Suitable for Markdown → Word (Phase 7), not for editing.
- **mammoth**: read-only, converts to semantic HTML and deliberately discards layout. Wrong tool for a faithful viewer; right tool for Word → Markdown (Phase 6).

Patching keeps the blast radius of any bug to the element that was edited, and makes the preservation claim testable as a byte comparison (§13.2).

Alternatives considered: full-model libraries above (lossy); `fflate.unzipSync` + `zipSync` recompressing every entry (simpler, but rewrites every byte of the file, loses stored-vs-deflated choices, and is slow on image-heavy documents).

### 3.2 ZIP container (D2)

Own reader/writer because no small library exposes "copy this entry's compressed bytes unchanged", and because the reader is needed anyway for pre-inflation safety checks.

Reader (MUST):
- Locate the End Of Central Directory record, read the central directory. Central-directory sizes and CRCs are authoritative (local headers may defer them to data descriptors).
- Compute each entry's **extent**: from its local-header offset to the next local-header offset in file order (or to the central directory start). The extent therefore includes any data descriptor without parsing it.
- Refuse, with a specific reason (§10.3), when: ZIP64 records are present; any entry is encrypted (general-purpose flag bit 0); compression method is not 0 (stored) or 8 (deflate); two entries share a name (case-insensitive, OPC rule); extents overlap; an entry name contains `..` or is absolute; declared total uncompressed size exceeds the limits in §10.2.
- Inflate lazily, per entry, on first access. Verify CRC-32 on inflate.

Writer (MUST):
- Emit entries in original order. For an **unchanged** entry, copy its extent verbatim and copy its central-directory record verbatim with only the local-header offset field patched. For a **changed** entry, write a fresh local header (no data descriptor, sizes and CRC filled in, UTF-8 flag as original, original DOS timestamp, deflate level 6) and a matching central record. **New** entries are appended after existing ones, timestamp 1980-01-01 00:00 (what Office itself writes). **Removed** entries are omitted.
- Preserve the archive comment.
- Consequence: a forced rewrite with no changes reproduces the input file byte for byte. This is a test invariant (§13.2 G1).

### 3.3 Lossless XML (D3)

A tokenizer plus a light tree. Each element holds: resolved namespace URI + local name, attributes (with their original raw text), children, and `[start, end)` offsets into the part's source string. An unmodified node serialises as its source slice; a modified node serialises itself and recurses, so untouched descendants still emit their slices.

MUST:
- Reject any part containing `<!DOCTYPE` (OOXML never uses DTDs). This removes XXE and entity-expansion attacks by construction. Only the five predefined entities and numeric character references are decoded.
- Match elements by **namespace URI + local name**, never by prefix. When creating elements, use the prefix (or default namespace) that the part's root element binds to the target namespace. If the needed namespace is not bound at the root, the part is not editable (read-only reason `unsupported-xml-layout`).
- Support UTF-8 parts for editing. A UTF-16 part is decoded for viewing and makes the document read-only.
- Preserve the XML declaration, comments, processing instructions, CDATA, attribute order, quote style and whitespace exactly.
- New text is escaped (`&`, `<`, `>`, and `"` in attributes); characters illegal in XML 1.0 (C0 controls other than tab/LF/CR) are stripped from user input before writing.

Alternatives considered: `@xmldom/xmldom` (MIT; re-serialises the entire part, normalising quoting and empty-element forms, so every edit rewrites the whole part); `saxes` (ISC; sound tokenizer, but recovering exact element start offsets from it is fiddly and a tree is still needed); `fast-xml-parser` (lossy on ordering/mixed content).

Risk accepted: this is new parsing code. It is mitigated by the round-trip invariant being trivially testable on every part of every fixture, and by save-time verification (§6.5).

### 3.4 Word renderer (D4)

docx-preview renders pages, section layout, styles, numbering, tables, images, headers/footers, footnotes. It is the highest-fidelity permissively licensed browser renderer. It is not Word: complex floating layout, text boxes, SmartArt, charts, equations and some tab-stop cases will differ. The viewer says so (§7.1 notices).

Facts relied on **[Verified in 0.4.1 source]**:
- UMD build expects a global `JSZip`; exposes `docx.renderAsync(data, bodyContainer, styleContainer, options)`.
- A paragraph-level `w:bookmarkStart` renders as `<span id="{w:name}">` inside the paragraph's `<p>`. This is the mapping hook (§8.2).
- With `breakPages: true`, a paragraph containing a page break is split into **two `<p>` elements**. Ordinal mapping (nth `<p>` = nth `w:p`) is therefore unsafe and MUST NOT be used.
- `w:altChunk` is rendered into an `<iframe srcdoc>` unless `renderAltChunks: false`.
- Hyperlinks become `<a href="{external target}">`.

Pin the exact version in `package.json` (no caret). The marker hook is undocumented behaviour; upgrades go through the Phase 0 mapping test.

Alternatives considered: mammoth (semantic HTML, loses layout); own renderer (large, lower fidelity); LibreOffice/Collabora WASM (tens of MB, MPL/LGPL); rendering through a remote service (privacy).

### 3.5 Excel grid and formatting (D6)

Own grid, DOM-based (accessible, themable, small). Canvas grids and full spreadsheet components (Univer, Luckysheet, x-data-spreadsheet, jspreadsheet CE, Handsontable) were rejected: they bring their own data model, which reintroduces a second source of truth, and they are 0.5–5 MB; Handsontable is not free for commercial use.

No workbook-reading library: the host reads the same lossless trees it patches, so the displayed model and the saved bytes cannot diverge.

---

## 4. Architecture

```
src/office/
  core/                 # NO 'vscode' import anywhere under core/. Pure, node-testable.
    zip.ts              # container reader/writer (§3.2)
    xml.ts              # lossless XML (§3.3)
    opc.ts              # content types, relationships, part graph, main-part discovery
    package.ts          # OfficePackage: entries + lazily parsed parts + dirty-part tracking + serialize()/verify()
    edits.ts            # OfficeEdit, PartChange, apply/invert (§6.3)
    limits.ts           # thresholds (§10.2)
    docx/
      model.ts          # body blocks, paragraph segments, classification (§8.1, §8.3)
      paragraphWriter.ts# rebuild w:p from committed segments (§8.4)
      styles.ts         # heading/list-paragraph style lookup + creation, b/i/u effective resolution
      numbering.ts      # numbering.xml read/create (§8.6)
      renderCopy.ts     # marker injection for the render-only copy (§8.2)
    xlsx/
      workbook.ts       # sheets, defined names, date system, protection
      sheet.ts          # row/cell index over sheetN.xml, cell read/write (§9.2–9.4)
      styles.ts         # styles.xml + theme colours -> StyleDTO
      format.ts         # numfmt wrapper: display strings, input parsing (§9.3)
      refs.ts           # reference shifting over @borgar/fx tokens (§9.6)
      structure.ts      # insert/delete rows/cols, sheet add/rename/delete (§9.6, §9.7)
    index.ts            # barrel; the entry point of the test bundle
  protocol.ts           # message unions + DTOs (§5)
  officeDocument.ts     # vscode.CustomDocument implementation (§6.1)
  officeEditorProviderBase.ts
  docxEditorProvider.ts # viewType vscodeMdEditor.docx
  xlsxEditorProvider.ts # viewType vscodeMdEditor.xlsx

media/
  officeCommon.js / officeCommon.css   # toolbar, banners, notices, theming tokens
  docxEditor.js / docxEditor.css
  docxIsland.js                         # UMD, pure: island DOM <-> segment list (node-testable)
  xlsxEditor.js / xlsxEditor.css
  xlsxGridMath.js                       # UMD, pure: virtualisation, selection, keyboard nav (node-testable)
  docx-preview.min.js, jszip.min.js     # copied by scripts/copy-vendor.js; add to .gitattributes -text
```

The file list above is the architectural shape. `docs/office-viewers-plan.md` refines it (additional modules such as `core/types.ts`, `core/sniff.ts`, `core/save.ts`, `media/xlsxGrid.js`, `media/xlsxCellEditor.js`, `media/docxMap.js`, `media/docxEdit.js`, `src/office/featureFlags.ts`); for file names and ownership the plan is authoritative.

Build changes:
- `package.json` dependencies: `fflate`, `numfmt`, `@borgar/fx`, `docx-preview` (exact), `jszip`.
- `scripts/copy-vendor.js`: two new entries (`docx-preview/dist/docx-preview.min.js`, `jszip/dist/jszip.min.js`).
- `esbuild.js`: no change for the extension build (new host deps bundle automatically). One new context for the test bundle (§13.1).
- `.vscodeignore`: add `docs/**` (this spec must not ship in the VSIX). `THIRD-PARTY-NOTICES.md` MUST ship, so it is not ignored.
- `.gitignore`: add `tests/.build/` and `tests/.out/`.

### 4.1 Contributions (`package.json`)

```jsonc
{ "viewType": "vscodeMdEditor.docx", "displayName": "Word Document Viewer",
  "selector": [{ "filenamePattern": "*.docx" }], "priority": "default" },
{ "viewType": "vscodeMdEditor.xlsx", "displayName": "Excel Workbook Viewer",
  "selector": [{ "filenamePattern": "*.xlsx" }], "priority": "default" }
```

Registration in `src/extension.ts`, after the glTF block (new steps 2d/2e):

- `webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true }` for docx (free Ctrl+F over the rendered DOM); `enableFindWidget: false` for xlsx (virtualised DOM; own find, §7.2).
- `supportsMultipleEditorsPerDocument: false`.

Settings (all under `vscodeMdEditor.office`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `startInEditMode` | boolean | `false` | Open editable files with Edit already on. |
| `sheetAppearance` | `"theme"` \| `"light"` | `"theme"` | Excel grid follows the VS Code theme, or always renders as a light sheet (§11.1). |
| `confirmStructuralEdits` | boolean | `true` | Show the "will not be adjusted" confirmation of §9.6 tier C. |

If another installed extension also claims `*.docx`/`*.xlsx` with default priority, VS Code asks the user to pick; nothing to do here beyond a README note.

---

## 5. Message protocol

Defined in `src/office/protocol.ts`. Rules common to both editors:

- The host owns a monotonically increasing `version` (integer, starts at 0, +1 per applied edit, undo, redo, revert or external reload).
- Every edit request carries `requestId` (webview-generated integer) and `baseVersion`. The host processes edits strictly in arrival order. If `baseVersion !== version` the host replies `{ ok: false, error: { code: 'stale' } }` and the webview refetches.
- The host never trusts the webview: every id, index, range and string is validated; out-of-range requests are answered with an error result, never thrown.
- Every request carrying a `requestId` is answered by exactly one reply: its success message or, for requests without a dedicated failure variant, `requestFailed`. (Edit requests are answered by their `*EditResult` with `ok: false`.) The webview never relies on a timeout. Requests without a `requestId` (`docxRequestRender`, `xlsxRequestSheetMeta`, `xlsxCopy`) are fire-and-forget: they are answered by their success message, or by a `notices` message on failure; `xlsxCopy` is answered only by the host writing to the clipboard.
- Binary payloads are sent as `Uint8Array` in the message body. **[Assumption]** VS Code ≥ 1.57 transfers typed arrays to webviews without JSON-encoding them; verify in Phase 0, fall back to base64 if not.

```ts
// ---------- shared ----------
export type ReadOnlyReason =
  | 'view-mode'            // not a restriction: Edit is simply off
  | 'non-writable-scheme'  // git:, readonly FS, etc.
  | 'too-large'            // §10.2
  | 'protected'            // document/sheet/workbook protection
  | 'strict-ooxml' | 'unsupported-xml-layout' | 'utf16-part'
  | 'tracked-changes-on';  // overridable, §8.7

export interface OfficeNotice { severity: 'info' | 'warning'; code: string; message: string; }

export interface OfficeError {
  code: 'stale' | 'read-only' | 'invalid' | 'blocked' | 'cancelled' | 'internal';
  message: string;          // user-presentable
}

export type OfficeCommonToWebview =
  | { type: 'init'; kind: 'docx' | 'xlsx'; fileName: string; version: number;
      canEdit: boolean; readOnlyReason: ReadOnlyReason | null; editMode: boolean;
      notices: OfficeNotice[] }
  | { type: 'loadError'; title: string; detail: string; actions: Array<'openExternally' | 'retry'> }
  | { type: 'editModeChanged'; editMode: boolean }
  | { type: 'flushPendingEdits'; flushId: number }   // host is about to save/backup
  | { type: 'notices'; notices: OfficeNotice[] }
  | { type: 'requestFailed'; requestId: number; error: OfficeError };   // generic failure reply for any requestId-carrying request that has no dedicated failure variant

export type OfficeCommonToHost =
  | { type: 'ready' }
  | { type: 'setEditMode'; editMode: boolean }
  | { type: 'flushed'; flushId: number }             // sent after any pending commit's result arrived
  | { type: 'openLink'; href: string }
  | { type: 'openExternally' }                       // vscode.env.openExternal(document.uri)
  | { type: 'retry' }
  | { type: 'writeClipboard'; text: string }
  | { type: 'showAbout' };
```

### 5.1 Word

```ts
export interface DocxBlockInfo {
  id: number;                       // stable for the session; never reused
  kind: 'paragraph' | 'opaque';     // opaque = table, sdt, altChunk, anything not a w:p
  parentId: number | null;          // null = direct child of w:body; otherwise the id of the enclosing table block (§8.1)
  cell?: { row: number; col: number }; // 0-based w:tr / w:tc ordinal inside the table `parentId`; present iff parentId !== null
  editable: boolean;                // false => lockReason set
  lockReason?: 'tracked-changes' | 'multi-paragraph-field' | 'unknown-content' | 'opaque' | 'merged-cell';
  removable: boolean;               // §8.5
  style: { kind: 'normal' | 'heading' | 'other'; level?: 1|2|3|4|5|6|7|8|9; name: string };
  list: { kind: 'none' | 'bullet' | 'number' | 'other'; level: number };
}

export type DocxSegment =
  | { kind: 'text'; id: number; text: string; b: boolean; i: boolean; u: boolean; css: DocxRunCss }
  | { kind: 'atom'; id: number; label: string; atomType: 'image' | 'field' | 'hyperlink' | 'footnote' | 'break' | 'math' | 'object' }
  | { kind: 'anchor'; id: number };            // zero-width, invisible, must round-trip

export interface DocxRunCss { color?: string; fontSizePt?: number; fontFamily?: string;
  highlight?: string; strike?: boolean; vertAlign?: 'super' | 'sub'; styleClass?: string; }

export type DocxCommitItem =
  | { kind: 'text'; text: string; b: boolean; i: boolean; u: boolean; src: number | null } // src = id of the text segment whose run properties it inherits
  | { kind: 'atom'; id: number }
  | { kind: 'anchor'; id: number };

export type DocxEditOp =
  | { op: 'commitParagraph'; blockId: number; items: DocxCommitItem[] }
  | { op: 'splitParagraph';  blockId: number; before: DocxCommitItem[]; after: DocxCommitItem[] }
  | { op: 'mergeWithPrevious'; blockId: number; items: DocxCommitItem[] }   // items = this block's current content
  | { op: 'insertParagraphAfter'; blockId: number | null }                 // null = at document start; a block inside a cell inserts into that cell
  | { op: 'removeParagraph'; blockId: number }
  | { op: 'setStyle'; blockIds: number[]; style: 'normal' | { heading: 1|2|3|4|5|6 } }
  | { op: 'setList';  blockIds: number[]; list: 'none' | 'bullet' | 'number' }
  | { op: 'setListLevel'; blockIds: number[]; delta: 1 | -1 };

export type DocxToWebview = OfficeCommonToWebview
  | { type: 'docxRender'; version: number; bytes: Uint8Array; blocks: DocxBlockInfo[] }
  | { type: 'docxBlockModel'; requestId: number; version: number; blockId: number; segments: DocxSegment[] }
  | { type: 'docxEditResult'; requestId: number; ok: true; version: number;
      blocks: DocxBlockInfo[];              // full, current block list (cheap: a few bytes per block)
      changedBlockIds: number[]; focus?: { blockId: number; at: 'start' | 'end' | number } }
  | { type: 'docxEditResult'; requestId: number; ok: false; error: OfficeError }
  | { type: 'docxStateChanged'; version: number };   // undo/redo/revert/reload: webview requests a new render

export type DocxToHost = OfficeCommonToHost
  | { type: 'docxRequestRender' }
  | { type: 'docxRequestBlockModel'; requestId: number; blockId: number }
  | { type: 'docxEdit'; requestId: number; baseVersion: number; edit: DocxEditOp };
```

### 5.2 Excel

```ts
export interface XlsxSheetInfo {
  id: number;                 // session-stable id, NOT the tab index
  name: string;
  kind: 'worksheet' | 'chartsheet' | 'other';
  state: 'visible' | 'hidden' | 'veryHidden';
  canEdit: boolean; readOnlyReason: ReadOnlyReason | null;
}

export interface XlsxSheetMeta {
  sheetId: number; version: number;
  rowCount: number; colCount: number;          // used range, min 100 x 26 for an empty sheet
  defaultColWidthPx: number; defaultRowHeightPx: number;
  colWidthsPx: Array<[col: number, px: number]>;   // sparse overrides, 0-based
  rowHeightsPx: Array<[row: number, px: number]>;
  hiddenCols: number[]; hiddenRows: number[];
  merges: Array<[r0: number, c0: number, r1: number, c1: number]>;
  frozenRows: number; frozenCols: number;
  notices: OfficeNotice[];                     // e.g. "3 charts and 1 image are not shown (preserved)"
}

export interface XlsxCell {
  r: number; c: number;
  d: string;                   // display string (already number-formatted)
  s: number;                   // index into the style table sent with the batch
  k: 'n' | 's' | 'b' | 'e' | 'd' | 'z';   // number, string, boolean, error, date-formatted number, empty-but-styled
  v?: number;                  // raw numeric value when k is 'n' or 'd' (selection Sum/Average use it, as Excel does)
  f?: true;                    // has a formula
  stale?: true;                // formula whose cached value is missing or may be out of date (§9.5)
  link?: string;               // hyperlink target
  note?: string;               // legacy comment text (read-only tooltip)
  ro?: true;                   // cell-level lock (array member, rich value, table header) (§9.4)
}

export interface XlsxStyle {   // resolved, CSS-ready; colours already theme/tint resolved
  bold?: true; italic?: true; underline?: true; strike?: true;
  color?: string; fill?: string; fontFamily?: string; fontSizePt?: number;
  h?: 'left' | 'center' | 'right' | 'justify'; v?: 'top' | 'middle' | 'bottom';
  wrap?: true; indent?: number;
  border?: { t?: string; r?: string; b?: string; l?: string };   // CSS border shorthand
  autoColor?: true;            // font colour is "automatic": follow theme (§11.1)
}

export type XlsxEditOp =
  | { op: 'setCells'; sheetId: number; cells: Array<{ r: number; c: number; input: string }> } // input is what the user typed
  | { op: 'clearCells'; sheetId: number; range: [number, number, number, number] }
  | { op: 'insertRows' | 'deleteRows'; sheetId: number; at: number; count: number }
  | { op: 'insertCols' | 'deleteCols'; sheetId: number; at: number; count: number }
  | { op: 'addSheet'; name?: string; afterSheetId?: number }
  | { op: 'renameSheet'; sheetId: number; name: string }
  | { op: 'deleteSheet'; sheetId: number };

export type XlsxToWebview = OfficeCommonToWebview
  | { type: 'xlsxWorkbook'; version: number; sheets: XlsxSheetInfo[]; activeSheetId: number }
  | { type: 'xlsxSheetMeta'; meta: XlsxSheetMeta }
  | { type: 'xlsxCells'; requestId: number; sheetId: number; version: number;
      range: [number, number, number, number]; cells: XlsxCell[]; styles: Record<number, XlsxStyle> }
  | { type: 'xlsxCellInput'; requestId: number; sheetId: number; r: number; c: number; input: string } // text to seed the cell editor
  | { type: 'xlsxEditResult'; requestId: number; ok: true; version: number;
      invalidate: 'cells' | 'sheet' | 'workbook'; sheetId?: number; range?: [number, number, number, number] }
  | { type: 'xlsxEditResult'; requestId: number; ok: false; error: OfficeError }
  | { type: 'xlsxFindResult'; requestId: number; matches: Array<{ sheetId: number; r: number; c: number }>; truncated: boolean }
  | { type: 'xlsxStateChanged'; version: number; invalidate: 'sheet' | 'workbook'; sheetId?: number };

export type XlsxToHost = OfficeCommonToHost
  | { type: 'xlsxRequestSheetMeta'; sheetId: number }
  | { type: 'xlsxRequestCells'; requestId: number; sheetId: number; range: [number, number, number, number] }
  | { type: 'xlsxRequestCellInput'; requestId: number; sheetId: number; r: number; c: number }
  | { type: 'xlsxEdit'; requestId: number; baseVersion: number; edit: XlsxEditOp }
  | { type: 'xlsxFind'; requestId: number; query: string; matchCase: boolean; sheetId: number | null }
  | { type: 'xlsxCopy'; sheetId: number; range: [number, number, number, number]; format: 'tsv' | 'markdown' };
```

Sheet names (`addSheet`, `renameSheet`) are validated by the host: 1-31 characters, none of `[]:*?/`, no leading or trailing `'`, unique case-insensitively within the workbook, and not the reserved name `History`; violations return `{ code: 'invalid' }`.

**Limits.** `PROTOCOL_LIMITS` in `src/office/protocol.ts` is the single source of truth for the inbound validator caps: at most 20,000 cells per `xlsxRequestCells`; at most 10,000 cells per `setCells`; cell input at most 32,767 characters; row index < 1,048,576 and column index < 16,384; at most 20,000 `blockIds` per docx edit; at most 200,000 commit items per paragraph edit, each text item at most 10,000,000 characters; `openLink` href at most 32,767 characters; `writeClipboard` text at most 50,000,000 characters; `xlsxFind` query at most 32,767 characters.

Cell windows: the grid requests the visible range plus an overscan of 40 rows / 10 columns, in requests of at most 20,000 cells. Responses for a superseded `version` are discarded by the webview.

---

## 6. Custom editor model

### 6.1 Document

`OfficeDocument implements vscode.CustomDocument`:

- `uri`, `kind`, `pkg: OfficePackage` (current state), `version`, `diskStamp: { mtime, size }` recorded at load and after each save, `readOnlyReason`.
- `openCustomDocument(uri, openContext)`: read bytes from `openContext.backupId` (parsed as a URI) when present, otherwise from `uri`, always via `vscode.workspace.fs.readFile` so remote and virtual file systems work. `untitledDocumentData` is ignored (no "new file" support in v1).
- If `vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false` (for example the `git:` side of a diff), the document is read-only (`non-writable-scheme`).
- Load failures do **not** throw from `openCustomDocument`; the document is created in an error state and the webview shows the error view (§10.3). Throwing would leave VS Code showing a generic failure with no "Open externally" action.
- A `FileSystemWatcher` on the file: on external change, if the document is clean, reload and post `…StateChanged`; if dirty, add a persistent warning notice ("changed on disk") and leave the in-memory state alone.

### 6.2 Provider callbacks

| Callback | Behaviour |
|---|---|
| `resolveCustomEditor` | Set webview options (scripts on; `localResourceRoots` = extension `media/` only — no workspace folder is needed), set HTML, wire messages. On `ready`, send `init`, then the first payload. |
| `onDidChangeCustomDocument` | Fire a `CustomDocumentEditEvent` `{ document, label, undo, redo }` for every applied edit (§6.3). VS Code owns the undo stack and the dirty flag; undoing back to the saved point makes the document clean again without help. |
| `saveCustomDocument` | §6.5. |
| `saveCustomDocumentAs` | Same pipeline, writes to `destination`. If the document has no edits, write the original bytes verbatim. |
| `revertCustomDocument` | Re-read from `uri`, rebuild the package, bump `version`, post `…StateChanged`. |
| `backupCustomDocument` | Serialise (cached per `version`, so repeated backups of an unchanged state cost nothing), write to `context.destination`, return `{ id: destination.toString(), delete }`. Restoring opens the backup bytes as the working state; VS Code restores the dirty flag. The undo stack does not survive a restart (acceptable). |

### 6.3 Edits, undo, redo

An `OfficeEdit` is `{ label: string; changes: PartChange[] }`, applied atomically. A `PartChange` is one of three kinds:

- `{ kind: 'node'; part; locator; before: string; after: string }` — replace one element's XML. Locators: docx block id; xlsx `(sheetId, row)` for a row element or `(sheetId, row, col)` for a cell. `before`/`after` may be empty (insert/remove).
- `{ kind: 'attr'; part; locator; name; before: string | null; after: string | null }` — set, change or remove one attribute of one element; only that element's start tag is rewritten. Used where an attribute of a large element changes (`cellXfs/@count`, `mergeCells/@count`, `dimension/@ref`, table `@ref`), so that G4 locality holds without re-emitting the element's children.
- `{ kind: 'part'; part; before: Uint8Array | null; after: Uint8Array | null }` — whole-part replacement, creation (`before` null) or deletion (`after` null). Used for structural operations. Both sides are stored **raw-deflated** (level 1) to bound undo memory; sheet XML compresses 10–20×.

The semantic locators above are resolved, when the edit is created, to a **node path**: the list of child-node indexes (counting every child node — elements, text, comments, processing instructions) from the part's root element down to the target. The path is what the change stores. Removing the node at a path and re-inserting at the same path are exact inverses, including surrounding whitespace, which is what makes G5 (§13.2) hold for inserts and removals. Adjacent text nodes left behind by a removal MUST NOT be merged while the part's tree is alive. An inserted element is spliced in with no added whitespace.

Each load, revert or external reload increments the document's `generation`. Every undo/redo closure captures the generation it was created in and, if it no longer matches, does nothing except tell the user ("Can't undo: the file was reloaded from disk"). Replace and remove changes additionally check that the node at the path serialises to the expected `before` text and fail the same way if not.

Undo applies the changes in reverse with `before`/`after` swapped; redo re-applies. Both bump `version` and post `…StateChanged`. No edit is recorded and no event fired when an operation changes nothing.

Labels (shown in Edit ▸ Undo): "Edit Paragraph", "Split Paragraph", "Merge Paragraphs", "Remove Paragraph", "Change Style", "Change List", "Edit Cell", "Paste Cells", "Clear Cells", "Insert Rows", "Delete Rows", "Insert Columns", "Delete Columns", "Add Sheet", "Rename Sheet", "Delete Sheet".

In-progress typing (an open paragraph island or cell editor) is **not** on the VS Code undo stack; it becomes one edit on commit. While an island or cell editor is open, Ctrl+Z/Ctrl+Y are handled locally by the browser's native text undo. **[Assumption]** the webview can keep these keys from reaching the workbench undo command by handling them in a capture-phase `keydown` listener; verify in Phase 0. Defensive rule regardless: if a `…StateChanged` arrives while an island or cell editor is open, the in-progress edit is cancelled and the user is told ("The document changed; your unfinished edit was discarded").

### 6.4 Edit mode

`init.canEdit` is false when a `readOnlyReason` other than `view-mode` applies. When `canEdit` is true the toolbar shows an **Edit** toggle (Ctrl/Cmd+E), off by default (`startInEditMode`). In View mode every editing gesture (typing, F2, double-click, Delete) shows a one-line hint, "Press Edit (Ctrl+E) to make changes", and does nothing else. Turning Edit off with an open island/cell editor commits it first.

### 6.5 Save pipeline

1. Post `flushPendingEdits` and wait for `flushed` (timeout 1500 ms; on timeout, proceed with committed state only).
2. **Conflict check**: `stat` the target. If `mtime`/`size` differ from `diskStamp`, show a modal: "Overwrite", "Revert to disk version", "Cancel".
3. **Serialise**: unchanged entries copied raw; each changed part serialised from its tree and deflated.
4. **Verify (MUST pass before writing)**: re-read the produced bytes with the container reader; inflate and CRC-check every entry; for each changed or new part, re-parse with the lossless parser and run the format validators (§13.3); check that every part named in `[Content_Types].xml` overrides and every internal relationship target exists. On failure: abort, write nothing, show "Save failed an internal consistency check — your file on disk was not changed" with a "Save a copy of diagnostics" action that writes the failing part names and validator messages (no document content) to a file the user chooses.
5. `vscode.workspace.fs.writeFile(uri, bytes)`. On failure map the error (§10.3) and rethrow so VS Code keeps the document dirty.
6. Update `diskStamp`; clear the serialisation cache key for backups.

Xlsx-only, as part of the first serialisation after any cell/structure edit: set `fullCalcOnLoad="1"` and remove the calc chain (§9.5).

---

## 7. Viewer features (v1)

### 7.1 Word viewer

In scope:
- Paged rendering via docx-preview with: `breakPages: true`, `inWrapper: true`, `ignoreLastRenderedPageBreak: true`, headers, footers, footnotes, endnotes on; `renderChanges: false` (shows the document as if all insertions were accepted and deletions applied — stated in a notice when tracked changes exist); `renderComments: false`; **`renderAltChunks: false`**; `experimental: false`; `useBase64URL: false`.
- Toolbar: Edit toggle, zoom (50–200 %, Fit width, Ctrl+wheel, Ctrl+= / Ctrl+-), section count (explicit page/section breaks; docx-preview has no flow pagination, so a 286-page Word doc renders as 1 section), "Open in Word" (`vscode.env.openExternal`), brand button (`getBrandButtonHtml()`).
- Find: VS Code's built-in webview find widget.
- Links: clicks are intercepted; external `http`/`https`/`mailto` targets go to the host as `openLink` and open through `vscode.env.openExternal`; internal `#anchor` links scroll; every other scheme is ignored.
- Notices bar listing what is present but shown approximately or not at all: tracked changes, comments (count), embedded objects, charts/SmartArt, equations, altChunks, macros. Detection is by scanning relationship types and a small set of element names; it never affects preservation.
- Text selection and copy of rendered text.

Non-goals (v1): comments pane, tracked-changes review UI, outline/navigation pane, print/PDF, page thumbnails, exact Word pagination, font substitution control, rendering of charts/SmartArt/OLE.

### 7.2 Excel viewer

In scope:
- Sheet tabs (visible sheets; hidden sheets listed in a "Hidden sheets" overflow menu, viewable; chartsheets shown as a tab with a "not displayed" placeholder).
- Virtualised grid: row/column headers, column widths and row heights from the file, hidden rows/columns (collapsed with a thin marker), frozen panes, merged cells, gridlines.
- Cell styling: font (bold, italic, underline, strike, colour, size, family), solid fills, borders (thin/medium/thick/dashed/dotted/double mapped to CSS), horizontal/vertical alignment, wrap, indent. Theme colours with tint and the indexed palette are resolved in the host.
- Number formats rendered with numfmt from the cell's format code (built-in ids and custom codes), including colour sections (`[Red]`) and the workbook date system (1900/1904). numfmt locale is fixed to `en-US` in v1.
- Formula cells show their cached value; the formula appears in the formula bar. Cells with no cached value show the formula text in italics with a "not calculated" marker.
- Selection (click, drag, Shift+arrows, Ctrl+A), status bar with Sum / Average / Count of selected numeric cells (from loaded cached values), formula bar (read-only in View mode).
- Copy selection as TSV (Ctrl+C) via the host clipboard; "Copy as Markdown table" in the context menu (this is Phase 5 pulled forward if cheap; otherwise hidden until Phase 5).
- Find (Ctrl+F): host-side search over display strings and formula text of the active sheet or all sheets, capped at 1,000 matches.
- Hyperlinks (Ctrl+click), legacy comment text as a tooltip with a corner marker.
- Per-sheet notices for content present but not shown: charts, images, shapes, pivot tables, sparklines, conditional formatting, data validation, slicers.

Non-goals (v1): rendering charts/images/shapes; evaluating conditional formatting; gradient/pattern fills (drawn as the nearest solid colour); rotated text; rich text within a cell (shown as plain text in the cell's style); row/column grouping controls; filter/sort UI; column resizing by drag (view-only widths; resizing would be an edit); zoom; print.

---

## 8. Word editing (v1)

### 8.1 Body model

The main part is found through `_rels/.rels` (relationship type `…/officeDocument`), not by hard-coded path. Its content type MUST be `application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml`; anything else (template, macro-enabled, Strict OOXML namespace `http://purl.oclc.org/ooxml/…`) is view-only.

Blocks live in **containers**. A container is either `w:body` or a table cell (`w:tc`). Each direct child of a container is a block with a session-stable integer id (ids are attached to nodes; a node re-created by undo/redo gets a fresh id, and undo/redo always triggers a full re-render). `docxRender.blocks` and `docxEditResult.blocks` list every block of every container, flattened in document order; a block inside a cell carries `parentId` (the id of the table block that directly contains the cell) and `cell`.

- A `w:p` that is a direct child of a container is a **paragraph block** and can be editable.
- A `w:tbl` that is a direct child of a container is an **opaque block** (never modified as a table: no row, column or cell is ever added, removed, merged or re-propertied; `w:tblPr`, `w:tblGrid`, `w:trPr`, `w:tcPr` are never touched; never removable). It is also a *container host*: for each `w:tr` that is a direct child of the `w:tbl`, each `w:tc` that is a direct child of that `w:tr` is a container, recursively (a nested table inside a cell is again an opaque block whose cells are containers).
- Everything else (block-level `w:sdt`, `w:altChunk`, container-level bookmarks and range markers, `w:customXml`, the final `w:sectPr`, unknown elements) is an opaque block: rendered by docx-preview, never modified, never removable, and **not** descended into. Rows or cells wrapped in `w:sdt` or `w:customXml` are therefore not containers; their paragraphs are not editable.

Table-cell rules (decision Q3, §16):

- Paragraphs in a **vertically merged continuation cell** (`w:tcPr/w:vMerge` present with `w:val` absent or `continue`) or a legacy horizontal continuation (`w:tcPr/w:hMerge` likewise) are locked with `merged-cell`: docx-preview renders a vMerge continuation as `<td style="display:none">` (paragraphs in the DOM but hidden), and a legacy `w:hMerge` continuation or a `w:vMerge` continuation with no restart above it as ordinary visible cells. All stay locked as `merged-cell`; the host never injects markers into them. The restart cell (`w:vMerge w:val="restart"`) and `w:gridSpan` cells are ordinary containers.
- A table carrying table-level revision marks locks its affected paragraphs with `tracked-changes`: `w:trPr/w:ins|w:del` (whole row), `w:tcPr/w:cellIns|w:cellDel|w:cellMerge` (that cell), any `w:tblPrChange`, `w:tblGridChange`, `w:trPrChange`, `w:tcPrChange`, `w:tblPrExChange` (whole table).
- The schema requires every `w:tc` to end with a `w:p`. Structural operations (§8.5) preserve this.
- `DocxBlockInfo.cell.col` is the ordinal of the `w:tc` within its row, not a grid column; the webview never needs grid arithmetic.

Consequence, stated plainly: **text in table cells is editable; table structure is not. Text inside text boxes, headers, footers, footnotes, endnotes and content controls is not editable in v1.**

### 8.2 Mapping rendered DOM to blocks (render-only copy)

For each render, the host builds a throwaway copy of the package in which `document.xml` has, for every editable-candidate paragraph block (in the body and in every cell container, at any nesting depth; never for `merged-cell` paragraphs), two injected empty bookmarks: `__vsmd_s_{blockId}` as the first child after `w:pPr`, and `__vsmd_e_{blockId}` as the last child, except when the paragraph's last child is a `w:r` whose last content element (ignoring `w:rPr` and `w:lastRenderedPageBreak`) is `w:br w:type="page"`; then the end marker goes immediately before that run. (docx-preview's page splitter treats any sibling after a page-break run as content for the next page; without this rule an empty `<p>`, or the run's own text, moves to the next page — Phase 0 S1.) Bookmark `w:id` values start at 2,000,000,000 and count up. The copy is sent as `docxRender.bytes` and is never saved; the real package is not touched. `docxEditor.css` MUST contain `span[id^="__vsmd_"]{display:none}`: visible empty marker spans shift layout by sub-pixel amounts (0.55 px measured); hidden ones are still found by `getElementById`/`closest('p')`. A page-break-split paragraph yields one `<p>` per page part; docx-preview splits only at the first page break per paragraph and does not split at breaks inside `w:hyperlink`; the rule above handles both.

After `renderAsync` resolves, the webview finds `span#__vsmd_s_{id}` / `span#__vsmd_e_{id}`; let `S` and `E` be the `<p>` elements containing the start and end marker and `C` the nearest `<td>`/`<th>` ancestor of `S` (or none, for a body paragraph). `E` MUST have the same nearest cell ancestor `C`, otherwise the pair is treated as not found. Every `<p>` from `S` to `E` in document order **whose nearest cell ancestor is also `C`** belongs to block `id` and gets `data-block="{id}"`. This handles the page-break split of body paragraphs, keeps a body paragraph from ever claiming the `<p>` elements of a table, and a cell paragraph from claiming those of a nested table. Blocks from `docxRender.blocks` with a heading style additionally get `role="heading"` and `aria-level`.

If a marker pair cannot be found for a block the host called editable, that block is treated as locked for this render and a diagnostic is logged. The webview MUST NOT guess.

Fallback if Phase 0 shows the hook to be unreliable across fixture documents: vendor a patched docx-preview that stamps a data attribute from a custom attribute on `w:p` (Apache-2.0 permits it). Second fallback: a separate, simpler "Edit view" drawn from the host model, with docx-preview kept as the read-only view.

### 8.3 Paragraph model

A paragraph's children are classified against an **allow-list**. Any child not on it locks the paragraph (`unknown-content`).

| Source content | Model |
|---|---|
| `w:pPr` | Kept verbatim; changed only by style/list operations. |
| `w:r` containing `w:t` | **Text segment.** `w:tab` → `\t`, `w:br` (no type, or `textWrapping`) → `\n`, `w:noBreakHyphen` → U+2011, `w:softHyphen` → U+00AD, inside the text. A run with mixed content is split virtually into consecutive segments sharing one `w:rPr`. |
| `w:r` containing `w:drawing`, `w:pict`, `w:object`, `w:sym`, `w:footnoteReference`, `w:endnoteReference`, `w:br w:type="page|column"`, `mc:AlternateContent`, `w:ptab`, `w:cr` | **Atom** (visible, read-only chip in the island). |
| Complex field: runs from `w:fldChar begin` to its matching `end`, including nested fields | One **atom** labelled with the field's result text. If begin and end are not in the same paragraph (TOC, cross-paragraph fields), every paragraph the field touches is locked (`multi-paragraph-field`). |
| `w:fldSimple`, `w:hyperlink`, inline `w:sdt`, `w:smartTag`, `m:oMath`, `m:oMathPara` | One **atom** each. Hyperlink text is therefore not editable in v1. |
| `w:bookmarkStart/End`, `w:commentRangeStart/End`, `w:r` containing only `w:commentReference`, `w:permStart/End`, `w:moveFromRangeStart/End`, `w:moveToRangeStart/End` | **Anchor** (zero-width, invisible, relocatable, never dropped). |
| `w:proofErr`, `w:lastRenderedPageBreak` (inside a run) | **Disposable.** Dropped from an edited paragraph; Word regenerates them. |
| `w:ins`, `w:del`, `w:moveFrom`, `w:moveTo`, or any `w:rPrChange`/`w:pPrChange` descendant | Paragraph locked (`tracked-changes`). |

`b`/`i`/`u` on a text segment are the **effective** values: direct `w:rPr`, then the run's character style, then the paragraph style's run properties, each following `w:basedOn`, then `w:docDefaults`. `w:b w:val="0"`/`false`/`off` counts as off. Known simplification: Word's XOR rule for toggle properties set in both a paragraph style and a character style is not implemented; the direct value or nearest style wins.

`DocxRunCss` carries only what is set **directly** on the run or by its character style; everything else is inherited in the island from the `<p>` element docx-preview already styled.

### 8.4 Committing a paragraph (how run formatting survives)

The island is built from the segment list: each text segment is a `<span data-seg="{id}">`, each atom a `contenteditable="false"` chip with `data-atom`, each anchor an empty `contenteditable="false"` span with `data-anchor`. Text typed inside or adjacent to a span lands in that span and so inherits its `data-seg`; pasted content is inserted as plain text. On commit `media/docxIsland.js` walks the DOM and emits `DocxCommitItem[]`: consecutive text with the same `(src, b, i, u)` is one item; `src` is the `data-seg` of the span the text sits in (or of the nearest preceding text span, or the following one, or `null` in an empty paragraph).

Host rebuild rules (`paragraphWriter.ts`), in order:

1. If the committed items equal the current segments, do nothing (no edit, no dirty).
2. `w:pPr` is emitted verbatim.
3. A text item whose `src` segment is unchanged in text and formatting, and whose original run's other pieces are also unchanged and still adjacent, emits the **original run XML slice verbatim** (attributes such as `w:rsidR` included).
4. Any other text item emits a new `<w:r>` with a copy of the `src` segment's original `w:rPr` slice, modified only for b/i/u (below), followed by `w:t xml:space="preserve"` pieces with `w:tab`/`w:br` for `\t`/`\n`. `src: null` emits a run with no `w:rPr` (it inherits the paragraph mark's look via the style). New runs carry no `w:rsid*` attributes.
5. Atoms and anchors emit their original XML verbatim at their committed positions.
6. **Nothing is dropped.** Any atom or anchor present before the edit but missing from the commit is re-inserted: at the position immediately after its nearest surviving original predecessor, or at the paragraph start if none. A paired anchor's start is always placed before its end. If atoms had to be re-inserted, the result carries a notice "Images, fields and links can't be deleted in this editor."
7. Toggle encoding in `w:rPr`, respecting the schema child order (`rStyle, rFonts, b, bCs, i, iCs, caps, smallCaps, strike, dstrike, outline, shadow, emboss, imprint, noProof, snapToGrid, vanish, webHidden, color, spacing, w, kern, position, sz, szCs, highlight, u, effect, bdr, shd, fitText, vertAlign, rtl, cs, em, lang, eastAsianLayout, specVanish, oMath`):
   - Bold on: `<w:b/>` and `<w:bCs/>`. Bold off: remove both if the inherited value (styles only) is off; otherwise write `<w:b w:val="0"/><w:bCs w:val="0"/>`.
   - Italic: the same with `w:i`/`w:iCs`.
   - Underline on: keep an existing `w:u` whose value is not `none`; otherwise `<w:u w:val="single"/>`. Off: remove, or `<w:u w:val="none"/>` when inherited on.
8. The paragraph element's own attributes are kept, except `w14:textId`, which is removed when content changed (it is an optional content hash).

### 8.5 Adding, splitting, merging, removing paragraphs

- **Split (Enter)**: the new paragraph follows the original. It receives a copy of `w:pPr`, minus `w:sectPr` (a section-ending paragraph keeps its `w:sectPr` on the **second** half, because that mark ends the section), and no `w14:paraId`/`w14:textId`/`w:rsid*` attributes. If the caret was at the end and the paragraph's style declares `w:next`, the new paragraph takes that style and drops `w:numPr` unless the next style is itself a list style. Enter in an **empty list item** removes the list formatting instead of splitting.
- **Soft line break (Shift+Enter)**: inserts `\n` in the text (`w:br`).
- **Merge (Backspace at start / Delete at end)**: the merged paragraph keeps the **first** paragraph's `w:pPr`. Blocked when the first paragraph's `w:pPr` contains `w:sectPr` (it would delete a section), or when either neighbour is locked or opaque.
- **Insert empty paragraph after** an opaque block (e.g. a table) via its hover affordance: new `w:p` with no properties.
- **Remove** (`removable` in `DocxBlockInfo`): allowed only for an editable paragraph with **no atoms** and no `w:sectPr`. Its anchors move to the start of the following paragraph block (or the end of the preceding one if it is last). The last remaining paragraph cannot be removed.
- **Containers.** Every operation above works within one container and never crosses a container boundary: split puts the new paragraph in the same cell; merge needs the previous/next **sibling block in the same container** to be an editable paragraph (Backspace at the start of a cell's first paragraph and Delete at the end of its last do nothing); "following"/"preceding" paragraph for anchor relocation and for list joining (§8.6) means a sibling in the same container. In a cell, a paragraph is not removable when it is the cell's only paragraph, or when it is the cell's last child and its previous sibling is not a `w:p` (a cell must end with a paragraph, e.g. after a nested table). "Insert empty paragraph after" on a nested table inserts into the cell that holds the table.

### 8.6 Headings and lists

Headings (levels 1–6 offered, matching Markdown; existing levels 7–9 are displayed and preserved):
- Find the style by `w:type="paragraph"` and `w:name/@w:val` equal, case-insensitively, to `heading N`. Word writes the built-in English name regardless of UI language, while the `w:styleId` is localised (`Heading1`, `berschrift1`, `Titre1`, `Ttulo1`); never match on the id. Fallback: a paragraph style whose `w:pPr/w:outlineLvl` is `N-1`.
- If no such style is defined (Word writes only styles in use), append one to `styles.xml`: `w:styleId` = `Heading{N}` (suffix a number if taken), `w:name` `heading N`, `w:basedOn` the default paragraph style, `w:next` the default paragraph style, `w:uiPriority 9`, `w:qFormat`, `w:pPr` with `w:keepNext`, `w:keepLines`, `w:spacing` and `w:outlineLvl N-1`, `w:rPr` using the theme major font and sizes 16/13/12/11/11/11 pt for levels 1–6. Exact markup is fixed in the plan doc and covered by a fixture test.
- "Normal": remove `w:pStyle`.
- Setting a style replaces only `w:pStyle` (first child of `w:pPr`; create `w:pPr` as the first child of `w:p` if absent). Direct formatting is left alone.

Lists:
- A paragraph's list state is its effective `w:numPr` (direct, else via the paragraph style chain); kind comes from `numId → w:num → w:abstractNum → w:lvl[@w:ilvl] → w:numFmt` (`bullet` → bullet; `decimal`, `lowerLetter`, `upperLetter`, `lowerRoman`, `upperRoman` → number; anything else → `other`, shown and preserved, toggleable off).
- **Turn on**: if the previous or next block is a list paragraph of the requested kind, reuse its `numId` and `ilvl` (joins that list). Otherwise use this editor's own definitions: one `w:abstractNum` per kind, identified by `<w:name w:val="VSMDBullet"/>` / `VSMDNumber`, nine levels, created on first use. Bullets share a single `w:num`. Each new numbered list gets a **new `w:num`** with `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>` so it restarts at 1. Set `w:pStyle` to the "List Paragraph" style (found by name `List Paragraph`, created if missing) only when the paragraph has no style.
- **Turn off**: remove `w:numPr`; if numbering came from the style, write `<w:numPr><w:numId w:val="0"/></w:numPr>`; remove `w:pStyle` if it is the List Paragraph style.
- **Level**: Tab / Shift+Tab at the start of a list item changes `w:ilvl` within 0–8.
- `numbering.xml` rules: all `w:abstractNum` elements precede all `w:num` elements; new ids are max+1. If the part does not exist, create it, add the relationship in `word/_rels/document.xml.rels` and the `Override` in `[Content_Types].xml`.
- `w:pPr` child order MUST be respected when inserting (`pStyle, keepNext, keepLines, pageBreakBefore, framePr, widowControl, numPr, …`); the full sequence lives as a constant in `paragraphWriter.ts`.

### 8.7 Protection and tracked changes

- `w:documentProtection` with enforcement on, or `w:writeProtection`, in `settings.xml` → read-only (`protected`), no override.
- `w:trackRevisions` on in `settings.xml` → read-only (`tracked-changes-on`) with an "Edit anyway (changes will not be tracked)" action that requires a modal confirmation once per document open. Edits made here are never written as revisions.

### 8.8 Editing interaction

- In Edit mode, hovering an editable paragraph shows an outline; click places the caret and opens the island (`docxRequestBlockModel` → island). Locked paragraphs show a lock tooltip with the reason. Opaque blocks show "Not editable here — preserved as is"; a table shows it only on its outer border, since its cells' paragraphs are individually editable. Paragraphs locked as `merged-cell` are not displayed and need no affordance.
- Commit on blur, on moving to another paragraph (arrow keys across the boundary, click elsewhere), on Ctrl+S (through `flushPendingEdits`), and after 1.5 s of typing inactivity (debounced commit without closing the island; the island DOM is never rebuilt while it has focus — see the WYSIWYG cursor lesson in project memory).
- After a commit the webview keeps its island DOM as the paragraph's display. A full docx-preview re-render is scheduled when no island has been focused for 2 s, or immediately after style/list changes, undo/redo and revert. It renders into a detached container and swaps in only if no island is open, restoring scroll to the block nearest the viewport top. Split and merge update the DOM optimistically (clone/remove the `<p>`, ids from `docxEditResult`) so typing is never blocked by a render.
- Toolbar in Edit mode: Bold, Italic, Underline (`aria-pressed`), style picker (Normal, Heading 1–6), Bullets, Numbering, Outdent, Indent. Style and list actions apply to the paragraph with the caret (multi-paragraph selection is a non-goal in v1).

Non-goals (v1 editing): fonts, sizes, colours, alignment, spacing; table structure (adding, removing, merging or resizing rows, columns and cells; table properties); images; hyperlink creation or editing; comments; tracked changes; headers/footers/footnotes; find-and-replace; spell/grammar check (LanguageTool integration is a candidate later); multi-paragraph selection operations; drag and drop; rich paste.

---

## 9. Excel editing (v1)

### 9.1 Workbook model

Main part via `_rels/.rels`; content type MUST be `…spreadsheetml.sheet.main+xml` (macro-enabled or template content types, or Strict namespaces → view-only). Sheets come from `workbook.xml` `sheets/sheet` (`name`, `sheetId`, `state`, `r:id`) resolved through `xl/_rels/workbook.xml.rels`. `workbookPr/@date1904` selects the date system.

A sheet part is parsed on first activation. The sheet index maps row number → row node and (row, column) → cell node. A worksheet is view-only if: `sheetProtection` is present (`protected`); any `row` or `c` lacks its `r` attribute (`unsupported-xml-layout`); it exceeds §10.2 limits. `workbookProtection/@lockStructure` disables add/rename/delete sheet only; cell edits and row/column operations stay available.

### 9.2 Reading cells

| `c/@t` | Value |
|---|---|
| absent or `n` | number from `v` |
| `s` | shared string index → plain text (rich runs concatenated; phonetic `rPh` ignored) |
| `inlineStr` | text of `is` (plain or rich) |
| `str` | formula string result |
| `b` | boolean |
| `e` | error text |
| `d` | ISO 8601 date; displayed as text |

Display string = numfmt applied to the value with the cell style's number format. A number whose format is a date format (`numfmt.isDateFormat`) is kind `d`.

### 9.3 Cell entry rules

`input` is exactly what the user typed. The host decides the stored form; no locale-dependent guessing.

| Input | Stored as |
|---|---|
| empty | cleared: `v`, `f`, `is` and `t` removed; the `c` element stays if it has a style `s`, otherwise it is removed |
| starts with `'` | text (rest of the input), even if it looks like a number or formula |
| starts with `=` and has more characters | formula (§9.5) |
| matches `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$` | number (`v` = shortest round-trip repr) |
| ends with `%` and the rest is a number, **and** the cell's format is a percent format | number / 100 |
| `TRUE` / `FALSE` (case-insensitive) | boolean |
| ISO date `YYYY-MM-DD`, optionally `THH:mm[:ss]` or ` HH:mm[:ss]`, a real calendar date within the range of §9.3.1, **and** the cell's effective number format is not Text (`@`) | serial number in the workbook's date system; if the effective format is General, the cell also gets a date format (§9.3.1) |
| anything else | text |

- Text is written as `<c … t="inlineStr"><is><t xml:space="preserve">…</t></is></c>`. **`sharedStrings.xml` is never modified.** A replaced shared string is left in the table; orphaned entries are harmless and Excel prunes them on its next save. Rationale: one touched part per cell edit, no count bookkeeping. Excel converts inline strings to shared strings when it next saves. Alternatives considered: appending to the shared string table (touches a second, often very large part on every text edit).
- Editing a rich-text cell replaces it with plain text (cell-level style kept). The cell editor shows a hint before the first such edit.
- **Dates** (decision Q2, §16): an ISO date typed into a cell is stored as a real serial date. In a General cell the cell is also given a date number format, by the one `styles.xml` patch this editor makes (§9.3.1). In a cell that already has a date format only the value changes. In a cell with any other explicit number format (currency, `0.00`, …) the serial is stored and the format is left alone, exactly as Excel does; in a Text-formatted cell the input stays text. Typing a number into a date-formatted cell stores that serial. The cell editor of a date cell is seeded with the ISO form; other number cells with the full-precision number; formula cells with `=` + formula.
- The style index `s` of an existing cell is never changed, with the single exception of §9.3.1. A newly created cell takes the row's `s` (when the row has `customFormat="1"`), else the column's `style` from `cols`, else none.
- New `row` elements are created with only `r`; rows and cells are inserted in ascending order. Existing `spans` attributes are left alone on value edits.
- Read-only cells (`ro`): members of a multi-cell array formula or data table (`f/@t="array"|"dataTable"` with a multi-cell `ref`); cells with `cm` or `vm` attributes (dynamic-array anchors, rich values such as in-cell images or data types); header-row cells of a table (the table part stores column names that must match).
- Paste: plain-text TSV from the clipboard into the active cell, expanding right/down; each value goes through the table above; one undoable edit; capped at 10,000 cells; refused if it would hit any read-only cell.

### 9.3.1 The date style patch (the only change ever made to `styles.xml`)

Applies when a `setCells` input is classified as a date and the target cell's **effective number format id is 0 (General)**. "Effective" means the `numFmtId` of `cellXfs/xf[s]`, where `s` is the cell's `s`, or for a cell being created the inherited row/column style, or 0.

- **Accepted range**: 1900-03-01 … 9999-12-31 in the 1900 date system (this sidesteps the fictitious 1900-02-29), 1904-01-01 … 9999-12-31 in the 1904 system. Hours 0–23, minutes and seconds 0–59. Anything else is text.
- **Format**: date only → built-in `numFmtId="14"` (short date). Date with time → built-in `numFmtId="22"` (short date + `h:mm`). Both are built-ins, so `numFmts` is never touched and no format code is written.
- **Target record**: a copy of the base record `cellXfs/xf[base]` (`base` = the effective style index above) — same `fontId`, `fillId`, `borderId`, `xfId`, every other attribute, and every child element (`alignment`, `protection`, `extLst`) copied from its source text — with `numFmtId` set to 14 or 22 and `applyNumberFormat="1"`. The cell therefore keeps its font, fill, border and alignment.
- **Reuse before append**: if `cellXfs` already contains a record equal to the target (same attribute name/value set irrespective of order, and identical child XML), use the lowest such index. This is what makes a second date typed into a similar cell free, and reuses a date style Excel already wrote.
- **Append**: otherwise insert the new `xf` as the **last child of `cellXfs`** (immediately after the current last `xf`, no added whitespace) and, if `cellXfs` has a `count` attribute, increase it by one. The new index is the previous number of `xf` children. Existing records are never changed, reordered or removed, so no existing `c/@s` changes meaning. Nothing else in `styles.xml` is touched (`fonts`, `fills`, `borders`, `cellStyleXfs`, `cellStyles`, `dxfs`, `numFmts`, `extLst`).
- The cell is written with `s` = that index and the serial in `v` (no `t`). This is the one case where an existing cell's `s` changes.
- **One edit**: the style change and the cell change are one undoable `OfficeEdit` (touched set: the sheet part and `xl/styles.xml`). Undo removes the appended record and restores `count`. A paste creates at most one new record per distinct `(base, numFmtId)` pair.
- **Fallback to text** (with the notice "Stored as text — this workbook has no cell formats to extend"): no styles part, styles part not UTF-8, `cellXfs` missing or empty, the main namespace not bound on the styles root, or the record count would exceed 65,490.
- Clearing a cell keeps its `s`, so the cell stays date-formatted (as in Excel).
- Validator and tests: §13.3 (styles rules) and Phase 2 acceptance (§14).

### 9.4 Shared formulas

`<f t="shared" si="n" ref="…">` (master) and `<f t="shared" si="n"/>` (dependants). Editing a dependant replaces its `f` with a plain formula. Before a master is edited or cleared, and before any structural operation on the sheet, every shared group affected is **materialised**: each dependant gets its explicit formula (the master's text with relative references offset by the cell delta) and the `t`/`si`/`ref` attributes are removed. Materialisation is part of the same undoable edit.

### 9.5 Formulas, cached values and recalculation

- Formula text is stored in file syntax: English function names, comma argument separators, no leading `=`. The UI shows and accepts the same syntax (locale-specific separators are a non-goal).
- Entry is validated with `@borgar/fx` `parse`. A formula that does not parse is **rejected** with the parser's position; it is never written, because a syntactically invalid formula makes Excel report the workbook as corrupt.
- Functions newer than Excel 2007 are stored with their `_xlfn.` prefix (e.g. `_xlfn.XLOOKUP`); the prefix is added on write from a built-in list and stripped for display. A function missing from the list is written bare and shows `#NAME?` in Excel until re-entered; the list lives in `xlsx/format.ts` and is covered by a test against known names.
- A formula typed here is a normal (non-array) formula. Dynamic-array spilling formulas entered here will behave as implicitly intersected in Excel. Limitation, stated in the README.
- **No calculation.** For the edited cell, the `v` element is **removed** (a stale result of a different formula is a wrong number that other tools would read as fact); the grid shows the formula text with the "not calculated" marker. For every other cell, cached values are kept as they are. Because dependants of an edited cell may now be out of date, once a workbook has any value/formula/structural edit all formula cells are flagged `stale` and a banner reads: "Formula results are from the last calculation in Excel and will update when the file is next opened there."
- On the first such edit (and included in the same save): set `fullCalcOnLoad="1"` on `workbook.xml` `calcPr` (create `calcPr` in schema position — after `definedNames`, before `oleSize`/`customWorkbookViews`/`pivotCaches` — if absent); delete `xl/calcChain.xml`, its relationship in `xl/_rels/workbook.xml.rels` and its `Override` in `[Content_Types].xml`. A calc chain that disagrees with the sheet's formulas triggers Excel's repair prompt; Excel rebuilds a missing one silently. Side effect to document: Excel will offer to save on close because it recalculated.

### 9.6 Insert/delete rows and columns

Reference semantics follow Excel: references at or beyond the insertion point shift; a range spanning the insertion point grows; a reference wholly inside a deleted band becomes `#REF!`; a range partly deleted shrinks. `$` markers do not affect structural shifting. Whole-row/column references (`3:5`, `B:D`) are handled. Structured references (`Table1[Col]`), defined-name uses and external-workbook references (`[1]Sheet1!A1`) are left as they are. Formulas are tokenised with `@borgar/fx/xlsx`; only reference tokens are rewritten, all other formula text is preserved character for character.

**Tier A — updated (the operation's undoable edit includes all of these):**
- In the sheet: `row/@r`, `c/@r` renumbering; `dimension/@ref`; `mergeCells` (shift, grow, shrink; a merge wholly deleted is removed and `mergeCells/@count` corrected, the element removed when empty); `cols` (column operations: split/shift `min`/`max`); `spans` attributes removed from all rows on column operations (optional attribute); `sheetView` `pane/@topLeftCell`, `selection/@activeCell` and `@sqref`; `autoFilter/@ref`; `sortState/@ref`; `hyperlinks/hyperlink/@ref`; `conditionalFormatting/@sqref` and formulas inside `cfRule`; `dataValidations/dataValidation/@sqref`, `formula1`, `formula2`; `protectedRanges/@sqref`; `ignoredErrors/@sqref`; `rowBreaks`/`colBreaks` `brk/@id`.
- Formulas in **every** worksheet that reference the edited sheet (qualified references; unqualified ones only on the sheet itself). Other sheets are parsed on demand for this.
- `workbook.xml` `definedNames` (including `_xlnm.Print_Area`, `_xlnm.Print_Titles`, `_xlnm._FilterDatabase`).
- Tables on the sheet (`xl/tables/tableN.xml`): for **row** operations strictly within or below the data area, and **column** operations entirely to the left of the table, update `table/@ref` and `autoFilter/@ref`.
- New rows/columns are empty and unstyled (Excel copies the neighbour's formatting; v1 does not).

**Tier B — blocked (the operation is refused with a message naming the cause; nothing changes):**
- It would split or partially delete a multi-cell array formula or data-table range.
- A column operation intersects a table's column span; a row operation would delete a table's header row, totals row or all of its data rows.
- The sheet has legacy or threaded comments at or beyond the affected index (the comment parts and their VML shapes cannot be shifted reliably in v1).
- A pivot table is located on the sheet at or beyond the affected index.
- Formulas contain 3-D references spanning the edited sheet (`Sheet1:Sheet3!A1`).
- Content would be pushed past row 1,048,576 or column 16,384 (XFD).
- Any other worksheet that must be rewritten is itself not editable (protected or over the size limit).

**Tier C — allowed after an explicit confirmation listing what will not follow the cells** (modal, default button Cancel; suppressible with `confirmStructuralEdits: false`):
- Drawings anchored at or beyond the index (images, charts, shapes keep their grid position rather than moving with the cells).
- Chart series and pivot-cache sources that reference the sheet (detected by scanning chart and pivot-cache-definition parts for the sheet name); their ranges are not adjusted.
- Ranges inside `extLst` (Excel 2010+ conditional formats, data validations and sparklines).

This list is the honest v1 limit. The split is deliberate: A is everything in the core schema that can be shifted mechanically; B is where a silent miss would attach content to the wrong cells or produce a file Excel repairs; C is where the result is valid but may surprise.

### 9.7 Sheets

- **Switch**: no edit. The active tab is view state only; `bookViews/@activeTab` is not written.
- **Add**: new part `xl/worksheets/sheet{K}.xml` (K = highest existing number + 1) with a minimal worksheet (`sheetData` only, using the same namespace binding style as an existing sheet); append `sheet` to `workbook.xml` with `sheetId` = max + 1 and a fresh `r:id`; add the relationship and the content-type `Override`. Default name `Sheet{n}`, first unused. `docProps/app.xml` is left alone (Excel rewrites it; a stale titles list is harmless).
- **Rename**: validate (1–31 characters; none of `\ / ? * [ ] :`; no leading or trailing apostrophe; not `History`; unique case-insensitively). Update `sheet/@name`, every formula in every worksheet that qualifies a reference with the old name (quoting as needed, `'` doubled), and `definedNames`. If the old name occurs in any chart or pivot-cache part, Tier C confirmation ("N charts/pivot tables reference this sheet by name and will not be updated").
- **Delete**: modal confirmation always. Blocked when it is the last visible worksheet, when the sheet is a pivot-cache source, or when the sheet is not a plain worksheet. Otherwise: remove the `sheet` element, its relationship, the part, and every part reachable **only** through the deleted sheet's relationships (drawings, comments, tables, printer settings, and their own exclusive children), with their content-type overrides; delete defined names scoped to the sheet and decrement `localSheetId` on names scoped to later sheets; clamp `workbookView/@activeTab` and `@firstSheet`; rewrite references to the sheet in other sheets' formulas and in defined names to `#REF!`.
- Reorder, hide/unhide, tab colour, copy sheet: non-goals.

Other non-goals (v1 editing): cell formatting of any kind (the automatic date format of §9.3.1 is the only style change); column width / row height changes; merge/unmerge; fill handle; sort; filter; cut/move (which needs reference rewriting); find-and-replace; comments; creating charts, tables or names.

---

## 10. Unsupported content, limits and errors

### 10.1 Never drop

- Parts the editor does not understand are never opened, only copied.
- Inside a touched part, elements the editor does not understand are never regenerated; they are emitted from their source slice.
- Where an edit cannot be made without disturbing such content, the edit is refused (locked paragraph, read-only cell, Tier B) with a reason. There is no "edit anyway and hope".

### 10.2 Limits **[Assumption — tune in Phase 0/1 with the perf fixtures]**

| Condition | Result |
|---|---|
| File > 250 MB, or declared uncompressed total > 1 GB, or any single entry declared > 400 MB | Refuse to open (error view). |
| docx: `document.xml` > 20 MB uncompressed, or > 20,000 blocks (all containers, table-cell paragraphs included) | View-only (`too-large`). |
| docx: file > 60 MB | View with a "large document, rendering may take a while" notice; re-render on idle only. |
| xlsx: any worksheet part > 64 MB uncompressed or > 500,000 non-empty cells | Whole workbook view-only; that sheet shows its first 50,000 rows with a truncation banner. |
| xlsx: worksheet part > 300 MB uncompressed | That sheet is not loaded (placeholder with "Open in Excel"). |

Host-side parsing of anything larger than 2 MB MUST yield to the event loop at least every ~30 ms (chunked async), so other extensions are not starved. A worker thread is a post-v1 optimisation.

### 10.3 Error and special-case UX

All load problems render an error view in the editor (`loadError`) with a plain explanation, an "Open in Word/Excel" button and, where sensible, "Retry".

| Case | Detection | Message |
|---|---|---|
| Password-protected | File starts with the OLE compound-file signature `D0 CF 11 E0 A1 B1 1A E1` and contains the UTF-16LE stream name `EncryptedPackage` | "This file is password-protected. Open it in Word/Excel to view it." No password prompt in v1. |
| Legacy format with a new extension | OLE signature without `EncryptedPackage` | "This looks like an older .doc/.xls file saved with a .docx/.xlsx name." |
| Office lock file | File name starts with `~$` | "This is a temporary lock file created by Word/Excel, not a document." |
| Not a ZIP / truncated / bad CRC / malformed XML in a required part | container or parser error | "This file is damaged and can't be displayed." with the technical reason under a "Details" disclosure. Never attempt repair. |
| ZIP64, encrypted entries, unsupported compression, duplicate or unsafe entry names | §3.2 | "This file uses a packaging feature this viewer doesn't support." (Attempt view via docx-preview only if the container reader accepted it; otherwise error view.) |
| Empty (0-byte) file | size 0 | "This file is empty." |
| File open in Word/Excel while we open it | A sibling `~${name}` lock file exists | Opens normally, with a warning notice: "This file appears to be open in Word/Excel. Saving here may fail or conflict." |
| Save fails because the file is locked (Windows `EBUSY`/`EPERM`/`EACCES`, `FileSystemError.NoPermissions`/`Unavailable`) | write error | "Couldn't save: the file is in use by another program (probably Word/Excel). Close it there and save again, or use Save As." The document stays dirty. |
| Changed on disk since load | §6.5 step 2 | Overwrite / Revert / Cancel modal. |
| Render failure in docx-preview | rejected promise or thrown error | Error view with "Open in Word"; editing disabled for the session. The package itself is unaffected. |

---

## 11. Theming, accessibility, keyboard

### 11.1 Theming

- All chrome (toolbar, tabs, headers, banners, notices, formula bar, status bar, scrollbars) uses `--vscode-*` variables and `body.vscode-light|vscode-dark|vscode-high-contrast|vscode-high-contrast-light` classes, consistent with the existing editors' CSS.
- **Word**: pages are always rendered as light "paper" with the document's own colours (as PDF viewers do), on a themed backdrop. Inverting authored colours is unreliable and would misrepresent the document. In high-contrast themes the page gets a `--vscode-contrastBorder` outline.
- **Excel** (`sheetAppearance: "theme"`): cells with no fill use the editor background; "automatic" font colour uses the editor foreground; authored fills and colours are used as authored; on a filled cell an automatic font colour becomes black or white by contrast with the fill; an explicit font colour whose contrast against the effective background is below 3:1 is replaced by the foreground colour. `"light"` renders the sheet as authored on white.
- Selection, focus ring and gridlines use theme tokens; nothing relies on colour alone (stale formulas, locked cells and read-only blocks also carry an icon or text).

### 11.2 Accessibility

- Excel grid: `role="grid"` with `aria-rowcount`/`aria-colcount`; rendered rows `role="row"` with `aria-rowindex`; cells `role="gridcell"` with `aria-colindex`, `aria-readonly`, `aria-selected`; headers `role="columnheader"`/`rowheader`. One tab stop; the active cell is tracked with `aria-activedescendant`. A polite live region announces "B7, 1,250.00, has formula" on navigation and the outcome of edits and blocked operations. Sheet tabs are `role="tablist"`/`tab`.
- Word: block elements keep docx-preview's semantic tags; headings get `role="heading"` + `aria-level` (§8.2); locked and opaque blocks expose their reason through `aria-describedby`; the island is a `role="textbox"` with `aria-multiline="true"` and a label "Paragraph N".
- Toolbars are `role="toolbar"` with arrow-key navigation; toggles use `aria-pressed`; every icon button has an accessible name.
- Honour `prefers-reduced-motion` (no animated scrolling or transitions) and `forced-colors`.
- All functionality is reachable from the keyboard; no hover-only actions (hover affordances have a keyboard equivalent in the block/cell context menu, Shift+F10).

### 11.3 Keyboard

Common: Ctrl/Cmd+E toggle Edit · Ctrl/Cmd+S save (VS Code) · Ctrl/Cmd+Z / Ctrl/Cmd+Y (or Shift+Z) undo/redo (VS Code stack; native inside an open island/cell editor) · Ctrl/Cmd+F find · Esc cancel the in-progress edit.

Word (Edit mode): Ctrl/Cmd+B / I / U · Enter split · Shift+Enter line break · Backspace at start / Delete at end merge · Tab / Shift+Tab list level (in a list item at caret start); otherwise, in a table cell, commit and move to the first editable paragraph of the next / previous cell (as Word does; at the last cell nothing happens — no row is added; Ctrl+Tab inserts a tab character); otherwise inserts a tab · Ctrl/Cmd+Alt+0 Normal, Ctrl/Cmd+Alt+1…6 Heading 1…6 · Ctrl/Cmd+Shift+8 bullets · Ctrl/Cmd+Shift+7 numbering · ArrowUp/Down at the first/last line moves to the adjacent editable paragraph · Ctrl+= / Ctrl+- zoom.

Excel: arrows, Tab/Shift+Tab, Enter/Shift+Enter move · Home, Ctrl+Home, Ctrl+End, PageUp/PageDown, Ctrl+arrows (jump to data edge) · Shift+movement extends the selection · Ctrl+A select all · Ctrl+C copy · Ctrl+PageUp/PageDown previous/next sheet · Edit mode: F2 or Enter or typing starts editing (typing replaces) · Enter commit and move down · Tab commit and move right · Esc cancel · Delete/Backspace clear selection · Ctrl+V paste · context menu (Shift+F10) on headers: Insert/Delete rows/columns; on tabs: Add/Rename/Delete.

---

## 12. Security

Documents are untrusted input.

- **CSP** (both webviews): `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource} blob: data:;` No `connect-src`, no `frame-src`. `'unsafe-inline'` styles are required because docx-preview injects `<style>` elements (and match the existing editors). The xlsx webview needs neither `blob:` nor `data:` and omits them.
- **No script execution from documents**: scripts only run with the nonce; inline handlers and `javascript:` URLs are blocked by CSP. Macros (`vbaProject.bin`) are never read, only copied; their presence is a notice.
- **No network**: with no `connect-src` and `img-src` limited to local/blob/data, linked (external) images, remote templates and tracking beacons in a document cannot load. Externally linked pictures show as broken images; a notice explains why.
- **altChunk** (embedded HTML/MHT) rendering is disabled (`renderAltChunks: false`).
- **HTML construction**: our webview code builds DOM with `createElement`/`textContent` only. `innerHTML` MUST NOT be used with document-derived strings anywhere in `media/docx*.js`, `media/xlsx*.js`, `media/officeCommon.js`. docx-preview's own output is the one exception and is contained by the CSP.
- **Links**: never navigated by the webview. The host accepts only `http:`, `https:`, `mailto:` and opens them with `vscode.env.openExternal` (which applies VS Code's trusted-domain prompt). Everything else is dropped. The host's `openLink` handler enforces this allow-list: any other scheme is ignored and a `notices` message tells the user the link was not opened. In-document `#bookmark` targets are handled by the webview itself and are never sent.
- **XML**: DTDs rejected (§3.3); no external entity or schema is ever fetched. Relationship targets with `TargetMode="External"` are never dereferenced by the host.
- **ZIP**: size and ratio limits are checked from the central directory before inflating (§10.2); entry names are treated as opaque keys and never used as file-system paths; nothing is extracted to disk.
- **Webview → host**: all messages validated (§5). Clipboard writes are plain text only (never HTML or other formats), via `writeClipboard` (for selections the webview copies) or written by the host from document content (`xlsxCopy`), capped by `PROTOCOL_LIMITS.MAX_CLIPBOARD`. Each `notices` message carries the full current notice list, not a delta.
- **Privacy**: no document content leaves the machine. Diagnostics (§6.5) contain part names and validator messages only.
- Workspace Trust: the viewers work in untrusted workspaces (they execute nothing from the workspace); declare this in the README rather than restricting.

---

## 13. Testing strategy

### 13.1 Harness

- New esbuild context `office-core-test`: entry `src/office/core/index.ts` → `tests/.build/office-core.cjs` (CJS, node platform, sourcemap, **not** minified, output git-ignored). `npm test` becomes `node esbuild.js --test-bundle && node --test "tests/**/*.test.{js,mjs}"`. This is why `core/` must not import `vscode`.
- Pure webview modules (`media/docxIsland.js`, `media/xlsxGridMath.js`) are UMD like `media/gltfViewerMath.js` and are required directly. DOM-dependent webview behaviour is exercised with a `node:vm` DOM shim as in `tests/findBar.test.js`.
- devDependencies for independent cross-checks only: `saxes` (a second, strict XML parser) and `exceljs` (a second xlsx reader). mammoth (arrives in Phase 6) doubles as a second docx reader; until then docx cross-checks use `saxes` plus the validators.

### 13.2 Round-trip guarantees (the definition of "not corrupting")

| Id | Guarantee | Test |
|---|---|---|
| G0 | A document with no edits is never dirty; Save As with no edits writes the original bytes. | Byte comparison. |
| G1 | **Container identity**: read → forced rewrite with no changes is **byte-identical** to the input. | Every fixture. |
| G2 | **XML identity**: for every XML part of every fixture, `serialize(parse(text)) === text`. | Every part of every fixture. |
| G3 | **Entry isolation**: after an edit, every entry outside the edit's declared touched set has identical compressed bytes, CRC and central-directory metadata. | Per operation type, with the touched set asserted exactly (e.g. Edit Cell on text → the one sheet part; first edit also `workbook.xml`, rels and content types for calcChain handling; a date typed into a General cell → the sheet part and `xl/styles.xml`). |
| G4 | **Locality**: inside a touched part, the text is identical to the original outside the smallest element(s) the operation targets. | Common prefix/suffix check against the expected element span. |
| G5 | **Undo identity**: edit → undo → serialise is byte-identical to the original; edit → undo → redo equals edit. | Per operation type; randomised sequences (seeded) of 200 operations on the mid-size fixtures. |
| G6 | **Semantic validity** of the result. | Format validators (§13.3) + independent re-read (saxes on every touched part; ExcelJS loads every edited workbook and reports the expected values/formulas). |

G1–G5 are byte-level and need no Office installation. "Semantically identical" is only invoked for G6.

### 13.3 Format validators (also run at save time, §6.5)

Docx: `w:rPr` and `w:pPr` children in schema order; every `w:numPr/w:numId` resolves to a `w:num`, every `w:num` to a `w:abstractNum`, abstractNums precede nums; every `w:pStyle`/`w:rStyle` id exists in `styles.xml`; bookmark and comment-range starts and ends balance with unique ids; no marker bookmark (`__vsmd_`) is present; `w14:paraId` values unique; every `w:tc` has a `w:p` as its last child; the number of `w:tbl`, `w:tr` and `w:tc` elements and the text of every `w:tblPr`, `w:tblGrid`, `w:trPr`, `w:tcPr` is unchanged from load (table structure is never edited).

Xlsx: rows strictly ascending by `r`, cells strictly ascending within a row and inside sheet bounds; `dimension` covers all cells; every `c/@s` < `cellXfs` count; every `t="s"` index < shared string count; merge ranges do not overlap; no `<f>` that fails to parse; shared-formula groups have exactly one master; sheet names valid and unique; every `sheet/@r:id` resolves; `definedName/@localSheetId` < sheet count; calcChain absent whenever formulas were touched. Styles (run whenever `xl/styles.xml` is a touched part): `cellXfs/@count`, when present, equals the number of `xf` children; every `xf/@numFmtId` is a built-in id (< 164) or defined in `numFmts`; every `xf/@fontId`, `@fillId`, `@borderId` is within its table and `@xfId` < the number of `cellStyleXfs/xf`; every record that existed at load is still present, at the same index, with identical text.

Both: content-type overrides and relationship targets resolve to existing parts; no orphaned part created by an operation.

### 13.4 Fixtures (`tests/fixtures/office/`, committed; mark `tests/fixtures/office/** binary` in `.gitattributes`)

Authored in real Word/Excel (Microsoft 365, Windows) unless noted, each with a one-line description in `tests/fixtures/office/README.md`:

Docx: `basic.docx` (headings, bold/italic/underline, both list kinds, nested list) · `multi-run.docx` (one paragraph with many differently formatted runs, tabs, line breaks) · `rich.docx` (table, inline and floating images, header/footer, footnotes, hyperlinks, page and section breaks) · `fields.docx` (TOC, page numbers, cross-reference, date field) · `anchors.docx` (bookmarks, comments on ranges inside paragraphs) · `tracked.docx` (insertions/deletions, Track Changes on) · `protected.docx` (read-only enforcement) · `localised-de.docx` (German Word: `berschrift1` style ids) · `no-heading-styles.docx` and `no-numbering.docx` (parts/styles absent) · `content-controls.docx` · `tables.docx` (text in cells with mixed run formatting, a list inside a cell, a nested table, `gridSpan` and `vMerge` cells, a cell ending in a nested table, a table spanning a page break, a content-control row, a tracked row insertion) · `libreoffice.docx` (written by LibreOffice) · `googledocs.docx` (exported from Google Docs) · `large.docx` (~300 pages, for performance) · `encrypted.docx` · `legacy-renamed.docx` (a .doc renamed) · `truncated.docx`.

Xlsx: `basic.xlsx` (numbers, text, booleans, errors, dates, percent, custom formats) · `styles.xlsx` (fonts, fills, borders, alignment, theme colours with tint, merged cells, frozen panes, hidden rows/columns, widths/heights) · `formulas.xlsx` (shared formulas, cross-sheet references, quoted sheet names, defined names, array formula, `_xlfn` functions, cells with no cached value) · `tables.xlsx` · `features.xlsx` (charts, image, conditional formats incl. data bars, data validation, comments, hyperlinks, sparklines, pivot table) · `date1904.xlsx` · `no-date-style.xlsx` (generated by script: styled cells, no date record in `cellXfs`; second variant `no-date-style-nocount.xlsx` without the `cellXfs/@count` attribute) and `no-styles.xlsx` (generated by script: no styles part) · `protected-sheet.xlsx`, `protected-structure.xlsx` · `inline-strings.xlsx` and `no-shared-strings.xlsx` (generated by script) · `prefixed-namespaces.xlsx` (generated by script, `x:` prefixes) · `libreoffice.xlsx` · `googlesheets.xlsx` · `large.xlsx` (200,000 cells) and `huge.xlsx` (over the edit limit; generated by script, not committed if > 5 MB — generated in the test setup instead) · `encrypted.xlsx` · `data-descriptors.xlsx` (generated by script: entries with flag bit 3) · `zip64.xlsx` (generated).

### 13.5 Verifying in real Word/Excel

Not possible in automated runs (no CI, and Office is not headless-friendly). Three layers:

1. **Release gate, manual-but-scripted** — `scripts/verify-office-open.ps1` (dev-only, Windows, requires desktop Office): for every file the edit tests write to `tests/.out/`, open through COM with repair disabled — Word `Documents.Open(path, ConfirmConversions:=$false, ReadOnly:=$true, OpenAndRepair:=$false)`, Excel `Workbooks.Open(path, CorruptLoad:=xlNormalLoad)` — and fail on any exception; for workbooks, also read back a few known cells after Excel's recalculation. Run before each release PR; record the run in `log.md`. **[Assumption]** desktop Office is installed on the release machine.
2. **Optional stronger check** — Open XML SDK `OpenXmlValidator` via a small `dotnet` script over the same outputs (schema validation without Office). Recommended, not required.
3. **Manual checklist** per release (in the plan doc): open edited fixtures in Word and Excel on Windows, Word/Excel for the web, LibreOffice, and macOS Pages/Numbers quick-look; confirm no repair prompt, edits present, untouched content visually unchanged.

---

## 14. Phases and acceptance criteria

v1 is Phases 0–4. Each phase is one or more `feature/*` branches with the usual self-reviewed PR to `develop`. Phases 1, 2+3 and 4 are each releasable.

### Phase 0 — Spike and core (no user-visible feature)

Deliver: `core/zip.ts`, `core/xml.ts`, `core/opc.ts`, `core/package.ts`, the test bundle, the first fixtures, and a throwaway webview proving the open questions.

Accept when:
- G1 and G2 pass on every fixture, including LibreOffice, Google and data-descriptor files.
- Container reader refusals (§3.2) and error classification (§10.3) are unit-tested.
- Spike report in `log.md` answers, with evidence: (a) marker-bookmark mapping finds every editable paragraph in `basic`, `rich`, `fields`, `anchors`, `libreoffice`, `googledocs`, including page-break splits; (b) `Uint8Array` transfer to the webview works and its cost for a 20 MB payload; (c) Ctrl+Z routing with a focused contenteditable inside a `CustomEditorProvider` webview; (d) docx-preview render time and memory for `large.docx`; (e) parse time and memory for `large.xlsx` against the §10.2 limits. If (a) fails, switch to the §8.2 fallback before Phase 3 starts and update this spec.

### Phase 1 — Viewers (read-only)

Deliver: both providers registered as default editors (as `CustomReadonlyEditorProvider`), everything in §7, §10.3, §11, §12; `THIRD-PARTY-NOTICES.md`; README section.

Accept when:
- Every fixture opens to either a correct view or the specified error view; none throws.
- Word: `rich.docx` shows pages, table, images, header/footer, footnotes; zoom, find and link handling work; notices list unsupported content.
- Excel: `styles.xlsx` matches Excel for widths, merges, frozen panes, fills, borders, number/date formats (compared against screenshots stored with the fixtures); scrolling `large.xlsx` stays responsive (no frame over 100 ms while scrolling on the reference machine); sheet switching, selection, status bar, copy as TSV, find.
- Light, dark, and both high-contrast themes checked; keyboard-only walkthrough and screen-reader spot check (Narrator or NVDA) done and logged.
- CSP has no violations in the webview console for any fixture; an external-image fixture makes no network request.
- No file is ever written; documents are never dirty.

### Phase 2 — Save pipeline and Excel cell editing

Deliver: `OfficeDocument` as a full `CustomEditorProvider`, §6 in full, Edit mode, §9.2–9.5, paste, clear.

Accept when:
- G0, G3, G4, G5, G6 pass for Edit Cell (each input kind in §9.3), Clear, Paste, formula entry, shared-formula materialisation.
- Date entry (§9.3.1): a date typed into a General cell is a number with a date format in Excel and in ExcelJS (the cell reads back as a `Date`); the touched set is exactly the sheet part plus `xl/styles.xml`; every pre-existing `xf` is byte-identical and at the same index; a second date in a like-styled cell appends nothing; a styled General cell keeps its font/fill/border; date-formatted, currency-formatted and Text-formatted targets leave `styles.xml` untouched; `no-styles.xlsx` falls back to text with the notice; `date1904.xlsx` stores the 1904 serial; undo restores `styles.xml` byte for byte.
- Save, Save As, Revert, hot exit (backup → kill window → restore dirty state), undo/redo to the saved point (document becomes clean) work in an Extension Development Host; evidence logged.
- Conflict-on-save, locked-file-on-save and verification-failure paths are exercised (the last via a test hook that corrupts the output in memory) and leave the on-disk file untouched.
- `verify-office-open.ps1` passes on all outputs; edited workbooks recalculate in Excel with correct values.

### Phase 3 — Word editing

Deliver: §8 in full.

Accept when:
- G3–G6 pass for: text edit within a multi-run paragraph (untouched runs byte-identical), b/i/u on a partial selection, toggling off inherited bold in a heading, split, merge, insert, remove, each style, each list operation (joining an existing Word list, starting a new numbered list that restarts at 1, creating `numbering.xml` and heading styles from nothing).
- Preservation tests: editing a paragraph in `anchors.docx` keeps every bookmark and comment (comment still present and attached in Word); select-all-and-type in a paragraph with an image keeps the image; `tracked.docx` and `fields.docx` (TOC) paragraphs are locked; `localised-de.docx` headings are recognised.
- Table cells (`tables.docx`): editing text in a cell keeps every other cell, `w:tblPr`/`w:tblGrid`/`w:trPr`/`w:tcPr` and the table's element counts byte-identical (G4 on the one `w:p`); split and merge stay inside the cell; the only paragraph of a cell, and a cell's last paragraph after a nested table, cannot be removed; merge across a cell boundary is refused; `vMerge` continuation cells are locked (`merged-cell`) and get no markers; nested-table cell paragraphs map and edit correctly; marker mapping never assigns a table's `<p>` to a surrounding body paragraph; Tab moves between cells.
- Typing latency: no docx-preview re-render while an island has focus; caret never jumps (manual check on `large.docx`, logged).
- `verify-office-open.ps1` passes on all outputs.

### Phase 4 — Excel structure

Deliver: §9.6 and §9.7.

Accept when:
- G3–G6 pass for insert/delete rows and columns (start, middle, end; through merges, tables, conditional formats, validations, defined names, cross-sheet formulas) and add/rename/delete sheet.
- Every Tier B condition has a test proving the operation is refused and the package unchanged; every Tier C condition shows its confirmation.
- Reference-shifting unit tests cover: relative/absolute/mixed, ranges growing/shrinking/`#REF!`, whole rows/columns, quoted sheet names, references inside strings (untouched), structured and external references (untouched).
- In Excel, after insert/delete: formulas, merges, table extents, names and conditional formats match what Excel itself produces for the same operation on the same fixture (golden comparison of formulas and ranges, prepared once by hand and stored with the fixtures).

### Post-v1

Recommended order: 5, 6, 7, 8. This differs from the brief in one respect — **Excel range → Markdown table is moved first**. It is a formatting function over a selection the grid already has (a day's work, no new dependency), it serves this extension's core Markdown audience immediately, and it does not depend on any other phase. The other three keep their requested order.

**Phase 5 — Excel sheet/range → Markdown table.** "Copy as Markdown table" (selection) and command "Convert Sheet to Markdown…" (used range → clipboard, or a new `.md`). Uses display strings; first row as header (option to synthesise `A, B, C…`); alignment from cell alignment or numeric type; `|` and newlines escaped; merged cells repeat nothing (value in the top-left cell only); cap 5,000 rows with a warning. Accept: output renders correctly in this extension's Markdown preview for `basic`, `styles`, `tables` fixtures; pipe/newline escaping unit-tested.

**Phase 6 — Word → Markdown.** Command "Convert Word Document to Markdown…" (explorer context menu for `.docx`, and the viewer toolbar). mammoth in the host (`convertToHtml` on the current in-memory bytes, so unsaved edits are included) → turndown with the existing table rules (`media/turndownTableRules.js`) → `<stem>.md` beside the source (prompt before overwrite), images written to `<stem>.assets/` and linked relatively (option: skip images). Headings, emphasis, lists, links, tables, footnotes, images. Accept: `basic`, `rich`, `localised-de` convert with headings/lists/tables/images intact; result opens in the Markdown editor; no network access; conversion warnings from mammoth surfaced in an output channel.

**Phase 7 — Markdown → Word.** Command "Export Markdown as Word Document…". markdown-it tokens (host) → `docx` library → `<stem>.docx`. Headings (real Heading styles), paragraphs, bold/italic/strike/inline code, links, nested bullet/numbered lists (real numbering), block quotes, code blocks (monospace, shaded), tables, local images, horizontal rules, task list items (☐/☑). Wikilinks become plain text. Mermaid blocks export as code in the first cut; rasterising them (the Mermaid editor already exports PNG through its webview) is a follow-up. Accept: output passes `verify-office-open.ps1` and the docx validators; round trip Markdown → Word → Markdown (Phase 6) preserves structure for the sample documents; the exported file opens in this extension's viewer.

**Phase 8 — Office files in wikilinks, backlinks and graph.** `[[report.docx]]`, `[[budget.xlsx]]`.
- Index: extend `FileIndexService` with a second, content-free entry kind (`kind: 'markdown' | 'office'` on `FileEntry`; office entries have empty `content`, `outgoingLinks`, `tags`). Scan `**/*.{docx,xlsx}` with the same `buildFindFilesExclude(getExcludePatterns())` call — remember an explicit `findFiles` exclude **replaces** `files.exclude`, which is exactly what `src/fileExclusions.ts` compensates for — and additionally skip names starting with `~$`. Pair `createFileSystemWatcher('**/*.{docx,xlsx}')` with the workspace file events, as the Markdown index does. Never read Office file contents during indexing.
- Resolution: an Office file resolves **only when the link includes its extension**. Keep a separate lower-cased `fileName → relativePath` map; `resolveWikilinkTarget` checks it before stripping `.md`/`.markdown`. Bare `[[report]]` keeps resolving to Markdown only, so existing links cannot change meaning and `report.docx` vs `report.xlsx` is never ambiguous. Backlinks are keyed by the lower-cased full file name.
- Autocomplete lists Office files with their extension and a type badge; `openWikilink` uses `vscode.open`, which lands in these viewers.
- Graph: `GraphNode` gains `kind`; Office nodes get a distinct shape/colour and a "Show Office files" filter (default on). Office nodes have incoming edges only.
- Rename propagation: renaming an Office file rewrites `[[old.docx]]` → `[[new.docx]]` in Markdown through the existing `onWillRenameFiles` `WorkspaceEdit`.
- The viewers gain a "Linked from" list (backlinks) in the toolbar overflow.
- Non-goals: links *from* Office documents, unlinked-mention search inside Office files, deep links to sheets/ranges or headings (`[[book.xlsx#Sheet2!A1:C5]]`), a sidebar tab for Office files.
- Accept: links resolve, autocomplete, backlinks and graph update on create/delete/rename done inside and outside VS Code; worktree copies under `.claude/worktrees` and `~$` lock files never appear; indexing 1,000 Office files adds no file reads.

---

## 15. Explicit non-goals for v1 (consolidated)

`.doc`, `.xls`, `.xlsm`, `.xltx`, `.dotx`, `.docm`, `.csv`, `.pptx` · creating new Office files · opening password-protected files · repairing damaged files · a calculation engine · co-authoring or OneDrive/SharePoint awareness · printing/PDF · web (browser) extension host · cell or text formatting beyond bold/italic/underline in Word · everything listed under "Non-goals" in §7, §8.8 and §9.7.

---

## 16. Assumptions, open questions and risks

Assumptions not verified (owner: Phase 0 unless noted):

1. Typed arrays are transferred to webviews efficiently by VS Code ≥ 1.85 (else base64; affects large-document render latency only). **[Verified Phase 0 S2]** 20 MB round trip ≈ 0.33 s; arrives as `Uint8Array` both directions.
2. Ctrl+Z/Ctrl+Y can be kept local to a focused island/cell editor in a custom-editor webview (else: in-progress text undo is unavailable and Ctrl+Z undoes the last committed edit, cancelling the in-progress one — acceptable but worse). Phase 0 S3: automated synthetic-key check inconclusive; awaiting a manual run by the user. If any guarded case fails, the documented fallback applies.
3. docx-preview's bookmark-to-`<span id>` behaviour holds for all fixture producers. **[Verified Phase 0 S1]** on Word-produced and synthetic inputs (body, cells to depth 3, page-break splits) with the §8.2 trailing-break rule and hidden-marker CSS. LibreOffice/Google files pending.
4. The §10.2 thresholds; they are estimates. **[Verified Phase 0 S4]** 286-page docx renders < 1 s; 200k-cell sheet parses ≈ 0.5 s, heap +100 MB. Thresholds unchanged.
5. Bundle-size estimates for mammoth and `docx` (Phases 6–7).
6. Desktop Word/Excel is available on the release machine for `verify-office-open.ps1`.
7. Orphaned shared strings and a stale `docProps/app.xml` are harmless to Excel, and a missing `calcChain.xml` is rebuilt silently. High confidence from the file format's behaviour in practice; confirmed for real only by the Phase 2 COM check.
8. Word accepts a paragraph whose `w14:paraId` is absent and runs without `w:rsid*`. High confidence (both are optional).
9. `numfmt` 4.x and `@borgar/fx` 5.x are published as `"type": "module"` packages **[Verified on the registry 2026-11-20]**; `@borgar/fx` declares no `main`, but both packages' `exports` carry `require` conditions with `.d.cts` types, so under Node16 resolution TypeScript resolves them as CommonJS. **[Verified Phase 0 S6]** `tsc --noEmit` passes with the repo's unchanged `tsconfig.json`.
10. Fixtures "authored in real Word/Excel" are produced by driving desktop Word/Excel through COM from a script (both are installed on the development machine **[Verified 2026-11-20]**), not by hand. LibreOffice is not installed there, and Google exports cannot be scripted: `libreoffice.docx`, `libreoffice.xlsx`, `googledocs.docx`, `googlesheets.xlsx` and a real German-Word `localised-de.docx` have to be supplied by the user (plan WP-03).

Resolved decisions (user, 2026-11-20) — these were open questions Q1–Q7 in the draft:

| # | Question | Decision | Where specified |
|---|---|---|---|
| Q1 | Cached value of an edited formula cell | **Accepted as specced.** The edited formula cell drops its cached value and shows "not calculated"; every other cell keeps its cached result. | §9.5 |
| Q2 | Dates typed into non-date cells | **Yes, in v1.** Stored as real serial dates; a General cell gets a built-in date format by appending (or reusing) one `xf` in `styles.xml`. This is the only style change the editor makes. | §9.3, §9.3.1, §13.3 |
| Q3 | Text in Word table cells | **Promoted to v1.** Paragraphs inside `w:tc` are editable with the same paragraph machinery, at any nesting depth. No row/column/cell add, remove or merge. Headers, footers, footnotes, endnotes, text boxes and content controls stay read-only. | §5.1, §8.1, §8.2, §8.5, §8.8, §11.3, §13.3 |
| Q4 | Default mode | **Accepted.** View by default with an explicit Edit toggle (`startInEditMode` to change). | §6.4 |
| Q5 | Tier C (charts, pivot sources, drawings that will not follow inserted/deleted rows and columns) | **Accepted.** Warn and allow. | §9.6 |
| Q6 | Post-v1 order | **Accepted.** Phase 5 (Excel range → Markdown table) first, then 6, 7, 8. | §14 |
| Q7 | Sidebar tab for Office files | **Accepted as specced: none.** Office files appear in autocomplete, backlinks and the graph only. | §14 Phase 8 |

Risks:

- **Own ZIP writer and XML parser** are the foundation and are new code. Mitigations: G1/G2 on every fixture, verify-before-write on every save, refusal rather than best effort on anything unusual. If G1 cannot be met for some producer's files, those files open view-only.
- **docx-preview fidelity** is good, not exact; users will compare it with Word. The notices and the "Open in Word" button set expectations. The library is a single-maintainer project; the version is pinned.
- **Editing appearance** inside a Word island is approximate until the next re-render.
- **Stale formula values** after edits are inherent to having no calc engine; mitigated by the banner, the stale marker and `fullCalcOnLoad`. Tools that read cached values without recalculating (pandas, previewers) will see old results until Excel re-saves.
- **Structural edits** (§9.6) are the highest-risk feature for silent semantic damage; hence Tier B/C and their own phase with Excel-produced golden files.
- **Extension size**: v1 adds roughly 175 KB of webview vendor files and about 140 KB (minified, measured Phase 0 S5) to the host bundle; mermaid alone is 5.5 MB today, so this is immaterial. Phases 6–7 add about 0.65 MB.
- **Becoming the default editor for `.docx`/`.xlsx`** changes what happens when users click those files (today VS Code offers to open them externally) and will collide with other Office viewer extensions; call it out in the CHANGELOG and README, and consider a `vscodeMdEditor.office.enabled`-style opt-out only if feedback demands it (editor associations already let users switch).
- **Host responsiveness** on very large files depends on the chunked parsing rule (§10.2); a worker thread is the escape hatch.
