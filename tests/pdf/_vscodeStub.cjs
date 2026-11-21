// The Office `vscode` stub (tests/office/_vscodeStub.cjs) plus what the PDF host shell also uses:
// `window.showSaveDialog`, `workspace.fs.writeFile`, `workspace.workspaceFolders`. It extends the
// same module object, so Office and PDF host bundles in one test process share one state.
'use strict';
const stub = require('../office/_vscodeStub.cjs');

const state = stub.__state;
const baseReset = state.reset.bind(state);
state.saveDialogs = [];
state.channels = [];
state.saveDialogResult = undefined;
state.writes = [];
state.reset = function reset() {
  baseReset();
  this.saveDialogs = [];
  this.channels = [];
  this.saveDialogResult = undefined;
  this.writes = [];
  this.failWrites = false;
  stub.workspace.workspaceFolders = undefined;
};

stub.workspace.workspaceFolders = undefined;
stub.workspace.fs.writeFile = async function writeFile(uri, data) {
  if (state.failWrites) throw new Error('EACCES: permission denied');
  state.writes.push(uri.toString());
  state.files.set(uri.toString(), { data, mtime: Date.now() });
};
stub.window.createOutputChannel = function createOutputChannel(name) {
  const ch = { name, lines: [], disposed: false, appendLine(l) { this.lines.push(l); }, dispose() { this.disposed = true; } };
  state.channels.push(ch);
  return ch;
};
stub.window.showSaveDialog = async function showSaveDialog(options) {
  state.saveDialogs.push(options);
  return state.saveDialogResult;
};

module.exports = stub;
