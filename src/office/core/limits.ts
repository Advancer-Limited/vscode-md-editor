// Size limits from spec §10.2. Tunable in one place (values may be adjusted after the WP-01 S4 spike).
const MB = 1024 * 1024;

export const LIMITS = {
  /** Refuse to open: file larger than this. */
  maxFileBytes: 250 * MB,
  /** Refuse to open: declared uncompressed total larger than this. */
  maxUncompressedTotalBytes: 1024 * MB,
  /** Refuse to open: any single entry declared larger than this. */
  maxEntryBytes: 400 * MB,

  /** docx: document.xml larger than this (uncompressed) is view-only (`too-large`). */
  docxMaxDocumentXmlBytes: 20 * MB,
  /** docx: more blocks than this (all containers, table-cell paragraphs included) is view-only. */
  docxMaxBlocks: 20_000,
  /** docx: file larger than this opens with a "large document" notice; re-render on idle only. */
  docxLargeFileBytes: 60 * MB,

  /** xlsx: any worksheet part larger than this (uncompressed) makes the whole workbook view-only. */
  xlsxMaxSheetXmlBytes: 64 * MB,
  /** xlsx: more non-empty cells than this in a sheet makes the whole workbook view-only. */
  xlsxMaxCells: 500_000,
  /** xlsx: rows shown (with a truncation banner) for a sheet over the limits above. */
  xlsxTruncatedRows: 50_000,
  /** xlsx: a worksheet part larger than this is not loaded (placeholder with "Open in Excel"). */
  xlsxSkipSheetXmlBytes: 300 * MB,

  /** Host-side parsing above this size must yield to the event loop (chunked async). */
  asyncParseThresholdBytes: 2 * MB,
  /** Maximum time between event-loop yields while parsing, in milliseconds. */
  parseYieldMs: 30,

  /**
   * XML: element nesting deeper than this is malformed. Real OOXML nests a few dozen levels (deeply
   * nested tables with content controls and AlternateContent stay well under 200); the cap bounds
   * the parser's stack and the tree depth that later recursion-free walks have to handle.
   */
  xmlMaxDepth: 10_000,
  /**
   * XML: more attributes (namespace declarations included) than this on one start tag is malformed.
   * The busiest real start tags (a Word document.xml root, ~40 xmlns declarations; a cell or run
   * properties element, < 20 attributes) are two orders of magnitude below it.
   */
  xmlMaxAttributes: 4_096,
} as const;
