// ========================================
// LanguageTool API Types
// ========================================

export interface LanguageToolResponse {
  software: {
    name: string;
    version: string;
    apiVersion: number;
  };
  language: {
    name: string;
    code: string;
    detectedLanguage?: {
      name: string;
      code: string;
      confidence: number;
    };
  };
  matches: LanguageToolMatch[];
}

export interface LanguageToolMatch {
  message: string;
  shortMessage: string;
  offset: number;
  length: number;
  replacements: LanguageToolReplacement[];
  context: {
    text: string;
    offset: number;
    length: number;
  };
  sentence: string;
  rule: {
    id: string;
    subId?: string;
    description: string;
    issueType: string;
    category: {
      id: string;
      name: string;
    };
    urls?: Array<{ value: string }>;
    isPremium?: boolean;
  };
  type: {
    typeName: string;
  };
  ignoreForIncompleteSentence: boolean;
  contextForSureMatch: number;
}

export interface LanguageToolReplacement {
  value: string;
  shortDescription?: string;
}

// ========================================
// Webview Message Protocol
// ========================================

/** Grammar match data sent to the webview for inline highlights */
export interface GrammarMatch {
  originalOffset: number;
  originalLength: number;
  matchedText: string;
  message: string;
  shortMessage: string;
  severity: 'error' | 'warning';
  ruleId: string;
  replacements: string[];
}

/** Messages from extension host -> editor webview */
export type ExtensionToWebviewMessage =
  | { type: 'update'; text: string }
  | { type: 'setTheme'; theme: 'light' | 'dark' | 'auto' }
  | { type: 'wikilinkSuggestions'; suggestions: WikilinkSuggestion[] }
  | { type: 'grammarResults'; matches: GrammarMatch[] }
  // Acknowledges a webview 'edit' message has been fully processed (applied
  // or rejected) by the host, so the webview knows when it's safe to stop
  // treating incoming 'update' messages as potentially stale.
  | { type: 'editAck' };

/** Messages from editor webview -> extension host */
export type WebviewToExtensionMessage =
  | { type: 'edit'; text: string; cursorOffset?: number }
  | { type: 'ready' }
  | { type: 'requestGrammarCheck' }
  | { type: 'requestWikilinkSuggestions'; prefix: string }
  | { type: 'openWikilink'; target: string }
  | { type: 'applyGrammarFix'; offset: number; length: number; replacement: string; expectedText?: string }
  /** Toolbar brand button — show the About dialog. */
  | { type: 'showAbout' };

export interface WikilinkSuggestion {
  stem: string;
  relativePath: string;
  folder: string;
}

// ========================================
// Graph Visualizer Types
// ========================================

export interface GraphNode {
  id: string;
  label: string;
  folder: string;
  tags: string[];
  connectionCount: number;
  isOrphan: boolean;
  isActive: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  frequency: number;
}

export interface GraphFilters {
  mode: 'global' | 'local';
  localDepth: number;
  showOrphans: boolean;
  folderFilter: string[];
  tagFilter: string[];
  searchQuery: string;
}

export interface RelationshipItem {
  relativePath: string;
  label: string;
  direction: 'incoming' | 'outgoing';
  depth: number;
}

/** Messages from extension host -> graph sidebar webview */
export type ExtensionToGraphMessage =
  | { type: 'graphData'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'relationshipData'; items: RelationshipItem[]; activeFile: string | null }
  | { type: 'activeFileChanged'; nodeId: string | null }
  | { type: 'filterState'; filters: GraphFilters };

/** Messages from graph sidebar webview -> extension host */
export type GraphToExtensionMessage =
  | { type: 'ready' }
  | { type: 'openFile'; relativePath: string }
  | { type: 'openFullGraph' }
  | { type: 'filterChanged'; filters: GraphFilters }
  | { type: 'requestRefresh' };

/** Messages from extension host -> full graph webview */
export type ExtensionToFullGraphMessage =
  | { type: 'graphData'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'activeFileChanged'; nodeId: string | null };

/** Messages from full graph webview -> extension host */
export type FullGraphToExtensionMessage =
  | { type: 'ready' }
  | { type: 'openFile'; relativePath: string }
  | { type: 'filterChanged'; filters: GraphFilters }
  | { type: 'requestRefresh' };

// ========================================
// Mermaid Diagram Editor Types
// ========================================

/** Messages from extension host -> mermaid editor webview */
export type MermaidEditorToWebviewMessage =
  | { type: 'update'; text: string }
  | { type: 'editAck' }
  /** Result of the export-theme QuickPick; the webview then rasterizes. */
  | { type: 'exportPngTheme'; theme: 'light' | 'dark' };

/** Messages from mermaid editor webview -> extension host */
export type MermaidWebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  /** Asks the host to prompt for an image theme before rasterizing. */
  | { type: 'requestPngExport' }
  /** Rasterized diagram, base64-encoded PNG, for the host to save to disk. */
  | { type: 'exportPng'; base64: string }
  | { type: 'exportError'; message: string }
  /** Toolbar brand button — show the About dialog. */
  | { type: 'showAbout' }
  /**
   * Serialized SVG to print. The host writes it to a standalone HTML file and
   * opens it externally — window.print() is suppressed inside VS Code's
   * sandboxed webview iframes, so printing cannot be done in the webview.
   */
  | { type: 'print'; svg: string };

// ========================================
// Extension Configuration
// ========================================

export interface LanguageToolConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  username: string;
  language: string;
  motherTongue: string;
  checkDelayMs: number;
}
