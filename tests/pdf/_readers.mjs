// PG6 helpers (spec 13.2): independent readers open a PDF and report what they see.
// Used by scripts/verify-pdf-open.mjs and by the edit tests (assertPg6). Never imported by the extension.
// Readers: pdf.js (legacy build, Node), PDFium (WASM, @hyzyla/pdfium), @cantoo/pdf-lib; optional `qpdf --check`.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const PJ = path.dirname(require.resolve('pdfjs-dist/package.json'));

/** Passwords for fixtures that need one. */
export const DEFAULT_PASSWORDS = { 'encrypted-user.pdf': 'test' };

export const READERS = ['pdfjs', 'pdfium', 'pdflib'];

const msg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
const pwOpt = (password) => (password !== undefined ? { password } : {});

/** pdf.js: page count, per-page annotation subtypes and text, form field values. */
export async function readPdfjs(bytes, { password, maxPages = 50 } = {}) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = lib.getDocument({
    data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false,
    cMapUrl: PJ + '/cmaps/', standardFontDataUrl: PJ + '/standard_fonts/', wasmUrl: PJ + '/wasm/', iccUrl: PJ + '/iccs/',
    ...pwOpt(password),
  });
  try {
    const doc = await task.promise;
    const r = { pages: doc.numPages, annots: [], text: [], fields: {} };
    for (let i = 1; i <= doc.numPages && i <= maxPages; i++) {
      const p = await doc.getPage(i);
      const an = await p.getAnnotations();
      r.annots.push(an.map((a) => ({
        subtype: a.subtype, rect: a.rect ? Array.from(a.rect) : undefined, color: a.color ? Array.from(a.color) : undefined,
        contents: a.contentsObj?.str ?? a.contents ?? undefined, field: a.fieldName || undefined,
      })));
      for (const a of an) if (a.fieldName) r.fields[a.fieldName] = a.fieldValue;
      const t = await p.getTextContent();
      r.text.push(t.items.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim());
      p.cleanup();
    }
    return r;
  } finally { await task.destroy(); }
}

let pdfiumLib;
/** PDFium: page count and non-white pixel count of the first `renderPages` pages (with form fields drawn). */
export async function readPdfium(bytes, { password, renderPages = 1, keepImage = false } = {}) {
  const { PDFiumLibrary } = await import('@hyzyla/pdfium');
  pdfiumLib ??= await PDFiumLibrary.init();
  const doc = await pdfiumLib.loadDocument(new Uint8Array(bytes), password);
  try {
    const r = { pages: doc.getPageCount(), renders: [] };
    for (let i = 0; i < Math.min(renderPages, r.pages); i++) {
      const img = await doc.getPage(i).render({ scale: 1, render: 'bitmap', renderFormFields: true });
      let nonWhite = 0;
      for (let k = 0; k < img.data.length; k += 4) if (img.data[k] < 250 || img.data[k + 1] < 250 || img.data[k + 2] < 250) nonWhite++;
      r.renders.push({ width: img.width, height: img.height, nonWhite });
      if (keepImage) (r.images ??= []).push(img);
    }
    return r;
  } finally { doc.destroy(); }
}

