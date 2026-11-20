# Office test fixtures

Committed binaries (`.gitattributes`: `tests/fixtures/office/** binary`), each <= 5 MB. Regenerate with:

```
pwsh scripts/office-fixtures/make-word.ps1       # real Word, via COM  (needs desktop Word)
pwsh scripts/office-fixtures/make-excel.ps1      # real Excel, via COM (needs desktop Excel)
node scripts/office-fixtures/make-synthetic.mjs  # run AFTER the two above (derives from basic.docx / basic.xlsx)
```

Both PowerShell scripts take `-Only name,name` to regenerate a subset and `-OutDir`.
Office output is not byte-reproducible (timestamps, revision dates, random bookmark / content-control ids, `w14:paraId`);
compare unzipped content, ignoring `docProps/*` and those ids. The synthetic generator IS byte-deterministic.
Password for `encrypted.docx` / `encrypted.xlsx`: `test`.
`huge.xlsx` (over the xlsx edit limit) is never committed: tests call `makeHugeXlsx(dir)` exported by `make-synthetic.mjs`.

## Docx (Word, Microsoft 365)

| File | Producer | Exercises |
|---|---|---|
| `basic.docx` | Word COM | Title, headings 1-3, bold/italic/underline runs, bullet list, numbered list with a nested level |
| `multi-run.docx` | Word COM | One paragraph of many differently formatted runs, tabs, a soft line break |
| `rich.docx` | Word COM | Table, inline picture, floating picture, header/footer, footnote, hyperlink, page break, section break |
| `fields.docx` | Word COM | TOC, PAGE field, cross-reference, DATE field (cached result fixed to "1 January 2020") |
| `anchors.docx` | Word COM | Bookmarks and comments on ranges inside paragraphs |
| `tracked.docx` | Word COM | Insertions and deletions, Track Changes left on (author "Fixture Author") |
| `protected.docx` | Word COM | `documentProtection` read-only enforcement (no password) |
| `no-heading-styles.docx` | Word COM | Normal paragraphs only; no Heading styles used |
| `no-numbering.docx` | Word COM | No lists, so no `numbering.xml` |
| `content-controls.docx` | Word COM | Inline rich/plain/dropdown/checkbox controls and a block-level control |
| `tables.docx` | Word COM (+ flat-OPC `InsertXML` for table 5) | Mixed run formatting in cells, list in a cell, nested table (the cell ends with the mandatory empty paragraph after it), `gridSpan` and `vMerge` cells, content-control row (repeating section: `w:sdt` around `w:tr`), 70-row table spanning pages, tracked row insertion (`w:trPr/w:ins`) |
| `large.docx` | Word COM | About 300 pages (48 chapters) for performance |
| `encrypted.docx` | Word COM | Password-protected (OLE container); password `test` |
| `legacy-renamed.docx` | Word COM | A Word 97-2003 `.doc` saved with a `.docx` extension |
| `truncated.docx` | make-synthetic | First 60 % of `basic.docx` |
| `external-image.docx` | make-synthetic | `basic.docx` plus a picture with `TargetMode="External"` pointing at `http://127.0.0.1:9/x.png` (CSP / no-network check) |
| `localised-de.synthetic.docx` | make-synthetic | `basic.docx` with heading style ids rewritten to `berschrift1..` (stand-in for the real German file) |

## Xlsx (Excel, Microsoft 365)

| File | Producer | Exercises |
|---|---|---|
| `basic.xlsx` | Excel COM | Numbers, text (incl. non-ASCII), booleans, constant errors, dates, time, percent, currency, custom formats; second sheet "Second Sheet" |
| `styles.xlsx` | Excel COM | Fonts, fills, theme colours with tint, borders, alignment, merged cells, frozen panes, hidden row/column, widths/heights |
| `formulas.xlsx` | Excel COM | Shared formulas, cross-sheet refs, quoted sheet names, defined names (global + sheet-scoped), legacy array formula, `_xlfn` functions, sheet `NoCache` whose formula cells have their cached `<v>` stripped (post-processed) |
| `tables.xlsx` | Excel COM | Two tables, calculated column, totals row |
| `features.xlsx` | Excel COM | Chart, image, conditional formats (data bar, colour scale, icon set, cell value), data validation, note, hyperlinks, sparklines, pivot table |
| `date1904.xlsx` | Excel COM | `date1904="1"` workbook with date cells |
| `protected-sheet.xlsx` | Excel COM | Sheet protection (no password) |
| `protected-structure.xlsx` | Excel COM | Workbook structure protection (no password) |
| `large.xlsx` | Excel COM | 200,000 cells (4000 x 50) |
| `encrypted.xlsx` | Excel COM | Password-protected; password `test` |
| `no-date-style.xlsx` | make-synthetic | Styled cells, `cellXfs` with `count` and no date record |
| `no-date-style-nocount.xlsx` | make-synthetic | Same, `cellXfs` without `count` |
| `no-styles.xlsx` | make-synthetic | No styles part, content type or relationship |
| `inline-strings.xlsx` | make-synthetic | `t="inlineStr"` cells, no shared strings |
| `no-shared-strings.xlsx` | make-synthetic | No sharedStrings part; text only via `t="str"` formula results |
| `prefixed-namespaces.xlsx` | make-synthetic | `x:` prefixed main namespace on workbook, sheet and shared strings |
| `data-descriptors.xlsx` | make-synthetic | Every entry written with general-purpose flag bit 3 (data descriptor) |
| `zip64.xlsx` | make-synthetic | `basic.xlsx` with a ZIP64 EOCD record and locator inserted (must be refused; JSZip cannot read it either) |

`expected/styles.pdf`: Excel `ExportAsFixedFormat` of `styles.xlsx`, the visual reference for Gate R1.

## PENDING: user-supplied producer files

The tests print a warning (not a failure) while these are missing. Until `localised-de.docx` arrives the synthetic German file stands in.

| File | Recipe |
|---|---|
| `libreoffice.docx` | Open `basic.docx` in LibreOffice Writer, File > Save As, type "Word 2007-365 (.docx)", Keep format. |
| `libreoffice.xlsx` | Open `basic.xlsx` in LibreOffice Calc, File > Save As, type "Excel 2007-365 (.xlsx)", Keep format. |
| `googledocs.docx` | Upload `basic.docx` to Google Drive, open with Google Docs, File > Download > Microsoft Word (.docx). |
| `googlesheets.xlsx` | Upload `basic.xlsx` to Google Drive, open with Google Sheets, File > Download > Microsoft Excel (.xlsx). |
| `localised-de.docx` | In a German-language Word, create a document with a Title and "Überschrift 1/2/3" paragraphs (built-in styles, so style ids are `berschrift1`...), a normal paragraph and a list; save as `.docx`. |

Drop each file into this folder under exactly that name.
