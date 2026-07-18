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
