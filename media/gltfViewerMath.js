// @ts-nocheck
// glTF viewer math — camera framing + JSON parse-error line extraction.
//
// Deliberately kept free of any three.js dependency (plain arrays / numbers
// in, plain objects out) so it can be unit-tested with plain Node, mirroring
// media/mermaidSyntax.js's UMD pattern. media/gltfEditor.js is the only
// caller in the webview; it translates THREE.Box3 into the plain
// [x, y, z] arrays this module expects.
(function (global) {
  'use strict';

  /**
   * Compute camera framing for a bounding box, given the camera's vertical
   * FOV in degrees. Mirrors the `frameModel()` maths in gltfEditor.js.
   *
   * A box is "empty" using THREE.Box3's own convention: min > max on any
   * axis (THREE.Box3's empty state is min = (+Inf,+Inf,+Inf), max =
   * (-Inf,-Inf,-Inf)). Callers must check `.isEmpty` before using the rest of
   * the result — an empty box has no meaningful center to frame.
   *
   * A degenerate but non-empty box (all dimensions zero — a single point)
   * would otherwise produce dist = 0, which forces near > far (both derived
   * from dist) and NaNs the projection matrix. maxDim is floored to a small
   * positive value to keep near < far in that case.
   *
   * @param {[number, number, number]} boxMin
   * @param {[number, number, number]} boxMax
   * @param {number} fovDeg vertical field of view, in degrees
   * @returns {{isEmpty: true} | {
   *   isEmpty: false,
   *   center: [number, number, number],
   *   size: [number, number, number],
   *   maxDim: number,
   *   dist: number,
   *   near: number,
   *   far: number,
   *   position: [number, number, number],
   * }}
   */
  function computeFraming(boxMin, boxMax, fovDeg) {
    const isEmpty =
      boxMin[0] > boxMax[0] || boxMin[1] > boxMax[1] || boxMin[2] > boxMax[2];
    if (isEmpty) {
      return { isEmpty: true };
    }

    const center = [
      (boxMin[0] + boxMax[0]) / 2,
      (boxMin[1] + boxMax[1]) / 2,
      (boxMin[2] + boxMax[2]) / 2,
    ];
    const size = [
      boxMax[0] - boxMin[0],
      boxMax[1] - boxMin[1],
      boxMax[2] - boxMin[2],
    ];
    const rawMaxDim = Math.max(size[0], size[1], size[2]);
    // Floor so a single-point (or perfectly flat-in-every-axis) box still
    // yields a usable, non-zero viewing distance.
    const maxDim = rawMaxDim > 0 ? rawMaxDim : 0.01;

    const dist = (maxDim / (2 * Math.tan((fovDeg * Math.PI) / 360))) * 1.5;
    const near = Math.max(dist / 100, 0.001);
    const far = dist * 100;
    const position = [
      center[0] + dist * 0.6,
      center[1] + dist * 0.4,
      center[2] + dist,
    ];

    return { isEmpty: false, center, size, maxDim: rawMaxDim, dist, near, far, position };
  }

  /**
   * Clamp a 1-based line number into [1, number of lines in source].
   * @param {number} line
   * @param {string} source
   * @returns {number}
   */
  function clampLine(line, source) {
    const max = Math.max(1, source.split('\n').length);
    return Math.min(Math.max(1, line), max);
  }

  /**
   * Pull a 1-based source line number out of a `JSON.parse` error.
   *
   * V8 has emitted two message shapes for this over time:
   *  - Newer (Node 20+ / Chromium 121+): "... in JSON at position 5 (line 1
   *    column 6)" — the line number is right there in the message.
   *  - Older: "... in JSON at position 5" — only a character offset; the
   *    line is recovered by counting newlines up to that offset in `source`.
   *
   * @param {unknown} err
   * @param {string} source the text that was parsed, used to count newlines
   *   for the older message shape and to clamp the result into range
   * @returns {number|null} 1-based line number, or null if neither shape matched
   */
  function extractJsonErrorLine(err, source) {
    const message = String((err && err.message) || err || '');

    const withLine = /\(line (\d+) column \d+\)/.exec(message);
    if (withLine) {
      return clampLine(parseInt(withLine[1], 10), source);
    }

    const withPosition = /at position (\d+)/.exec(message);
    if (withPosition) {
      const pos = Math.max(0, Math.min(parseInt(withPosition[1], 10), source.length));
      const line = source.slice(0, pos).split('\n').length;
      return clampLine(line, source);
    }

    return null;
  }

  const api = { computeFraming, extractJsonErrorLine };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.GltfViewerMath = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
