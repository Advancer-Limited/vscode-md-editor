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

/** Messages from extension host -> editor webview */
export type ExtensionToWebviewMessage =
  | { type: 'update'; text: string }
  | { type: 'setTheme'; theme: 'light' | 'dark' | 'auto' }
  | { type: 'wikilinkSuggestions'; suggestions: WikilinkSuggestion[] };

/** Messages from editor webview -> extension host */
export type WebviewToExtensionMessage =
  | { type: 'edit'; text: string }
  | { type: 'ready' }
  | { type: 'requestGrammarCheck' }
  | { type: 'requestWikilinkSuggestions'; prefix: string }
  | { type: 'openWikilink'; target: string };

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

/** Messages from extension host -> graph webview */
export type ExtensionToGraphMessage =
  | { type: 'graphData'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'activeFileChanged'; nodeId: string | null }
  | { type: 'filterState'; filters: GraphFilters };

/** Messages from graph webview -> extension host */
export type GraphToExtensionMessage =
  | { type: 'ready' }
  | { type: 'openFile'; relativePath: string }
  | { type: 'filterChanged'; filters: GraphFilters }
  | { type: 'requestRefresh' };

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
