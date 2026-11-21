// PWP-15: core/state.ts — host-owned edit state, deltas, undo/redo, normalisation (spec §6.3).
import { test } from 'node:test';
import assert from 'node:assert';
import { core } from './_helpers.mjs';

const S = core.state;
const LETTER = { x0: 0, y0: 0, x1: 612, y1: 792 };

/** Three pages (the third offset and rotated), two deletable annotations (one with a Popup), three fields. */
function makeCtx() {
  return {
    pages: [{ mediaBox: LETTER }, { mediaBox: LETTER, cropBox: { x0: 36, y0: 36, x1: 576, y1: 756 } },
      { mediaBox: { x0: 1000, y0: 2000, x1: 1842, y1: 2595 }, rotate: 90 }],
    deletable: new Map([['10 0', { page: 0, popup: '11 0' }], ['20 0', { page: 1 }], ['21 3', { page: 2 }]]),
    popups: new Map([['11 0', '10 0']]),
    fields: new Map([['30 0', { kind: 'text' }], ['31 0', { kind: 'button' }], ['32 0', { kind: 'choice' }],
      ['33 0', { kind: 'text', check: (v) => (v.length > 5 ? 'Too long.' : null) }]]),
  };
}

function makeEnv(baseline = new Map()) {
  let t = 0;
  return { baseline, now: () => new Date(Date.UTC(2026, 10, 21) + 1000 * t++).toISOString() };
}

const quad = (x, y, w = 40, h = 12) => [x, y + h, x + w, y + h, x, y, x + w, y];
const hl = (localId, o = {}) => ({ kind: 'highlight', localId, page: 0, quads: quad(100, 100), color: 'yellow', comment: '', ...o });
const ink = (localId, o = {}) => ({ kind: 'ink', localId, page: 1, paths: [[100, 100, 120, 130, 140, 100]], color: 'red', width: 2, comment: '', ...o });
const add = (spec) => ({ op: 'addAnnotation', spec });
const upd = (localId, patch) => ({ op: 'updateAnnotation', localId, patch });
const rmLocal = (localId) => ({ op: 'removeAnnotation', target: { localId } });
const rmRef = (num, gen = 0) => ({ op: 'removeAnnotation', target: { ref: { num, gen } } });
const setF = (...values) => ({ op: 'setFields', values: values.map(([num, value, loaded]) =>
  (loaded === undefined ? { ref: { num, gen: 0 }, value } : { ref: { num, gen: 0 }, value, loaded })) });

/** Plan + apply; asserts success and returns the plan. */
function edit(state, op, ctx, env) {
  const plan = S.applyEdit(state, op, ctx, env);
  assert.ok(plan.ok, plan.ok ? '' : `${op.op}: ${plan.error.reason}`);
  return plan;
}

function refused(state, op, ctx, env, reason) {
  const before = S.cloneState(state);
  const plan = S.planEdit(state, op, ctx, env);
  assert.strictEqual(plan.ok, false, `${op.op} should be refused`);
  assert.strictEqual(plan.error.reason, reason);
  assert.strictEqual(plan.error.code, 'invalid');
  assert.ok(plan.error.message.length > 0);
  assert.ok(S.statesEqual(state, before), 'a refused plan changes nothing');
}

test('refKey / parseRefKey', () => {
  assert.strictEqual(S.refKey({ num: 12, gen: 3 }), '12 3');
  assert.deepStrictEqual(S.parseRefKey('12 3'), { num: 12, gen: 3 });
});

