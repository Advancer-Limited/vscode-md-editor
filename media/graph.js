// @ts-check
(function () {
  // @ts-ignore - ForceGraph loaded globally from force-graph.min.js
  const ForceGraphConstructor = window.ForceGraph;
  /** @type {ReturnType<typeof acquireVsCodeApi>} */
  const vscode = acquireVsCodeApi();

  const container = document.getElementById('graph-container');
  const btnMode = document.getElementById('btn-mode');
  const depthSlider = /** @type {HTMLInputElement} */ (document.getElementById('depth-slider'));
  const showOrphans = /** @type {HTMLInputElement} */ (document.getElementById('show-orphans'));
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));

  let currentMode = 'local';
  let highlightedNode = null;
  let highlightedNeighbors = new Set();

  // Color palette for folders
  const folderColors = {};
  const palette = [
    '#4a9eff', '#4ec9b0', '#ce9178', '#c586c0', '#dcdcaa',
    '#9cdcfe', '#6a9955', '#d7ba7d', '#569cd6', '#b5cea8',
  ];
  let colorIdx = 0;

  function getFolderColor(folder) {
    if (!folder) return '#888';
    if (!folderColors[folder]) {
      folderColors[folder] = palette[colorIdx % palette.length];
      colorIdx++;
    }
    return folderColors[folder];
  }

  // Build adjacency for highlight on hover
  let adjacencyMap = new Map();

  function getNodeSize(connectionCount) {
    return Math.max(2, Math.sqrt(connectionCount + 1) * 3);
  }

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

  // Initialize the graph
  const graph = ForceGraphConstructor()(container)
    .nodeId('id')
    .nodeLabel(node => `${node.label}${node.folder ? ' (' + node.folder + ')' : ''}`)
    .nodeVal(node => getNodeSize(node.connectionCount))
    .nodeColor(node => {
      if (node.isActive) return '#ffcc00';
      if (highlightedNode) {
        if (node === highlightedNode) return '#ffcc00';
        if (highlightedNeighbors.has(node.id)) return '#4a9eff';
        return 'rgba(100,100,100,0.2)';
      }
      if (node.isOrphan) return 'rgba(128,128,128,0.4)';
      return getFolderColor(node.folder);
    })
    .nodeCanvasObjectMode(() => 'after')
    .nodeCanvasObject((node, ctx, globalScale) => {
      const label = node.label;
      const fontSize = Math.max(10, 12 / globalScale);
      if (fontSize / globalScale < 3) return; // Too small to read

      ctx.font = `${fontSize}px Sans-Serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Only show labels for active, hovered, or zoomed-in nodes
      const showLabel = node.isActive ||
        node === highlightedNode ||
        highlightedNeighbors.has(node.id) ||
        globalScale > 1.5;

      if (!showLabel) return;

      const nodeRadius = getNodeSize(node.connectionCount);
      ctx.fillStyle = node.isActive ? '#ffcc00' : 'rgba(212,212,212,0.85)';
      ctx.fillText(label, node.x, node.y + nodeRadius + fontSize * 0.8);
    })
    .linkColor(link => {
      if (highlightedNode) {
        const s = typeof link.source === 'object' ? link.source.id : link.source;
        const t = typeof link.target === 'object' ? link.target.id : link.target;
        if (s === highlightedNode.id || t === highlightedNode.id) {
          return 'rgba(74,158,255,0.8)';
        }
        return 'rgba(100,100,100,0.05)';
      }
      return `rgba(255,255,255,${0.08 + 0.12 * (link.frequency || 1)})`;
    })
    .linkWidth(link => Math.min(3, 0.5 + (link.frequency || 1) * 0.5))
    .d3Force('charge')?.strength(-400);

  graph.d3Force('link')?.distance(120);

  // Interaction handlers
  graph.onNodeClick((node) => {
    vscode.postMessage({ type: 'openFile', relativePath: node.id });
  });

  graph.onNodeDblClick((node) => {
    graph.centerAt(node.x, node.y, 500);
    graph.zoom(2.5, 500);
  });

  graph.onNodeHover((node) => {
    highlightedNode = node || null;
    highlightedNeighbors = new Set();
    if (node) {
      const neighbors = adjacencyMap.get(node.id);
      if (neighbors) {
        highlightedNeighbors = neighbors;
      }
    }
    container.style.cursor = node ? 'pointer' : 'default';
  });

  // Responsive sizing
  function resize() {
    const rect = container.getBoundingClientRect();
    graph.width(rect.width).height(rect.height);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  // ================================================
  // Controls
  // ================================================
  function getFilters() {
    return {
      mode: currentMode,
      localDepth: parseInt(depthSlider.value),
      showOrphans: showOrphans.checked,
      folderFilter: [],
      tagFilter: [],
      searchQuery: searchInput.value,
    };
  }

  btnMode.addEventListener('click', () => {
    currentMode = currentMode === 'local' ? 'global' : 'local';
    btnMode.textContent = currentMode === 'local' ? 'Local' : 'Global';
    depthSlider.disabled = currentMode === 'global';
    vscode.postMessage({ type: 'filterChanged', filters: getFilters() });
  });

  depthSlider.addEventListener('input', () => {
    vscode.postMessage({ type: 'filterChanged', filters: getFilters() });
  });

  showOrphans.addEventListener('change', () => {
    vscode.postMessage({ type: 'filterChanged', filters: getFilters() });
  });

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      vscode.postMessage({ type: 'filterChanged', filters: getFilters() });
    }, 300);
  });

  // ================================================
  // Message handling from extension
  // ================================================
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'graphData': {
        if (!Array.isArray(msg.nodes) || !Array.isArray(msg.edges)) break;
        highlightedNode = null;
        highlightedNeighbors = new Set();
        buildAdjacency(msg.edges);
        graph.graphData({
          nodes: msg.nodes,
          links: msg.edges,
        });
        // Center on active node if present
        const activeNode = msg.nodes.find(n => n.isActive);
        if (activeNode && msg.nodes.length > 1) {
          setTimeout(() => {
            graph.centerAt(activeNode.x, activeNode.y, 300);
          }, 500);
        }
        break;
      }
      case 'activeFileChanged':
        // Re-request graph data to recenter
        vscode.postMessage({ type: 'requestRefresh' });
        break;
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
})();
