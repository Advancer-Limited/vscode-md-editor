import * as vscode from 'vscode';

/**
 * Show the extension's About dialog (product, version, author).
 *
 * Kept out of utils.ts deliberately: that module is imported directly by the
 * Node test runner and must stay free of the `vscode` import.
 */
export async function showAboutDialog(context: vscode.ExtensionContext): Promise<void> {
  const pkg = context.extension.packageJSON as Record<string, any>;
  const author =
    (typeof pkg.author === 'object' ? pkg.author?.name : pkg.author) ?? 'Advancer Limited';

  await vscode.window.showInformationMessage(pkg.displayName ?? pkg.name, {
    modal: true,
    detail:
      `Version ${pkg.version}\n` +
      `By ${author}\n\n` +
      `${pkg.description ?? ''}`,
  });
}
