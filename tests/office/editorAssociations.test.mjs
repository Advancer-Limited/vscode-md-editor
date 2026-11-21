// "Choose Editors for Office and PDF Files…": pure logic (src/office/editorAssociations.ts) and the
// command wiring (src/office/chooseDocumentEditors.ts) against the in-memory vscode stub.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const stubPath = path.join(here, '_vscodeStub.cjs');
const vscode = require(stubPath);
const S = vscode.__state;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let m;
before(async () => {
  const outfile = path.join(root, 'tests', '.build', 'office-assoc.cjs');
  await esbuild.build({
    stdin: {
      contents: "export * from './src/office/editorAssociations.ts'; export * from './src/office/chooseDocumentEditors.ts';",
      resolveDir: root, sourcefile: 'assoc-entry.ts', loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    plugins: [{ name: 'vscode-stub', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath, external: true })); } }],
  });
  m = require(outfile);
});
beforeEach(() => S.reset());

const DOCX = { pattern: '*.docx', viewType: 'vscodeMdEditor.docx', label: 'Word Document Viewer' };

test('package.json: command is declared and every table row we offer is a contributed editor', () => {
  const cmd = pkg.contributes.commands.find((c) => c.command === 'vscodeMdEditor.chooseDocumentEditors');
  assert.ok(cmd);
  assert.strictEqual(cmd.title, 'Choose Editors for Office and PDF Files…');
  assert.strictEqual(cmd.category, 'Markdown Editor');
  const have = pkg.contributes.customEditors.map((e) => e.viewType);
  const offered = m.availableTypes(have).map((t) => t.pattern);
  assert.ok(offered.includes('*.docx') && offered.includes('*.xlsx'));
});

test('availableTypes only offers rows whose viewType is contributed', () => {
  assert.deepStrictEqual(m.availableTypes(['vscodeMdEditor.docx']).map((t) => t.pattern), ['*.docx']);
  assert.deepStrictEqual(m.availableTypes([]).map((t) => t.pattern), []);
});

test('describeCurrent covers extension / default / other / automatic', () => {
  assert.match(m.describeCurrent(DOCX, 'vscodeMdEditor.docx'), /This extension/);
  assert.match(m.describeCurrent(DOCX, 'default'), /default editor/);
  assert.match(m.describeCurrent(DOCX, 'other.ext.view'), /other\.ext\.view/);
  assert.strictEqual(m.describeCurrent(DOCX, undefined), 'Automatic');
});

test('nextAssociations sets, defaults and removes while preserving other keys, without mutating', () => {
  const cur = { '*.xlsx': 'x.y', '*.png': 'img' };
  const copy = JSON.parse(JSON.stringify(cur));
  assert.deepStrictEqual(m.nextAssociations(cur, DOCX, 'extension'), { ...cur, '*.docx': 'vscodeMdEditor.docx' });
  assert.deepStrictEqual(m.nextAssociations(cur, DOCX, 'default'), { ...cur, '*.docx': 'default' });
  assert.deepStrictEqual(m.nextAssociations({ ...cur, '*.docx': 'default' }, DOCX, 'auto'), cur);
  assert.deepStrictEqual(m.nextAssociations(undefined, DOCX, 'auto'), {});
  assert.deepStrictEqual(cur, copy);
});

test('workspaceOverrides', () => {
  assert.strictEqual(m.workspaceOverrides(DOCX, { '*.docx': 'default' }), true);
  assert.strictEqual(m.workspaceOverrides(DOCX, { '*.xlsx': 'default' }, undefined), false);
  assert.strictEqual(m.workspaceOverrides(DOCX, undefined, { '*.docx': 'x' }), true);
  assert.strictEqual(m.workspaceOverrides(DOCX, undefined), false);
});

test('command: writes the user-level setting, preserves other keys, confirms', async () => {
  S.inspected['workbench.editorAssociations'] = { globalValue: { '*.png': 'img', '*.xlsx': 'default' } };
  S.quickPicks.push((items) => items.find((i) => i.label === '*.docx'), (items) => items.find((i) => i.choice === 'extension'));
  await m.chooseDocumentEditors(pkg);
  assert.strictEqual(S.updates.length, 1);
  const u = S.updates[0];
  assert.strictEqual(u.key, 'workbench.editorAssociations');
  assert.strictEqual(u.target, vscode.ConfigurationTarget.Global);
  assert.deepStrictEqual(u.value, { '*.png': 'img', '*.xlsx': 'default', '*.docx': 'vscodeMdEditor.docx' });
  assert.strictEqual(S.messages.filter((x) => x[0] === 'info').length, 1);
});

test('command: type items show the current choice', async () => {
  S.inspected['workbench.editorAssociations'] = { globalValue: { '*.xlsx': 'default' } };
  let seen;
  S.quickPicks.push((items) => { seen = items; return undefined; });
  await m.chooseDocumentEditors(pkg);
  assert.match(seen.find((i) => i.label === '*.xlsx').description, /default editor/);
  assert.match(seen.find((i) => i.label === '*.docx').description, /Automatic/);
  assert.strictEqual(S.updates.length, 0);
});

test('command: cancelling either step writes nothing; workspace override is reported', async () => {
  S.quickPicks.push((items) => items[0], undefined);
  await m.chooseDocumentEditors(pkg);
  assert.strictEqual(S.updates.length, 0);

  S.inspected['workbench.editorAssociations'] = { workspaceValue: { '*.docx': 'default' } };
  S.quickPicks.push((items) => items.find((i) => i.label === '*.docx'), (items) => items.find((i) => i.choice === 'auto'));
  await m.chooseDocumentEditors(pkg);
  assert.strictEqual(S.updates.length, 1);
  assert.deepStrictEqual(S.updates[0].value, {});
  assert.strictEqual(S.messages.filter((x) => x[0] === 'info').length, 2);
  assert.match(S.messages[1][1], /workspace/i);
});
