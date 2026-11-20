// make-synthetic.mjs - generates the scripted Office fixtures of spec 13.4 (no Office needed).
// Usage: node scripts/office-fixtures/make-synthetic.mjs [outDir]
// Requires basic.docx / basic.xlsx (made by make-word.ps1 / make-excel.ps1) in outDir.
// Output is byte-deterministic (fixed ZIP timestamps, fixed content).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(here, '..', '..', 'tests', 'fixtures', 'office');
const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

async function zipOf(files, { streamFiles = false } = {}) {
  const z = new JSZip();
  for (const [name, data] of files) z.file(name, data, { date: FIXED_DATE, createFolders: false });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles });
}

async function readParts(file) {
  const z = await JSZip.loadAsync(fs.readFileSync(file));
  const parts = [];
  for (const name of Object.keys(z.files)) {
    if (z.files[name].dir) continue;
    parts.push([name, await z.file(name).async('nodebuffer')]);
  }
  return parts;
}

// ---- minimal xlsx builder -----------------------------------------------------------------
function sheetXml({ prefix = '', cells }) {
  const p = prefix ? prefix + ':' : '';
  const nsDecl = prefix ? `xmlns:${prefix}="${NS_MAIN}"` : `xmlns="${NS_MAIN}"`;
  const rows = cells.map((row, i) => {
    const r = i + 1;
    const cs = row.map((c, j) => c.replace('@@', String.fromCharCode(65 + j) + r).replace(/<c /g, `<${p}c `)
      .replace(/<\/c>/g, `</${p}c>`).replace(/<(is|v|f|t)>/g, `<${p}$1>`).replace(/<\/(is|v|f|t)>/g, `</${p}$1>`)).join('');
    return `<${p}row r="${r}">${cs}</${p}row>`;
  }).join('');
  return `${XML_DECL}<${p}worksheet ${nsDecl} xmlns:r="${NS_R}"><${p}dimension ref="A1:${String.fromCharCode(64 + cells[0].length)}${cells.length}"/><${p}sheetData>${rows}</${p}sheetData></${p}worksheet>`;
}
const num = (v, s) => `<c r="@@"${s !== undefined ? ` s="${s}"` : ''}><v>${v}</v></c>`;
const inl = (t, s) => `<c r="@@" t="inlineStr"${s !== undefined ? ` s="${s}"` : ''}><is><t>${t}</t></is></c>`;
const fstr = (t, s) => `<c r="@@" t="str"${s !== undefined ? ` s="${s}"` : ''}><f>"${t}"</f><v>${t}</v></c>`;
const sst = (i, s) => `<c r="@@" t="s"${s !== undefined ? ` s="${s}"` : ''}><v>${i}</v></c>`;

function workbookParts({ prefix = '', sheet, styles = null, sharedStrings = null }) {
  const p = prefix ? prefix + ':' : '';
  const nsDecl = prefix ? `xmlns:${prefix}="${NS_MAIN}"` : `xmlns="${NS_MAIN}"`;
  let rels = `<Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/>`;
  let ct = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
  const parts = [];
  if (styles) {
    rels += `<Relationship Id="rId2" Type="${NS_R}/styles" Target="styles.xml"/>`;
    ct += '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    parts.push(['xl/styles.xml', styles]);
  }
  if (sharedStrings) {
    rels += `<Relationship Id="rId3" Type="${NS_R}/sharedStrings" Target="sharedStrings.xml"/>`;
    ct += '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>';
    parts.push(['xl/sharedStrings.xml', sharedStrings]);
  }
  return [
    ['[Content_Types].xml', `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${ct}</Types>`],
    ['_rels/.rels', `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML_DECL}<${p}workbook ${nsDecl} xmlns:r="${NS_R}"><${p}sheets><${p}sheet name="Sheet1" sheetId="1" r:id="rId1"/></${p}sheets></${p}workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">${rels}</Relationships>`],
    ['xl/worksheets/sheet1.xml', sheet],
    ...parts,
  ];
}

