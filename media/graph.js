// @ts-check
(function () {
  /** @type {ReturnType<typeof acquireVsCodeApi>} */
  const vscode = acquireVsCodeApi();

  const fileList = document.getElementById('file-list');
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
  const btnShowGraph = document.getElementById('btn-show-graph');

  // Track which nodes are expanded
  const expandedNodes = new Set();

  // ================================================
  // Render file list
  // ================================================
  function renderFileList(nodes) {
    if (!fileList) return;

    if (!nodes || nodes.length === 0) {
      fileList.innerHTML = '<div class="empty-msg">No files found</div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const node of nodes) {
      const hasLinks = node.links && node.links.length > 0;
      const isExpanded = expandedNodes.has(node.relativePath);

      // File node row
      const row = document.createElement('div');
      row.className = 'file-node' + (node.isActive ? ' active' : '');
      row.dataset.path = node.relativePath;

      // Expand toggle
      const toggle = document.createElement('span');
      toggle.className = 'node-toggle' + (isExpanded ? ' expanded' : '');
      toggle.textContent = hasLinks ? (isExpanded ? '\u25BC' : '\u25B6') : '\u2022';
      toggle.style.cursor = hasLinks ? 'pointer' : 'default';
      row.appendChild(toggle);

      // File icon
      const icon = document.createElement('span');
      icon.className = 'node-icon';
      icon.textContent = '\uD83D\uDCC4';
      row.appendChild(icon);

      // Label
      const label = document.createElement('span');
      label.className = 'node-label';
      label.textContent = node.label;
      row.appendChild(label);

      // Link count badge
      if (hasLinks) {
        const badge = document.createElement('span');
        badge.className = 'node-badge';
        badge.textContent = String(node.links.length);
        row.appendChild(badge);
      }

      // Folder
      if (node.folder) {
        const folder = document.createElement('span');
        folder.className = 'node-folder';
        folder.textContent = node.folder;
        row.appendChild(folder);
      }

      fragment.appendChild(row);

      // Links sub-list (if expanded)
      if (hasLinks && isExpanded) {
        const linkList = document.createElement('div');
        linkList.className = 'link-list';

        for (const link of node.links) {
          const linkRow = document.createElement('div');
          linkRow.className = 'link-item';
          linkRow.dataset.path = link.relativePath;

          const arrow = document.createElement('span');
          arrow.className = 'link-arrow ' + (link.direction === 'in' ? 'link-in' : 'link-out');
          arrow.innerHTML = link.direction === 'in' ? '&#8592;' : '&#8594;';
          linkRow.appendChild(arrow);

          const linkLabel = document.createElement('span');
          linkLabel.className = 'link-label';
          linkLabel.textContent = link.label;
          linkRow.appendChild(linkLabel);

          linkList.appendChild(linkRow);
        }

        fragment.appendChild(linkList);
      }
    }

    fileList.innerHTML = '';
    fileList.appendChild(fragment);
  }

  // ================================================
  // Event delegation
  // ================================================
  fileList.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Click on toggle arrow → expand/collapse
    const toggle = target.closest('.node-toggle');
    if (toggle) {
      const row = toggle.closest('.file-node');
      if (row) {
        const path = row.dataset.path;
        if (expandedNodes.has(path)) {
          expandedNodes.delete(path);
        } else {
          expandedNodes.add(path);
        }
        // Re-request to trigger re-render with same data
        vscode.postMessage({ type: 'ready' });
      }
      return;
    }

    // Click on file node label → open file
    const fileNode = target.closest('.file-node');
    if (fileNode && !target.closest('.node-toggle')) {
      vscode.postMessage({ type: 'openFile', relativePath: fileNode.dataset.path });
      return;
    }

    // Click on link item → open that linked file
    const linkItem = target.closest('.link-item');
    if (linkItem) {
      vscode.postMessage({ type: 'openFile', relativePath: linkItem.dataset.path });
      return;
    }
  });

  // ================================================
  // Controls
  // ================================================
  btnShowGraph.addEventListener('click', () => {
    vscode.postMessage({ type: 'openFullGraph' });
  });

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      vscode.postMessage({ type: 'searchChanged', query: searchInput.value });
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
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
})();
