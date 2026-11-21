// Limits from spec §9.3 (spike S4, 2026-11-21: limits unchanged, memory budget restated).
// Tunable in one place. No 'vscode' import anywhere under src/pdf/core.
const MB = 1024 * 1024;

export const PDF_LIMITS = {
  /** Refuse to open (error view, "Open externally"): file larger than this. */
  maxFileBytes: 500 * MB,
  /** Opens with a "large file" notice; thumbnails are not pre-rendered. */
  largeFileBytes: 150 * MB,
  /** View-only (`too-large`): file larger than this ... */
  maxEditFileBytes: 100 * MB,
  /** ... or with more pages than this. */
  maxEditPages: 20_000,

  /** Strict reader: more cross-reference entries than this is not editable (`unsupported-structure`). */
  maxXrefEntries: 5_000_000,
  /** Strict reader: object nesting deeper than this is not editable. */
  maxObjectNesting: 200,
  /** Strict reader: a /Prev chain longer than this (or with a cycle) is not editable. */
  maxRevisions: 2_000,
  /** Strict reader: an object stream inflating to more than this is not editable. */
  maxObjectStreamBytes: 64 * MB,
  /** Strict reader: a dictionary of more than this many bytes of tokens is not editable. */
  maxDictionaryBytes: 4 * MB,

  /**
   * Classification work budget (spec §6.2): the strict reader may lex/decode at most
   * classifyWorkFactor x file size + classifyWorkBaseBytes, and classification may take at most
   * classifyTimeBaseMs + classifyTimePerMbMs per MB; beyond either the file is view-only (`too-large`).
   */
  classifyWorkFactor: 4,
  classifyWorkBaseBytes: 64 * MB,
  classifyTimeBaseMs: 10_000,
  classifyTimePerMbMs: 100,

  /** Writer result larger than the loaded size plus this fails verification. */
  maxWriteGrowthBytes: 64 * MB,

  /** Webview memory budget while viewing: <= viewMemoryFactor x file size + memoryBaseBytes. */
  viewMemoryFactor: 1.5,
  /** Transient webview peak while saving: <= saveMemoryFactor x file size + memoryBaseBytes. */
  saveMemoryFactor: 9,
  memoryBaseBytes: 300 * MB,

  /** Host-side work over this size yields to the event loop. */
  asyncParseThresholdBytes: 2 * MB,
  /** Maximum time between event-loop yields, in milliseconds. */
  yieldIntervalMs: 30,
} as const;

export type PdfLimits = typeof PDF_LIMITS;