function stylesXml({ withCount, withDate = false }) {
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    '<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'];
  if (withDate) xfs.push('<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>');
  return `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs${withCount ? ` count="${xfs.length}"` : ''}>${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

const gridCells = (mk, withStyles) => [
  [mk.text('Name', withStyles ? 1 : undefined), mk.text('Qty', withStyles ? 1 : undefined), mk.text('Note', withStyles ? 1 : undefined)],
  [mk.text('Apples'), num(3, withStyles ? 2 : undefined), mk.text('first')],
  [mk.text('Pears & "Plums" <x>'.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')), num(4.5), mk.text('escaped')],
  [mk.text('Empty'), (withStyles ? '<c r="@@" s="2"/>' : '<c r="@@"/>'), mk.text('styled blank')],
];

async function makeInlineStrings(dir) {
  const sheet = sheetXml({ cells: gridCells({ text: inl }, false) });
  return write(dir, 'inline-strings.xlsx', await zipOf(workbookParts({ sheet })));
}
async function makeNoSharedStrings(dir) {
  const sheet = sheetXml({ cells: gridCells({ text: fstr }, false).map((r) => r.map((c) => c.replace(/&amp;|&lt;|&gt;|"Plums"/g, 'x'))) });
  return write(dir, 'no-shared-strings.xlsx', await zipOf(workbookParts({ sheet })));
}
async function makePrefixed(dir) {
  const sst1 = `${XML_DECL}<x:sst xmlns:x="${NS_MAIN}" count="2" uniqueCount="2"><x:si><x:t>Prefixed</x:t></x:si><x:si><x:t>Namespaces</x:t></x:si></x:sst>`;
  const cells = [[sst(0), sst(1)], [num(1), num(2)]];
  const sheet = sheetXml({ prefix: 'x', cells });
  return write(dir, 'prefixed-namespaces.xlsx', await zipOf(workbookParts({ prefix: 'x', sheet, sharedStrings: sst1 })));
}
async function makeNoDateStyle(dir, withCount, name) {
  const sheet = sheetXml({ cells: gridCells({ text: inl }, true) });
  return write(dir, name, await zipOf(workbookParts({ sheet, styles: stylesXml({ withCount }) })));
}
async function makeNoStyles(dir) {
  // cells carry no s attribute and there is no styles part, content-type or relationship
  const sheet = sheetXml({ cells: gridCells({ text: inl }, false) });
  return write(dir, 'no-styles.xlsx', await zipOf(workbookParts({ sheet })));
}
async function makeDataDescriptors(dir) {
  const parts = await readParts(path.join(dir, 'basic.xlsx'));
  return write(dir, 'data-descriptors.xlsx', await zipOf(parts, { streamFiles: true }));
}
function makeZip64(dir) {
  const src = fs.readFileSync(path.join(dir, 'basic.xlsx'));
  let eocd = -1;
  for (let i = src.length - 22; i >= 0; i--) if (src.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('basic.xlsx: no EOCD');
  const total = src.readUInt16LE(eocd + 10), cdSize = src.readUInt32LE(eocd + 12), cdOff = src.readUInt32LE(eocd + 16);
  const rec = Buffer.alloc(56);   // ZIP64 end of central directory record
  rec.writeUInt32LE(0x06064b50, 0); rec.writeBigUInt64LE(44n, 4); rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14);
  rec.writeUInt32LE(0, 16); rec.writeUInt32LE(0, 20); rec.writeBigUInt64LE(BigInt(total), 24); rec.writeBigUInt64LE(BigInt(total), 32);
  rec.writeBigUInt64LE(BigInt(cdSize), 40); rec.writeBigUInt64LE(BigInt(cdOff), 48);
  const loc = Buffer.alloc(20);   // ZIP64 end of central directory locator
  loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4); loc.writeBigUInt64LE(BigInt(eocd), 8); loc.writeUInt32LE(1, 16);
  return write(dir, 'zip64.xlsx', Buffer.concat([src.subarray(0, eocd), rec, loc, src.subarray(eocd)]));
}
function makeTruncated(dir) {
  const src = fs.readFileSync(path.join(dir, 'basic.docx'));
  return write(dir, 'truncated.docx', src.subarray(0, Math.floor(src.length * 0.6)));
}
async function makeExternalImage(dir) {
  const parts = await readParts(path.join(dir, 'basic.docx'));
  const out = parts.map(([n, d]) => {
    if (n === 'word/document.xml') {
      let x = d.toString('utf8');
      const para = '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">'
        + '<wp:extent cx="914400" cy="914400"/><wp:docPr id="9001" name="External picture"/>'
        + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="x.png"/><pic:cNvPicPr/></pic:nvPicPr>`
        + `<pic:blipFill><a:blip xmlns:r="${NS_R}" r:link="rIdExtImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
        + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
      const i = x.lastIndexOf('<w:sectPr');
      if (i < 0) throw new Error('basic.docx: no sectPr');
      x = x.slice(0, i) + para + x.slice(i);
      return [n, Buffer.from(x, 'utf8')];
    }
    if (n === 'word/_rels/document.xml.rels') {
      const x = d.toString('utf8').replace('</Relationships>',
        `<Relationship Id="rIdExtImg1" Type="${NS_R}/image" Target="http://127.0.0.1:9/x.png" TargetMode="External"/></Relationships>`);
      return [n, Buffer.from(x, 'utf8')];
    }
    return [n, d];
  });
  return write(dir, 'external-image.docx', await zipOf(out));
}
async function makeLocalisedDe(dir) {
  const parts = await readParts(path.join(dir, 'basic.docx'));
  const out = parts.map(([n, d]) => {
    if (!/^word\/.*\.xml$/.test(n)) return [n, d];
    const x = d.toString('utf8')
      .replace(/"Heading(\d)Char"/g, '"berschrift$1Zchn"')
      .replace(/"Heading(\d)"/g, '"berschrift$1"');
    return [n, Buffer.from(x, 'utf8')];
  });
  return write(dir, 'localised-de.synthetic.docx', await zipOf(out));
}

function write(dir, name, buf) {
  fs.writeFileSync(path.join(dir, name), buf);
  console.log(`  wrote ${name} (${buf.length} bytes)`);
  return path.join(dir, name);
}

/** Build huge.xlsx (> xlsxMaxCells non-empty cells, so view-only) into `dir`; not committed. Returns the path. */
export async function makeHugeXlsx(dir, { rows = 12_000, cols = 50 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const parts = [];
  for (let r = 1; r <= rows; r++) {
    let cs = '';
    for (let c = 1; c <= cols; c++) {
      let col = '', n = c;
      while (n > 0) { col = String.fromCharCode(65 + ((n - 1) % 26)) + col; n = Math.floor((n - 1) / 26); }
      cs += `<c r="${col}${r}"><v>${(r * 31 + c * 17) % 10007}</v></c>`;
    }
    parts.push(`<row r="${r}">${cs}</row>`);
  }
  const sheet = `${XML_DECL}<worksheet xmlns="${NS_MAIN}"><sheetData>${parts.join('')}</sheetData></worksheet>`;
  const buf = await zipOf(workbookParts({ sheet }));
  const file = path.join(dir, 'huge.xlsx');
  fs.writeFileSync(file, buf);
  return file;
}

export async function makeSynthetic(dir = DEFAULT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  await makeInlineStrings(dir);
  await makeNoSharedStrings(dir);
  await makePrefixed(dir);
  await makeNoDateStyle(dir, true, 'no-date-style.xlsx');
  await makeNoDateStyle(dir, false, 'no-date-style-nocount.xlsx');
  await makeNoStyles(dir);
  await makeDataDescriptors(dir);
  makeZip64(dir);
  makeTruncated(dir);
  await makeExternalImage(dir);
  await makeLocalisedDe(dir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIR;
  await makeSynthetic(dir);
}
