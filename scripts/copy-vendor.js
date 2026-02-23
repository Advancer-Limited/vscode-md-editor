const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js');
const destDir = path.join(__dirname, '..', 'media');
const dest = path.join(destDir, 'markdown-it.min.js');

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

if (fs.existsSync(src)) {
  fs.copyFileSync(src, dest);
  console.log('Copied markdown-it.min.js to media/');
} else {
  console.warn('WARNING: markdown-it.min.js not found at', src);
  console.warn('Run npm install first.');
}

// Copy force-graph
const fgSrc = path.join(__dirname, '..', 'node_modules', 'force-graph', 'dist', 'force-graph.min.js');
const fgDest = path.join(destDir, 'force-graph.min.js');

if (fs.existsSync(fgSrc)) {
  fs.copyFileSync(fgSrc, fgDest);
  console.log('Copied force-graph.min.js to media/');
} else {
  console.warn('WARNING: force-graph.min.js not found at', fgSrc);
  console.warn('Run npm install first.');
}
