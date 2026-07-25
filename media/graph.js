// @ts-check
(function () {
  /** @type {ReturnType<typeof acquireVsCodeApi>} */
  const vscode = acquireVsCodeApi();

  const fileList = document.getElementById('file-list');
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
  const btnShowGraph = document.getElementById('btn-show-graph');
  const btnToggleLinksView = document.getElementById('btn-toggle-links-view');

  const mermaidFileList = document.getElementById('mermaid-file-list');
  const mermaidSearchInput = /** @type {HTMLInputElement} */ (document.getElementById('mermaid-search-input'));
  const btnToggleMermaidView = document.getElementById('btn-toggle-mermaid-view');

  // ================================================
  // Persisted per-tab state (view mode survives a webview reload)
  // ================================================
  const persisted = vscode.getState() || {};
  /** @type {{linksViewMode: 'flat'|'folders', mermaidViewMode: 'flat'|'folders'}} */
  const state = {
    linksViewMode: persisted.linksViewMode === 'folders' ? 'folders' : 'flat',
    mermaidViewMode: persisted.mermaidViewMode === 'folders' ? 'folders' : 'flat',
  };
  let lastLinksNodes = [];
  let lastMermaidNodes = [];

  function savePersistedState() {
    vscode.setState({ linksViewMode: state.linksViewMode, mermaidViewMode: state.mermaidViewMode });
  }

  // ================================================
  // View-mode toggle buttons (icon-only, matching the .mmd editor's
  // snippet-palette convention: inline SVG + title/aria-label tooltip)
  // ================================================
  const LIST_ICON = '<line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/>';
  const FOLDER_ICON = '<path d="M2 4.5 H6.5 L8 6.5 H14 V12.5 H2 Z"/>';

  function renderToggleButton(btn, viewMode) {
    if (!btn) return;
    const svg =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (viewMode === 'folders' ? FOLDER_ICON : LIST_ICON) +
      '</svg>';
    btn.innerHTML = svg;
    const nextLabel = viewMode === 'folders' ? 'Show flat list' : 'Show folder structure';
    btn.title = nextLabel;
    btn.setAttribute('aria-label', nextLabel);
  }

  function setSearchDisabledLook(btn, disabled, viewMode) {
    if (!btn) return;
    btn.disabled = disabled;
    btn.classList.toggle('disabled', disabled);
    if (disabled) {
      btn.title = 'Folder view is unavailable while searching';
      btn.setAttribute('aria-label', btn.title);
    } else {
      // Restore the real label/icon — otherwise the "unavailable while
      // searching" tooltip would stick around after the search is cleared.
      renderToggleButton(btn, viewMode);
    }
  }

  renderToggleButton(btnToggleLinksView, state.linksViewMode);
  renderToggleButton(btnToggleMermaidView, state.mermaidViewMode);

  btnToggleLinksView?.addEventListener('click', () => {
    state.linksViewMode = state.linksViewMode === 'folders' ? 'flat' : 'folders';
    renderToggleButton(btnToggleLinksView, state.linksViewMode);
    savePersistedState();
    renderFileList(lastLinksNodes);
  });

  btnToggleMermaidView?.addEventListener('click', () => {
    state.mermaidViewMode = state.mermaidViewMode === 'folders' ? 'flat' : 'folders';
    renderToggleButton(btnToggleMermaidView, state.mermaidViewMode);
    savePersistedState();
    renderMermaidFileList(lastMermaidNodes);
  });

  // ================================================
  // Tab switching (client-side only — both tabs' data is already sent by
  // the host on 'ready', so switching needs no round trip)
  // ================================================
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      tabButtons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      tabPanels.forEach((p) => {
        p.classList.toggle('active', p.getAttribute('data-panel') === target);
      });
      closeFolderMenu();
    });
  });

  // ================================================
  // Folder tree grouping (shared by both tabs)
  // ================================================
  /**
   * Group a flat node list into a tree keyed by folder path segments.
   * Folders are only ever created here when a file needs them, so a folder
   * with no matching file (directly or in a subfolder) never appears —
   * satisfies "don't show empty folders" by construction, not by filtering.
   */
  function buildFolderTree(nodes) {
    const root = { children: new Map(), files: [] };
    for (const node of nodes) {
      const parts = node.relativePath.split('/');
      const dirs = parts.slice(0, -1);
      let cur = root;
      let pathSoFar = '';
      for (const dir of dirs) {
        pathSoFar = pathSoFar ? pathSoFar + '/' + dir : dir;
        if (!cur.children.has(dir)) {
          cur.children.set(dir, { name: dir, path: pathSoFar, children: new Map(), files: [] });
        }
        cur = cur.children.get(dir);
      }
      cur.files.push(node);
    }
    return root;
  }

  /**
   * Walk a folder-tree level, appending folder headers (subfolders first,
   * then files, both alphabetical — the conventional file-explorer order)
   * via the shared logic, and delegating each file row to `renderRow`.
   */
  function renderTreeLevel(fragment, level, depth, renderRow) {
    const folderNames = Array.from(level.children.keys()).sort((a, b) => a.localeCompare(b));
    for (const name of folderNames) {
      const child = level.children.get(name);
      const header = document.createElement('div');
      header.className = 'folder-header';
      header.style.paddingLeft = (8 + depth * 14) + 'px';
      header.dataset.folderPath = child.path;

      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      icon.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + FOLDER_ICON + '</svg>';
      header.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'folder-label';
      label.textContent = name;
      header.appendChild(label);

      fragment.appendChild(header);
      renderTreeLevel(fragment, child, depth + 1, renderRow);
    }

    const files = level.files.slice().sort((a, b) => a.label.localeCompare(b.label));
    for (const node of files) {
      renderRow(fragment, node, depth);
    }
  }

  /** Render `nodes` flat (sorted, as given) or grouped into a folder tree. */
  function renderGrouped(fragment, nodes, viewMode, renderRow) {
    if (viewMode === 'folders') {
      const tree = buildFolderTree(nodes);
      renderTreeLevel(fragment, tree, 0, renderRow);
    } else {
      for (const node of nodes) {
        renderRow(fragment, node, 0);
      }
    }
  }

  // ================================================
  // Render Markdown Links file list
  // ================================================
  /**
   * Match the host's own searchChanged filter (label/folder substring),
   * so the instant client-side preview while typing shows the CORRECT
   * filtered set immediately, rather than the stale unfiltered list for the
   * ~200ms until the debounced host round-trip's real filtered list lands.
   */
  function filterNodesByQuery(nodes, query) {
    if (!query) return nodes;
    const q = query.toLowerCase();
    return nodes.filter((n) =>
      n.label.toLowerCase().includes(q) || (n.folder || '').toLowerCase().includes(q));
  }

  function renderFileList(nodes, isCanonical = true) {
    if (!fileList) return;
    if (isCanonical) {
      lastLinksNodes = nodes || [];
    }

    const query = searchInput ? searchInput.value.trim() : '';
    const effectiveMode = query ? 'flat' : state.linksViewMode;
    setSearchDisabledLook(btnToggleLinksView, !!query, state.linksViewMode);

    // The whole list is torn down and rebuilt on every update (including
    // expand/collapse round-trips) — preserve the scroll position so the
    // view doesn't jump back to the top.
    const savedScrollTop = fileList.scrollTop;
    const savedDocScrollTop = document.scrollingElement ? document.scrollingElement.scrollTop : 0;

    if (!nodes || nodes.length === 0) {
      fileList.innerHTML = '<div class="empty-msg">No files found</div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    renderGrouped(fragment, nodes, effectiveMode, (frag, node, depth) => {
      const row = document.createElement('div');
      row.className = 'file-node' + (node.isActive ? ' active' : '');
      row.dataset.path = node.relativePath;
      row.style.paddingLeft = (8 + depth * 14) + 'px';

      const icon = document.createElement('span');
      icon.className = 'node-icon';
      icon.textContent = '📄';
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'node-label';
      label.textContent = node.label;
      row.appendChild(label);

      // Flat view is deliberately just an alphabetical file list, no folder
      // info — folder view (the tree itself) is where that context lives.
      // Link navigation lives in the interactive graph (Show Graph button),
      // not here — files appear exactly once, same set as folder view.

      frag.appendChild(row);
    });

    fileList.innerHTML = '';
    fileList.appendChild(fragment);
    fileList.scrollTop = savedScrollTop;
    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = savedDocScrollTop;
    }
  }

  // ================================================
  // Render Mermaid file list
  // ================================================
  function renderMermaidFileList(nodes, isCanonical = true) {
    if (!mermaidFileList) return;
    if (isCanonical) {
      lastMermaidNodes = nodes || [];
    }

    const query = mermaidSearchInput ? mermaidSearchInput.value.trim() : '';
    const effectiveMode = query ? 'flat' : state.mermaidViewMode;
    setSearchDisabledLook(btnToggleMermaidView, !!query, state.mermaidViewMode);

    const savedScrollTop = mermaidFileList.scrollTop;

    if (!nodes || nodes.length === 0) {
      mermaidFileList.innerHTML = '<div class="empty-msg">No diagrams found</div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    renderGrouped(fragment, nodes, effectiveMode, (frag, node, depth) => {
      const row = document.createElement('div');
      row.className = 'file-node';
      row.dataset.path = node.relativePath;
      row.style.paddingLeft = (8 + depth * 14) + 'px';

      const icon = document.createElement('span');
      icon.className = 'node-icon';
      icon.textContent = '📄';
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'node-label';
      label.textContent = node.label;
      row.appendChild(label);

      frag.appendChild(row);
    });

    mermaidFileList.innerHTML = '';
    mermaidFileList.appendChild(fragment);
    mermaidFileList.scrollTop = savedScrollTop;
  }

  // ================================================
  // Folder context menu (right-click a folder header): add a file inside
  // it, or reveal it in VS Code's native Explorer. Built as a floating menu
  // rather than a native context menu — webviews don't get contributed
  // context menus for arbitrary DOM elements — mirroring the floating-menu
  // pattern already used for the wikilink picker and mermaid template menu.
  // ================================================
  let folderMenu = null;

  function closeFolderMenu() {
    if (folderMenu) {
      folderMenu.remove();
      folderMenu = null;
      document.removeEventListener('mousedown', onFolderMenuOutsideClick, true);
      document.removeEventListener('keydown', onFolderMenuKeydown, true);
    }
  }

  function onFolderMenuOutsideClick(e) {
    if (folderMenu && !folderMenu.contains(e.target)) {
      closeFolderMenu();
    }
  }

  function onFolderMenuKeydown(e) {
    if (e.key === 'Escape') {
      closeFolderMenu();
    }
  }

  function openFolderMenu(x, y, folderPath, kind) {
    closeFolderMenu();

    folderMenu = document.createElement('div');
    folderMenu.className = 'folder-menu';

    const addItem = document.createElement('button');
    addItem.className = 'folder-menu-item';
    addItem.textContent = kind === 'markdown' ? 'Add Markdown' : 'Add Mermaid';
    addItem.addEventListener('mousedown', (e) => {
      e.preventDefault();
      closeFolderMenu();
      vscode.postMessage({ type: 'createFile', folderPath, kind });
    });
    folderMenu.appendChild(addItem);

    const revealItem = document.createElement('button');
    revealItem.className = 'folder-menu-item';
    revealItem.textContent = 'Show in Explorer';
    revealItem.addEventListener('mousedown', (e) => {
      e.preventDefault();
      closeFolderMenu();
      vscode.postMessage({ type: 'revealInExplorer', folderPath, kind });
    });
    folderMenu.appendChild(revealItem);

    // Items are focusable buttons, so a keyboard user can Tab onto one —
    // mousedown alone (needed so a real click doesn't blur/close the menu
    // first) doesn't fire for Enter/Space, so handle those explicitly too.
    folderMenu.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('.folder-menu-item');
      if (!item) return;
      e.preventDefault();
      item.dispatchEvent(new MouseEvent('mousedown'));
    });

    document.body.appendChild(folderMenu);

    // Clamp to the viewport so a right-click near the right/bottom edge
    // doesn't render partly off-screen.
    const rect = folderMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    folderMenu.style.left = Math.max(4, left) + 'px';
    folderMenu.style.top = Math.max(4, top) + 'px';

    setTimeout(() => {
      document.addEventListener('mousedown', onFolderMenuOutsideClick, true);
      document.addEventListener('keydown', onFolderMenuKeydown, true);
    }, 0);
  }

  // ================================================
  // Event delegation — Markdown Links tab
  // ================================================
  fileList?.addEventListener('contextmenu', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const header = target.closest('.folder-header');
    if (!header) return;
    e.preventDefault();
    openFolderMenu(e.clientX, e.clientY, header.dataset.folderPath || '', 'markdown');
  });

  fileList?.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const fileNode = target.closest('.file-node');
    if (fileNode) {
      vscode.postMessage({ type: 'openFile', relativePath: fileNode.dataset.path });
    }
  });

  // ================================================
  // Event delegation — Mermaid tab
  // ================================================
  mermaidFileList?.addEventListener('contextmenu', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const header = target.closest('.folder-header');
    if (!header) return;
    e.preventDefault();
    openFolderMenu(e.clientX, e.clientY, header.dataset.folderPath || '', 'mermaid');
  });

  mermaidFileList?.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const fileNode = target.closest('.file-node');
    if (fileNode) {
      vscode.postMessage({ type: 'openMermaidFile', relativePath: fileNode.dataset.path });
    }
  });

  // ================================================
  // Controls
  // ================================================
  btnShowGraph?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openFullGraph' });
  });

  let searchTimer;
  searchInput?.addEventListener('input', () => {
    const query = searchInput.value.trim();
    setSearchDisabledLook(btnToggleLinksView, !!query, state.linksViewMode);
    // Instant preview from the data already on hand, correctly filtered —
    // not the canonical list, so this doesn't clobber lastLinksNodes; the
    // host's own (debounced) filtered reply still lands and re-renders.
    renderFileList(filterNodesByQuery(lastLinksNodes, query), false);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      vscode.postMessage({ type: 'searchChanged', query: searchInput.value });
    }, 200);
  });

  let mermaidSearchTimer;
  mermaidSearchInput?.addEventListener('input', () => {
    const mermaidQuery = mermaidSearchInput.value.trim();
    setSearchDisabledLook(btnToggleMermaidView, !!mermaidQuery, state.mermaidViewMode);
    renderMermaidFileList(filterNodesByQuery(lastMermaidNodes, mermaidQuery), false);
    clearTimeout(mermaidSearchTimer);
    mermaidSearchTimer = setTimeout(() => {
      vscode.postMessage({ type: 'mermaidSearchChanged', query: mermaidSearchInput.value });
    }, 200);
  });

  // ================================================
  // Message handling
  // ================================================
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'fileList':
        renderFileList(msg.nodes);
        break;
      case 'mermaidFileList':
        renderMermaidFileList(msg.nodes);
        break;
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
})();
