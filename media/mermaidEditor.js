// @ts-check
(function () {
  /** @type {ReturnType<typeof acquireVsCodeApi>} */
  const vscode = acquireVsCodeApi();

  const textarea = /** @type {HTMLTextAreaElement} */ (
    document.getElementById('mmd-input')
  );
  const highlightPre = /** @type {HTMLPreElement} */ (
    document.getElementById('mmd-highlight')
  );
  const highlightCode = /** @type {HTMLElement} */ (
    document.getElementById('mmd-highlight-code')
  );
  const preview = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-preview')
  );
  const viewport = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-viewport')
  );
  const errorEl = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-error')
  );
  const container = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-container')
  );
  const divider = /** @type {HTMLDivElement} */ (
    document.getElementById('mmd-divider')
  );
  const zoomReadout = /** @type {HTMLSpanElement} */ (
    document.getElementById('mmd-zoom-readout')
  );
  const btnExportPng = /** @type {HTMLButtonElement} */ (
    document.getElementById('mmd-export-png')
  );
  const btnPrint = /** @type {HTMLButtonElement} */ (
    document.getElementById('mmd-print')
  );

  // @ts-ignore - MermaidSyntax loaded globally from mermaidSyntax.js
  const syntax = MermaidSyntax;

  // ================================================
  // Diagram theming
  // ================================================
  // Mermaid's stock themes look distinctly "default-y" — squared corners,
  // heavy saturated fills, browser-default fonts. These overrides aim for a
  // flatter, more professional look that also sits naturally inside VS Code.
  const DIAGRAM_FONT =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif';

  const THEME_VARIABLES = {
    dark: {
      background: 'transparent',
      primaryColor: '#2d333b',
      primaryBorderColor: '#6e7681',
      primaryTextColor: '#e6edf3',
      secondaryColor: '#31363f',
      tertiaryColor: '#22272e',
      lineColor: '#8b949e',
      textColor: '#e6edf3',
      mainBkg: '#2d333b',
      nodeBorder: '#6e7681',
      clusterBkg: 'rgba(110, 118, 129, 0.10)',
      clusterBorder: '#484f58',
      edgeLabelBackground: '#22272e',
      titleColor: '#e6edf3',
    },
    light: {
      background: 'transparent',
      primaryColor: '#f6f8fa',
      primaryBorderColor: '#9aa5b1',
      primaryTextColor: '#1f2328',
      secondaryColor: '#eef1f4',
      tertiaryColor: '#ffffff',
      lineColor: '#6e7781',
      textColor: '#1f2328',
      mainBkg: '#f6f8fa',
      nodeBorder: '#9aa5b1',
      clusterBkg: 'rgba(110, 119, 129, 0.06)',
      clusterBorder: '#d0d7de',
      edgeLabelBackground: '#ffffff',
      titleColor: '#1f2328',
    },
  };

  /** Canvas fill for each export theme. Must not be sampled from the live
   *  body background — exporting "dark" from a light editor would then fill
   *  with the light background and produce light-on-light output. */
  const EXPORT_BACKGROUND = { light: '#ffffff', dark: '#1e1e1e' };

  /** 'light' | 'dark' for the current VS Code colour theme. */
  function currentThemeKind() {
    const cl = document.body.classList;
    // vscode-high-contrast-light also carries vscode-high-contrast, so test
    // for the light variant explicitly rather than assuming HC means dark.
    return cl.contains('vscode-light') || cl.contains('vscode-high-contrast-light')
      ? 'light'
      : 'dark';
  }

  function mermaidConfigFor(kind) {
    const vars = Object.assign({ fontFamily: DIAGRAM_FONT, fontSize: '14px' }, THEME_VARIABLES[kind]);
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: DIAGRAM_FONT,
      themeVariables: vars,
      flowchart: { curve: 'basis', htmlLabels: true, padding: 12, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
    };
  }

  /**
   * Refinements mermaid's theme variables can't express (it has no
   * border-radius variable). Injected as a <style> INSIDE the SVG so it
   * travels with the element — the preview, the PNG rasterization and the
   * printed page all pick it up from the same place.
   */
  const DIAGRAM_STYLE_CSS =
    '.node rect,.node polygon,.node path{rx:4px;ry:4px;}' +
    '.cluster rect{rx:6px;ry:6px;}' +
    '.node rect,.node circle,.node ellipse,.node polygon,.node path{stroke-width:1.25px;}' +
    '.edgePath .path,.flowchart-link{stroke-width:1.5px;}' +
    '.edgeLabel{font-size:12px;}' +
    'text,.nodeLabel,.edgeLabel,.label{font-family:' + DIAGRAM_FONT + ';}';

  function applyDiagramStyling(svgEl) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = DIAGRAM_STYLE_CSS;
    svgEl.insertBefore(style, svgEl.firstChild);
  }

  // @ts-ignore - mermaid loaded globally from mermaid.min.js
  mermaid.initialize(mermaidConfigFor(currentThemeKind()));

  // Track whether the current textarea update originated from the extension
  // host (an 'update' message), so the 'input' handler doesn't treat the
  // resulting DOM mutation as a local edit and echo it straight back.
  let isExternalUpdate = false;

  // The diagram source most recently posted to the extension host, plus
  // whether a debounced local edit is still waiting to be posted, plus how
  // many posted edits haven't been acked yet. Together these let the
  // 'update' handler recognize echoes of our own edits and avoid clobbering
  // local typing that is still in flight to the host.
  let lastSentEditText = null;
  let localEditPending = false;
  let editsInFlight = 0;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let editDebounce;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let renderDebounce;
  let renderSeq = 0;

  // The extension host's document text may use CRLF line endings while the
  // textarea (an HTML control) always normalizes to LF internally. Work in
  // LF throughout the webview and let the host re-expand to the document's
  // real EOL on the way back in (mirrors mermaidEditorProvider.ts's 'edit'
  // handler). Without this, `text === lastSentEditText` below would never
  // match for CRLF documents and every one of our own edits would look like
  // an external change, causing the textarea to be clobbered and the caret
  // to jump on every keystroke.
  function normalizeEol(text) {
    return text.replace(/\r\n/g, '\n');
  }

  // ================================================
  // Syntax highlighting overlay
  // ================================================
  // The <pre> mirror is purely presentational: it is never edited, never
  // focused, and never written back to. The textarea remains the single
  // editing surface and the source of truth for all document sync.

  /** 1-based line number mermaid last reported an error on, or null. */
  let currentErrorLine = null;
  let errorBar = null;
  /**
   * The most recent source that parsed successfully — i.e. what the preview
   * is actually showing, which may be older than textarea.value while the
   * user is mid-edit (keep-last-good). Export and print render from this.
   */
  let lastGoodSource = null;

  function getErrorBar() {
    if (!errorBar) {
      errorBar = document.createElement('div');
      errorBar.className = 'mmd-error-line-bar';
      errorBar.hidden = true;
      highlightPre.appendChild(errorBar);
    }
    return errorBar;
  }

  /**
   * Re-apply the error-line marking to the freshly rebuilt highlight DOM.
   * Must run after every updateHighlight(), since innerHTML replacement
   * destroys the previous marker and bar position.
   */
  function reapplyErrorLine() {
    const bar = getErrorBar();
    if (currentErrorLine === null) {
      bar.hidden = true;
      return;
    }
    const span = highlightCode.querySelector(
      '.mmd-line[data-line="' + currentErrorLine + '"]'
    );
    if (!span) {
      bar.hidden = true;
      return;
    }
    span.classList.add('mmd-error-line');
    // An inline span can fragment across visual lines when wrapped, so use
    // the union rect rather than offsetTop, and convert to the <pre>'s
    // content coordinates so the bar scrolls with the text.
    const r = span.getBoundingClientRect();
    const p = highlightPre.getBoundingClientRect();
    bar.style.top = (r.top - p.top + highlightPre.scrollTop) + 'px';
    bar.style.height = r.height + 'px';
    bar.hidden = false;
  }

  /**
   * Rebuild the highlight overlay from the given source.
   * Runs synchronously on every keystroke — a per-line regex pass plus one
   * innerHTML assignment is ~1-3ms for a typical diagram, and debouncing it
   * would leave the (transparent) textarea text visibly unpainted while
   * typing.
   */
  function updateHighlight(text) {
    highlightCode.innerHTML = syntax.buildHighlightHtml(text);
    reapplyErrorLine();
  }

  // Keep the mirror's scroll position locked to the textarea's. Both writes
  // target an overflow:hidden element, so there's no read-after-write layout
  // cycle to thrash; doing this in rAF would instead show the colour layer
  // lagging a frame behind the text while scrolling.
  textarea.addEventListener('scroll', () => {
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;
  });

  // ================================================
  // Message handling from the extension host
  // ================================================
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'editAck') {
      editsInFlight = Math.max(0, editsInFlight - 1);
      return;
    }
    if (message.type === 'exportPngTheme') {
      exportPng(message.theme === 'light' ? 'light' : 'dark');
      return;
    }
    if (message.type === 'update') {
      const text = normalizeEol(message.text);
      const isEcho = text === textarea.value || text === lastSentEditText;
      if (isEcho) {
        return;
      }
      // A newer local edit is still in flight to the host (debounced, or
      // sent but not yet acked) — applying this now-stale host text would
      // clobber what the user just typed. Drop it; once the in-flight edit
      // is acked, the document already matches what we're showing.
      if (localEditPending || editsInFlight > 0) {
        return;
      }
      isExternalUpdate = true;
      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;
      textarea.value = text;
      textarea.selectionStart = Math.min(selStart, text.length);
      textarea.selectionEnd = Math.min(selEnd, text.length);
      isExternalUpdate = false;
      // A programmatic value assignment fires no 'input' event, so the
      // overlay must be refreshed explicitly here.
      updateHighlight(text);
      highlightPre.scrollTop = textarea.scrollTop;
      renderDiagram(text);
    }
  });

  textarea.addEventListener('input', () => {
    if (isExternalUpdate) {
      return;
    }
    const text = textarea.value;

    updateHighlight(text);

    clearTimeout(renderDebounce);
    renderDebounce = setTimeout(() => renderDiagram(text), 300);

    localEditPending = true;
    clearTimeout(editDebounce);
    editDebounce = setTimeout(() => {
      localEditPending = false;
      editsInFlight++;
      lastSentEditText = text;
      vscode.postMessage({ type: 'edit', text: text });
    }, 150);
  });

  // ================================================
  // Diagram rendering
  // ================================================

  /**
   * Give the SVG intrinsic pixel dimensions. Mermaid emits a viewBox plus
   * width="100%" (and a max-width style) so it scales to its container —
   * which would fight the zoom transform, so pin it to real pixels instead.
   */
  function normalizeSvg(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const w = (vb && vb.width) || rect.width;
    const h = (vb && vb.height) || rect.height;
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.style.maxWidth = 'none';
    return { w, h };
  }

  function setExportButtonsEnabled(enabled) {
    if (btnExportPng) btnExportPng.disabled = !enabled;
    if (btnPrint) btnPrint.disabled = !enabled;
  }

  /** @param {string} source */
  async function renderDiagram(source) {
    const seq = ++renderSeq;
    if (!source.trim()) {
      preview.innerHTML = '';
      errorEl.hidden = true;
      currentErrorLine = null;
      lastGoodSource = null;
      reapplyErrorLine();
      setExportButtonsEnabled(false);
      // The next diagram is a fresh one — let it auto-fit rather than
      // inheriting the previous diagram's pan/zoom (which could place it
      // entirely off-screen).
      hasAutoFitted = false;
      return;
    }
    const diagramId = 'mmd-diagram-' + seq;
    try {
      // @ts-ignore - mermaid global
      await mermaid.parse(source);
      // @ts-ignore - mermaid global
      const { svg } = await mermaid.render(diagramId, source);
      if (seq !== renderSeq) {
        // A newer render superseded this one while we were awaiting it —
        // drop the stale result instead of flashing an old diagram back in.
        return;
      }
      // Note: only preview's *contents* are replaced. The #mmd-preview
      // element itself survives, which is what preserves the zoom/pan
      // transform on it across re-renders.
      preview.innerHTML = svg;
      errorEl.hidden = true;
      currentErrorLine = null;
      lastGoodSource = source;
      reapplyErrorLine();

      const svgEl = preview.querySelector('svg');
      if (svgEl) {
        applyDiagramStyling(svgEl);
        const size = normalizeSvg(svgEl);
        setExportButtonsEnabled(true);
        // Auto-fit only on the first successful render of this panel's
        // lifetime. Re-fitting on later renders would yank the view out from
        // under a user who has zoomed in and kept typing.
        if (!hasAutoFitted) {
          fitToView(size);
          hasAutoFitted = true;
        }
      }
    } catch (err) {
      if (seq !== renderSeq) {
        return;
      }
      // mermaid.render() creates a hidden scratch container (id `d` +
      // diagramId) to render into and normally removes it; on a thrown
      // error it can be left behind. Clean it up so failed renders don't
      // leak DOM nodes into the page.
      const orphan = document.getElementById('d' + diagramId);
      if (orphan) {
        orphan.remove();
      }
      // Keep-last-good-render: leave `preview` untouched (it still shows the
      // last valid diagram, if any) and just surface the error banner plus
      // the offending source line.
      errorEl.textContent = String((err && err.message) || err);
      errorEl.hidden = false;
      currentErrorLine = syntax.extractErrorLine(err, source);
      reapplyErrorLine();
    }
  }

  // ================================================
  // Zoom & pan
  // ================================================
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 1.1;
  const FIT_PADDING = 24;

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let hasAutoFitted = false;

  function applyTransform() {
    preview.style.transform =
      'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
    if (zoomReadout) {
      zoomReadout.textContent = Math.round(zoom * 100) + '%';
    }
  }

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  /**
   * Zoom about a fixed viewport point. With transform-origin at 0 0 the
   * content point under viewport point c is u = (c - pan) / zoom; holding u
   * fixed across a zoom change gives pan' = c - u * zoom'.
   */
  function zoomAt(cx, cy, factor) {
    const next = clampZoom(zoom * factor);
    panX = cx - ((cx - panX) / zoom) * next;
    panY = cy - ((cy - panY) / zoom) * next;
    zoom = next;
    applyTransform();
  }

  function zoomAtCenter(factor) {
    zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
  }

  function fitToView(size) {
    const svg = preview.querySelector('svg');
    if (!svg) return;
    let w = size && size.w;
    let h = size && size.h;
    if (!w || !h) {
      const vb = svg.viewBox && svg.viewBox.baseVal;
      w = (vb && vb.width) || svg.getBoundingClientRect().width;
      h = (vb && vb.height) || svg.getBoundingClientRect().height;
    }
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!w || !h || !vw || !vh) return;
    zoom = clampZoom(Math.min((vw - 2 * FIT_PADDING) / w, (vh - 2 * FIT_PADDING) / h));
    panX = (vw - w * zoom) / 2;
    panY = (vh - h * zoom) / 2;
    applyTransform();
  }

  function resetZoom() {
    zoom = 1;
    const svg = preview.querySelector('svg');
    if (svg) {
      const vb = svg.viewBox && svg.viewBox.baseVal;
      const w = (vb && vb.width) || svg.getBoundingClientRect().width;
      const h = (vb && vb.height) || svg.getBoundingClientRect().height;
      panX = Math.max(0, (viewport.clientWidth - w) / 2);
      panY = Math.max(0, (viewport.clientHeight - h) / 2);
    } else {
      panX = 0;
      panY = 0;
    }
    applyTransform();
  }

  // Ctrl/Cmd+wheel zooms (this also covers macOS trackpad pinch, which
  // Chromium reports as ctrl+wheel); plain wheel pans, since the viewport
  // has no native scrolling of its own — the transform IS the scroll model.
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    } else {
      panX -= e.deltaX;
      panY -= e.deltaY;
      applyTransform();
    }
  }, { passive: false });

  // Drag-to-pan. Uses its own flag and a distinct mousedown target from the
  // divider's drag, so the two document-level listeners can never both act.
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panOrigX = 0;
  let panOrigY = 0;

  viewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    viewport.classList.add('panning');
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOrigX = panX;
    panOrigY = panY;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    panX = panOrigX + (e.clientX - panStartX);
    panY = panOrigY + (e.clientY - panStartY);
    applyTransform();
  });

  document.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      viewport.classList.remove('panning');
    }
  });

  document.getElementById('mmd-zoom-in')?.addEventListener('click', () => zoomAtCenter(ZOOM_STEP));
  document.getElementById('mmd-zoom-out')?.addEventListener('click', () => zoomAtCenter(1 / ZOOM_STEP));
  document.getElementById('mmd-zoom-reset')?.addEventListener('click', resetZoom);
  document.getElementById('mmd-zoom-fit')?.addEventListener('click', () => fitToView());
  zoomReadout?.addEventListener('click', resetZoom);
  document.getElementById('btn-about')?.addEventListener('click', () => vscode.postMessage({ type: 'showAbout' }));

  // ================================================
  // Export: PNG and print
  // ================================================
  /** Separate from renderSeq — see renderThemedSvg. */
  let exportSeq = 0;

  /**
   * Render the current source off-screen in a specific theme, for export and
   * print. Uses an `%%{init}%%` directive rather than re-initializing mermaid
   * globally, so it can't race the live preview's own render. (If the user's
   * source already sets a theme explicitly, theirs wins — respecting an
   * explicit authored choice is the right call.)
   *
   * @param {'light'|'dark'} kind
   * @returns {Promise<SVGSVGElement|null>}
   */
  async function renderThemedSvg(kind) {
    // Deliberately the last source that PARSED, not textarea.value. The
    // preview keeps showing the last good diagram while the source is
    // mid-edit and broken (keep-last-good), and export must match what the
    // user is looking at — rendering the broken source would fail, silently
    // fall back to the on-screen SVG, and export it in the wrong theme.
    const source = lastGoodSource;
    if (!source || !source.trim()) return null;
    const directive = '%%{init: ' + JSON.stringify({
      theme: 'base',
      themeVariables: Object.assign(
        { fontFamily: DIAGRAM_FONT, fontSize: '14px' },
        THEME_VARIABLES[kind]
      ),
    }) + '}%%\n';
    // Deliberately NOT renderSeq — bumping that would make an in-flight
    // preview render see itself as superseded and silently bail.
    const diagramId = 'mmd-export-' + (++exportSeq);
    try {
      // @ts-ignore - mermaid global
      const { svg } = await mermaid.render(diagramId, directive + source);
      const holder = document.createElement('div');
      holder.innerHTML = svg;
      const el = /** @type {SVGSVGElement|null} */ (holder.querySelector('svg'));
      if (el) applyDiagramStyling(el);
      return el;
    } catch (_) {
      // Same scratch-node cleanup as the preview path — a failed render can
      // leave mermaid's hidden container behind.
      const orphan = document.getElementById('d' + diagramId);
      if (orphan) orphan.remove();
      return null;
    }
  }

  /**
   * Serialize a diagram SVG at its intrinsic size, independent of the current
   * zoom/pan (the transform lives on the wrapper, not the SVG itself).
   * @param {SVGSVGElement} [svgOverride] use this SVG instead of the previewed one
   */
  function serializeSvg(svgOverride) {
    const svg = svgOverride || preview.querySelector('svg');
    if (!svg) return null;
    const clone = /** @type {SVGSVGElement} */ (svg.cloneNode(true));
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const w = (vb && vb.width) || parseFloat(svg.getAttribute('width')) || rect.width / zoom;
    const h = (vb && vb.height) || parseFloat(svg.getAttribute('height')) || rect.height / zoom;
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    if (!clone.getAttribute('viewBox')) {
      clone.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    }
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.style.maxWidth = 'none';
    return { text: new XMLSerializer().serializeToString(clone), w, h };
  }

  /**
   * @param {'light'|'dark'} themeKind background/diagram theme for the image
   */
  async function exportPng(themeKind) {
    // Re-render in the chosen theme rather than rasterizing what's on screen,
    // so a light-background export from a dark editor gets dark-on-light text
    // rather than an unreadable light-on-light image.
    let themed = null;
    if (themeKind !== currentThemeKind()) {
      themed = await renderThemedSvg(themeKind);
      if (!themed) {
        // Falling back to the on-screen SVG here would export the WRONG
        // theme (e.g. a dark diagram onto a white canvas) while still
        // reporting success. Fail loudly instead.
        vscode.postMessage({
          type: 'exportError',
          message: 'Could not render the diagram for export. Fix any errors in the diagram and try again.',
        });
        return;
      }
    }
    const serialized = serializeSvg(themed || undefined);
    if (!serialized) return;
    const { text, w, h } = serialized;
    try {
      // A data: URL keeps the canvas untainted and is already permitted by
      // the webview CSP's `img-src ... data:` (a blob: URL would need the
      // CSP widened).
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to rasterize the diagram'));
        img.src = url;
      });

      // 2x for crispness, but scale DOWN below 1 when necessary: a diagram
      // wider than the cap would otherwise exceed Chromium's canvas limits,
      // making toDataURL() return the empty "data:," and silently write a
      // 0-byte file.
      const MAX_DIMENSION = 8192;
      const scale = Math.min(2, MAX_DIMENSION / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(w * scale));
      canvas.height = Math.max(1, Math.ceil(h * scale));
      const ctx = canvas.getContext('2d');
      // Fill with the editor background rather than leaving it transparent:
      // mermaid picks its theme from the VS Code theme, so a dark-theme
      // diagram has light text that would be invisible on white.
      ctx.fillStyle = EXPORT_BACKGROUND[themeKind] || EXPORT_BACKGROUND.dark;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // A canvas that exceeded the browser's limits yields the empty
      // "data:," rather than throwing — catch that here so it surfaces as an
      // error instead of a success toast over a 0-byte file.
      const dataUrl = canvas.toDataURL('image/png');
      const base64 = dataUrl.startsWith('data:image/png;base64,')
        ? dataUrl.slice('data:image/png;base64,'.length)
        : '';
      if (!base64) {
        throw new Error('The diagram is too large to rasterize.');
      }
      vscode.postMessage({ type: 'exportPng', base64: base64 });
    } catch (err) {
      vscode.postMessage({
        type: 'exportError',
        message: String((err && err.message) || err),
      });
    }
  }

  // The image theme is picked in a native VS Code QuickPick on the host side,
  // which replies with 'exportPngTheme'.
  btnExportPng?.addEventListener('click', () => {
    if (!preview.querySelector('svg')) return;
    vscode.postMessage({ type: 'requestPngExport' });
  });

  // window.print() does NOT work inside a VS Code webview — they're
  // sandboxed iframes without allow-modals, so the print dialog is
  // suppressed silently. Instead the host writes a standalone HTML file and
  // opens it in the real browser, where Print (and its "Save as PDF"
  // destination) works properly.
  //
  // Printing always uses the light theme: a dark-theme diagram prints as
  // light-on-white (i.e. invisible) or wastes a page of toner.
  btnPrint?.addEventListener('click', async () => {
    if (!preview.querySelector('svg')) return;
    let themed = null;
    if (currentThemeKind() !== 'light') {
      themed = await renderThemedSvg('light');
      if (!themed) {
        // Same reasoning as exportPng: printing the on-screen dark diagram
        // onto white paper is worse than telling the user why it failed.
        vscode.postMessage({
          type: 'exportError',
          message: 'Could not render the diagram for printing. Fix any errors in the diagram and try again.',
        });
        return;
      }
    }
    const serialized = serializeSvg(themed || undefined);
    if (!serialized) return;
    vscode.postMessage({ type: 'print', svg: serialized.text });
  });

  // ================================================
  // Draggable divider for pane resizing
  // ================================================
  let isDragging = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    divider.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const containerRect = container.getBoundingClientRect();
    const editorPane = document.getElementById('mmd-editor-pane');
    const previewPane = document.getElementById('mmd-preview-pane');
    if (!editorPane || !previewPane) return;

    const offset = e.clientX - containerRect.left;
    const percentage = Math.max(20, Math.min(80, (offset / containerRect.width) * 100));

    editorPane.style.flex = 'none';
    editorPane.style.width = percentage + '%';
    previewPane.style.flex = 'none';
    previewPane.style.width = (100 - percentage) + '%';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      divider.classList.remove('dragging');
    }
  });

  // VS Code swaps body classes (vscode-light/vscode-dark) when the colour
  // theme changes. Mermaid bakes its colours into the rendered SVG, so the
  // diagram has to be re-rendered to follow the new theme.
  let themeKind = currentThemeKind();
  new MutationObserver(() => {
    const next = currentThemeKind();
    if (next === themeKind) return;
    themeKind = next;
    // @ts-ignore - mermaid global
    mermaid.initialize(mermaidConfigFor(next));
    renderDiagram(textarea.value);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  setExportButtonsEnabled(false);
  applyTransform();
  vscode.postMessage({ type: 'ready' });
  // Initial render happens when the first 'update' message arrives.
})();