/** @cantoo/pdf-lib: page count, object count, annotation subtypes per page and form field values. */
export async function readPdfLib(bytes, { password } = {}) {
  const { PDFDocument, PDFName, PDFArray, PDFDict } = await import('@cantoo/pdf-lib');
  const load = (pw) => PDFDocument.load(bytes, { updateMetadata: false, ...pwOpt(pw) });
  // pdf-lib refuses encrypted files without a password even when the user password is empty (owner-only restrictions).
  const doc = await load(password).catch((e) => (password === undefined && /encrypted/i.test(String(e.message)) ? load('') : Promise.reject(e)));
  const r = { pages: doc.getPageCount(), objects: doc.context.enumerateIndirectObjects().length, annots: [], fields: {} };
  for (const page of doc.getPages()) {
    const arr = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const subs = [];
    if (arr) {
      for (let i = 0; i < arr.size(); i++) {
        const d = arr.lookupMaybe(i, PDFDict);
        subs.push(d?.get(PDFName.of('Subtype'))?.toString().replace(/^\//, '') ?? '?');
      }
    }
    r.annots.push(subs);
  }
  try {
    for (const f of doc.getForm().getFields()) {
      try { r.fields[f.getName()] = f.getText ? f.getText() : f.isChecked ? f.isChecked() : f.getSelected ? f.getSelected() : null; } catch { r.fields[f.getName()] = null; }
    }
  } catch { /* no AcroForm */ }
  return r;
}

/** Find `qpdf`: $QPDF, then PATH. Returns a command string or null. Never required. */
export function findQpdf() {
  for (const c of [process.env.QPDF, 'qpdf'].filter(Boolean)) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

/** `qpdf --check`. Exit 0 = ok; 3 = warnings only (reported, still a pass). Throws on errors. */
export function readQpdf(qpdf, file, { password } = {}) {
  const r = spawnSync(qpdf, ['--check', ...(password !== undefined ? [`--password=${password}`] : []), file], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split(/\r?\n/).filter((l) => /WARNING|ERROR|error/.test(l)).slice(0, 5);
  if (r.status !== 0 && r.status !== 3) throw new Error(`qpdf exit ${r.status}: ${lines[0] ?? 'check failed'}`);
  return { exit: r.status, warnings: r.status === 3 ? lines : [] };
}

/**
 * Run every reader over `bytes`. Never throws: each reader reports { ok, ...data } or { ok: false, error }.
 * Options: password, qpdf (command from findQpdf, or null), file (path, needed for qpdf), readers (subset),
 * renderPages, keepImage (keep PDFium bitmaps in result.pdfium.images).
 */
export async function openAll(bytes, opts = {}) {
  const { password, qpdf = null, file, readers = READERS, renderPages = 1, keepImage = false } = opts;
  const impls = {
    pdfjs: () => readPdfjs(bytes, { password }),
    pdfium: () => readPdfium(bytes, { password, renderPages, keepImage }),
    pdflib: () => readPdfLib(bytes, { password }),
  };
  const out = {};
  for (const name of readers) {
    try { out[name] = { ok: true, ...(await impls[name]()) }; } catch (e) { out[name] = { ok: false, error: msg(e) }; }
  }
  if (qpdf && file) {
    try { out.qpdf = { ok: true, ...readQpdf(qpdf, file, { password }) }; } catch (e) { out.qpdf = { ok: false, error: msg(e) }; }
  }
  return out;
}

/**
 * PG6 check. Returns a list of problem strings (empty = pass).
 *   result   openAll() output for the saved file
 *   base     openAll() output for the loaded file (page count and untouched-page text are compared against it)
 *   expect   { annots?: [{ page (1-based), subtype, count? (default 1), contents? }], touchedPages?: number[] }
 * Every reader that ran must have opened the file; page counts must agree between readers and with the base; each
 * expected annotation must appear on top of the base's (pdf.js and pdf-lib); text of untouched pages must be equal.
 */
export function checkPg6(result, base, expect = {}) {
  const problems = [];
  for (const [name, r] of Object.entries(result)) if (!r.ok) problems.push(`${name}: failed to open (${r.error})`);
  const counts = READERS.filter((n) => result[n]?.ok).map((n) => [n, result[n].pages]);
  if (new Set(counts.map((c) => c[1])).size > 1) problems.push(`page count differs between readers: ${counts.map((c) => c.join('=')).join(', ')}`);
  if (base) for (const [n, pages] of counts) if (base[n]?.ok && base[n].pages !== pages) problems.push(`${n}: page count ${base[n].pages} -> ${pages}`);
  const touched = new Set(expect.touchedPages ?? []);
  if (base?.pdfjs?.ok && result.pdfjs?.ok) {
    result.pdfjs.text.forEach((t, i) => {
      if (!touched.has(i + 1) && base.pdfjs.text[i] !== undefined && base.pdfjs.text[i] !== t) problems.push(`pdfjs: text of untouched page ${i + 1} changed`);
    });
  }
  for (const want of expect.annots ?? []) {
    const idx = want.page - 1;
    const n = want.count ?? 1;
    if (result.pdfjs?.ok) {
      const b = base?.pdfjs?.ok ? (base.pdfjs.annots[idx] ?? []).filter((a) => a.subtype === want.subtype).length : 0;
      const got = result.pdfjs.annots[idx] ?? [];
      if (got.filter((a) => a.subtype === want.subtype).length < b + n) problems.push(`pdfjs: page ${want.page} lacks ${want.subtype}`);
      if (want.contents !== undefined && !got.some((a) => a.subtype === want.subtype && a.contents === want.contents)) problems.push(`pdfjs: page ${want.page} ${want.subtype} comment not found`);
    }
    if (result.pdflib?.ok) {
      const b = base?.pdflib?.ok ? (base.pdflib.annots[idx] ?? []).filter((s) => s === want.subtype).length : 0;
      if ((result.pdflib.annots[idx] ?? []).filter((s) => s === want.subtype).length < b + n) problems.push(`pdflib: page ${want.page} lacks ${want.subtype}`);
    }
  }
  return problems;
}

/** For edit tests: open base and saved bytes, run checkPg6, throw an Error listing the problems. Returns the readers' result. */
export async function assertPg6(savedBytes, baseBytes, expect = {}, opts = {}) {
  const base = baseBytes ? await openAll(baseBytes, opts) : undefined;
  const result = await openAll(savedBytes, { ...opts, file: undefined });
  const problems = checkPg6(result, base, expect);
  if (problems.length) throw new Error('PG6 failed:\n  ' + problems.join('\n  '));
  return result;
}

/** RGBA image -> PNG (for the eyeballing renders). */
export function toPng({ width: w, height: h, data }) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Expand arguments (files and directories, recursive, skipping png/) to a sorted list of .pdf paths. */
export function collectPdfs(args) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'png') walk(p); } else if (/\.pdf$/i.test(e.name)) files.push(p);
    }
  };
  for (const a of args) {
    if (!fs.existsSync(a)) continue;
    if (fs.statSync(a).isDirectory()) walk(a); else files.push(a);
  }
  return files.sort();
}
