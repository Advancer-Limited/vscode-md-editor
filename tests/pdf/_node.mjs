// The Node versions the pdf.js-backed PDF suites need, in one place (review S5).
//
// pdf.js 6.5.438 `saveDocument()` needs Node >= 22.13; reading a document with pdf.js needs Node 20+. On an older Node
// those suites cannot run. They are then skipped, but never silently: a loud warning is printed once, and
// tests/pdf/nodeVersion.test.mjs FAILS unless PDF_TESTS_ALLOW_OLD_NODE=1 is set — so a green `npm test` always means
// the writer, contract and verifier suites really ran (see CONTRIBUTING.md).

const [major, minor] = process.versions.node.split('.').map(Number);

export const NODE_FOR_WRITER = '22.13';
export const writerSupported = major > 22 || (major === 22 && minor >= 13);
export const readerSupported = major >= 20;

/** `skip` option for tests that run pdf.js's writer: false, or the reason. */
export const skipWriter = writerSupported ? false : `pdf.js saveDocument() needs Node >= ${NODE_FOR_WRITER}`;
/** `skip` option for tests that only read with pdf.js. */
export const skipPdfjs = readerSupported ? false : 'pdf.js needs Node 20+';

let warned = false;
/** Print the skip warning once per process (each test file is its own process). */
export function warnIfSkipped(suite) {
  if (writerSupported || warned) return;
  warned = true;
  const line = '!'.repeat(100);
  console.warn(`${line}\n!! ${suite}: pdf.js-backed cases SKIPPED on Node ${process.versions.node} (${skipWriter}).\n`
    + `!! This run does NOT verify the PDF writer or the save verifier. Use Node >= ${NODE_FOR_WRITER}.\n${line}`);
}
