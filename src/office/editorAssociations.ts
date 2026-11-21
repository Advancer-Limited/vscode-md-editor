// Pure logic behind "Choose Editors for Office and PDF Files…" (no vscode import, unit-tested).
// A friendly front end to `workbench.editorAssociations`: pattern -> viewType | "default".

export interface DocumentTypeDef {
  pattern: string;
  viewType: string;
  /** Name of this extension's viewer, e.g. "Word Document Viewer". */
  label: string;
}

/** Later branches add rows. A row is offered only if its viewType is contributed (see availableTypes). */
export const DOCUMENT_TYPES: readonly DocumentTypeDef[] = [
  { pattern: '*.docx', viewType: 'vscodeMdEditor.docx', label: 'Word Document Viewer' },
  { pattern: '*.xlsx', viewType: 'vscodeMdEditor.xlsx', label: 'Excel Workbook Viewer' },
];

export type Associations = Record<string, string>;
export type Choice = 'extension' | 'default' | 'auto';

/** Only the rows whose custom editor really is registered in package.json. */
export function availableTypes(
  contributedViewTypes: readonly string[],
  table: readonly DocumentTypeDef[] = DOCUMENT_TYPES,
): DocumentTypeDef[] {
  const have = new Set(contributedViewTypes);
  return table.filter((t) => have.has(t.viewType));
}

/** Human description of what `value` (an association value, or undefined) means for a type. */
export function describeCurrent(def: DocumentTypeDef, value: string | undefined): string {
  if (value === undefined || value === '') return 'Automatic';
  if (value === def.viewType) return `This extension (${def.label})`;
  if (value === 'default') return "VS Code's default editor";
  return `Another editor (${value})`;
}

export interface TypeItem { label: string; description: string; def: DocumentTypeDef }

export function buildTypeItems(types: readonly DocumentTypeDef[], effective: Associations): TypeItem[] {
  return types.map((def) => ({
    label: def.pattern,
    description: `${def.label}: ${describeCurrent(def, effective[def.pattern])}`,
    def,
  }));
}

export interface ChoiceItem { label: string; detail: string; choice: Choice }

export function buildChoiceItems(def: DocumentTypeDef): ChoiceItem[] {
  return [
    { label: "Use this extension's viewer", detail: `Open ${def.pattern} files in the ${def.label}.`, choice: 'extension' },
    { label: "Use VS Code's default editor", detail: 'Open them with VS Code itself, or whichever extension claims them.', choice: 'default' },
    { label: 'Let VS Code decide (remove the setting)', detail: 'Removes the association; VS Code picks by priority.', choice: 'auto' },
  ];
}

/** New associations object: every other key preserved, input never mutated. */
export function nextAssociations(current: Associations | undefined, def: DocumentTypeDef, choice: Choice): Associations {
  const next: Associations = { ...(current ?? {}) };
  if (choice === 'extension') next[def.pattern] = def.viewType;
  else if (choice === 'default') next[def.pattern] = 'default';
  else delete next[def.pattern];
  return next;
}

/** True when a workspace-level value for the pattern would override what is written at user level. */
export function workspaceOverrides(
  def: DocumentTypeDef,
  workspaceValue: Associations | undefined,
  workspaceFolderValue?: Associations,
): boolean {
  return [workspaceValue, workspaceFolderValue].some((v) => !!v && Object.prototype.hasOwnProperty.call(v, def.pattern));
}
