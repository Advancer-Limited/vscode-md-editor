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

const DOCX = { pattern: '*.docx', viewType: 'vscodeMdEditor.docx', label: 'Word Document Editor' };

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
  // Review N6: nothing left -> undefined (the setting is removed, not written as {}).
  assert.strictEqual(m.nextAssociations(undefined, DOCX, 'auto'), undefined);
  assert.strictEqual(m.nextAssociations({ '*.docx': 'default' }, DOCX, 'auto'), undefined);
  // Case and glob variants of the pattern are replaced by the exact pattern.
  assert.deepStrictEqual(m.nextAssociations({ '*.DOCX': 'x', '**/*.docx': 'y', '*.png': 'img' }, DOCX, 'extension'), { '*.png': 'img', '*.docx': 'vscodeMdEditor.docx' });
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
  assert.strictEqual(S.updates[0].value, undefined, 'an empty result removes the setting');
  assert.strictEqual(S.messages.filter((x) => x[0] === 'info').length, 2);
  assert.match(S.messages[1][1], /workspace/i);
});

test('N6: case-variant and glob keys are recognised when showing the current choice and for workspace overrides', async () => {
  S.inspected['workbench.editorAssociations'] = { globalValue: { '*.DOCX': 'default', '**/*.xlsx': 'vscodeMdEditor.xlsx' } };
  let seen;
  S.quickPicks.push((items) => { seen = items; return undefined; });
  await m.chooseDocumentEditors(pkg);
  assert.match(seen.find((i) => i.label === '*.docx').description, /default editor \(set for \*\.DOCX\)/);
  assert.match(seen.find((i) => i.label === '*.xlsx').description, /This extension .*set for \*\*\/\*\.xlsx/);
  assert.strictEqual(m.workspaceOverrides(DOCX, { '**/*.DOCX': 'x' }), true);
  assert.deepStrictEqual(m.matchingKeys(DOCX, { '*.docx': 'a', '*.DOCX': 'b', '*.docm': 'c' }), ['*.docx', '*.DOCX']);
});

test('N6: the write is based on the user-level value re-read just before writing, never on workspace values', async () => {
  S.inspected['workbench.editorAssociations'] = {
    globalValue: { '*.gif': 'g' }, workspaceValue: { '*.png': 'ws' }, workspaceFolderValue: { '*.bmp': 'wf' },
  };
  S.quickPicks.push(
    (items) => items.find((i) => i.label === '*.docx'),
    (items) => {
      // The user setting changes while the picker is open (another window, settings.json edit).
      S.inspected['workbench.editorAssociations'] = { ...S.inspected['workbench.editorAssociations'], globalValue: { '*.gif': 'g', '*.svg': 's' } };
      return items.find((i) => i.choice === 'default');
    },
  );
  await m.chooseDocumentEditors(pkg);
  assert.strictEqual(S.updates.length, 1);
  assert.deepStrictEqual(S.updates[0].value, { '*.gif': 'g', '*.svg': 's', '*.docx': 'default' });
  assert.strictEqual(S.updates[0].target, vscode.ConfigurationTarget.Global);
});

test('PDF row is offered only once vscodeMdEditor.pdf is a contributed custom editor', () => {
  const have = pkg.contributes.customEditors.map((e) => e.viewType);
  assert.ok(have.includes('vscodeMdEditor.pdf'), 'PWP-11 contributes the PDF viewer');
  assert.ok(m.availableTypes(have).some((t) => t.pattern === '*.pdf'), 'so the command lists *.pdf');
  const pdfEditor = pkg.contributes.customEditors.find((e) => e.viewType === 'vscodeMdEditor.pdf');
  assert.deepStrictEqual([pdfEditor.displayName, pdfEditor.priority, pdfEditor.selector], ['PDF Viewer', 'default', [{ filenamePattern: '*.pdf' }]]);
  assert.deepStrictEqual(m.availableTypes(['vscodeMdEditor.docx']).map((t) => t.pattern), ['*.docx']);
  const withPdf = m.availableTypes([...have, 'vscodeMdEditor.pdf']).find((t) => t.pattern === '*.pdf');
  assert.deepStrictEqual(withPdf && [withPdf.viewType, withPdf.label], ['vscodeMdEditor.pdf', 'PDF Viewer']);
});
