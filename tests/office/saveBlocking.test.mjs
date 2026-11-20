// Gate R2 F5 perf regression: backing up and saving large.xlsx (200k cells, 6.5 MB sheet XML) after an
// edit never blocks the extension host's event loop for long (spec §6.5 step 4, §10.2). The host
// (OfficeDocument + the xlsx provider) is bundled against the `vscode` stub as in
// xlsxEditWiring.test.mjs. The longest block is measured with a 10 ms setInterval drift monitor while
// the backup / save runs. The bound (1,000 ms) is generous for slow CI machines; measured locally on
// an idle machine the longest block is ~50–200 ms (it was 0.5–0.8 s for a backup and 1.6–2 s for a
// save before F5, and ~4 s for either before the staged save).
import { test, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { fixture } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;
const MAX_BLOCK_MS = 1000;

let host;

before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'office-host-blocking.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/office/xlsxEditorProvider.ts';",
        "export * from './src/office/officeDocument.ts';",
        "export * from './src/office/featureFlags.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'office-host-blocking-entry.ts',
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [
      { name: 'vscode-stub', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath, external: true })); } },
      {
        name: 'mutable-flags',
        setup(b) {
          b.onLoad({ filter: /featureFlags\.ts$/ }, (args) => {
            const src = fs.readFileSync(args.path, 'utf8');
            assert.ok(src.includes('Object.freeze('), 'featureFlags.ts freezes OFFICE_FLAGS');
            return { contents: src.replace('Object.freeze(', '('), loader: 'ts' };
          });
        },
      },
    ],
  });
  host = require(outfile);
  host.OfficeDocument.diskCheckDelayMs = 0;
  host.OfficeDocument.backupDelayMs = 0;   // measure the work, not the quiet period
});

const ctx = {
  extensionUri: vscode.Uri.file('/ext'),
  extension: { packageJSON: { name: 'x', displayName: 'X', version: '0.0.0', description: '' } },
  subscriptions: [],
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makePanel() {
  const sent = [];
  let onMsg = () => {};
  return {
    sent,
    webview: {
      options: {}, html: '', cspSource: 'https://csp.example',
      asWebviewUri: (u) => ({ toString: () => 'https://webview' + u.path }),
      postMessage: async (m) => {
        sent.push(m);
        if (m.type === 'flushPendingEdits') setTimeout(() => onMsg({ type: 'flushed', flushId: m.flushId }), 0);
        return true;
      },
      onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
    },
    onDidDispose: () => ({ dispose() {} }),
    send: (raw) => onMsg(raw),
  };
}

async function waitFor(cond, what) {
  for (let i = 0; i < 2000; i++) {
    const v = cond();
    if (v) return v;
    await tick(5);
  }
  assert.fail('timed out waiting for ' + what);
}

/** Longest event-loop block (ms) while `fn` runs: the largest gap between 10 ms interval ticks, minus 10. */
async function longestBlock(fn) {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  try {
    await fn();
    // One more tick, so a block at the very end is seen too.
    await new Promise((r) => setTimeout(r, 15));
  } finally {
    clearInterval(timer);
  }
  return Math.max(0, Math.round(worst));
}

/** One measured backup and save of large.xlsx (fresh document, one edit before each). */
async function attempt() {
  S.reset();
  host.OFFICE_FLAGS.xlsxEdit = true;
  const uri = vscode.Uri.file('/ws/large.xlsx');
  S.writeFile(uri, fixture('large.xlsx'), 1000);
  const provider = new host.XlsxEditorProvider(ctx);
  const doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
  const panel = makePanel();
  await provider.resolveCustomEditor(doc, panel, token);
  await panel.send({ type: 'ready' });
  assert.ok(doc.canEdit, 'large.xlsx is editable');
  await panel.send({ type: 'setEditMode', editMode: true });
  let rid = 0;
  const edit = async (r, c, input) => {
    const id = ++rid;
    await panel.send({ type: 'xlsxEdit', requestId: id, baseVersion: doc.version, edit: { op: 'setCells', sheetId: 1, cells: [{ r, c, input }] } });
    const res = await waitFor(() => panel.sent.find((m) => m.type === 'xlsxEditResult' && m.requestId === id), 'xlsxEditResult');
    assert.ok(res.ok, JSON.stringify(res));
  };

  await edit(5, 1, '123');
  const dest = vscode.Uri.file('/backups/blocking/1');
  const backupMs = await longestBlock(() => provider.backupCustomDocument(doc, { destination: dest }, token));
  assert.ok(S.read(dest)?.length > 0, 'the backup was written');

  await edit(6, 1, '124');
  const saveMs = await longestBlock(() => provider.saveCustomDocument(doc, token));
  const saved = S.read(uri);
  assert.ok(saved && saved.length > 0);
  // The saved file holds both edits.
  const { core } = await import('./_helpers.mjs');
  const text = new TextDecoder().decode(core.pkg.OfficePackage.open('x.xlsx', saved).bytes('xl/worksheets/sheet1.xml'));
  assert.match(text, /<v>123<\/v>/);
  assert.match(text, /<v>124<\/v>/);
  doc.dispose();
  return { backupMs, saveMs };
}

// The measure is wall-clock time, so a machine busy with other work (npm test runs the test files in
// parallel) can stretch a short block or add a GC pause. A real regression — one long synchronous
// stage — shows in every attempt; up to three attempts are made and the best one must pass.
test('F5: backup and save of large.xlsx never block the event loop for long', { timeout: 600_000 }, async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const r = await attempt();
    runs.push(r);
    if (r.backupMs < MAX_BLOCK_MS && r.saveMs < MAX_BLOCK_MS) break;
  }
  const text = runs.map((r) => `backup ${r.backupMs} ms, save ${r.saveMs} ms`).join('; ');
  console.log(`# F5 longest event-loop block on large.xlsx: ${text} (bound ${MAX_BLOCK_MS} ms)`);
  const best = runs[runs.length - 1];
  assert.ok(best.backupMs < MAX_BLOCK_MS, `backup blocked the event loop for ${best.backupMs} ms (${text})`);
  assert.ok(best.saveMs < MAX_BLOCK_MS, `save blocked the event loop for ${best.saveMs} ms (${text})`);
});
