#!/usr/bin/env node
// Opens saved PDFs in independent readers (PG6, spec 13.4 step 2): pdf.js (Node), PDFium (WASM), @cantoo/pdf-lib and,
// when found (PATH or $QPDF), `qpdf --check`. Renders page 1 with PDFium to <out>/png/ for eyeballing.
//
//   node scripts/verify-pdf-open.mjs [paths...] [--out tests/.out/pdf] [--no-png] [--dry-run]
//                                    [--password name=pw ...] [--no-qpdf] [--quiet]
//
// paths: files or directories (recursive); default <out>. One JSON summary on stdout, per-file lines on stderr.
// Exit: 0 every file passed, 1 at least one file failed, 2 nothing to check. --dry-run lists what would be checked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAll, findQpdf, collectPdfs, toPng, DEFAULT_PASSWORDS } from '../tests/pdf/_readers.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const inputs = [];
const passwords = { ...DEFAULT_PASSWORDS };
let out = path.join(root, 'tests', '.out', 'pdf');
let png = true; let dry = false; let useQpdf = true; let quiet = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') out = path.resolve(argv[++i]);
  else if (a === '--no-png') png = false;
  else if (a === '--dry-run') dry = true;
  else if (a === '--no-qpdf') useQpdf = false;
  else if (a === '--quiet') quiet = true;
  else if (a === '--password') { const [n, ...p] = String(argv[++i]).split('='); passwords[n] = p.join('='); }
  else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(64); }
  else inputs.push(a);
}
if (!inputs.length) inputs.push(out);
const files = collectPdfs(inputs);
if (!files.length) {
  console.log(JSON.stringify({ checked: 0, passed: 0, failed: 0, message: 'no PDF files found', inputs }));
  process.exit(2);
}

const qpdf = useQpdf ? findQpdf() : null;
const readers = ['pdfjs', 'pdfium', 'pdflib', ...(qpdf ? ['qpdf'] : [])];
const qpdfNote = qpdf ?? 'not found (optional)';
if (dry) {
  console.log(JSON.stringify({ dryRun: true, checked: files.length, readers, qpdf: qpdfNote, files }, null, 1));
  process.exit(0);
}

const results = [];
for (const file of files) {
  const name = path.basename(file);
  const r = await openAll(new Uint8Array(fs.readFileSync(file)), { password: passwords[name], qpdf, file, keepImage: png });
  const problems = Object.entries(r).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.error}`);
  const pages = {};
  for (const k of ['pdfjs', 'pdfium', 'pdflib']) if (r[k].ok) pages[k] = r[k].pages;
  if (new Set(Object.values(pages)).size > 1) problems.push(`page count differs between readers: ${JSON.stringify(pages)}`);
  let pngPath;
  if (png && r.pdfium.ok && r.pdfium.images?.[0]) {
    fs.mkdirSync(path.join(out, 'png'), { recursive: true });
    pngPath = path.join(out, 'png', name.replace(/\.pdf$/i, '') + '.png');
    fs.writeFileSync(pngPath, toPng(r.pdfium.images[0]));
  }
  const row = {
    file: path.relative(root, file), ok: problems.length === 0, pages, problems,
    ...(r.qpdf?.ok && r.qpdf.warnings.length ? { qpdfWarnings: r.qpdf.warnings } : {}),
    ...(pngPath ? { png: path.relative(root, pngPath) } : {}),
  };
  results.push(row);
  if (!quiet) console.error(`${row.ok ? 'PASS' : 'FAIL'} ${row.file}${row.ok ? '' : '  ' + problems.join(' | ')}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ checked: results.length, passed: results.length - failed, failed, readers, qpdf: qpdfNote, results }, null, 1));
process.exit(failed ? 1 : 0);