test('every op applies, undoes and redoes to the exact states, with its label', () => {
  const ctx = makeCtx();
  const env = makeEnv(new Map([['30 0', 'loaded'], ['31 0', false], ['32 0', ['a']]]));
  const s = S.emptyState();
  const ops = [
    [add(hl(1)), 'Highlight'],
    [add(ink(2)), 'Draw'],
    [upd(1, { comment: 'note' }), 'Edit Comment'],
    [upd(1, { color: 'blue' }), 'Change Colour'],
    [upd(2, { comment: 'x', color: 'green' }), 'Edit Comment and Colour'],
    [rmLocal(2), 'Delete Annotation'],
    [rmRef(10), 'Delete Annotation'],
    [rmRef(21, 3), 'Delete Annotation'],
    [setF([30, 'typed'], [31, true], [32, ['b', 'c']]), 'Fill Form Field'],
  ];
  const snapshots = [S.cloneState(s)];
  const deltas = [];
  for (const [op, label] of ops) {
    const plan = edit(s, op, ctx, env);
    assert.strictEqual(plan.label, label);
    assert.ok(plan.delta.length > 0);
    deltas.push(plan.delta);
    snapshots.push(S.cloneState(s));
  }
  for (let i = deltas.length - 1; i >= 0; i--) {
    assert.ok(S.applyDelta(s, S.invertDelta(deltas[i])));
    assert.ok(S.statesEqual(s, snapshots[i]), `undo ${i}`);
  }
  assert.ok(S.isEmptyState(s));
  for (let i = 0; i < deltas.length; i++) {
    assert.ok(S.applyDelta(s, deltas[i]));
    assert.ok(S.statesEqual(s, snapshots[i + 1]), `redo ${i}`);
  }
  // Redo restores the same record (creation time and unique name included).
  assert.strictEqual(s.added.get(1).createdAt, snapshots[1].added.get(1).createdAt);
  assert.strictEqual(s.added.get(1).uniqueName, snapshots[1].added.get(1).uniqueName);
});

test('normalisation: add then remove leaves nothing; value back to loaded removes the key', () => {
  const ctx = makeCtx();
  const env = makeEnv();
  const s = S.emptyState();
  edit(s, add(hl(1)), ctx, env);
  edit(s, upd(1, { comment: 'c' }), ctx, env);
  edit(s, rmLocal(1), ctx, env);
  assert.ok(S.isEmptyState(s));

  // The loaded value is reported with the first change and kept (first report wins).
  assert.deepStrictEqual(S.fieldBaselines(setF([30, 'new', 'orig'], [99, 'x', 'y'], [31, true, 'wrong kind']), ctx), [['30 0', 'orig']]);
  edit(s, setF([30, 'new', 'orig']), ctx, env);
  assert.strictEqual(env.baseline.get('30 0'), 'orig');
  edit(s, setF([30, 'newer', 'lie']), ctx, env);
  assert.strictEqual(env.baseline.get('30 0'), 'orig', 'a later loaded value is ignored');
  assert.strictEqual(s.fields.get('30 0'), 'newer');
  const back = edit(s, setF([30, 'orig']), ctx, env);
  assert.strictEqual(back.delta[0].after, undefined);
  assert.ok(S.isEmptyState(s));

  // Choice arrays compare by value; button false back to loaded false.
  edit(s, setF([32, ['x', 'y'], ['x']], [31, true, false]), ctx, env);
  edit(s, setF([32, ['x']], [31, false]), ctx, env);
  assert.ok(S.isEmptyState(s));
});

test('an op that changes nothing plans an empty delta', () => {
  const ctx = makeCtx();
  const env = makeEnv(new Map([['30 0', 'v']]));
  const s = S.emptyState();
  edit(s, add(hl(1, { comment: 'c' })), ctx, env);
  edit(s, rmRef(20), ctx, env);
  edit(s, setF([31, true]), ctx, env);
  const snap = S.cloneState(s);
  for (const op of [upd(1, { comment: 'c' }), upd(1, { color: 'yellow' }), upd(1, { comment: 'c', color: 'yellow' }),
    rmRef(20), setF([31, true]), setF([30, 'v'])]) {
    const plan = S.planEdit(s, op, ctx, env);
    assert.ok(plan.ok);
    assert.strictEqual(plan.delta.length, 0, JSON.stringify(op));
  }
  assert.ok(S.statesEqual(s, snap));
});

test('removing a Popup removes its markup annotation (one key)', () => {
  const ctx = makeCtx();
  const env = makeEnv();
  const s = S.emptyState();
  edit(s, rmRef(11), ctx, env);
  assert.deepStrictEqual([...s.removed], ['10 0']);
  assert.strictEqual(S.planEdit(s, rmRef(10), ctx, env).delta.length, 0, 'already removed through its Popup');
});

