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

/**
 * Keys of `assoc` that name `def`'s files: the exact pattern, or a case or glob variant of it
 * (`*.DOCX`, or the pattern behind a leading `**`-slash glob) written by hand (review N6). Exact key first.
 */
export function matchingKeys(def: DocumentTypeDef, assoc: Associations | undefined): string[] {
  if (!assoc) return [];
  const want = def.pattern.toLowerCase();
  const norm = (k: string): string => k.trim().toLowerCase().replace(/^(\*\*\/)+/, '');
  const keys = Object.keys(assoc).filter((k) => k === def.pattern || norm(k) === want);
  return keys.sort((a, b) => (a === def.pattern ? -1 : b === def.pattern ? 1 : 0));
}

/** The association in force for `def` (exact key, else a variant) and the key it comes from. */
export function currentAssociation(def: DocumentTypeDef, effective: Associations): { key: string; value: string } | undefined {
  const key = matchingKeys(def, effective)[0];
  return key === undefined ? undefined : { key, value: effective[key] };
}

export function buildTypeItems(types: readonly DocumentTypeDef[], effective: Associations): TypeItem[] {
  return types.map((def) => {
    const cur = currentAssociation(def, effective);
    const via = cur && cur.key !== def.pattern ? ` (set for ${cur.key})` : '';
    return { label: def.pattern, description: `${def.label}: ${describeCurrent(def, cur?.value)}${via}`, def };
  });
}

export interface ChoiceItem { label: string; detail: string; choice: Choice }

export function buildChoiceItems(def: DocumentTypeDef): ChoiceItem[] {
  return [
    { label: "Use this extension's viewer", detail: `Open ${def.pattern} files in the ${def.label}.`, choice: 'extension' },
    { label: "Use VS Code's default editor", detail: 'Open them with VS Code itself, or whichever extension claims them.', choice: 'default' },
    { label: 'Let VS Code decide (remove the setting)', detail: 'Removes the association; VS Code picks by priority.', choice: 'auto' },
  ];
}

/**
 * New user-level associations: every other key preserved, input never mutated; case/glob variants of
 * the pattern (matchingKeys) are replaced by the exact pattern so they cannot keep overriding the
 * choice. `undefined` when nothing is left, so the setting is removed rather than written as `{}`.
 */
export function nextAssociations(current: Associations | undefined, def: DocumentTypeDef, choice: Choice): Associations | undefined {
  const next: Associations = { ...(current ?? {}) };
  for (const k of matchingKeys(def, next)) delete next[k];
  if (choice === 'extension') next[def.pattern] = def.viewType;
  else if (choice === 'default') next[def.pattern] = 'default';
  return Object.keys(next).length === 0 ? undefined : next;
}

/** True when a workspace-level value for the pattern would override what is written at user level. */
export function workspaceOverrides(
  def: DocumentTypeDef,
  workspaceValue: Associations | undefined,
  workspaceFolderValue?: Associations,
): boolean {
  return [workspaceValue, workspaceFolderValue].some((v) => matchingKeys(def, v).length > 0);
}
