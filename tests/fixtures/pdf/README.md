# PDF test fixtures

Committed binaries (`.gitattributes`: `tests/fixtures/pdf/** binary`), each <= 5 MB. Regenerate with:

```
node scripts/pdf-fixtures/make-synthetic.mjs [--out <dir>] [name.pdf ...]   # everything "generated" below
node scripts/pdf-fixtures/make-signed.mjs                                    # signed.pdf (needs openssl on PATH)
pwsh scripts/pdf-fixtures/make-producers.ps1 [-Only word,chrome]            # word.pdf (desktop Word), chrome.pdf (Edge)
```

`make-synthetic.mjs` is byte-deterministic (fixed dates, no random ids) except the two encrypted files (random file id and salts).
`jpx-jbig2.pdf` needs Python with Pillow (JPEG 2000 encoder) to regenerate. `make-signed.mjs` creates a throwaway self-signed
certificate in the OS temp dir at run time and deletes it; no key or certificate is committed, and the signature is untrusted
by design. `make-producers.ps1` starts its own hidden Word instance (never attaches to a running Word, always quits it) and
uses a throwaway Edge profile. Producer output is not byte-reproducible.

Password for `encrypted-user.pdf` and `encrypted-owner.pdf`: `test`. `huge.pdf` (over the 100 MB edit limit) is never committed:
tests call `makeHugePdf(dir)` exported by `make-synthetic.mjs`.

Page counts below are asserted by `tests/pdf/fixturesOpen.test.mjs` (pdf.js, Node).

## Generated (`make-synthetic.mjs`)

| File | Pages | Exercises |
|---|---|---|
| `basic.pdf` | 2 | Text, classic xref table, Helvetica / Times-Bold |
| `xref-stream.pdf` | 3 | Object streams and a cross-reference stream |
| `multi-revision.pdf` | 2 | `basic` plus two appended incremental revisions (Info dictionary replaced each time) |
| `outline.pdf` | 3 | Nested bookmarks (named and explicit destinations, a `GoTo` action), name tree of destinations, page-1 links: named dest, explicit dest, `https:` URI, `javascript:` URI (must be dropped), Launch action (must be dropped) |
| `forms.pdf` | 2 | AcroForm: text, multiline, MaxLen, comb, read-only, checkbox, radio group, dropdown, list box, an unsigned signature field |
| `forms-js.pdf` | 1 | Field calculation (`/AA /C`, `/CO`), format and keystroke scripts |
| `annotated.pdf` | 2 | Existing Highlight, Underline, Text note, Ink (each with a Popup), FreeText, Link |
| `rotated.pdf` | 4 | `/Rotate` 0/90/180/270, mixed page sizes, two CropBoxes |
| `attachments.pdf` | 1 | Three embedded files (one with an awkward name) |
| `encrypted-user.pdf` | 2 | RC4/AES user password `test` (owner `owner-secret`): password prompt, wrong-password retry |
| `encrypted-owner.pdf` | 2 | Empty user password, owner password `test`, restricted permissions: opens without a prompt, not editable |
| `scanned.pdf` | 3 | Image-only pages (1-bit Flate), no text layer: "scanned" notice |
| `cjk.pdf` | 1 | Non-embedded CJK fonts (UniJIS / UniGB CMaps) |
| `base14.pdf` | 1 | Non-embedded standard fonts including Symbol and ZapfDingbats |
| `jpx-jbig2.pdf` | 1 | A JPEG 2000 image and a JBIG2 (MMR) image: the wasm decoders |
| `tagged.pdf` | 1 | Structure tree (Document, H1, P, P), `MarkInfo`, `Lang` |
| `js-openaction.pdf` | 1 | `OpenAction`, document-level and page-open JavaScript that would raise an alert if run (`JS-OPENACTION-RAN`, `JS-DOC-LEVEL-RAN`); nothing must run |
| `hybrid-xref.pdf` | 2 | Classic table plus `/XRefStm`; page 2 exists only in an object stream |
| `large.pdf` | 2000 | Two lines per page, object streams: scrolling and virtualisation (about 1 MB) |
| `truncated.pdf` | - | First 700 bytes of `basic.pdf`: error view (`InvalidPDFException`) |
| `not-a-pdf.pdf` | - | Plain text with a `.pdf` name: error view |
| `empty.pdf` | - | Zero bytes: error view |
| `broken-xref.pdf` | 2 | `basic.pdf` with a wrong `startxref` and shifted offsets: opens through pdf.js recovery, not editable |

## Real producers

| File | Pages | Producer | Exercises |
|---|---|---|---|
| `word.pdf` | 2 | Word COM `ExportAsFixedFormat`, structure tags on, bookmarks from headings | Tagged PDF, outline, table, list, hyperlink, embedded subset fonts |
| `chrome.pdf` | 6 | Edge headless `--print-to-pdf` | Skia/Chromium producer: embedded fonts, link, table, many pages |
| `signed.pdf` | 1 | `make-signed.mjs`, throwaway self-signed certificate | One approval signature (`adbe.pkcs7.detached`, SHA-256), no later changes |

## PENDING: supplied by the user (not yet present; `fixtures.test.mjs` warns)

| File | Needed before | Notes |
|---|---|---|
| `acrobat-forms.pdf` | Gate P4 | Form authored in Adobe Acrobat |
| `acrobat-annotated.pdf` | Gate P3 | Annotations made in Acrobat |
| `acrobat-signed.pdf` | Gate P3 | Signed in Acrobat (signed, non-certified) |
| `certified.pdf` | Gate P3 | Certified with DocMDP "no changes" |
| `linearized.pdf` | Gate P1 | Fast-web-view file |
| `xfa.pdf` | Gate P1 | Real XFA form |
| `scanner.pdf` | Gate P1 | From a scanner (image plus OCR text layer, or image only) |
| `latex.pdf` | Gate P1 | LaTeX-produced (Type 1 / OpenType fonts, hyperref links) |

The ten everyday PDFs for the spike corpus are not committed and are not listed here.