test('refusals', () => {
  const ctx = makeCtx();
  const env = makeEnv();
  const s = S.emptyState();
  edit(s, add(hl(1)), ctx, env);
  refused(s, add(hl(1)), ctx, env, 'duplicate-local-id');
  refused(s, add(hl(2, { page: 3 })), ctx, env, 'unknown-page');
  refused(s, add(hl(2, { quads: [1, 1, 1, 1, 1, 1, 1, 1] })), ctx, env, 'bad-geometry');
  refused(s, add(hl(2, { quads: quad(600, 780) })), ctx, env, 'outside-page');
  refused(s, add(hl(2, { page: 2, quads: quad(100, 100) })), ctx, env, 'outside-page');
  refused(s, add(ink(2, { paths: [[1, 1]] })), ctx, env, 'bad-geometry');
  refused(s, add(ink(2, { paths: [] })), ctx, env, 'bad-geometry');
  refused(s, add(ink(2, { paths: [[-1, -1, 10, 10]], width: 4 })), ctx, env, 'outside-page');
  refused(s, upd(9, { comment: 'x' }), ctx, env, 'unknown-annotation');
  refused(s, rmLocal(9), ctx, env, 'unknown-annotation');
  refused(s, rmRef(99), ctx, env, 'not-deletable');
  refused(s, rmRef(10, 1), ctx, env, 'not-deletable');
  refused(s, setF([99, 'x']), ctx, env, 'not-fillable');
  refused(s, setF([30, true]), ctx, env, 'bad-value');
  refused(s, setF([31, 'on']), ctx, env, 'bad-value');
  refused(s, setF([32, false]), ctx, env, 'bad-value');
  refused(s, setF([30, 'x', true]), ctx, env, 'bad-value');
  refused(s, setF([33, 'toolong']), ctx, env, 'bad-value');
  refused(s, setF([30, 'a'], [30, 'b']), ctx, env, 'duplicate-field');
  // A refused first change still records its loaded value (the webview does not send it again).
  const env2 = makeEnv();
  assert.strictEqual(S.applyEdit(s, setF([30, 'ok', 'L'], [99, 'x']), ctx, env2).ok, false);
  assert.strictEqual(env2.baseline.get('30 0'), 'L');
  // A setFields with one bad entry changes nothing, even when the good one comes first.
  refused(s, setF([30, 'ok'], [99, 'x']), ctx, env, 'not-fillable');
  // Forms off (empty field table) refuses every field.
  refused(s, setF([30, 'x']), { ...ctx, fields: new Map() }, env, 'not-fillable');
  // On the offset page a highlight inside its media box is accepted.
  edit(s, add(hl(3, { page: 2, quads: quad(1100, 2100) })), ctx, env);
});

test('at most MAX_ADDED_ANNOTATIONS session annotations', () => {
  const ctx = makeCtx();
  const env = makeEnv();
  const s = S.emptyState();
  for (let i = 0; i < S.MAX_ADDED_ANNOTATIONS; i++) {
    const plan = S.planEdit(s, add(hl(i)), ctx, env);
    S.applyDelta(s, plan.delta);
  }
  assert.strictEqual(s.added.size, S.MAX_ADDED_ANNOTATIONS);
  refused(s, add(hl(S.MAX_ADDED_ANNOTATIONS)), ctx, env, 'too-many-annotations');
});

test('specs are normalised, copied and frozen', () => {
  const ctx = makeCtx();
  const env = makeEnv();
  const s = S.emptyState();
  const q = [140, 100, 100, 100, 140, 112, 100, 112];   // BR BL TR TL
  const spec = hl(1, { quads: q });
  edit(s, add(spec), ctx, env);
  const rec = s.added.get(1);
  assert.deepStrictEqual(rec.spec.quads, [100, 112, 140, 112, 100, 100, 140, 100]);
  q[0] = 9999;
  spec.comment = 'mutated';
  assert.strictEqual(rec.spec.comment, '');
  assert.ok(Object.isFrozen(rec) && Object.isFrozen(rec.spec) && Object.isFrozen(rec.spec.quads));
  const paths = [[100, 100, 110, 110]];
  edit(s, add(ink(2, { paths })), ctx, env);
  paths[0][0] = -1;
  assert.strictEqual(s.added.get(2).spec.paths[0][0], 100);
  assert.ok(Object.isFrozen(s.added.get(2).spec.paths[0]));
  assert.deepStrictEqual(S.annotationBounds(s.added.get(2).spec), { x0: 99, y0: 99, x1: 111, y1: 111 });
});

