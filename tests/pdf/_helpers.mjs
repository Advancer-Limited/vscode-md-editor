// Shared helpers for PDF tests. Core code is reached only through the test bundle
// (built by `node esbuild.js --test-bundle`, which `npm test` runs first).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(here, '..', 'fixtures', 'pdf');

export const core = require('../.build/pdf-core.cjs');

/** Read a fixture from tests/fixtures/pdf/ as a Uint8Array. */
export function fixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
}

/** List *.pdf fixture names (empty until PWP-03 lands). */
export function allFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.pdf')).sort();
}

/**
 * Event-loop responsiveness while `fn` runs. A setImmediate ticker records every gap between event-loop turns.
 * The longest gap alone is a poor measure: it is wall-clock time, so it also holds GC pauses and the scheduler
 * time other test files (run in parallel by `npm test`) take from this process; under load one gap of a correct
 * 30 ms slice was measured at 113–188 ms. So responsiveness is asserted as:
 *  - the yield cadence: the median gap stays near the code's own slice length (`yieldIntervalMs`, 30 ms), which
 *    one long synchronous stage cannot fake, because work that never yields leaves only one or two gaps;
 *  - enough turns: at least one turn per `CADENCE_TURN_MS` of run time;
 *  - a hard ceiling with headroom (`MAX_LOOP_GAP_MS`) that still catches a real block of hundreds of ms.
 */
export const MAX_LOOP_GAP_MS = 250;
export const MEDIAN_LOOP_GAP_MS = 60;
export const CADENCE_TURN_MS = 100;

export async function watchLoop(fn) {
  let last = performance.now(); let on = true; const gaps = []; const t0 = performance.now();
  const tick = () => { const t = performance.now(); gaps.push(t - last); last = t; if (on) setImmediate(tick); };
  setImmediate(tick);
  const result = await fn();
  const ms = performance.now() - t0;
  on = false;
  await new Promise((r) => setImmediate(r));
  const sorted = gaps.slice().sort((a, b) => a - b);
  const maxGap = sorted.length ? sorted[sorted.length - 1] : ms;
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : ms;
  const long = gaps.filter((g) => g > 25).map((g) => g.toFixed(1));
  return { result, ms, gaps, turns: gaps.length, maxGap, median,
    summary: `${gaps.length} turns in ${ms.toFixed(0)} ms, median gap ${median.toFixed(1)} ms, max ${maxGap.toFixed(1)} ms; gaps over 25 ms: ${long.join(' ') || 'none'}` };
}

/** Assert the `watchLoop` stats show a responsive event loop (see `watchLoop`). */
export function assertResponsive(assert, w, label) {
  assert.ok(w.maxGap < MAX_LOOP_GAP_MS, `${label}: event loop blocked for ${w.maxGap.toFixed(1)} ms (${w.summary})`);
  assert.ok(w.median < MEDIAN_LOOP_GAP_MS, `${label}: median event-loop gap ${w.median.toFixed(1)} ms — not yielding at its cadence (${w.summary})`);
  assert.ok(w.turns >= Math.floor(w.ms / CADENCE_TURN_MS), `${label}: only ${w.turns} event-loop turns in ${w.ms.toFixed(0)} ms (${w.summary})`);
}
