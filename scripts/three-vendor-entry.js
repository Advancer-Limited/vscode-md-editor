// Vendor entry point for the glTF editor's 3D viewer.
//
// three.js dropped its UMD builds (removed at r160/r161) and its
// examples/jsm/* addons (GLTFLoader, OrbitControls, RoomEnvironment) have
// been ESM-only since r148. There is no single file to copy into media/ the
// way mermaid.min.js / force-graph.min.js are (see scripts/copy-vendor.js) —
// instead this entry re-exports everything the webview needs, and esbuild
// bundles it into one IIFE global (`ThreeBundle`) at media/three-bundle.js
// (see the second esbuild context in esbuild.js). Keep this file a pure
// re-export; application logic belongs in media/gltfEditor.js.
export * as THREE from 'three';
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
