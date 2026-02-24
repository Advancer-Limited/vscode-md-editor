// @ts-check
(function () {
  // @ts-ignore
  const ForceGraphLib = window.ForceGraph;
  /** @type {ReturnType<typeof acquireVsCodeApi>} */
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('graph-container');
  const tooltip = document.getElementById('node-tooltip');
  const controlsBody = document.getElementById('controls-body');
  const toggleControls = document.getElementById('toggle-controls');

  function setStatus(text) {
    console.log('[FullGraph] ' + text);
  }

  if (!ForceGraphLib) {
    setStatus('ERROR: ForceGraph not loaded');
    return;
  }

  // Control elements
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
  const showOrphans = /** @type {HTMLInputElement} */ (document.getElementById('show-orphans'));
  const labelMode = /** @type {HTMLSelectElement} */ (document.getElementById('label-mode'));
  const showArrows = /** @type {HTMLInputElement} */ (document.getElementById('show-arrows'));
  const chargeSlider = /** @type {HTMLInputElement} */ (document.getElementById('charge-slider'));
  const distanceSlider = /** @type {HTMLInputElement} */ (document.getElementById('distance-slider'));
  const centerForce = /** @type {HTMLInputElement} */ (document.getElementById('center-force'));
  const btnFit = document.getElementById('btn-fit');
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');

  let highlightedNode = null;
  let highlightedNeighbors = new Set();
  let pinnedNodes = new Set();
  let activeNodeId = null;
  let dataReceived = false;

  // Read VS Code theme colors from CSS variables
  function themeColor(varName, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return val || fallback;
  }

  // Theme-aware semantic colors
  const activeColor = themeColor('--vscode-editorWarning-foreground', '#ffcc00');
  const highlightColor = themeColor('--vscode-textLink-foreground', '#4a9eff');
  const labelColor = themeColor('--vscode-editor-foreground', '#d4d4d4');
  const dimColor = themeColor('--vscode-disabledForeground', 'rgba(128,128,128,0.4)');

  // Folder color palette — uses VS Code symbol icon colors for a native look
  const folderColors = {};
  const palette = [
    themeColor('--vscode-symbolIcon-classForeground', '#ee9d28'),
    themeColor('--vscode-symbolIcon-functionForeground', '#b180d7'),
    themeColor('--vscode-symbolIcon-variableForeground', '#75beff'),
    themeColor('--vscode-symbolIcon-stringForeground', '#ee9d28'),
    themeColor('--vscode-symbolIcon-namespaceForeground', '#ee9d28'),
    themeColor('--vscode-symbolIcon-interfaceForeground', '#75beff'),
    themeColor('--vscode-symbolIcon-methodForeground', '#b180d7'),
    themeColor('--vscode-symbolIcon-enumeratorForeground', '#ee9d28'),
  ];

  // Deduplicate palette (some symbol colors resolve to the same value)
  const uniquePalette = [...new Set(palette)];
  // If too few unique colors, supplement with textLink and button colors
  if (uniquePalette.length < 4) {
    const extras = [
      themeColor('--vscode-textLink-foreground', '#4a9eff'),
      themeColor('--vscode-button-background', '#0e639c'),
      themeColor('--vscode-textPreformat-foreground', '#d7ba7d'),
      themeColor('--vscode-terminal-ansiGreen', '#4ec9b0'),
      themeColor('--vscode-terminal-ansiMagenta', '#c586c0'),
      themeColor('--vscode-terminal-ansiBlue', '#569cd6'),
      themeColor('--vscode-terminal-ansiYellow', '#dcdcaa'),
      themeColor('--vscode-terminal-ansiRed', '#f44747'),
    ];
    for (const c of extras) {
      if (!uniquePalette.includes(c)) uniquePalette.push(c);
      if (uniquePalette.length >= 8) break;
    }
  }

  let colorIdx = 0;
  function getFolderColor(folder) {
    if (!folder) return themeColor('--vscode-descriptionForeground', '#888');
    if (!folderColors[folder]) {
      folderColors[folder] = uniquePalette[colorIdx % uniquePalette.length];
      colorIdx++;
    }
    return folderColors[folder];
  }

  let adjacencyMap = new Map();
  function buildAdjacency(edges) {
    adjacencyMap = new Map();
    for (const edge of edges) {
      const s = typeof edge.source === 'object' ? edge.source.id : edge.source;
      const t = typeof edge.target === 'object' ? edge.target.id : edge.target;
      if (!adjacencyMap.has(s)) adjacencyMap.set(s, new Set());
      if (!adjacencyMap.has(t)) adjacencyMap.set(t, new Set());
      adjacencyMap.get(s).add(t);
      adjacencyMap.get(t).add(s);
    }
  }

  function getNodeSize(connectionCount) {
    return Math.max(3, Math.sqrt(connectionCount + 1) * 4);
  }

  // Toggle controls
  let controlsVisible = true;
  toggleControls.addEventListener('click', () => {
    controlsVisible = !controlsVisible;
    controlsBody.style.display = controlsVisible ? 'block' : 'none';
    toggleControls.classList.toggle('collapsed', !controlsVisible);
  });

  // Create graph
  setStatus('Creating graph...');
  const graph = ForceGraphLib()(container)
    .nodeId('id')
    .nodeVal(node => getNodeSize(node.connectionCount))
    .nodeColor(node => {
      if (node.id === activeNodeId || node.isActive) return activeColor;
      if (highlightedNode) {
        if (node === highlightedNode) return activeColor;
        if (highlightedNeighbors.has(node.id)) return highlightColor;
        return 'rgba(100,100,100,0.15)';
      }
      if (node.isOrphan) return dimColor;
      return getFolderColor(node.folder);
    })
    .nodeCanvasObjectMode(() => 'after')
    .nodeCanvasObject((node, ctx, globalScale) => {
      const label = node.label;
      const fontSize = Math.max(10, 14 / globalScale);
      const currentLabelMode = labelMode.value;
      let showLabel = false;
      if (currentLabelMode === 'always') showLabel = true;
      else if (currentLabelMode === 'never') showLabel = false;
      else showLabel = node.isActive || node.id === activeNodeId || node === highlightedNode || highlightedNeighbors.has(node.id) || globalScale > 1.2;
      if (!showLabel) return;
      if (fontSize / globalScale < 2) return;
      ctx.font = `${fontSize}px Sans-Serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const nodeRadius = getNodeSize(node.connectionCount);
      const isActive = node.isActive || node.id === activeNodeId;
      if (isActive) { ctx.shadowColor = activeColor; ctx.shadowBlur = 12; }
      ctx.fillStyle = isActive ? activeColor : labelColor;
      ctx.fillText(label, node.x, node.y + nodeRadius + fontSize * 0.8);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    })
    .linkColor(link => {
      if (highlightedNode) {
        const s = typeof link.source === 'object' ? link.source.id : link.source;
        const t = typeof link.target === 'object' ? link.target.id : link.target;
        if (s === highlightedNode.id || t === highlightedNode.id) return highlightColor;
        return 'rgba(100,100,100,0.03)';
      }
      return 'rgba(128,128,128,0.15)';
    })
    .linkWidth(link => Math.min(3, 0.5 + (link.frequency || 1) * 0.5))
    .linkDirectionalArrowLength(0);

  graph.d3Force('charge')?.strength(-300);
  graph.d3Force('link')?.distance(100);

  // Custom force: pull orphan nodes toward the center so they don't drift far away
  function orphanGravity(alpha) {
    const nodes = graph.graphData().nodes;
    if (!nodes) return;
    for (const node of nodes) {
      if (node.isOrphan) {
        const strength = 0.1 * alpha;
        node.vx -= node.x * strength;
        node.vy -= node.y * strength;
      }
    }
  }
  orphanGravity.initialize = function () {};
  graph.d3Force('orphanGravity', orphanGravity);

  setStatus('Graph created. Setting up interactions...');

  // Interactions — use click with timer for double-click detection
  let lastClickTime = 0;
  let lastClickNode = null;
  graph.onNodeClick(node => {
    const now = Date.now();
    if (lastClickNode === node && now - lastClickTime < 400) {
      // Double-click: open file
      vscode.postMessage({ type: 'openFile', relativePath: node.id });
      lastClickNode = null;
    } else {
      // Single click: show tooltip
      lastClickNode = node;
      lastClickTime = now;
      showNodeTooltip(node);
    }
  });
  graph.onNodeHover(node => {
    highlightedNode = node || null;
    highlightedNeighbors = new Set();
    if (node) { const n = adjacencyMap.get(node.id); if (n) highlightedNeighbors = n; }
    container.style.cursor = node ? 'pointer' : 'default';
  });
  graph.onNodeDragEnd(node => { node.fx = node.x; node.fy = node.y; pinnedNodes.add(node.id); });
  graph.onNodeRightClick(node => { node.fx = undefined; node.fy = undefined; pinnedNodes.delete(node.id); });
  graph.onBackgroundClick(() => hideTooltip());

  // Tooltip
  function showNodeTooltip(node) {
    const connections = adjacencyMap.get(node.id)?.size || 0;
    const tags = node.tags && node.tags.length > 0 ? node.tags.join(', ') : 'none';
    tooltip.innerHTML = `
      <div class="tooltip-title">${escapeHtml(node.label)}</div>
      <div class="tooltip-detail">${escapeHtml(node.folder || 'root')}</div>
      <div class="tooltip-detail">Connections: ${connections}</div>
      <div class="tooltip-detail">Tags: ${tags}</div>
      <div class="tooltip-actions">
        <button class="tooltip-btn" data-action="open" data-path="${escapeHtml(node.id)}">Open</button>
      </div>`;
    tooltip.classList.remove('hidden');
    tooltip.querySelector('[data-action="open"]')?.addEventListener('click', (e) => {
      const path = /** @type {HTMLElement} */ (e.target).getAttribute('data-path');
      if (path) vscode.postMessage({ type: 'openFile', relativePath: path });
      hideTooltip();
    });
  }
  function hideTooltip() { tooltip.classList.add('hidden'); }
  function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

  // Resize
  const resizeObserver = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) graph.width(r.width).height(r.height);
  });
  resizeObserver.observe(container);

  // Process incoming graph data
  function handleGraphData(nodes, edges) {
    try {
      dataReceived = true;
      buildAdjacency(edges);

      // Preserve pinned
      const oldPos = new Map();
      const cur = graph.graphData();
      if (cur.nodes) {
        for (const n of cur.nodes) {
          if (pinnedNodes.has(n.id)) oldPos.set(n.id, { fx: n.fx, fy: n.fy });
        }
      }
      for (const n of nodes) {
        const p = oldPos.get(n.id);
        if (p) { n.fx = p.fx; n.fy = p.fy; }
      }

      // Set dimensions
      const r = container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) graph.width(r.width).height(r.height);

      graph.graphData({ nodes: nodes, links: edges });
      setStatus(nodes.length + ' nodes, ' + edges.length + ' edges');

      setTimeout(() => graph.zoomToFit(400, 40), 800);
    } catch (err) {
      setStatus('ERROR in handleGraphData: ' + err.message);
    }
  }

  // ==========================================
  // SINGLE message handler — registered early
  // ==========================================
  window.addEventListener('message', (event) => {
    try {
      const msg = event.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'graphData':
          if (Array.isArray(msg.nodes) && Array.isArray(msg.edges)) {
            handleGraphData(msg.nodes, msg.edges);
          }
          break;
        case 'activeFileChanged':
          activeNodeId = msg.nodeId;
          break;
      }
    } catch (err) {
      setStatus('ERROR in message handler: ' + err.message);
    }
  });

  // Controls
  function getFilters() {
    return { mode: 'global', localDepth: 2, showOrphans: showOrphans.checked, folderFilter: [], tagFilter: [], searchQuery: searchInput.value };
  }
  let searchTimer;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => vscode.postMessage({ type: 'filterChanged', filters: getFilters() }), 300); });
  showOrphans.addEventListener('change', () => vscode.postMessage({ type: 'filterChanged', filters: getFilters() }));
  showArrows.addEventListener('change', () => graph.linkDirectionalArrowLength(showArrows.checked ? 4 : 0));
  chargeSlider.addEventListener('input', () => { graph.d3Force('charge')?.strength(parseInt(chargeSlider.value)); graph.d3ReheatSimulation(); });
  distanceSlider.addEventListener('input', () => { graph.d3Force('link')?.distance(parseInt(distanceSlider.value)); graph.d3ReheatSimulation(); });
  centerForce.addEventListener('change', () => {
    graph.d3Force('center', centerForce.checked ? (window.d3?.forceCenter?.() || null) : null);
    graph.d3ReheatSimulation();
  });
  btnFit.addEventListener('click', () => graph.zoomToFit(400, 40));
  btnZoomIn.addEventListener('click', () => graph.zoom(graph.zoom() * 1.5, 300));
  btnZoomOut.addEventListener('click', () => graph.zoom(graph.zoom() / 1.5, 300));

  // Request data
  vscode.postMessage({ type: 'ready' });

  // Retry if no data after delays
  [1500, 4000].forEach(delay => {
    setTimeout(() => {
      if (!dataReceived) {
        setStatus('Retrying (' + delay + 'ms)...');
        vscode.postMessage({ type: 'requestRefresh' });
      }
    }, delay);
  });
})();
