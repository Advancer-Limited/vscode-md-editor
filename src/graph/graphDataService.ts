import { FileIndexService } from '../wikilink/fileIndexService.js';
import { GraphNode, GraphEdge, GraphFilters, RelationshipItem } from '../types.js';

export class GraphDataService {
  constructor(private readonly fileIndexService: FileIndexService) {}

  /** Build the full graph from the index. */
  public getGlobalGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const files = this.fileIndexService.getAllFiles();
    const edgeMap = new Map<string, GraphEdge>();

    // Count outgoing connections per file
    const outCount = new Map<string, number>();

    for (const file of files) {
      let outgoing = 0;
      for (const link of file.outgoingLinks) {
        const resolved = this.fileIndexService.resolveWikilink(link.target);
        if (!resolved) {
          continue;
        }
        outgoing++;
        // Use sorted key for undirected edges
        const edgeKey = [file.relativePath, resolved].sort().join('->');
        const existing = edgeMap.get(edgeKey);
        if (existing) {
          existing.frequency++;
        } else {
          edgeMap.set(edgeKey, {
            source: file.relativePath,
            target: resolved,
            frequency: 1,
          });
        }
      }
      outCount.set(file.relativePath, outgoing);
    }

    const nodes: GraphNode[] = files.map(file => {
      const outgoing = outCount.get(file.relativePath) || 0;
      const incoming = this.fileIndexService.getBacklinksFor(file.stem).length;
      const connectionCount = outgoing + incoming;

      return {
        id: file.relativePath,
        label: file.stem,
        folder: file.folder,
        tags: file.tags,
        connectionCount,
        isOrphan: connectionCount === 0,
        isActive: false,
      };
    });

    return { nodes, edges: Array.from(edgeMap.values()) };
  }

  /** Build a local graph using BFS from a starting file. */
  public getLocalGraph(
    startPath: string,
    depth: number,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const global = this.getGlobalGraph();

    // Build adjacency
    const adjacency = new Map<string, Set<string>>();
    for (const edge of global.edges) {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, new Set());
      }
      if (!adjacency.has(edge.target)) {
        adjacency.set(edge.target, new Set());
      }
      adjacency.get(edge.source)!.add(edge.target);
      adjacency.get(edge.target)!.add(edge.source);
    }

    // BFS
    const visited = new Set<string>();
    const queue: Array<{ id: string; d: number }> = [{ id: startPath, d: 0 }];
    visited.add(startPath);

    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (d >= depth) {
        continue;
      }
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ id: neighbor, d: d + 1 });
        }
      }
    }

    const nodes = global.nodes.filter(n => visited.has(n.id));
    const edges = global.edges.filter(
      e => visited.has(e.source) && visited.has(e.target),
    );

    // Mark active node
    for (const node of nodes) {
      node.isActive = node.id === startPath;
    }

    return { nodes, edges };
  }

  /** Get relationship items for a file, grouped by direction and depth. */
  public getRelationships(filePath: string, maxDepth: number): RelationshipItem[] {
    const entry = this.fileIndexService.getFileEntry(filePath);
    if (!entry) {
      return [];
    }

    const items: RelationshipItem[] = [];
    const visited = new Set<string>([filePath]);

    // BFS queue: [relativePath, depth, direction-from-start]
    const queue: Array<{ path: string; depth: number; direction: 'outgoing' | 'incoming' }> = [];

    // Seed depth-1: direct outgoing links
    for (const link of entry.outgoingLinks) {
      const resolved = this.fileIndexService.resolveWikilink(link.target);
      if (resolved && !visited.has(resolved)) {
        visited.add(resolved);
        queue.push({ path: resolved, depth: 1, direction: 'outgoing' });
      }
    }

    // Seed depth-1: direct incoming links (backlinks)
    const backlinks = this.fileIndexService.getBacklinksFor(entry.stem);
    for (const bl of backlinks) {
      if (!visited.has(bl.relativePath)) {
        visited.add(bl.relativePath);
        queue.push({ path: bl.relativePath, depth: 1, direction: 'incoming' });
      }
    }

    // Process BFS
    let idx = 0;
    while (idx < queue.length) {
      const { path, depth, direction } = queue[idx++];
      const neighbor = this.fileIndexService.getFileEntry(path);
      if (!neighbor) {
        continue;
      }

      items.push({
        relativePath: path,
        label: neighbor.stem,
        direction,
        depth,
      });

      // Expand further if within maxDepth
      if (depth < maxDepth) {
        // Outgoing from this neighbor
        for (const link of neighbor.outgoingLinks) {
          const resolved = this.fileIndexService.resolveWikilink(link.target);
          if (resolved && !visited.has(resolved)) {
            visited.add(resolved);
            queue.push({ path: resolved, depth: depth + 1, direction });
          }
        }
        // Incoming to this neighbor
        const nBacklinks = this.fileIndexService.getBacklinksFor(neighbor.stem);
        for (const bl of nBacklinks) {
          if (!visited.has(bl.relativePath)) {
            visited.add(bl.relativePath);
            queue.push({ path: bl.relativePath, depth: depth + 1, direction });
          }
        }
      }
    }

    // Sort by depth, then label
    items.sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));
    return items;
  }

  /** Apply filters to graph data. */
  public applyFilters(
    data: { nodes: GraphNode[]; edges: GraphEdge[] },
    filters: GraphFilters,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    let nodes = data.nodes;

    if (!filters.showOrphans) {
      nodes = nodes.filter(n => !n.isOrphan);
    }
    if (filters.folderFilter.length > 0) {
      nodes = nodes.filter(n => filters.folderFilter.includes(n.folder));
    }
    if (filters.tagFilter.length > 0) {
      nodes = nodes.filter(n => n.tags.some(t => filters.tagFilter.includes(t)));
    }
    if (filters.searchQuery) {
      const q = filters.searchQuery.toLowerCase();
      // Always include the searched node + all nodes for edge context
      const matchingIds = new Set(
        nodes.filter(n => n.label.toLowerCase().includes(q)).map(n => n.id),
      );
      // Highlight matching nodes (caller can use this)
      nodes = nodes.map(n => ({
        ...n,
        isActive: matchingIds.has(n.id) || n.isActive,
      }));
    }

    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = data.edges.filter(
      e => nodeIds.has(e.source) && nodeIds.has(e.target),
    );

    return { nodes, edges };
  }
}
