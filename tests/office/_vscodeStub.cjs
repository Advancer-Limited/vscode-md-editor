// Minimal in-memory stand-in for the `vscode` module, enough to drive the Office host shell
// (src/office/officeDocument.ts, officeEditorProviderBase.ts, docxEditorProvider.ts) under
// `node --test`. Bundled host code `require`s this file in place of 'vscode' (see hostShell.test.mjs).
'use strict';
const path = require('node:path');

class Uri {
  constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.query = query; }
  static file(p) { return new Uri('file', p.replace(/\\/g, '/')); }
  static parse(s) {
    const m = /^([a-zA-Z][\w+.-]*):(.*)$/.exec(s);
    if (!m) throw new Error('bad uri ' + s);
    const rest = m[2].replace(/^\/\//, '');
    const q = rest.indexOf('?');
    return new Uri(m[1], q >= 0 ? rest.slice(0, q) : rest, q >= 0 ? rest.slice(q + 1) : '');
  }
  static joinPath(base, ...segs) { return new Uri(base.scheme, path.posix.join(base.path, ...segs), base.query); }
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}:${this.scheme === 'mailto' ? '' : '//'}${this.path}${this.query ? '?' + this.query : ''}`; }
}

class EventEmitter {
  constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose: () => { this.listeners = this.listeners.filter((f) => f !== fn); } }; }; }
  fire(e) { for (const fn of this.listeners.slice()) fn(e); }
  dispose() { this.listeners = []; }
}

class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }

const state = {
  /** uri string -> { data: Uint8Array, mtime: number } */
  files: new Map(),
  watchers: [],
  opened: [],
  clipboard: undefined,
  /** uri strings passed to workspace.fs.readFile, in order */
  reads: [],
  messages: [],
  registered: [],
  config: {},
  /** 'section.key' -> { globalValue, workspaceValue, workspaceFolderValue } for getConfiguration().inspect */
  inspected: {},
  /** getConfiguration().update calls: { key, value, target } */
  updates: [],
  /** answers handed to window.showQuickPick in order (a function receives the items) */
  quickPicks: [],
  reset() {
    this.config = {}; this.inspected = {}; this.updates.length = 0; this.quickPicks.length = 0;
    this.files.clear(); this.watchers.length = 0; this.opened.length = 0;
    this.clipboard = undefined; this.messages.length = 0; this.registered.length = 0;
    this.reads.length = 0; env.remoteName = undefined;
  },
  writeFile(uri, data, mtime = Date.now()) { this.files.set(uri.toString(), { data, mtime }); },
};

function fileNotFound(uri) { const e = new Error(`EntryNotFound (FileSystemError): ${uri}`); e.code = 'FileNotFound'; return e; }

const workspace = {
  fs: {
    async readFile(uri) {
      state.reads.push(uri.toString());
      const f = state.files.get(uri.toString());
      if (!f) throw fileNotFound(uri);
      return f.data;
    },
    async stat(uri) {
      const f = state.files.get(uri.toString());
      if (!f) throw fileNotFound(uri);
      return { type: 1, ctime: f.mtime, mtime: f.mtime, size: f.data.length };
    },
    isWritableFileSystem(scheme) {
      if (scheme === 'file') return true;
      if (scheme === 'git') return false;
      return undefined;
    },
  },
  /** Settings: tests put values in `__state.config` keyed 'section.key'. */
  getConfiguration(section) {
    return {
      get: (key, dflt) => { const k = `${section}.${key}`; return k in state.config ? state.config[k] : dflt; },
      inspect: (key) => state.inspected[`${section}.${key}`],
      async update(key, value, target) { state.updates.push({ key: `${section}.${key}`, value, target }); },
    };
  },
  createFileSystemWatcher(pattern) {
    const change = new EventEmitter(), create = new EventEmitter(), del = new EventEmitter();
    const w = {
      pattern, disposed: false,
      onDidChange: change.event, onDidCreate: create.event, onDidDelete: del.event,
      // Like VS Code, events carry the changed file's URI (default: the pattern's own file).
      fireChange: (u) => change.fire(u ?? Uri.joinPath(pattern.base, pattern.pattern)),
      fireCreate: (u) => create.fire(u ?? Uri.joinPath(pattern.base, pattern.pattern)),
      dispose() { this.disposed = true; },
    };
    state.watchers.push(w);
    return w;
  },
};

const env = {
  /** undefined for a local window; e.g. 'ssh-remote' in a remote one. */
  remoteName: undefined,
  async openExternal(uri) { state.opened.push(uri.toString()); return true; },
  clipboard: { async writeText(t) { state.clipboard = t; } },
};

const window = {
  async showInformationMessage(...a) { state.messages.push(['info', ...a]); return undefined; },
  async showWarningMessage(...a) { state.messages.push(['warning', ...a]); return undefined; },
  async showErrorMessage(...a) { state.messages.push(['error', ...a]); return undefined; },
  async showQuickPick(items, options) {
    state.quickPickCalls = (state.quickPickCalls || 0) + 1;
    const a = state.quickPicks.shift();
    return typeof a === 'function' ? a(items, options) : a;
  },
  registerCustomEditorProvider(viewType, provider, options) {
    state.registered.push({ viewType, provider, options });
    return { dispose() {} };
  },
};

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

module.exports = { ConfigurationTarget, Uri, EventEmitter, RelativePattern, workspace, env, window, __state: state };
