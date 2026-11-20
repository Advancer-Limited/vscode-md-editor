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
  messages: [],
  registered: [],
  reset() {
    this.files.clear(); this.watchers.length = 0; this.opened.length = 0;
    this.clipboard = undefined; this.messages.length = 0; this.registered.length = 0;
  },
  writeFile(uri, data, mtime = Date.now()) { this.files.set(uri.toString(), { data, mtime }); },
};

function fileNotFound(uri) { const e = new Error(`EntryNotFound (FileSystemError): ${uri}`); e.code = 'FileNotFound'; return e; }

const workspace = {
  fs: {
    async readFile(uri) {
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
  createFileSystemWatcher(pattern) {
    const change = new EventEmitter(), create = new EventEmitter(), del = new EventEmitter();
    const w = {
      pattern, disposed: false,
      onDidChange: change.event, onDidCreate: create.event, onDidDelete: del.event,
      fireChange: () => change.fire(), fireCreate: () => create.fire(),
      dispose() { this.disposed = true; },
    };
    state.watchers.push(w);
    return w;
  },
};

const env = {
  async openExternal(uri) { state.opened.push(uri.toString()); return true; },
  clipboard: { async writeText(t) { state.clipboard = t; } },
};

const window = {
  async showInformationMessage(...a) { state.messages.push(['info', ...a]); return undefined; },
  async showWarningMessage(...a) { state.messages.push(['warning', ...a]); return undefined; },
  async showErrorMessage(...a) { state.messages.push(['error', ...a]); return undefined; },
  registerCustomEditorProvider(viewType, provider, options) {
    state.registered.push({ viewType, provider, options });
    return { dispose() {} };
  },
};

module.exports = { Uri, EventEmitter, RelativePattern, workspace, env, window, __state: state };
