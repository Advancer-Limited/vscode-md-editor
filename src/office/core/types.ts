// Shared Office types, copied verbatim from spec §5. protocol.ts (WP-07) re-exports these.
export type ReadOnlyReason =
  | 'view-mode'            // not a restriction: Edit is simply off
  | 'non-writable-scheme'  // git:, readonly FS, etc.
  | 'too-large'            // §10.2
  | 'protected'            // document/sheet/workbook protection
  | 'strict-ooxml' | 'unsupported-xml-layout' | 'utf16-part'
  | 'tracked-changes-on';  // overridable, §8.7

export interface OfficeNotice { severity: 'info' | 'warning'; code: string; message: string; }

export interface OfficeError {
  code: 'stale' | 'read-only' | 'invalid' | 'blocked' | 'cancelled' | 'internal';
  message: string;          // user-presentable
}