test('applyDelta refuses a stale delta atomically', () => {
  const ctx = makeCtx();
  const env = makeEnv();
  const s = S.emptyState();
  const d1 = edit(s, add(hl(1)), ctx, env).delta;
  assert.strictEqual(S.applyDelta(s, d1), false, 'redo of an add that is already there');
  const d2 = edit(s, setF([30, 'a']), ctx, env).delta;
  edit(s, setF([30, 'b']), ctx, env);
  const snap = S.cloneState(s);
  assert.strictEqual(S.applyDelta(s, S.invertDelta(d2)), false, 'undo of a value that has since changed');
  // Mixed: first entry matches, second does not -> nothing applied.
  const mixed = [{ slot: 'removed', key: '20 0', before: false, after: true }, { slot: 'fields', key: '30 0', before: 'zzz', after: undefined }];
  assert.strictEqual(S.applyDelta(s, mixed), false);
  assert.strictEqual(S.applyDelta(s, [mixed[0], mixed[0]]), false, 'a repeated key');
  assert.ok(S.statesEqual(s, snap));
  assert.ok(S.applyDelta(s, []), 'the empty delta always applies');
});

test('toStateView: canonical order (page, createdAt, localId), refs by number, fresh copies', () => {
  const ctx = makeCtx();
  const env = { now: () => '2026-11-21T00:00:00.000Z' };   // equal times -> localId decides
  const s = S.emptyState();
  edit(s, add(ink(7)), ctx, env);
  edit(s, add(hl(9)), ctx, env);
  edit(s, add(hl(3)), ctx, env);
  edit(s, add(hl(5, { page: 1 })), ctx, env);
  edit(s, rmRef(21, 3), ctx, env);
  edit(s, rmRef(10), ctx, env);
  edit(s, setF([32, ['z']], [30, 't']), ctx, env);
  const v = S.toStateView(s, 42);
  assert.strictEqual(v.version, 42);
  assert.deepStrictEqual(v.annots.map((a) => [a.page, a.localId]), [[0, 3], [0, 9], [1, 5], [1, 7]]);
  assert.strictEqual(v.annots[0].createdAt, '2026-11-21T00:00:00.000Z');
  assert.deepStrictEqual(v.removed, [{ num: 10, gen: 0 }, { num: 21, gen: 3 }]);
  assert.deepStrictEqual(v.fields, [{ ref: { num: 30, gen: 0 }, value: 't' }, { ref: { num: 32, gen: 0 }, value: ['z'] }]);
  v.annots[0].quads[0] = -5;
  v.fields[1].value.push('q');
  assert.notStrictEqual(s.added.get(3).spec.quads[0], -5);
  assert.deepStrictEqual(s.fields.get('32 0'), ['z']);
  // Creation time orders before localId.
  const t = ['b', 'a'];
  const s2 = S.emptyState();
  const env2 = { now: () => `2026-11-21T00:00:0${t.length}.000Z${t.pop()}` };
  edit(s2, add(hl(1)), ctx, env2);   // later string
  edit(s2, add(hl(2)), ctx, env2);   // earlier string
  assert.deepStrictEqual(S.canonicalAnnotations(s2).map((r) => r.spec.localId), [2, 1]);
  assert.strictEqual(S.toStateView(S.emptyState(), 0).annots.length, 0);
});

test('custom unique names; the default is deterministic', () => {
  const ctx = makeCtx();
  const s = S.emptyState();
  edit(s, add(hl(4)), ctx, { now: () => 'T', uniqueName: (id, at) => `u${id}${at}` });
  assert.strictEqual(s.added.get(4).uniqueName, 'u4T');
  assert.strictEqual(S.uniqueNameFor(4, 'T'), S.uniqueNameFor(4, 'T'));
});

// ---------------------------------------------------------------- seeded random sequences

function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOADED = new Map([['30 0', 'L'], ['31 0', false], ['32 0', ['a']], ['33 0', '']]);
const COLORS = ['yellow', 'green', 'blue', 'pink', 'red'];

