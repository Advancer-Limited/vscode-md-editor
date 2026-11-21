// Barrel for the PDF core (no `vscode` imports allowed under src/pdf/core).
// Written once by PWP-02; parallel WPs replace the stub module files and never edit this.
// (protocol.ts lives one level up, src/pdf/protocol.ts, and is not part of the core barrel.)
export * as sniff from './sniff.js';
export * as reader from './reader.js';
export * as classify from './classify.js';
export * as state from './state.js';
export * as geometry from './geometry.js';
export * as storageAdapter from './storageAdapter.js';
export * as verify from './verify.js';
export * as limits from './limits.js';
