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

class CancellationError extends Error { constructor() { super('Canceled'); this.name = 'Canceled'; } }

/** Mirrors vscode.FileSystemError: `code` and a name like "NoPermissions (FileSystemError)". */
class FileSystemError extends Error {
  constructor(message, code) { super(message); this.code = code; this.name = `${code} (FileSystemError)`; }
  static FileNotFound(u) { return new FileSystemError(`EntryNotFound (FileSystemError): ${u}`, 'FileNotFound'); }
  static NoPermissions(m) { return new FileSystemError(String(m ?? 'NoPermissions'), 'NoPermissions'); }
  static Unavailable(m) { return new FileSystemError(String(m ?? 'Unavailable'), 'Unavailable'); }
}

class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }

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
  commands: [],
  /** Every fs mutation in order: ['write'|'rename'|'delete', uri string(s)]. */
  fsLog: [],
  /**
   * Failure injection: `(op, uri, extra) => Error | undefined`, op in write/rename/delete/stat.
   * Returning an error makes that call throw it (after `renameDeletesTarget` handling for rename).
   */
  fail: undefined,
  /** Like VS Code's disk provider: rename with overwrite deletes the target before renaming. */
  renameDeletesTarget: false,
  /** Answer for the next modal/notification with buttons: (message, items) => item | undefined. */
  answer: undefined,
  saveDialogResult: undefined,
  activeTabInput: undefined,
  clock: 10_000,
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
    this.commands.length = 0; this.fsLog.length = 0;
    this.fail = undefined; this.renameDeletesTarget = false; this.answer = undefined;
    this.saveDialogResult = undefined; this.activeTabInput = undefined; this.clock = 10_000;
    this.reads.length = 0; env.remoteName = undefined;
  },
  writeFile(uri, data, mtime = Date.now()) { this.files.set(uri.toString(), { data, mtime }); },
  read(uri) { return this.files.get(uri.toString())?.data; },
};

function fileNotFound(uri) { const e = new Error(`EntryNotFound (FileSystemError): ${uri}`); e.code = 'FileNotFound'; return e; }
function injected(op, uri, extra) { const e = state.fail?.(op, uri.toString(), extra); if (e) throw e; }

const workspace = {
  fs: {
    async readFile(uri) {
      state.reads.push(uri.toString());
      const f = state.files.get(uri.toString());
      if (!f) throw fileNotFound(uri);
      return f.data;
    },
    async stat(uri) {
      injected('stat', uri);
      const f = state.files.get(uri.toString());
      if (!f) throw fileNotFound(uri);
      return { type: 1, ctime: f.mtime, mtime: f.mtime, size: f.data.length };
    },
    async writeFile(uri, data) {
      injected('write', uri);
      state.fsLog.push(['write', uri.toString()]);
      state.files.set(uri.toString(), { data: new Uint8Array(data), mtime: ++state.clock });
    },
    async rename(from, to, opts) {
      const f = state.files.get(from.toString());
      if (!f) throw fileNotFound(from);
      if (state.files.has(to.toString()) && !opts?.overwrite) throw new FileSystemError('exists', 'FileExists');
      if (state.renameDeletesTarget) state.files.delete(to.toString());
      injected('rename', from, to.toString());
      state.fsLog.push(['rename', from.toString(), to.toString()]);
      state.files.delete(from.toString());
      state.files.set(to.toString(), { data: f.data, mtime: ++state.clock });
    },
    async delete(uri) {
      injected('delete', uri);
      if (!state.files.has(uri.toString())) throw fileNotFound(uri);
      state.fsLog.push(['delete', uri.toString()]);
      state.files.delete(uri.toString());
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

/** Records the message; answers with `state.answer(message, items, options)` when buttons are offered. */
function notify(kind, args) {
  state.messages.push([kind, ...args]);
  const items = args.slice(1).filter((a) => typeof a === 'string');
  const options = args.slice(1).find((a) => typeof a === 'object' && a !== null);
  return Promise.resolve(items.length && state.answer ? state.answer(args[0], items, options) : undefined);
}

const window = {
  showInformationMessage(...a) { return notify('info', a); },
  showWarningMessage(...a) { return notify('warning', a); },
  showErrorMessage(...a) { return notify('error', a); },
  async showSaveDialog(opts) { state.messages.push(['saveDialog', opts]); return state.saveDialogResult; },
  async showQuickPick(items, options) {
    state.quickPickCalls = (state.quickPickCalls || 0) + 1;
    const a = state.quickPicks.shift();
    return typeof a === 'function' ? a(items, options) : a;
  },
  registerCustomEditorProvider(viewType, provider, options) {
    state.registered.push({ viewType, provider, options });
    return { dispose() {} };
  },
  get tabGroups() {
    return { activeTabGroup: { activeTab: state.activeTabInput ? { input: state.activeTabInput } : undefined } };
  },
};

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

const commands = {
  async executeCommand(id, ...args) { state.commands.push([id, ...args]); return undefined; },
};

module.exports = {
  ConfigurationTarget, Uri, EventEmitter, RelativePattern, CancellationError, FileSystemError, TabInputCustom,
  workspace, env, window, commands, __state: state,
};
