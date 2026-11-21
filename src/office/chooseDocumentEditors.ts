import * as vscode from 'vscode';
import {
  availableTypes, buildChoiceItems, buildTypeItems, nextAssociations, workspaceOverrides,
  type Associations,
} from './editorAssociations.js';

export const CHOOSE_DOCUMENT_EDITORS_COMMAND = 'vscodeMdEditor.chooseDocumentEditors';

/** viewTypes from this extension's package.json `contributes.customEditors`. */
export function contributedViewTypes(packageJSON: unknown): string[] {
  const eds = (packageJSON as { contributes?: { customEditors?: Array<{ viewType?: string }> } })?.contributes?.customEditors ?? [];
  return eds.map((e) => e.viewType).filter((v): v is string => typeof v === 'string');
}

export async function chooseDocumentEditors(packageJSON: unknown): Promise<void> {
  const types = availableTypes(contributedViewTypes(packageJSON));
  if (types.length === 0) return;
  const cfg = vscode.workspace.getConfiguration('workbench');
  const info = cfg.inspect<Associations>('editorAssociations');
  const effective: Associations = {
    ...(info?.globalValue ?? {}), ...(info?.workspaceValue ?? {}), ...(info?.workspaceFolderValue ?? {}),
  };

  const typeItem = await vscode.window.showQuickPick(buildTypeItems(types, effective), {
    title: 'Choose Editors for Office and PDF Files',
    placeHolder: 'Which file type?',
  });
  if (!typeItem) return;
  const choiceItem = await vscode.window.showQuickPick(buildChoiceItems(typeItem.def), {
    title: `Editor for ${typeItem.def.pattern}`,
    placeHolder: 'Which editor should open these files?',
  });
  if (!choiceItem) return;

  const next = nextAssociations(info?.globalValue, typeItem.def, choiceItem.choice);
  try {
    await cfg.update('editorAssociations', next, vscode.ConfigurationTarget.Global);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not update workbench.editorAssociations: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  void vscode.window.showInformationMessage(`${typeItem.def.pattern} files: "${choiceItem.label}". This applies to files opened from now on.`);
  if (workspaceOverrides(typeItem.def, info?.workspaceValue, info?.workspaceFolderValue)) {
    void vscode.window.showInformationMessage(
      `This workspace's settings also set an editor for ${typeItem.def.pattern} and take priority over your user setting here.`,
    );
  }
}
