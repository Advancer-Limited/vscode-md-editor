// Side-effect module: the viewer components read the display API from globalThis.pdfjsLib
// at module evaluation, so this must be imported (and evaluated) before pdf_viewer.mjs.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
globalThis.pdfjsLib = pdfjsLib;
