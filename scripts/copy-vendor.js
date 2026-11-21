const fs = require('fs');
const path = require('path');

const destDir = path.join(__dirname, '..', 'media');

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

// Vendored webview libraries: copied from node_modules into media/ because
// webviews load them directly (they are not bundled by esbuild).
const vendorFiles = [
  {
    src: path.join(__dirname, '..', 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js'),
    dest: path.join(destDir, 'markdown-it.min.js'),
  },
  {
    src: path.join(__dirname, '..', 'node_modules', 'turndown', 'lib', 'turndown.browser.umd.js'),
    dest: path.join(destDir, 'turndown.browser.umd.js'),
  },
  {
    src: path.join(__dirname, '..', 'node_modules', 'force-graph', 'dist', 'force-graph.min.js'),
    dest: path.join(destDir, 'force-graph.min.js'),
  },
  {
    src: path.join(__dirname, '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    dest: path.join(destDir, 'mermaid.min.js'),
  },
  {
    src: path.join(__dirname, '..', 'node_modules', 'docx-preview', 'dist', 'docx-preview.min.js'),
    dest: path.join(destDir, 'docx-preview.min.js'),
  },
  {
    src: path.join(__dirname, '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js'),
    dest: path.join(destDir, 'jszip.min.js'),
  },
];

let missing = false;

for (const { src, dest } of vendorFiles) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${path.basename(dest)} to media/`);
  } else {
    console.error(`ERROR: ${path.basename(dest)} not found at ${src}`);
    console.error('Run npm install first.');
    missing = true;
  }
}

// Fail the build loudly rather than silently packaging a broken extension
// with missing webview libraries.
if (missing) {
  process.exitCode = 1;
}

// pdf.js worker and data files (PDF viewer). Loaded by URL at run time from media/pdfjs/.
// Deliberately NOT copied: pdf.sandbox*.mjs and wasm/quickjs-eval.* (the JavaScript
// sandbox; scripting is never enabled), image_decoders/, source maps, the non-legacy
// builds and *_nowasm_fallback.js (cannot load under the viewer CSP). See spec §3.
const pdfjsRoot = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
const pdfjsDest = path.join(destDir, 'pdfjs');

/** Copy files of `srcSub` whose name passes `keep` into media/pdfjs/<destSub> (recursive for subdirectories). */
function copyPdfjsDir(srcSub, destSub, keep) {
  const from = path.join(pdfjsRoot, srcSub);
  const to = path.join(pdfjsDest, destSub);
  if (!fs.existsSync(from)) {
    console.error(`ERROR: pdfjs-dist/${srcSub} not found. Run npm install first.`);
    missing = true;
    return;
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !keep(entry.name)) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    n++;
  }
  console.log(`Copied ${n} files from pdfjs-dist/${srcSub} to media/pdfjs/${destSub}/`);
}

function copyPdfjsFile(srcSub, destName) {
  const from = path.join(pdfjsRoot, srcSub);
  if (!fs.existsSync(from)) {
    console.error(`ERROR: pdfjs-dist/${srcSub} not found. Run npm install first.`);
    missing = true;
    return;
  }
  fs.mkdirSync(pdfjsDest, { recursive: true });
  fs.copyFileSync(from, path.join(pdfjsDest, destName));
  console.log(`Copied ${destName} to media/pdfjs/`);
}

copyPdfjsFile(path.join('legacy', 'build', 'pdf.worker.min.mjs'), 'pdf.worker.min.mjs');
copyPdfjsFile(path.join('legacy', 'web', 'pdf_viewer.css'), 'pdf_viewer.css');
copyPdfjsFile('LICENSE', 'LICENSE');
copyPdfjsDir('cmaps', 'cmaps', () => true); // *.bcmap + LICENSE
copyPdfjsDir('standard_fonts', 'standard_fonts', () => true); // fonts + LICENSE_FOXIT, LICENSE_LIBERATION
copyPdfjsDir('iccs', 'iccs', () => true);
copyPdfjsDir('wasm', 'wasm', (name) => /^(openjpeg|jbig2|qcms_bg)\.wasm$/.test(name) || (/^LICENSE_/.test(name) && !/QUICKJS/.test(name)));
copyPdfjsDir(path.join('legacy', 'web', 'images'), 'images', () => true);

if (missing) {
  process.exitCode = 1;
}
