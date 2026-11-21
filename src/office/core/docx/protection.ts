// WP-31: document protection and tracked-changes detection (spec §8.7). Reads `word/settings.xml`
// (found through the main part's relationships, never by path); never writes; never throws: a missing,
// unparsable or foreign settings part answers "no restriction".
//
//   w:documentProtection with enforcement on, or w:writeProtection -> 'protected' (no override)
//   w:trackRevisions on                                            -> 'tracked-changes-on' (overridable)
//
// Protection wins when both are present. `w:documentProtection` whose `w:enforcement` is absent or off
// is a stored but inactive protection and does not restrict. `w:writeProtection` counts whenever it is
// present, as the spec says (including a "recommended only" one: the conservative reading).
//
// No `vscode` import here (core rule).

import type { OfficePackage } from '../package.js';
import type { ReadOnlyReason } from '../types.js';
import { attr, child } from '../xml.js';
import type { XmlElement } from '../xml.js';
import { mainPart } from '../opc.js';
import { relatedPart, onOff, W_NS } from './styles.js';

export interface ProtectionResult {
  readOnlyReason: Extract<ReadOnlyReason, 'protected' | 'tracked-changes-on'> | null;
}

function isOn(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'on';
}

/** The settings root of a docx package, or null when there is none or it cannot be read. */
function settingsRoot(pkg: OfficePackage): XmlElement | null {
  try {
    const main = mainPart(pkg).name;
    const part = relatedPart(pkg, main, 'settings');
    if (!part) return null;
    const root = pkg.xml(part).root;
    return root.ns === W_NS && root.local === 'settings' ? root : null;
  } catch {
    return null;
  }
}

/** Why a docx must not be edited (or only after an override) because of its own settings, or null. */
export function detectProtection(pkg: OfficePackage): ProtectionResult {
  const root = settingsRoot(pkg);
  if (!root) return { readOnlyReason: null };
  if (child(root, W_NS, 'writeProtection')) return { readOnlyReason: 'protected' };
  const dp = child(root, W_NS, 'documentProtection');
  if (dp && isOn(attr(dp, W_NS, 'enforcement'))) return { readOnlyReason: 'protected' };
  const tr = child(root, W_NS, 'trackRevisions');
  if (tr && onOff(tr)) return { readOnlyReason: 'tracked-changes-on' };
  return { readOnlyReason: null };
}
