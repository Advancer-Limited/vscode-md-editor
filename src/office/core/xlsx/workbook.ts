// Workbook read model (spec §9.1, §10.2).
//
// `Workbook.load` reads only `xl/workbook.xml` (found through `_rels/.rels`, never by path) and its
// relationships. Worksheet parts are parsed on first use (`sheet(id)`, async, cached). The shared
// strings part is read on first need. Chartsheets and other non-worksheet sheets are listed but
// never parsed.
//
// Sheet ids are session-stable numbers assigned here in tab order (1, 2, …); they are NOT the tab
// index and NOT the file's `sheetId` (that is `fileSheetId`). Code that adds sheets later takes the
// next id from `allocateSheetId()`.
//
// No `vscode` import here (core rule).

import type { ReadOnlyReason } from '../types.js';
import { LIMITS } from '../limits.js';
import type { OfficePackage } from '../package.js';
import { zipLimits } from '../package.js';
import { readZip } from '../zip.js';
import { attr, child, childrenOf } from '../xml.js';
import { mainPart, partNameFromTarget, readRelationships } from '../opc.js';
import type { Relationship } from '../opc.js';
import { OfficeLoadError } from '../sniff.js';
import { SharedStrings, isMainNs } from './sharedStrings.js';
import { Sheet } from './sheet.js';

export interface SheetEntry {
  id: number; name: string; part: string | null; kind: 'worksheet' | 'chartsheet' | 'other';
  state: 'visible' | 'hidden' | 'veryHidden'; rId: string; fileSheetId: number;
}

/** Why `Workbook.sheet(id)` could not produce a Sheet. */
export type SheetLoadFailure = 'unknown-sheet' | 'not-worksheet' | 'missing-part' | 'too-large' | 'damaged';

export class SheetLoadError extends Error {
  readonly failure: SheetLoadFailure;
  constructor(failure: SheetLoadFailure, message: string) {
    super(message);
    this.name = 'SheetLoadError';
    this.failure = failure;
  }
}

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_R_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const REL_BASES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/',
];

/** Short relationship type ('worksheet', 'sharedStrings', …) for the transitional and Strict URIs. */
function relKind(type: string): string | undefined {
  for (const base of REL_BASES) if (type.startsWith(base)) return type.slice(base.length);
  return undefined;
}

const truthy = (v: string | undefined): boolean => v === '1' || v === 'true';

export class Workbook {
  readonly pkg: OfficePackage;
  /** The main part (`xl/workbook.xml` in practice), in package case. */
  readonly workbookPart: string;
  readonly date1904: boolean;
  /** `workbookProtection/@lockStructure`: add/rename/delete sheet are disabled; cells stay editable (§9.1). */
  readonly structureLocked: boolean;
  /** Styles / theme / shared strings parts from the workbook relationships, or null. */
  readonly stylesPart: string | null;
  readonly themePart: string | null;
  readonly sharedStringsPart: string | null;
  sheets: SheetEntry[];

  private nextSheetId: number;
  private sst: SharedStrings | null = null;
  private readonly loaded = new Map<number, Promise<Sheet>>();
  private readonly loadedSheets = new Map<number, Sheet>();
  private entrySizes: Map<string, number> | null = null;

  private constructor(pkg: OfficePackage) {
    this.pkg = pkg;
    const main = mainPart(pkg);
    this.workbookPart = main.name;
    const root = pkg.xml(main.name).root;
    if (root.local !== 'workbook' || !isMainNs(root.ns)) {
      throw new OfficeLoadError('damaged', `${main.name}: root element is not a SpreadsheetML workbook`);
    }
    const ns = root.ns;
    const pr = child(root, ns, 'workbookPr');
    this.date1904 = pr ? truthy(attr(pr, '', 'date1904')) : false;
    const prot = child(root, ns, 'workbookProtection');
    this.structureLocked = prot ? truthy(attr(prot, '', 'lockStructure')) : false;

    const rels = readRelationships(pkg, main.name);
    const byId = new Map<string, Relationship>(rels.map((r) => [r.id, r]));
    const firstOf = (kind: string): string | null => {
      const r = rels.find((x) => !x.external && relKind(x.type) === kind);
      return r ? this.resolve(r) : null;
    };
    this.stylesPart = firstOf('styles');
    this.themePart = firstOf('theme');
    this.sharedStringsPart = firstOf('sharedStrings');

    const sheetsEl = child(root, ns, 'sheets');
    if (!sheetsEl) throw new OfficeLoadError('damaged', `${main.name}: no sheets element`);
    this.sheets = [];
    let id = 1;
    for (const el of childrenOf(sheetsEl, ns, 'sheet')) {
      const rId = attr(el, NS_R, 'id') ?? attr(el, NS_R_STRICT, 'id') ?? '';
      const rel = byId.get(rId);
      const k = rel ? relKind(rel.type) : undefined;
      const kind: SheetEntry['kind'] = k === 'worksheet' ? 'worksheet' : k === 'chartsheet' ? 'chartsheet' : 'other';
      const part = rel && !rel.external ? this.resolve(rel) : null;
      const st = attr(el, '', 'state');
      const fileSheetId = Number(attr(el, '', 'sheetId'));
      this.sheets.push({
        id: id++,
        name: attr(el, '', 'name') ?? '',
        part,
        kind,
        state: st === 'hidden' ? 'hidden' : st === 'veryHidden' ? 'veryHidden' : 'visible',
        rId,
        fileSheetId: Number.isInteger(fileSheetId) ? fileSheetId : 0,
      });
    }
    this.nextSheetId = id;
  }

