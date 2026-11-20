// Word viewer notices (spec §7.1, §12): what the document contains that docx-preview shows only
// approximately or not at all. Detection scans relationship types, part names and a few element
// names with plain text patterns; it never parses the whole body and never affects preservation.
//
// No `vscode` import here (core rule).

import type { OfficePackage } from '../package.js';
import type { OfficeNotice } from '../types.js';
import { mainPart, readRelationships } from '../opc.js';

const REL_PREFIX = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const REL_VBA = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';

/** `<w:ins ` / `<w:del ` / move markers, any prefix; `delText`, `insideH` etc. do not match. */
const RE_TRACKED = /<(?:[\w.-]+:)?(?:ins|del|moveFrom|moveTo)(?=[\s>/])/;
const RE_ALT_CHUNK = /<(?:[\w.-]+:)?altChunk(?=[\s>/])/;
const RE_MATH = /<(?:[\w.-]+:)?(?:oMath|oMathPara)(?=[\s>/])/;
const RE_OBJECT = /<(?:[\w.-]+:)?object(?=[\s>/])/;
const RE_COMMENT = /<(?:[\w.-]+:)?comment(?=[\s>/])/g;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function safeText(pkg: OfficePackage, part: string): string {
  try { return pkg.has(part) ? pkg.text(part) : ''; } catch { return ''; }
}

export function detectDocxNotices(pkg: OfficePackage): OfficeNotice[] {
  const names = pkg.partNames();
  const lower = names.map((n) => n.toLowerCase());
  const anyPart = (re: RegExp): boolean => lower.some((n) => re.test(n));

  let main = '';
  try { main = mainPart(pkg).name; } catch { /* no main part: nothing to scan */ }
  const body = main ? safeText(pkg, main) : '';

  let rels: Array<{ type: string; target: string; external: boolean }> = [];
  try { if (main) rels = readRelationships(pkg, main); } catch { /* unreadable rels: part names still work */ }
  const hasRel = (suffix: string): boolean => rels.some((r) => r.type === REL_PREFIX + suffix);

  const out: OfficeNotice[] = [];

  if (RE_TRACKED.test(body)) {
    out.push({
      severity: 'info', code: 'tracked-changes',
      message: 'This document has tracked changes. They are shown as if all changes were accepted.',
    });
  }

  const commentParts = names.filter((n) => /(^|\/)comments\.xml$/i.test(n));
  if (commentParts.length || hasRel('comments')) {
    let count = 0;
    for (const part of commentParts) count += (safeText(pkg, part).match(RE_COMMENT) || []).length;
    out.push({
      severity: 'info', code: 'comments',
      message: count > 0
        ? `This document has ${count} ${plural(count, 'comment', 'comments')}. Comments are not shown.`
        : 'This document has comments. Comments are not shown.',
    });
  }

  if (anyPart(/(^|\/)embeddings\//) || hasRel('oleObject') || hasRel('package') || RE_OBJECT.test(body)) {
    out.push({
      severity: 'info', code: 'embedded-objects',
      message: 'This document has embedded objects. They are not shown (they are kept when the file is saved).',
    });
  }

  if (anyPart(/(^|\/)(charts|diagrams)\//) || hasRel('chart') || hasRel('diagramData')) {
    out.push({
      severity: 'info', code: 'charts',
      message: 'This document has charts or SmartArt. They are not shown (they are kept when the file is saved).',
    });
  }

  if (RE_MATH.test(body)) {
    out.push({
      severity: 'info', code: 'equations',
      message: 'This document has equations. They may be shown approximately.',
    });
  }

  if (RE_ALT_CHUNK.test(body) || hasRel('aFChunk') || anyPart(/(^|\/)afchunk[^/]*$/)) {
    out.push({
      severity: 'info', code: 'altchunks',
      message: 'This document embeds other content (HTML or other documents) that is not shown.',
    });
  }

  if (anyPart(/(^|\/)vbaproject\.bin$/) || rels.some((r) => r.type === REL_VBA)) {
    out.push({
      severity: 'info', code: 'macros',
      message: 'This document contains macros. They are never run or changed.',
    });
  }

  if (rels.some((r) => r.external && r.type === REL_PREFIX + 'image')) {
    out.push({
      severity: 'info', code: 'external-images',
      message: 'This document links to pictures stored elsewhere. Linked pictures are not loaded and appear broken.',
    });
  }

  return out;
}
