// Raw DEFLATE compression that yields to the event loop (spec §10.2), byte-identical to fflate's
// `deflateSync(data, { level })` (what `zip.rawDeflate` uses, so `OfficePackage.serializeAsync` equals
// `serialize`). fflate's streaming `Deflate` cannot be used for that: it picks a different hash size
// and splits blocks at its chunk boundaries, so its output differs. This is fflate 0.8.3's one-shot
// compressor (`dopt` -> `dflt`, `wblk`, `hTree`, `lc`, `hMap`, …) transcribed with the main loop
// made resumable: every DEFLATE_CHECK_EVERY input positions it checks a deadline and awaits a yield.
// Nothing else changed, so the bit stream is the same; tests/office/saveAsync.test.mjs checks it
// against fflate on every fixture part and on random data. If fflate is upgraded, re-check that test.
//
// fflate is MIT licensed: Copyright (c) 2026 Arjun Barrett (https://github.com/101arrowz/fflate).
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software. THE
// SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
//
// No `vscode` import here (core rule).

const u8 = Uint8Array, u16 = Uint16Array, i32 = Int32Array;

// fixed length extra bits
const fleb = new u8([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0]);
// fixed distance extra bits
const fdeb = new u8([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0]);
// code length index map
const clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

function freb(eb: Uint8Array, start: number): { b: Uint16Array; r: Int32Array } {
  const b = new u16(31);
  for (let i = 0; i < 31; ++i) b[i] = start += 1 << eb[i - 1];
  const r = new i32(b[30]);
  for (let i = 1; i < 30; ++i) {
    for (let j = b[i]; j < b[i + 1]; ++j) r[j] = ((j - b[i]) << 5) | i;
  }
  return { b, r };
}
const revfl = freb(fleb, 2).r;
revfl[258] = 28;
const revfd = freb(fdeb, 0).r;

const rev = new u16(32768);
for (let i = 0; i < 32768; ++i) {
  let x = ((i & 0xAAAA) >> 1) | ((i & 0x5555) << 1);
  x = ((x & 0xCCCC) >> 2) | ((x & 0x3333) << 2);
  x = ((x & 0xF0F0) >> 4) | ((x & 0x0F0F) << 4);
  rev[i] = (((x & 0xFF00) >> 8) | ((x & 0x00FF) << 8)) >> 1;
}

/** Huffman codes from code lengths (the encoder half of fflate's hMap: r = 0). */
function hMap(cd: Uint8Array, mb: number): Uint16Array {
  const s = cd.length;
  const l = new u16(mb);
  for (let i = 0; i < s; ++i) if (cd[i]) ++l[cd[i] - 1];
  const le = new u16(mb);
  for (let i = 1; i < mb; ++i) le[i] = (le[i - 1] + l[i - 1]) << 1;
  const co = new u16(s);
  for (let i = 0; i < s; ++i) if (cd[i]) co[i] = rev[le[cd[i] - 1]++] >> (15 - cd[i]);
  return co;
}

const flt = new u8(288);
for (let i = 0; i < 144; ++i) flt[i] = 8;
for (let i = 144; i < 256; ++i) flt[i] = 9;
for (let i = 256; i < 280; ++i) flt[i] = 7;
for (let i = 280; i < 288; ++i) flt[i] = 8;
const fdt = new u8(32);
for (let i = 0; i < 32; ++i) fdt[i] = 5;
const flm = hMap(flt, 9);
const fdm = hMap(fdt, 5);

const shft = (p: number): number => ((p + 7) / 8) | 0;
const et = new u8(0);

function wbits(d: Uint8Array, p: number, v: number): void {
  v <<= p & 7;
  const o = (p / 8) | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
}

function wbits16(d: Uint8Array, p: number, v: number): void {
  v <<= p & 7;
  const o = (p / 8) | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
  d[o + 2] |= v >> 16;
}

interface HNode { s: number; f: number; l?: HNode; r?: HNode }

function ln(n: HNode, l: Uint16Array, d: number): number {
  return n.s == -1 ? Math.max(ln(n.l!, l, d + 1), ln(n.r!, l, d + 1)) : (l[n.s] = d);
}