  /** Read the workbook part of an xlsx package. Throws OfficeLoadError('damaged') for a malformed workbook. */
  static load(pkg: OfficePackage): Workbook {
    if (pkg.kind !== 'xlsx') throw new Error(`Workbook.load: package is ${pkg.kind}, not xlsx`);
    return new Workbook(pkg);
  }

  /** Internal part name for a relationship, in package case; null when it is missing from the package. */
  private resolve(rel: Relationship): string | null {
    let name: string;
    try { name = partNameFromTarget(this.workbookPart, rel.target); } catch { return null; }
    if (!this.pkg.has(name)) return null;
    const key = name.toLowerCase();
    return this.pkg.partNames().find((n) => n.toLowerCase() === key) ?? name;
  }

  /** A new session-stable sheet id (for sheets added later). */
  allocateSheetId(): number {
    return this.nextSheetId++;
  }

  /**
   * Why the whole workbook cannot be edited, or null: the package's reason (strict, UTF-16, macro
   * content type, a worksheet part > 64 MB), else `too-large` once any loaded sheet is over the
   * §10.2 cell limit. Sheet-level reasons (`protected`, layout) are on `Sheet.readOnlyReason`.
   */
  get viewOnlyReason(): ReadOnlyReason | null {
    if (this.pkg.viewOnlyReason) return this.pkg.viewOnlyReason;
    for (const s of this.loadedSheets.values()) if (s.overLimits) return 'too-large';
    return null;
  }

  /** Shared string `i` (plain text), or '' when out of range. */
  sharedString(i: number): string {
    return this.sharedStrings().get(i) ?? '';
  }

  /** The shared strings table, read on first use (empty when the workbook has none). */
  sharedStrings(): SharedStrings {
    if (!this.sst) {
      this.sst = this.sharedStringsPart ? SharedStrings.parse(this.pkg.xml(this.sharedStringsPart)) : SharedStrings.empty();
    }
    return this.sst;
  }

  /** Drop the cached shared strings so the next read re-parses the part (after a write to it). */
  invalidateSharedStrings(): void {
    this.sst = null;
  }

  /** Uncompressed size of a part: the ZIP's declared size for an original entry, else its current bytes. */
  partSize(part: string): number {
    if (!this.entrySizes) {
      this.entrySizes = new Map();
      for (const e of readZip(this.pkg.originalBytes, zipLimits()).entries) this.entrySizes.set(e.name.toLowerCase(), e.uncompressedSize);
    }
    const n = this.entrySizes.get(part.toLowerCase());
    return n !== undefined && !this.pkg.touchedParts().some((t) => t.toLowerCase() === part.toLowerCase())
      ? n
      : this.pkg.bytes(part).length;
  }

  entry(id: number): SheetEntry | undefined {
    return this.sheets.find((s) => s.id === id);
  }

  /**
   * Drop the cached model of sheet `id` (its part's tree was replaced, e.g. a deletion rolled back):
   * the next `sheet(id)` loads it again from the package under the same id.
   */
  forgetSheet(id: number): void {
    this.loaded.delete(id);
    this.loadedSheets.delete(id);
  }

  /** The sheet already loaded for `id`, without loading it. */
  loadedSheet(id: number): Sheet | undefined {
    return this.loadedSheets.get(id);
  }

  /**
   * The worksheet `id`, parsed (chunked, §10.2) and indexed on first use, then cached. Rejects with
   * SheetLoadError for an unknown id, a chartsheet/other sheet, a missing part, a part over the
   * 300 MB "not loaded" limit, or a malformed part (`damaged`, with the parser message).
   */
  sheet(id: number): Promise<Sheet> {
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const p = this.loadSheet(id);
    this.loaded.set(id, p);
    p.then((s) => { this.loadedSheets.set(id, s); }, () => { this.loaded.delete(id); });
    return p;
  }

  private async loadSheet(id: number): Promise<Sheet> {
    const e = this.entry(id);
    if (!e) throw new SheetLoadError('unknown-sheet', `No sheet with id ${id}`);
    if (e.kind !== 'worksheet') throw new SheetLoadError('not-worksheet', `Sheet "${e.name}" is a ${e.kind}, not a worksheet`);
    if (!e.part) throw new SheetLoadError('missing-part', `Sheet "${e.name}" has no worksheet part`);
    const size = this.partSize(e.part);
    if (size > LIMITS.xlsxSkipSheetXmlBytes) {
      throw new SheetLoadError('too-large', `Sheet "${e.name}" is ${size} bytes uncompressed; it is not loaded`);
    }
    // Shared strings first (small next to sheets; parsed with the same chunking rule).
    if (!this.sst && this.sharedStringsPart) {
      const doc = await this.pkg.xmlAsync(this.sharedStringsPart);
      this.sst ??= SharedStrings.parse(doc);
    }
    let sheet: Sheet;
    try {
      const doc = await this.pkg.xmlAsync(e.part);
      sheet = new Sheet(e.part, doc, { pkg: this.pkg, sharedStrings: () => this.sharedStrings(), partBytes: size });
    } catch (err) {
      throw new SheetLoadError('damaged', `Sheet "${e.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    await sheet.buildIndexAsync();
    return sheet;
  }
}
