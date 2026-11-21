// Review S5: a green `npm test` must not be vacuous. The writer, contract and verifier suites skip themselves on a
// Node too old for pdf.js's writer; this test makes such a run FAIL, unless the skip is asked for explicitly with
// PDF_TESTS_ALLOW_OLD_NODE=1 (then it is reported as skipped, loudly). Building and packaging still work on the
// Node versions CONTRIBUTING.md lists; only the full test suite needs Node >= 22.13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_FOR_WRITER, warnIfSkipped, writerSupported } from './_node.mjs';

const allowOld = process.env.PDF_TESTS_ALLOW_OLD_NODE === '1';
warnIfSkipped('nodeVersion');

test(`Node is new enough for the pdf.js-backed suites (>= ${NODE_FOR_WRITER})`,
  { skip: !writerSupported && allowOld ? 'PDF_TESTS_ALLOW_OLD_NODE=1: pdf.js-backed suites knowingly skipped' : false }, () => {
    assert.ok(writerSupported, `Node ${process.versions.node} cannot run pdf.js saveDocument(): the writer, contract and verifier `
      + `suites were skipped. Use Node >= ${NODE_FOR_WRITER}, or set PDF_TESTS_ALLOW_OLD_NODE=1 to accept a partial run.`);
  });
