// Entry of the pdf.js webview bundle (esbuild IIFE, global `PdfjsBundle`, media/pdfjs-bundle.js).
// Display API first (sets globalThis.pdfjsLib), then the viewer components that read it.
// Legacy build only: the modern build needs newer syntax than the minimum VS Code supports (spec §3.1).
import './pdfjs-global.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsViewer from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
export { pdfjsLib, pdfjsViewer };
