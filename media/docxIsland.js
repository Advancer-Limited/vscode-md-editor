// @ts-nocheck
// Word paragraph "island": segment list <-> contenteditable DOM (spec §8.4 first paragraph, plan WP-32).
//
// Pure DOM module, UMD like media/gltfViewerMath.js. No globals: every DOM call goes through the
// paragraph element it is given (and its ownerDocument) or the `doc` passed to build().
//
// Island shape (built once when the island opens; never rebuilt while the user types):
//   <p data-block=..>                                   docx-preview's <p>, children replaced by build()
//     <span data-seg="12" data-b="1" data-i="0" data-u="0" [data-nbsp="1"] [data-strike="1"]>text<br>more</span>
//     <span contenteditable="false" data-atom="13" data-atom-type="image" class="docx-chip ...">Image</span>
//     <span contenteditable="false" data-anchor="14" class="docx-anchor"></span>
//   `data-seg=""` means src null (text with no source run). A '\n' at the very end of the island is
//   followed by one extra placeholder <br>, because a trailing <br> is not displayed by browsers;
//   read() drops the last <br> of the island when nothing visible follows it.
//
// read() never modifies the DOM. Browser-made structure is normalised logically:
//   - wrappers without data-seg (<b>, <i>, <font>, <span style>, ...) are transparent; formatting
//     comes only from the nearest data-seg span's data-b/i/u (the toolbar is the only way to format);
//   - a block element (<div>, <p>, ...) that starts after content is a line break ('\n');
//   - <br> is '\n'; '\r\n' and '\r' become '\n';
//   - U+00A0 typed by the browser becomes a space, except inside a span whose source text already
//     contained U+00A0 (data-nbsp="1"), where every U+00A0 is kept (document nbsp never silently lost);
//   - text outside any data-seg span takes the src/b/i/u of the nearest preceding data-seg span,
//     else the following one, else src null with the paragraph's base look;
//   - chip label text is never read; a chip or anchor id seen twice is emitted once.
//
// Positions: a "unit" is one character, one <br>, one chip or one anchor. Caret offsets exchanged
// with the host (docxEditResult.focus.at as a number, offsetOf()) count visible units only:
// characters (incl. '\t', '\n'), line breaks and chips; anchors count 0.
//
// Security (plan §1.8): document strings reach the DOM only through textContent / createTextNode /
// setAttribute / style properties (validated). No innerHTML anywhere.
(function (global) {
  'use strict';

  const ELEMENT = 1;
  const TEXT = 3;
  const NBSP = '\u00A0';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IMG', 'svg', 'SVG', 'IFRAME', 'OBJECT', 'VIDEO', 'AUDIO', 'CANVAS']);
  const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
    'TABLE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'DL', 'DT', 'DD', 'FIGURE', 'HR']);
  const ATOM_TYPES = new Set(['image', 'field', 'hyperlink', 'footnote', 'break', 'math', 'object']);
  const ATOM_FALLBACK_LABEL = { image: 'Image', field: 'Field', hyperlink: 'Link', footnote: 'Footnote', break: 'Break', math: 'Equation', object: 'Object' };
  const WORD_HIGHLIGHT = { darkYellow: '#808000', darkBlue: '#00008b', darkCyan: '#008b8b', darkGreen: '#006400',
    darkMagenta: '#8b008b', darkRed: '#8b0000', darkGray: '#a9a9a9', lightGray: '#d3d3d3' };

  /** Per-island state set by build(): original segments (for cancel), empty-segment ids, base look. */
  const islands = new WeakMap();

  // ------------------------------------------------------------------------------ small helpers

  function tagOf(n) { return n && n.nodeType === ELEMENT ? String(n.tagName || n.nodeName || '').toUpperCase() : ''; }
  function has(el, name) { return el.nodeType === ELEMENT && el.getAttribute(name) !== null; }
  function textOf(n) { const d = n.data !== undefined ? n.data : n.nodeValue; return d == null ? '' : String(d); }
  function setText(n, s) { if (n.data !== undefined) { n.data = s; } else { n.nodeValue = s; } }
  function kids(n) { return n.childNodes ? Array.prototype.slice.call(n.childNodes) : []; }
  function indexIn(parent, child) { return kids(parent).indexOf(child); }
  function idAttr(el, name) {
    const v = el.getAttribute(name);
    return v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null;
  }
  /** data-seg value: number, null (attribute ""), or undefined (not a valid seg span). */
  function segSrc(el) {
    if (el.nodeType !== ELEMENT) { return undefined; }
    const v = el.getAttribute('data-seg');
    if (v === null) { return undefined; }
    if (v === '') { return null; }
    return /^\d{1,15}$/.test(v) ? Number(v) : undefined;
  }
  function isSeg(el) { return segSrc(el) !== undefined; }
  function flagsOf(el) {
    return { b: el.getAttribute('data-b') === '1', i: el.getAttribute('data-i') === '1', u: el.getAttribute('data-u') === '1' };
  }
  function docOf(el) { return el.ownerDocument; }

  /** Visual b/i/u (+ strike from data-strike) of a seg span, from its data attributes. */
  function applyLook(span) {
    const f = flagsOf(span);
    const strike = span.getAttribute('data-strike') === '1';
    span.style.fontWeight = f.b ? 'bold' : 'normal';
    span.style.fontStyle = f.i ? 'italic' : 'normal';
    const deco = [];
    if (f.u) { deco.push('underline'); }
    if (strike) { deco.push('line-through'); }
    span.style.textDecoration = deco.length ? deco.join(' ') : 'none';
  }

  function cssColor(v) {
    if (typeof v !== 'string') { return null; }
    if (/^#?[0-9a-fA-F]{6}$/.test(v) || /^#?[0-9a-fA-F]{3}$/.test(v)) { return v[0] === '#' ? v : '#' + v; }
    if (Object.prototype.hasOwnProperty.call(WORD_HIGHLIGHT, v)) { return WORD_HIGHLIGHT[v]; }
    if (/^[a-zA-Z]{1,30}$/.test(v) && v.toLowerCase() !== 'none' && v.toLowerCase() !== 'auto') { return v.toLowerCase(); }
    return null;
  }

  /** Direct run look from DocxRunCss (§8.3: everything else is inherited from the <p>). */
  function applyRunCss(span, css) {
    if (!css || typeof css !== 'object') { return; }
    const color = cssColor(css.color);
    if (color) { span.style.color = color; }
    if (typeof css.fontSizePt === 'number' && isFinite(css.fontSizePt) && css.fontSizePt > 0 && css.fontSizePt <= 1638) {
      span.style.fontSize = css.fontSizePt + 'pt';
    }
    if (typeof css.fontFamily === 'string' && css.fontFamily) {
      const fam = css.fontFamily.replace(/["'\\;{}<>()]/g, '').slice(0, 100).trim();
      if (fam) { span.style.fontFamily = '"' + fam + '"'; }
    }
    const hl = cssColor(css.highlight);
    if (hl) { span.style.backgroundColor = hl; }
    if (css.vertAlign === 'super' || css.vertAlign === 'sub') { span.style.verticalAlign = css.vertAlign; }
    if (css.strike === true) { span.setAttribute('data-strike', '1'); }
    if (typeof css.styleClass === 'string' && /^[A-Za-z_][\w-]{0,100}$/.test(css.styleClass)) {
      span.className = (span.className ? span.className + ' ' : '') + css.styleClass;
    }
  }

  function setFlagAttrs(span, f) {
    span.setAttribute('data-b', f.b ? '1' : '0');
    span.setAttribute('data-i', f.i ? '1' : '0');
    span.setAttribute('data-u', f.u ? '1' : '0');
  }

  /** Appends text with '\n' as <br> elements. Returns true when the last thing appended is a <br>. */
  function appendTextWithBreaks(doc, el, text) {
    const parts = String(text).split('\n');
    let lastBr = false;
    parts.forEach((part, k) => {
      if (k > 0) { el.appendChild(doc.createElement('br')); lastBr = true; }
      if (part) { el.appendChild(doc.createTextNode(part)); lastBr = false; }
    });
    return lastBr;
  }

  function baseLook(doc, paragraphEl, opts) {
    if (opts && opts.base && typeof opts.base === 'object') {
      return { b: !!opts.base.b, i: !!opts.base.i, u: !!opts.base.u };
    }
    try {
      const view = doc && doc.defaultView;
      const cs = view && view.getComputedStyle ? view.getComputedStyle(paragraphEl) : null;
      if (cs) {
        const w = String(cs.fontWeight || '');
        const deco = String(cs.textDecorationLine || cs.textDecoration || '');
        return { b: w === 'bold' || w === 'bolder' || Number(w) >= 600, i: String(cs.fontStyle) === 'italic' || String(cs.fontStyle) === 'oblique', u: deco.indexOf('underline') >= 0 };
      }
    } catch (_e) { /* no computed style available: plain */ }
    return { b: false, i: false, u: false };
  }

  // ------------------------------------------------------------------------------ build

  /**
   * Fills `paragraphEl` with the island for `segments` (DocxSegment[]). Replaces all children.
   * Call once when the island opens (and on cancel); never while the user is typing.
   * opts.base: {b,i,u} look of text with no source run (default: the <p>'s computed style).
   */
  function build(doc, segments, paragraphEl, opts) {
    while (paragraphEl.firstChild) { paragraphEl.removeChild(paragraphEl.firstChild); }
    const list = Array.isArray(segments) ? segments : [];
    const emptyIds = new Set();
    let lastVisible = null;      // { kind: 'br'|'text'|'atom', span }
    let lastSpan = null;
    for (const seg of list) {
      if (!seg || typeof seg !== 'object') { continue; }
      if (seg.kind === 'text' && typeof seg.id === 'number') {
        const span = doc.createElement('span');
        span.setAttribute('data-seg', String(seg.id));
        setFlagAttrs(span, seg);
        const text = typeof seg.text === 'string' ? seg.text : '';
        if (text.indexOf(NBSP) >= 0) { span.setAttribute('data-nbsp', '1'); }
        applyRunCss(span, seg.css);
        applyLook(span);
        if (!text) { emptyIds.add(seg.id); }
        const endsBr = appendTextWithBreaks(doc, span, text);
        paragraphEl.appendChild(span);
        lastSpan = span;
        if (text) { lastVisible = { kind: endsBr ? 'br' : 'text', span }; }
      } else if (seg.kind === 'atom' && typeof seg.id === 'number') {
        const chip = doc.createElement('span');
        const type = ATOM_TYPES.has(seg.atomType) ? seg.atomType : 'object';
        const label = typeof seg.label === 'string' && seg.label ? seg.label : ATOM_FALLBACK_LABEL[type];
        chip.setAttribute('contenteditable', 'false');
        chip.setAttribute('data-atom', String(seg.id));
        chip.setAttribute('data-atom-type', type);
        chip.className = 'docx-chip docx-chip-' + type;
        chip.setAttribute('title', label);
        chip.setAttribute('aria-label', label);
        chip.textContent = label;
        paragraphEl.appendChild(chip);
        lastVisible = { kind: 'atom', span: null };
      } else if (seg.kind === 'anchor' && typeof seg.id === 'number') {
        const a = doc.createElement('span');
        a.setAttribute('contenteditable', 'false');
        a.setAttribute('data-anchor', String(seg.id));
        a.className = 'docx-anchor';
        a.setAttribute('aria-hidden', 'true');
        paragraphEl.appendChild(a);
      }
    }
    // Placeholder <br>: a trailing '\n' needs one to be visible; an empty island needs one for height.
    if (!lastVisible || lastVisible.kind === 'br') {
      const host = lastVisible && lastVisible.span ? lastVisible.span : (lastSpan && !lastVisible ? lastSpan : paragraphEl);
      host.appendChild(doc.createElement('br'));
    }
    islands.set(paragraphEl, { segments: list, emptyIds, base: baseLook(doc, paragraphEl, opts) });
    return paragraphEl;
  }

  // ------------------------------------------------------------------------------ linear model

  /**
   * Walks the island and returns { units, start, end, root, state }.
   * unit: { kind: 'char', ch, node, off, span, top } | { kind: 'br', node|null (null = block boundary), span, top }
   *     | { kind: 'atom'|'anchor', id, node } | { kind: 'empty', span }
   * After resolution every text-ish unit has `ref` (seg span whose src/flags apply, or null).
   */
  function linearize(root) {
    const state = islands.get(root) || { segments: [], emptyIds: new Set(), base: { b: false, i: false, u: false } };
    const units = [];
    const start = new Map();
    const end = new Map();
    const seenAtoms = new Set();
    const seenAnchors = new Set();
    let pendingBreak = false;

    const isVisible = (u) => u.kind === 'char' || u.kind === 'br' || u.kind === 'atom';
    function lastVisibleUnit() { for (let k = units.length - 1; k >= 0; k--) { if (isVisible(units[k])) { return units[k]; } } return null; }
    function lastIsBreak() { const u = lastVisibleUnit(); return !!u && (u.kind === 'br' || (u.kind === 'char' && u.ch === '\n')); }
    function breakIfNeeded(span, top) {
      if (pendingBreak) {
        pendingBreak = false;
        if (lastVisibleUnit() && !lastIsBreak()) { units.push({ kind: 'br', node: null, span, top }); }
      }
    }

    function walk(node, span, top) {
      if (node.nodeType === TEXT) {
        const t = textOf(node);
        if (t.length) { breakIfNeeded(span, top); }
        start.set(node, units.length);
        for (let k = 0; k < t.length; k++) { units.push({ kind: 'char', ch: t[k], node, off: k, span, top }); }
        end.set(node, units.length);
        return;
      }
      if (node.nodeType !== ELEMENT) { start.set(node, units.length); end.set(node, units.length); return; }
      const tg = tagOf(node);
      if (node !== root && SKIP_TAGS.has(tg)) { start.set(node, units.length); end.set(node, units.length); return; }
      if (node !== root && has(node, 'data-atom')) {
        const id = idAttr(node, 'data-atom');
        if (id !== null && !seenAtoms.has(id)) { breakIfNeeded(span, top); }
        start.set(node, units.length);
        if (id !== null && !seenAtoms.has(id)) { seenAtoms.add(id); units.push({ kind: 'atom', id, node }); }
        end.set(node, units.length);
        return;                                          // chip label is never content
      }
      if (node !== root && has(node, 'data-anchor')) {
        const id = idAttr(node, 'data-anchor');
        start.set(node, units.length);
        if (id !== null && !seenAnchors.has(id)) { seenAnchors.add(id); units.push({ kind: 'anchor', id, node }); }
        kids(node).forEach((c) => walk(c, span, top));    // stray text typed into an anchor is still text
        end.set(node, units.length);
        return;
      }
      if (node !== root && tg === 'BR') {
        breakIfNeeded(span, top);
        start.set(node, units.length);
        units.push({ kind: 'br', node, span, top });
        end.set(node, units.length);
        return;
      }
      const block = node !== root && BLOCK_TAGS.has(tg);
      if (block) {
        pendingBreak = false;
        if (lastVisibleUnit() && !lastIsBreak()) { units.push({ kind: 'br', node: null, span, top }); }
      }
      const seg = node !== root && isSeg(node);
      const childSpan = seg ? node : span;
      const childTop = top || (seg ? node : null);
      start.set(node, units.length);
      const before = units.length;
      kids(node).forEach((c) => walk(c, childSpan, childTop));
      // An originally empty segment's span with no text in it (a placeholder <br> may sit there).
      if (seg && state.emptyIds.has(segSrc(node)) && units.slice(before).every((u) => u.kind === 'br' && u.node)) {
        units.push({ kind: 'empty', span: node, top: childTop });   // keeps an originally empty segment
      }
      end.set(node, units.length);
      if (block) { pendingBreak = true; }
    }
    walk(root, null, null);

    // Resolve the run each text-ish unit belongs to: own span, else preceding span, else following.
    let prev = null;
    for (const u of units) {
      if (u.kind === 'atom' || u.kind === 'anchor') { continue; }
      if (u.span) { prev = u.span; u.ref = u.span; } else { u.ref = prev; }
    }
    let next = null;
    for (let k = units.length - 1; k >= 0; k--) {
      const u = units[k];
      if (u.kind === 'atom' || u.kind === 'anchor') { continue; }
      if (u.span) { next = u.span; } else if (!u.ref) { u.ref = next; }
    }
    // The island's last <br> is a placeholder when nothing visible follows it.
    for (let k = units.length - 1; k >= 0; k--) {
      const u = units[k];
      if (u.kind === 'anchor' || u.kind === 'empty') { continue; }
      if (u.kind === 'br' && u.node) { u.placeholder = true; }
      break;
    }
    return { units, start, end, root, state };
  }

  function lookOf(lin, u) {
    if (u.ref) {
      const f = flagsOf(u.ref);
      return { src: segSrc(u.ref), b: f.b, i: f.i, u: f.u };
    }
    const base = lin.state.base;
    return { src: null, b: base.b, i: base.i, u: base.u };
  }

  function isTextUnit(u) { return u.kind === 'char' || u.kind === 'br' || u.kind === 'empty'; }
  function isVisibleUnit(u) { return (u.kind === 'char' || u.kind === 'br' || u.kind === 'atom') && !u.placeholder; }

  /** DocxCommitItem[] for units [from, to). Anchors listed in `extraAnchors` are appended at the end. */
  function itemsFromUnits(lin, from, to) {
    const items = [];
    let cur = null;
    for (let k = from; k < to; k++) {
      const u = lin.units[k];
      if (u.placeholder) { continue; }
      if (u.kind === 'atom' || u.kind === 'anchor') { items.push({ kind: u.kind, id: u.id }); cur = null; continue; }
      if (!isTextUnit(u)) { continue; }
      const look = lookOf(lin, u);
      let ch = '';
      if (u.kind === 'br') { ch = '\n'; }
      else if (u.kind === 'char') {
        ch = u.ch;
        if (ch === NBSP && !(u.span && u.span.getAttribute('data-nbsp') === '1')) { ch = ' '; }
      }
      if (cur && cur.src === look.src && cur.b === look.b && cur.i === look.i && cur.u === look.u) {
        cur.text += ch;
      } else {
        cur = { kind: 'text', text: ch, b: look.b, i: look.i, u: look.u, src: look.src, keepEmpty: u.kind === 'empty' };
        items.push(cur);
      }
      if (u.kind === 'empty') { cur.keepEmpty = true; }
    }
    const out = [];
    for (const it of items) {
      if (it.kind !== 'text') { out.push(it); continue; }
      const text = it.text.replace(/\r\n?/g, '\n');
      if (!text && !it.keepEmpty) { continue; }
      out.push({ kind: 'text', text, b: it.b, i: it.i, u: it.u, src: it.src });
    }
    return out;
  }

  /** Nearest ancestor (or self) of `n` below root whose content is not part of the island text. */
  function opaqueAncestor(n, root) {
    for (let p = n; p && p !== root; p = p.parentNode) {
      if (p.nodeType === ELEMENT && (has(p, 'data-atom') || SKIP_TAGS.has(tagOf(p)))) { return p; }
    }
    return null;
  }

  function within(root, n) {
    for (let p = n; p; p = p.parentNode) { if (p === root) { return true; } }
    return false;
  }

  /** Unit index of a DOM boundary point, or null when the point is outside the island. */
  function posOf(lin, container, offset) {
    if (!container || !within(lin.root, container)) { return null; }
    const block = opaqueAncestor(container, lin.root);
    if (block) { return block === container && offset > 0 ? lin.end.get(block) : lin.start.get(block); }
    if (container.nodeType === TEXT) {
      const st = lin.start.get(container);
      if (st === undefined) { return null; }
      return st + Math.max(0, Math.min(offset, lin.end.get(container) - st));
    }
    const ch = kids(container);
    if (offset < ch.length) {
      const s = lin.start.get(ch[offset]);
      return s === undefined ? null : s;
    }
    const e = lin.end.get(container);
    return e === undefined ? null : e;
  }

  function rangePositions(lin, range) {
    if (!range) { return null; }
    let s = posOf(lin, range.startContainer, range.startOffset);
    let e = posOf(lin, range.endContainer, range.endOffset);
    if (s === null && e === null) { return null; }
    if (s === null) { s = e; }
    if (e === null) { e = s; }
    return s <= e ? [s, e] : [e, s];
  }

  /**
   * DOM point for unit index `idx`. affinity 'forward' prefers the start of the unit at idx,
   * 'backward' the end of the unit before it (both prefer positions inside text nodes).
   */
  function pointAt(lin, idx, affinity) {
    const units = lin.units;
    const atText = idx < units.length && units[idx].kind === 'char' ? { container: units[idx].node, offset: units[idx].off } : null;
    const afterText = idx > 0 && units[idx - 1].kind === 'char' ? { container: units[idx - 1].node, offset: units[idx - 1].off + 1 } : null;
    const first = affinity === 'backward' ? afterText || atText : atText || afterText;
    if (first) { return first; }
    const at = idx < units.length ? units[idx] : null;
    if (at && at.node) { return { container: at.node.parentNode, offset: indexIn(at.node.parentNode, at.node) }; }
    if (at && at.kind === 'empty') { return { container: at.span, offset: 0 }; }
    const prev = idx > 0 ? units[idx - 1] : null;
    if (prev && prev.node) { return { container: prev.node.parentNode, offset: indexIn(prev.node.parentNode, prev.node) + 1 }; }
    if (prev && prev.kind === 'empty') { return { container: prev.span, offset: 0 }; }
    // Empty island: inside the first seg span if there is one.
    const firstSpan = findFirst(lin.root, (n) => n !== lin.root && isSeg(n));
    return firstSpan ? { container: firstSpan, offset: 0 } : { container: lin.root, offset: 0 };
  }

  function findFirst(n, pred) {
    for (const c of kids(n)) {
      if (c.nodeType !== ELEMENT) { continue; }
      if (pred(c)) { return c; }
      const d = findFirst(c, pred);
      if (d) { return d; }
    }
    return null;
  }

  function rangeLike(a, b) {
    const z = b || a;
    return { startContainer: a.container, startOffset: a.offset, endContainer: z.container, endOffset: z.offset,
      collapsed: a.container === z.container && a.offset === z.offset };
  }

  function firstVisibleIndex(lin) {
    for (let k = 0; k < lin.units.length; k++) { if (isVisibleUnit(lin.units[k])) { return k; } }
    return -1;
  }
  function lastVisibleIndex(lin) {
    for (let k = lin.units.length - 1; k >= 0; k--) { if (isVisibleUnit(lin.units[k])) { return k; } }
    return -1;
  }

  // ------------------------------------------------------------------------------ public API

  /** DocxCommitItem[] for the island's current content. Never changes the DOM. */
  function read(paragraphEl) {
    const lin = linearize(paragraphEl);
    return itemsFromUnits(lin, 0, lin.units.length);
  }

  /**
   * Content before and after `range` (selection contents are dropped, as Enter replaces a selection;
   * anchors inside the selection are kept, at the end of `before`). Does not change the DOM.
   */
  function splitAt(paragraphEl, range) {
    const lin = linearize(paragraphEl);
    const pos = rangePositions(lin, range) || [lin.units.length, lin.units.length];
    const before = itemsFromUnits(lin, 0, pos[0]);
    for (let k = pos[0]; k < pos[1]; k++) {
      if (lin.units[k].kind === 'anchor') { before.push({ kind: 'anchor', id: lin.units[k].id }); }
    }
    return { before, after: itemsFromUnits(lin, pos[1], lin.units.length) };
  }

  function caretAtStart(paragraphEl, range) {
    if (!range || !isCollapsed(range)) { return false; }
    const lin = linearize(paragraphEl);
    const p = rangePositions(lin, range);
    if (!p) { return false; }
    const f = firstVisibleIndex(lin);
    return f < 0 || p[0] <= f;
  }

  function caretAtEnd(paragraphEl, range) {
    if (!range || !isCollapsed(range)) { return false; }
    const lin = linearize(paragraphEl);
    const p = rangePositions(lin, range);
    if (!p) { return false; }
    return p[0] > lastVisibleIndex(lin);
  }

  function isCollapsed(range) {
    if (typeof range.collapsed === 'boolean') { return range.collapsed; }
    return range.startContainer === range.endContainer && range.startOffset === range.endOffset;
  }

  /** Visible-unit offset of the range start (see header: anchors count 0). */
  function offsetOf(paragraphEl, range) {
    const lin = linearize(paragraphEl);
    const p = rangePositions(lin, range);
    if (!p) { return 0; }
    let n = 0;
    for (let k = 0; k < p[0]; k++) { if (isVisibleUnit(lin.units[k])) { n++; } }
    return n;
  }

  function indexForAt(lin, at) {
    const units = lin.units;
    if (at === 'start') {
      let k = 0;
      while (k < units.length && !isVisibleUnit(units[k]) && units[k].kind !== 'empty') { k++; }
      return k < units.length ? k : 0;
    }
    if (at === 'end') {
      const l = lastVisibleIndex(lin);
      return l + 1;
    }
    let n = Math.max(0, Math.floor(Number(at) || 0));
    if (n === 0) { return indexForAt(lin, 'start'); }
    for (let k = 0; k < units.length; k++) {
      if (isVisibleUnit(units[k])) { n--; if (n === 0) { return k + 1; } }
    }
    return lastVisibleIndex(lin) + 1;
  }

  /**
   * Places the caret at 'start' | 'end' | visible-unit offset (number) and applies it to the document
   * selection when one is available. Returns the collapsed range-like object.
   */
  function setCaret(paragraphEl, at) {
    const lin = linearize(paragraphEl);
    const pt = pointAt(lin, indexForAt(lin, at), at === 'start' ? 'forward' : 'backward');
    const r = rangeLike(pt);
    applySelection(docOf(paragraphEl), r);
    return r;
  }

  /** Applies a range-like object to the document selection (no-op without selection support). */
  function applySelection(doc, r) {
    try {
      const sel = doc && (doc.getSelection ? doc.getSelection() : doc.defaultView && doc.defaultView.getSelection && doc.defaultView.getSelection());
      if (!sel || !doc.createRange) { return false; }
      const range = doc.createRange();
      range.setStart(r.startContainer, r.startOffset);
      range.setEnd(r.endContainer, r.endOffset);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (_e) { return false; }
  }

  /** {b,i,u} shown for the range: collapsed = the text before the caret; otherwise all-selected-on. */
  function formatAt(paragraphEl, range) {
    const lin = linearize(paragraphEl);
    const p = rangePositions(lin, range) || [0, 0];
    const units = lin.units;
    if (p[0] === p[1]) {
      for (let k = p[0] - 1; k >= 0; k--) { if (isTextUnit(units[k]) && !units[k].placeholder) { return pick(lookOf(lin, units[k])); } }
      for (let k = p[0]; k < units.length; k++) { if (isTextUnit(units[k])) { return pick(lookOf(lin, units[k])); } }
      return pick(lookOf(lin, { ref: null }));
    }
    const sel = units.slice(p[0], p[1]).filter((u) => isTextUnit(u) && !u.placeholder && u.kind !== 'empty');
    if (!sel.length) { return { b: false, i: false, u: false }; }
    const looks = sel.map((u) => lookOf(lin, u));
    return { b: looks.every((l) => l.b), i: looks.every((l) => l.i), u: looks.every((l) => l.u) };
  }
  function pick(l) { return { b: l.b, i: l.i, u: l.u }; }

  // ------------------------------------------------------------------------------ toggle

  const WORD_CHAR = /[\p{L}\p{N}_'\u2019]/u;

  /** Units inside one carrier (text units by carrier; chips/anchors by DOM containment), in order. */
  function unitsOfCarrier(units, c) {
    return units.filter((u) => (u.kind === 'atom' || u.kind === 'anchor')
      ? u.node !== c && within(c, u.node)
      : (u.top || u.node) === c);
  }

  /** Clone of the span whose look a text unit uses (or a fresh src-null span). */
  function spanFor(doc, lin, ref) {
    if (ref) { return ref.cloneNode(false); }
    const s = doc.createElement('span');
    s.setAttribute('data-seg', '');
    setFlagAttrs(s, lin.state.base);
    applyLook(s);
    return s;
  }

  /**
   * Re-creates one carrier (outermost seg span, or a stray text node / <br>) as a flat sequence of
   * seg spans split where `groupOf(unit)` changes. Chips and anchors inside are moved, not copied.
   * `insertAt` (unit index) inserts an empty span produced by `makeEmpty(refUnit)` at that position.
   */
  function rebuildCarrier(doc, lin, carrier, cunits, groupOf, setFlag, insertAt, makeEmpty) {
    const out = [];
    let cur = null;
    let curKey = null;
    let textNode = null;
    let made = null;
    const emitEmpty = (refUnit) => { made = makeEmpty(refUnit); out.push(made.span); cur = null; };
    for (const u of cunits) {
      if (insertAt !== null && u.index === insertAt && !made) { emitEmpty(u); }
      if (u.kind === 'atom' || u.kind === 'anchor') { out.push(u.node); cur = null; continue; }
      if (u.kind === 'empty') { continue; }
      const g = groupOf(u);
      const key = g + '|' + (u.ref ? lin.refId(u.ref) : 'none');
      if (!cur || key !== curKey) {
        cur = spanFor(doc, lin, u.ref);
        if (g) { setFlag(cur); }
        applyLook(cur);
        out.push(cur);
        curKey = key;
        textNode = null;
      }
      if (u.kind === 'char') {
        let ch = u.ch;
        if (ch === NBSP && !(u.span && u.span.getAttribute('data-nbsp') === '1')) { ch = ' '; }
        if (!textNode) { textNode = doc.createTextNode(''); cur.appendChild(textNode); }
        setText(textNode, textOf(textNode) + ch);
        u.newNode = textNode; u.newOff = textOf(textNode).length - 1;
      } else {
        const br = doc.createElement('br');
        cur.appendChild(br);
        textNode = null;
        u.newNode = br;
      }
    }
    if (insertAt !== null && !made && cunits.length && cunits[cunits.length - 1].index + 1 === insertAt) {
      emitEmpty(cunits[cunits.length - 1]);
    }
    const parent = carrier.parentNode;
    for (const n of out) { parent.insertBefore(n, carrier); }
    parent.removeChild(carrier);
    return made;
  }

  /**
   * Toggles bold/italic/underline over `range` (Word rule: on unless every selected character is
   * already on). A collapsed caret inside a word toggles the word; elsewhere an empty span with the
   * new look is inserted at the caret for the next typed text. Only the spans the selection touches
   * are re-created. Returns the new range-like object (also applied to the document selection).
   */
  function toggle(paragraphEl, range, which) {
    if (which !== 'b' && which !== 'i' && which !== 'u') { throw new Error('toggle: which must be b, i or u'); }
    const doc = docOf(paragraphEl);
    const lin = linearize(paragraphEl);
    const refIds = new Map();
    lin.refId = (el) => { if (!refIds.has(el)) { refIds.set(el, refIds.size + 1); } return refIds.get(el); };
    lin.units.forEach((u, k) => { u.index = k; });
    const pos = rangePositions(lin, range);
    if (!pos) { return range; }
    let [s, e] = pos;
    const units = lin.units;
    if (s === e) {
      const isWord = (k) => k >= 0 && k < units.length && units[k].kind === 'char' && WORD_CHAR.test(units[k].ch);
      if (isWord(s - 1) && isWord(s)) {
        while (isWord(s - 1)) { s--; }
        while (isWord(e)) { e++; }
      }
    }
    const flip = (span, on) => { span.setAttribute('data-' + which, on ? '1' : '0'); };

    if (s === e) {
      // Collapsed outside a word: insert an empty span carrying the new look.
      const refUnit = (() => {
        for (let k = s - 1; k >= 0; k--) { if (isTextUnit(units[k])) { return units[k]; } }
        for (let k = s; k < units.length; k++) { if (isTextUnit(units[k])) { return units[k]; } }
        return null;
      })();
      const cur = refUnit ? lookOf(lin, refUnit) : lookOf(lin, { ref: null });
      const makeEmpty = () => {
        const span = spanFor(doc, lin, refUnit ? refUnit.ref : null);
        flip(span, !cur[which]);
        applyLook(span);
        const t = doc.createTextNode('');
        span.appendChild(t);
        return { span, text: t };
      };
      // Find the carrier holding the caret position (unit before or at s).
      const host = [units[s - 1], units[s]].find((u) => u && (u.kind === 'char' || (u.kind === 'br' && u.node)));
      let made;
      if (host) {
        const carrier = host.top || host.node;
        const cunits = unitsOfCarrier(units, carrier);
        made = rebuildCarrier(doc, lin, carrier, cunits, () => false, () => {}, s, makeEmpty);
      }
      if (!made) {
        made = makeEmpty(refUnit);
        const pt = pointAt(lin, s, 'forward');
        const ctn = pt.container.nodeType === TEXT ? pt.container.parentNode : pt.container;
        const ref = pt.container.nodeType === TEXT ? pt.container.nextSibling : kids(ctn)[pt.offset] || null;
        ctn.insertBefore(made.span, ref);
      }
      const r = { startContainer: made.text, startOffset: 0, endContainer: made.text, endOffset: 0, collapsed: true };
      applySelection(doc, r);
      return r;
    }

    const selected = units.filter((u) => u.index >= s && u.index < e && (u.kind === 'char' || u.kind === 'br') && !u.placeholder);
    if (!selected.length) { return range; }
    const on = !selected.every((u) => lookOf(lin, u)[which]);
    const carriers = [];
    for (const u of selected) {
      const c = u.top || u.node;
      if (c && carriers.indexOf(c) < 0) { carriers.push(c); }
    }
    const inSel = (u) => u.index >= s && u.index < e;
    for (const c of carriers) {
      const cunits = unitsOfCarrier(units, c);
      rebuildCarrier(doc, lin, c, cunits, inSel, (span) => flip(span, on), null, null);
    }
    const lin2 = linearize(paragraphEl);
    const r = rangeLike(pointAt(lin2, s, 'forward'), pointAt(lin2, e, 'backward'));
    applySelection(doc, r);
    return r;
  }

  // ------------------------------------------------------------------------------ paste / insert

  /** Plain text from a clipboard DataTransfer: text/plain only (HTML is never read), normalised. */
  function plainText(clipboardData) {
    let t = '';
    try { t = clipboardData && clipboardData.getData ? String(clipboardData.getData('text/plain') || '') : ''; } catch (_e) { t = ''; }
    // eslint-disable-next-line no-control-regex
    return t.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  /**
   * Replaces the range with plain `text` ('\n' becomes <br>), editing text nodes in place.
   * Chips inside the range are removed (the host re-inserts them, §8.4 rule 6); anchors stay.
   * Returns the collapsed caret after the inserted text (also applied to the selection).
   */
  function insertText(paragraphEl, range, text) {
    const doc = docOf(paragraphEl);
    let lin = linearize(paragraphEl);
    const pos = rangePositions(lin, range) || [lin.units.length, lin.units.length];
    if (pos[0] !== pos[1]) {
      deleteUnits(lin, pos[0], pos[1]);
      lin = linearize(paragraphEl);
    }
    const s = pos[0];
    const pt = pointAt(lin, s, 'backward');
    const str = String(text).replace(/\r\n?/g, '\n');
    let parent;
    let ref;
    if (pt.container.nodeType === TEXT) {
      const node = pt.container;
      const t = textOf(node);
      if (str.indexOf('\n') < 0) {
        setText(node, t.slice(0, pt.offset) + str + t.slice(pt.offset));
        const r = { startContainer: node, startOffset: pt.offset + str.length, endContainer: node, endOffset: pt.offset + str.length, collapsed: true };
        applySelection(doc, r);
        return r;
      }
      setText(node, t.slice(0, pt.offset));
      parent = node.parentNode;
      ref = node.nextSibling;
      if (pt.offset < t.length) {
        const tail = doc.createTextNode(t.slice(pt.offset));
        parent.insertBefore(tail, ref);
        ref = tail;
      }
    } else {
      parent = pt.container;
      ref = kids(parent)[pt.offset] || null;
    }
    const parts = str.split('\n');
    let last = null;
    let lastIsBr = false;
    parts.forEach((part, k) => {
      if (k > 0) { last = doc.createElement('br'); parent.insertBefore(last, ref); lastIsBr = true; }
      if (part) { last = doc.createTextNode(part); parent.insertBefore(last, ref); lastIsBr = false; }
    });
    if (lastIsBr) {
      const lin2 = linearize(paragraphEl);
      const idx = lin2.start.get(last);
      const after = lin2.units.slice(idx + 1).some((u) => u.kind === 'char' || u.kind === 'atom' || (u.kind === 'br' && !u.placeholder));
      const hasPlaceholder = lin2.units.slice(idx + 1).some((u) => u.placeholder);
      if (!after && !hasPlaceholder) { parent.insertBefore(doc.createElement('br'), last.nextSibling); }
    }
    const r = last
      ? (lastIsBr
        ? { startContainer: parent, startOffset: indexIn(parent, last) + 1, endContainer: parent, endOffset: indexIn(parent, last) + 1, collapsed: true }
        : { startContainer: last, startOffset: textOf(last).length, endContainer: last, endOffset: textOf(last).length, collapsed: true })
      : rangeLike(pt);
    applySelection(doc, r);
    return r;
  }

  /** Deletes units [s, e) in place: characters trimmed from their text nodes, <br>s and chips removed. */
  function deleteUnits(lin, s, e) {
    const cut = new Map();   // text node -> [from, to)
    for (let k = s; k < e; k++) {
      const u = lin.units[k];
      if (u.kind === 'char') {
        const c = cut.get(u.node);
        if (c) { c[1] = u.off + 1; } else { cut.set(u.node, [u.off, u.off + 1]); }
      } else if ((u.kind === 'br' && u.node && !u.placeholder) || u.kind === 'atom') {
        if (u.node.parentNode) { u.node.parentNode.removeChild(u.node); }
      }
    }
    cut.forEach((c, node) => { const t = textOf(node); setText(node, t.slice(0, c[0]) + t.slice(c[1])); });
  }

  // ------------------------------------------------------------------------------ segments / undo

  /** The commit items that mean "nothing changed" for a segment list (what read() returns after build()). */
  function itemsFromSegments(segments) {
    const out = [];
    for (const seg of Array.isArray(segments) ? segments : []) {
      if (!seg) { continue; }
      if (seg.kind === 'text') { out.push({ kind: 'text', text: String(seg.text || ''), b: !!seg.b, i: !!seg.i, u: !!seg.u, src: seg.id }); }
      else if (seg.kind === 'atom' || seg.kind === 'anchor') { out.push({ kind: seg.kind, id: seg.id }); }
    }
    return out;
  }

  function sameItems(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { return false; }
    for (let k = 0; k < a.length; k++) {
      const x = a[k]; const y = b[k];
      if (x.kind !== y.kind) { return false; }
      if (x.kind === 'text') {
        if (x.text !== y.text || x.b !== y.b || x.i !== y.i || x.u !== y.u || x.src !== y.src) { return false; }
      } else if (x.id !== y.id) { return false; }
    }
    return true;
  }

  /** True when the island's content differs from the segments it was built from. */
  function isDirty(paragraphEl) {
    const st = islands.get(paragraphEl);
    return !st || !sameItems(read(paragraphEl), itemsFromSegments(st.segments));
  }

  // Ctrl+Z inside an open island. Phase 0 spike S3 (can the webview keep Ctrl+Z/Ctrl+Y local?) is
  // still pending, so the documented fallback applies: Ctrl+Z cancels the in-progress edit, Ctrl+Y /
  // Ctrl+Shift+Z do nothing; the caller stops both in a capture-phase keydown listener. If S3 passes,
  // set UNDO_POLICY to 'native' and the browser's own text undo handles both keys.
  const UNDO_POLICY = 'cancel-edit';

  /** 'cancel' | 'block' | null for a keydown event while an island is open. */
  function undoKeyAction(ev) {
    if (!ev || !(ev.ctrlKey || ev.metaKey) || ev.altKey) { return null; }
    const k = String(ev.key || '').toLowerCase();
    const undo = k === 'z' && !ev.shiftKey;
    const redo = k === 'y' || (k === 'z' && ev.shiftKey);
    if (!undo && !redo) { return null; }
    if (UNDO_POLICY === 'native') { return null; }
    return undo ? 'cancel' : 'block';
  }

  /** Discards the in-progress edit: rebuilds the island from the segments it was opened with. */
  function cancel(paragraphEl) {
    const st = islands.get(paragraphEl);
    if (!st) { return false; }
    build(docOf(paragraphEl), st.segments, paragraphEl, { base: st.base });
    return true;
  }

  /** Forgets the island state (call when the island closes). */
  function release(paragraphEl) { islands.delete(paragraphEl); }

  const api = {
    build, read, splitAt, toggle, caretAtStart, caretAtEnd, setCaret, offsetOf, formatAt,
    plainText, insertText, itemsFromSegments, sameItems, isDirty, undoKeyAction, cancel, release,
    applySelection, UNDO_POLICY,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.DocxIsland = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