/** A random op, valid or not, biased towards ids and refs that exist. */
function randomOp(r, s, nextId, reported) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const ids = [...s.added.keys()];
  const k = r();
  if (k < 0.3) {
    const page = Math.floor(r() * 3);
    if (r() < 0.5) {
      const x = page === 2 ? 1100 : 100 + r() * 300, y = page === 2 ? 2100 : 100 + r() * 500;
      const quads = [];
      for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) quads.push(...quad(x, y + 14 * i, 10 + r() * 60));
      return add(hl(nextId, { page, quads, color: pick(COLORS), comment: r() < 0.3 ? 'c' : '' }));
    }
    const ox = page === 2 ? 1000 : 0, oy = page === 2 ? 2000 : 0;
    return add(ink(nextId, { page, paths: [[ox + 100, oy + 100, ox + 100 + r() * 200, oy + 100 + r() * 200]], width: pick([1, 2, 4]) }));
  }
  if (k < 0.45) {
    const id = ids.length && r() < 0.9 ? pick(ids) : 999_999;
    return upd(id, r() < 0.5 ? { comment: pick(['', 'a', 'b']) } : { color: pick(COLORS) });
  }
  if (k < 0.6) return rmLocal(ids.length && r() < 0.9 ? pick(ids) : 999_999);
  if (k < 0.72) return rmRef(...pick([[10], [11], [20], [21, 3], [77]]));
  const n = 1 + Math.floor(r() * 2);
  const values = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const key = pick(['30 0', '31 0', '32 0', '33 0']);
    if (used.has(key)) continue;
    used.add(key);
    const num = Number(key.split(' ')[0]);
    let value;
    if (key === '31 0') value = r() < 0.5;
    else if (key === '32 0') value = pick([['a'], ['b'], ['a', 'b'], []]);
    else value = pick([LOADED.get(key), 'x', 'yy', 'zzzzzzz']);
    // The webview reports the loaded value with the first change to a field (spec §6.3), sometimes again later.
    const first = !reported.has(key);
    if (first) reported.add(key);
    values.push(first || r() < 0.2 ? [num, value, LOADED.get(key)] : [num, value]);
  }
  return setF(...values);
}

for (const seed of [1, 2, 3, 7, 42, 1234, 99991, 314159, 271828, 8675309]) {
  test(`seeded random sequence (seed ${seed}): 200 ops with undo/redo match a replay of the surviving ops`, () => {
    const r = rng(seed);
    const ctx = makeCtx();
    const env = makeEnv(new Map());
    const s = S.emptyState();
    const history = [];   // { op, createdAt, delta }
    let top = 0;           // history[0..top) is applied; history[top..] is the redo tail
    let nextId = 1;
    const reported = new Set();
    let applied = 0;
    for (let step = 0; step < 200; step++) {
      const k = r();
      if (k < 0.2 && top > 0) {
        assert.ok(S.applyDelta(s, S.invertDelta(history[--top].delta)), 'undo applies');
      } else if (k < 0.3 && top < history.length) {
        assert.ok(S.applyDelta(s, history[top++].delta), 'redo applies');
      } else {
        const op = randomOp(r, s, nextId, reported);
        if (op.op === 'addAnnotation') nextId++;
        let createdAt = null;
        S.noteBaselines(env.baseline, S.fieldBaselines(op, ctx));   // recorded whatever the outcome
        const plan = S.planEdit(s, op, ctx, { ...env, now: () => (createdAt = env.now()) });
        if (!plan.ok || plan.delta.length === 0) continue;   // refused or no change: no edit recorded
        assert.ok(S.applyDelta(s, plan.delta));
        history.length = top;                                 // a new edit drops the redo tail
        history.push({ op, createdAt, delta: plan.delta });
        top++;
        applied++;
      }
      // Invariant after every step: the state equals a fresh replay of the surviving ops.
      if (step % 10 === 9 || step === 199) {
        const replay = S.emptyState();
        for (const h of history.slice(0, top)) {
          const plan = S.planEdit(replay, h.op, ctx, { baseline: LOADED, now: () => h.createdAt });
          assert.ok(plan.ok && plan.delta.length > 0, 'a surviving op replays as a real edit');
          assert.ok(S.applyDelta(replay, plan.delta));
        }
        assert.ok(S.statesEqual(s, replay), `step ${step}: state differs from the replay`);
        assert.deepStrictEqual(S.toStateView(s, 0), S.toStateView(replay, 0));
      }
    }
    assert.ok(applied > 40, `enough edits exercised (${applied})`);
    // Everything undone -> exactly the empty state.
    while (top > 0) assert.ok(S.applyDelta(s, S.invertDelta(history[--top].delta)));
    assert.ok(S.isEmptyState(s), 'all undone is the empty state');
    // And everything redone again -> the same state as the full replay.
    while (top < history.length) assert.ok(S.applyDelta(s, history[top++].delta));
    const replay = S.emptyState();
    for (const h of history) S.applyDelta(replay, S.planEdit(replay, h.op, ctx, { baseline: LOADED, now: () => h.createdAt }).delta);
    assert.ok(S.statesEqual(s, replay));
  });
}
