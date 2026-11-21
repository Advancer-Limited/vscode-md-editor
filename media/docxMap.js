// @ts-nocheck
// Word render mapping: docx-preview output -> model block ids (spec §8.2, plan WP-27).
//
// The host renders a copy of the document whose paragraphs carry two empty marker bookmarks,
// `__vsmd_s_{id}` and `__vsmd_e_{id}` (src/office/core/docx/renderCopy.ts). docx-preview renders a
// bookmark start as `<span id="{name}">` inside the paragraph's `<p>`. For each block:
//   S, E = the <p> holding the start / end marker; C = nearest <td>/<th> ancestor of S (none for a
//   body paragraph). E must have the same C, otherwise the pair is "not found". Every <p> from S to
//   E in document order whose nearest cell ancestor is also C belongs to the block and gets
//   `data-block="{id}"`. So a page-break-split body paragraph claims both halves, never the <p>s of
//   a table between them, and a cell paragraph never claims those of a nested table.
// Two refinements of the §8.2 rule, needed because a split paragraph's halves sit on different
// pages: a claimed <p> must also be in the document body (inside an <article>) exactly when S is,
// so the page footer, footnotes and next page's header rendered between the halves are never
// claimed; and a <p> nested inside another <p> (text-box content) is never claimed. "Nearest cell
// ancestor" is therefore "nearest <td>/<th>/<p> ancestor"; a marker <p> that is itself nested in a
// <p> is not found.
// A block whose pair is missing, duplicated, out of order, in different cells, or whose <p> another
// block also claims is reported in `missing` and gets no <p>: the webview MUST NOT guess (the
// caller treats it as locked for this render and logs a diagnostic).
//
// Pure DOM module, UMD like media/docxIsland.js: walks childNodes only, no globals, no innerHTML.
(function (global) {
  'use strict';

  const ELEMENT = 1;
  const MARKER_PREFIX = '__vsmd_';
  const START = MARKER_PREFIX + 's_';
  const END = MARKER_PREFIX + 'e_';

  const tagOf = (el) => String(el.nodeName || el.tagName || '').toUpperCase();
  const isCell = (el) => { const t = tagOf(el); return t === 'TD' || t === 'TH'; };

  /** Nearest ancestor-or-self matching `pred`, stopping below `root` (root itself is never returned). */
  function closestWithin(node, root, pred) {
    for (let n = node; n && n !== root; n = n.parentNode) {
      if (n.nodeType === ELEMENT && pred(n)) { return n; }
    }
    return null;
  }

  /** Blocks the host put markers on: paragraphs that are not merged-cell continuations. */
  function isCandidate(info) {
    return !!info && info.kind === 'paragraph' && info.lockReason !== 'merged-cell';
  }

  /**
   * Map rendered <p> elements under `root` to blocks.
   * @param root       the element docx-preview rendered into
   * @param blockInfos DocxBlockInfo[] from docxRender / docxEditResult
   * @returns { byId: Map<number, Element[]>, missing: number[] } — byId lists each mapped block's
   *   <p> elements in document order; missing lists candidate blocks (paragraph, not merged-cell)
   *   that could not be mapped, in blockInfos order.
   */
  function mapBlocks(root, blockInfos) {
    // One walk: every <p> in document order (with its nearest cell), every marker span by id.
    const paras = [];
    const pIndex = new Map();
    const spans = new Map();   // marker id -> element[] (more than one = not found)
    const stack = [root];
    while (stack.length > 0) {
      const el = stack.pop();
      if (el !== root) {
        const tag = tagOf(el);
        if (tag === 'P') { pIndex.set(el, paras.length); paras.push(el); }
        else if (tag === 'SPAN') {
          const id = el.getAttribute('id');
          if (id && id.startsWith(MARKER_PREFIX)) {
            const list = spans.get(id);
            if (list) { list.push(el); } else { spans.set(id, [el]); }
          }
        }
      }
      const kids = el.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) {
        if (kids[i].nodeType === ELEMENT) { stack.push(kids[i]); }
      }
    }
    // Context of a <p>: its nearest <td>/<th>/<p> ancestor (null at body level), and whether it is in
    // the document body (<article>) rather than a page's header, footer or notes.
    const ctxCache = new Map();
    const ctxOf = (p) => {
      let c = ctxCache.get(p);
      if (!c) {
        const near = closestWithin(p.parentNode, root, (n) => isCell(n) || tagOf(n) === 'P');
        c = { near, inBody: !!closestWithin(p.parentNode, root, (n) => tagOf(n) === 'ARTICLE'),
          nested: !!near && tagOf(near) === 'P' };
        ctxCache.set(p, c);
      }
      return c;
    };
    const sameCtx = (a, b) => a.near === b.near && a.inBody === b.inBody;
    const isP = (el) => tagOf(el) === 'P';
    const one = (name) => { const l = spans.get(name); return l && l.length === 1 ? l[0] : null; };

    // Clear a previous mapping of this DOM (mapBlocks is idempotent).
    for (const p of paras) {
      if (p.getAttribute('data-block') !== null) {
        p.removeAttribute('data-block');
        if (p.getAttribute('data-block-heading') !== null) {
          p.removeAttribute('data-block-heading');
          p.removeAttribute('role');
          p.removeAttribute('aria-level');
        }
      }
    }

    const claims = new Map();  // block id -> <p>[]
    const owner = new Map();   // <p> -> block id
    const missing = [];
    const bad = new Set();
    const infos = (blockInfos || []).filter(isCandidate);
    for (const info of infos) {
      const id = info.id;
      const s = one(START + id);
      const e = one(END + id);
      const S = s && closestWithin(s, root, isP);
      const E = e && closestWithin(e, root, isP);
      if (!S || !E) { missing.push(id); continue; }
      const C = ctxOf(S);
      if (C.nested || !sameCtx(ctxOf(E), C)) { missing.push(id); continue; }
      const i0 = pIndex.get(S);
      const i1 = pIndex.get(E);
      if (i1 < i0) { missing.push(id); continue; }
      const mine = [];
      for (let k = i0; k <= i1; k++) {
        const p = paras[k];
        if (!sameCtx(ctxOf(p), C)) { continue; }
        if (owner.has(p)) { bad.add(owner.get(p)); bad.add(id); continue; }
        owner.set(p, id);
        mine.push(p);
      }
      claims.set(id, mine);
    }
    // Overlapping claims: neither block is trusted.
    for (const info of infos) {
      if (bad.has(info.id)) { claims.delete(info.id); missing.push(info.id); }
    }
    if (bad.size > 0) {
      const order = new Map(infos.map((b, i) => [b.id, i]));
      missing.sort((a, b) => order.get(a) - order.get(b));
    }

    const byId = new Map();
    for (const info of infos) {
      const ps = claims.get(info.id);
      if (!ps) { continue; }
      const level = info.style && info.style.kind === 'heading' ? Number(info.style.level) : 0;
      for (const p of ps) {
        p.setAttribute('data-block', String(info.id));
        if (level >= 1) {
          p.setAttribute('role', 'heading');
          p.setAttribute('aria-level', String(level));
          p.setAttribute('data-block-heading', '1');
        }
      }
      byId.set(info.id, ps);
    }
    return { byId, missing };
  }

  /** Id of the block `node` is in (nearest ancestor-or-self with data-block), or null. */
  function blockOf(node) {
    for (let n = node; n; n = n.parentNode) {
      if (n.nodeType === ELEMENT && typeof n.getAttribute === 'function') {
        const v = n.getAttribute('data-block');
        if (v !== null && v !== '') {
          const id = Number(v);
          return Number.isInteger(id) ? id : null;
        }
      }
    }
    return null;
  }

  /**
   * docx-preview's CSS class for a style id (`DocxRunCss.styleClass` is the raw w:rStyle id):
   * `{className}_{id with runs of spaces/dots -> '-', runs of '&' -> 'and', lower-cased}`
   * (docx-preview 0.4.1 processStyleName/escapeClassName; className defaults to "docx").
   */
  function styleClassName(styleId, className) {
    const base = className || 'docx';
    if (!styleId) { return base; }
    return base + '_' + String(styleId).replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase();
  }

  const api = { mapBlocks, blockOf, styleClassName, MARKER_PREFIX };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.DocxMap = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