/** Code lengths from a frequency table, at most `mb` bits. */
function hTree(d: Uint16Array, mb: number): { t: Uint8Array; l: number } {
  const t: HNode[] = [];
  for (let i = 0; i < d.length; ++i) if (d[i]) t.push({ s: i, f: d[i] });
  const s = t.length;
  const t2 = t.slice();
  if (!s) return { t: et, l: 0 };
  if (s == 1) {
    const v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return { t: v, l: 1 };
  }
  t.sort((a, b) => a.f - b.f);
  t.push({ s: -1, f: 25001 });
  let l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 != s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  let maxSym = t2[0].s;
  for (let i = 1; i < s; ++i) if (t2[i].s > maxSym) maxSym = t2[i].s;
  const tr = new u16(maxSym + 1);
  let mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    let i = 0, dt = 0;
    const lft = mbt - mb, cst = 1 << lft;
    t2.sort((a, b) => tr[b.s] - tr[a.s] || a.f - b.f);
    for (; i < s; ++i) {
      const i2_1 = t2[i].s;
      if (tr[i2_1] > mb) {
        dt += cst - (1 << (mbt - tr[i2_1]));
        tr[i2_1] = mb;
      } else break;
    }
    dt >>= lft;
    while (dt > 0) {
      const i2_2 = t2[i].s;
      if (tr[i2_2] < mb) dt -= 1 << (mb - tr[i2_2]++ - 1);
      else ++i;
    }
    for (; i >= 0 && dt; --i) {
      const i2_3 = t2[i].s;
      if (tr[i2_3] == mb) {
        --tr[i2_3];
        ++dt;
      }
    }
    mbt = mb;
  }
  return { t: new u8(tr), l: mbt };
}

/** Run-length coded code lengths. */
function lc(c: Uint8Array): { c: Uint16Array; n: number } {
  let s = c.length;
  while (s && !c[--s]);
  const cl = new u16(++s);
  let cli = 0, cln = c[0], cls = 1;
  const w = (v: number): void => { cl[cli++] = v; };
  for (let i = 1; i <= s; ++i) {
    if (c[i] == cln && i != s) ++cls;
    else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138) w(32754);
        if (cls > 2) {
          w(cls > 10 ? ((cls - 11) << 5) | 28690 : ((cls - 3) << 5) | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6) w(8304);
        if (cls > 2) w(((cls - 3) << 5) | 8208), cls = 0;
      }
      while (cls--) w(cln);
      cls = 1;
      cln = c[i];
    }
  }
  return { c: cl.subarray(0, cli), n: s };
}

function clen(cf: Uint16Array, cl: Uint8Array): number {
  let l = 0;
  for (let i = 0; i < cl.length; ++i) l += cf[i] * cl[i];
  return l;
}

/** Stored block; returns the new bit position. */
function wfblk(out: Uint8Array, pos: number, dat: Uint8Array): number {
  const s = dat.length;
  const o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (let i = 0; i < s; ++i) out[o + i + 4] = dat[i];
  return (o + 4 + s) * 8;
}

function wblk(dat: Uint8Array, out: Uint8Array, final: number, syms: Int32Array, lf: Uint16Array, df: Uint16Array,
  eb: number, li: number, bs: number, bl: number, p: number): number {
  wbits(out, p++, final);
  ++lf[256];
  const { t: dlt, l: mlb } = hTree(lf, 15);
  const { t: ddt, l: mdb } = hTree(df, 15);
  const { c: lclt, n: nlc } = lc(dlt);
  const { c: lcdt, n: ndc } = lc(ddt);
  const lcfreq = new u16(19);
  for (let i = 0; i < lclt.length; ++i) ++lcfreq[lclt[i] & 31];
  for (let i = 0; i < lcdt.length; ++i) ++lcfreq[lcdt[i] & 31];
  const { t: lct, l: mlcb } = hTree(lcfreq, 7);
  let nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc);
  const flen = (bl + 5) << 3;
  const ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  const dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
  if (bs >= 0 && flen <= ftlen && flen <= dtlen) return wfblk(out, p, dat.subarray(bs, bs + bl));
  let lm: Uint16Array, ll: Uint8Array, dm: Uint16Array, dl: Uint8Array;
  wbits(out, p, 1 + (dtlen < ftlen ? 1 : 0)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb), ll = dlt, dm = hMap(ddt, mdb), dl = ddt;
    const llm = hMap(lct, mlcb);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (let i = 0; i < nlcc; ++i) wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    const lcts = [lclt, lcdt];
    for (let it = 0; it < 2; ++it) {
      const clct = lcts[it];
      for (let i = 0; i < clct.length; ++i) {
        const len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15) wbits(out, p, (clct[i] >> 5) & 127), p += clct[i] >> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (let i = 0; i < li; ++i) {
    const sym = syms[i];
    if (sym > 255) {
      const len = (sym >> 18) & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7) wbits(out, p, (sym >> 23) & 31), p += fleb[len];
      const dst = sym & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3) wbits16(out, p, (sym >> 5) & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[sym]), p += ll[sym];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
}

// deflate options (nice << 13) | chain, per level 1..9
const deo = new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);

/** Input positions between deadline checks (a check costs one Date.now()). */
const DEFLATE_CHECK_EVERY = 16384;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * Raw DEFLATE of `data` at `level` (1–9), identical to fflate `deflateSync(data, { level })`, yielding
 * to the event loop whenever `yieldEveryMs` have passed since the last yield.
 */
export async function deflateRawAsync(data: Uint8Array, level: number, yieldEveryMs: number): Promise<Uint8Array> {
  if (!Number.isInteger(level) || level < 1 || level > 9) throw new RangeError(`deflateRawAsync: level ${level} is not 1–9`);
  const dat = data;
  // dopt with no state: one final block stream; hash bits from the input size.
  const plvl = Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5);
  const s = dat.length;
  const o = new u8(s + 5 * (1 + Math.ceil(s / 7000)));
  const w = o;
  const lst = 1;
  let pos = 0;
  const opt = deo[level - 1];
  const n = opt >> 13, c = opt & 8191;
  const msk = (1 << plvl) - 1;
  const prev = new u16(32768), head = new u16(msk + 1);
  const bs1 = Math.ceil(plvl / 3), bs2 = 2 * bs1;
  const hsh = (i: number): number => (dat[i] ^ (dat[i + 1] << bs1) ^ (dat[i + 2] << bs2)) & msk;
  const syms = new i32(25000);
  const lf = new u16(288), df = new u16(32);
  let lc1 = 0, eb = 0, i = 0, li = 0, wi = 0, bs = 0;
  let deadline = Date.now() + yieldEveryMs;
  let nextCheck = DEFLATE_CHECK_EVERY;
  for (; i + 2 < s; ++i) {
    if (i >= nextCheck) {
      nextCheck = i + DEFLATE_CHECK_EVERY;
      if (Date.now() >= deadline) {
        await yieldToEventLoop();
        deadline = Date.now() + yieldEveryMs;
      }
    }
    const hv = hsh(i);
    let imod = i & 32767, pimod = head[hv];
    prev[imod] = pimod;
    head[hv] = imod;
    if (wi <= i) {
      const rem = s - i;
      if ((lc1 > 7000 || li > 24576) && (rem > 423 || !lst)) {
        pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
        li = lc1 = eb = 0, bs = i;
        for (let j = 0; j < 286; ++j) lf[j] = 0;
        for (let j = 0; j < 30; ++j) df[j] = 0;
      }
      let l = 2, d = 0, ch = c, dif = imod - pimod & 32767;
      if (rem > 2 && hv == hsh(i - dif)) {
        const maxn = Math.min(n, rem) - 1;
        const maxd = Math.min(32767, i);
        const ml = Math.min(258, rem);
        while (dif <= maxd && --ch && imod != pimod) {
          if (dat[i + l] == dat[i + l - dif]) {
            let nl = 0;
            for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl);
            if (nl > l) {
              l = nl, d = dif;
              if (nl > maxn) break;
              const mmd = Math.min(dif, nl - 2);
              let md = 0;
              for (let j = 0; j < mmd; ++j) {
                const ti = i - dif + j & 32767;
                const pti = prev[ti];
                const cd = ti - pti & 32767;
                if (cd > md) md = cd, pimod = ti;
              }
            }
          }
          imod = pimod, pimod = prev[imod];
          dif += imod - pimod & 32767;
        }
      }
      if (d) {
        syms[li++] = 268435456 | (revfl[l] << 18) | revfd[d];
        const lin = revfl[l] & 31, din = revfd[d] & 31;
        eb += fleb[lin] + fdeb[din];
        ++lf[257 + lin];
        ++df[din];
        wi = i + l;
        ++lc1;
      } else {
        syms[li++] = dat[i];
        ++lf[dat[i]];
      }
    }
  }
  for (i = Math.max(i, wi); i < s; ++i) {
    syms[li++] = dat[i];
    ++lf[dat[i]];
  }
  pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
  return new u8(o.subarray(0, shft(pos)));
}
