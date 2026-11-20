// Save pipeline steps 3–4 (spec §6.5): serialise, then verify the produced bytes in memory before a
// single byte is written. Verification never trusts the writer:
//
// 1. Re-read the bytes with the container reader (same limits as open).
// 2. Inflate and CRC-check every entry.
// 3. The entry set is exactly the package's part set; every changed part's entry inflates to the
//    package's current bytes for it; every unchanged part's entry has its original CRC and sizes (G3).
// 4. Re-open the bytes as an OfficePackage (load classification must still accept them) and re-parse
//    every changed XML part with the lossless parser (and check serialize(parse(text)) === text, G2).
// 5. Run `packageValidator` (always) and the caller's format validators on the re-opened package.
//
// Any failure returns `ok: false` with the failures and NO bytes. A validator that throws is a failure.
//
// No `vscode` import here (core rule).

import { OfficePackage, zipLimits } from './package.js';
import { OfficeLoadError } from './sniff.js';
import { LIMITS } from './limits.js';
import { ZipError, crc32, inflateEntry, inflateEntryAsync, readZip } from './zip.js';
import type { ZipArchive, ZipEntry } from './zip.js';
import { XmlError, decodePart, parseXml, serialize as serializeXml } from './xml.js';
import {
  CONTENT_TYPES_PART, NS_CONTENT_TYPES, contentTypeOf, normalizePartName, partNameFromTarget,
  readRelationships, sourcePartOfRels,
} from './opc.js';
import { attr, childrenOf } from './xml.js';

/** Context passed to validators by serializeAndVerify. */
export interface ValidatorContext {
  /**
   * The package as it was loaded (opened from `originalBytes`, lazily, once), or undefined if it
   * cannot be opened. Lets a validator ignore problems the file already had before this session.
   */
  original(): OfficePackage | undefined;
}

/**
 * A format validator: messages for every problem found ([] = ok). `pkg` is the re-opened output;
 * `touched` the parts changed since load (deleted parts included). Prefix a message with
 * `<part name>: ` to attribute it to a part.
 */
export type Validator = ((pkg: OfficePackage, touched: string[], ctx?: ValidatorContext) => string[]) & {
  /**
   * The same checks with the same messages, yielding to the event loop while it works (§10.2). Used
   * by `verifyBytesAsync` when present; the validator itself is called otherwise.
   */
  readonly async?: (pkg: OfficePackage, touched: string[], ctx?: ValidatorContext) => Promise<string[]>;
};
export interface VerifyFailure { part?: string; message: string; }

export type VerifyResult = { ok: true; bytes: Uint8Array } | { ok: false; failures: VerifyFailure[] };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const lower = (s: string): string => normalizePartName(s).toLowerCase();

/** Parts we parse as XML: by content type (…+xml, …/xml) or, failing that, by extension. */
function isXmlPart(pkg: OfficePackage, part: string): boolean {
  let ct: string | undefined;
  try { ct = contentTypeOf(pkg, part); } catch { ct = undefined; }
  if (ct !== undefined) {
    const c = ct.toLowerCase().split(';')[0].trim();
    if (c.endsWith('+xml') || c.endsWith('/xml')) return true;
  }
  return /\.(xml|rels|vml)$/i.test(part);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Attribute "<part>: message" to that part when the prefix names a known part. */
function toFailure(message: string, known: ReadonlySet<string>): VerifyFailure {
  const i = message.indexOf(': ');
  if (i > 0 && known.has(lower(message.slice(0, i)))) return { part: normalizePartName(message.slice(0, i)), message };
  return { message };
}

/**
 * Serialise `pkg` and verify the result (spec §6.5 step 4). On success `bytes` is what to write; for
 * a package with nothing changed it is `pkg.originalBytes` itself (G0). `hooks.corrupt` (tests and the
 * verification-failure path of the manual checklist) receives a copy of the serialised bytes and
 * returns what is verified instead.
 */
export function serializeAndVerify(pkg: OfficePackage, validators: Validator[], hooks?: { corrupt?(bytes: Uint8Array): Uint8Array }): VerifyResult {
  let bytes: Uint8Array;
  try {
    bytes = pkg.serialize();
  } catch (e) {
    return { ok: false, failures: [{ message: `Serialisation failed: ${errText(e)}` }] };
  }
  if (hooks?.corrupt) bytes = hooks.corrupt(bytes.slice());
  const failures = verifyBytes(pkg, bytes, validators);
  return failures.length > 0 ? { ok: false, failures } : { ok: true, bytes };
}

/** All verification failures of `bytes` as the serialisation of `pkg` ([] = ok). Exported for tests. */
export function verifyBytes(pkg: OfficePackage, bytes: Uint8Array, validators: Validator[]): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  const touched = pkg.touchedParts();
  const touchedSet = new Set(touched.map(lower));
  const expected = new Map(pkg.partNames().map((n) => [lower(n), n] as const));

  // 1. Container.
  let zip: ZipArchive;
  try {
    zip = readZip(bytes, zipLimits());
  } catch (e) {
    return [{ message: `Output is not a readable ZIP: ${e instanceof ZipError ? `${e.code}: ${e.message}` : errText(e)}` }];
  }

  // Original entries, for the G3 check of unchanged parts.
  let originalEntries: Map<string, ZipEntry> | undefined;
  try {
    originalEntries = new Map(readZip(pkg.originalBytes, zipLimits()).entries.map((e) => [lower(e.name), e] as const));
  } catch {
    originalEntries = undefined;   // the original loaded, so this cannot happen; the other checks still run
  }

  // 2–3. Every entry: inflate + CRC, set equality, content of changed parts, metadata of unchanged ones.
  const seen = new Set<string>();
  for (const e of zip.entries) {
    const key = lower(e.name);
    seen.add(key);
    let data: Uint8Array;
    try {
      data = inflateEntry(zip, e);
    } catch (err) {
      failures.push({ part: e.name, message: `${e.name}: entry does not inflate: ${err instanceof ZipError ? `${err.code}: ${err.message}` : errText(err)}` });
      continue;
    }
    if (crc32(data) !== e.crc32) failures.push({ part: e.name, message: `${e.name}: CRC-32 mismatch` });
    if (e.name.endsWith('/')) continue;   // directory entries are copied, not parts
    const name = expected.get(key);
    if (name === undefined) { failures.push({ part: e.name, message: `${e.name}: unexpected entry in the output` }); continue; }
    if (name !== e.name) failures.push({ part: e.name, message: `${e.name}: entry name case differs from part ${name}` });
    if (touchedSet.has(key)) {
      let want: Uint8Array;
      try { want = pkg.bytes(name); } catch (err) { failures.push({ part: name, message: `${name}: cannot read the part: ${errText(err)}` }); continue; }
      if (!sameBytes(data, want)) failures.push({ part: name, message: `${name}: entry content differs from the edited part` });
    } else if (originalEntries) {
      const o = originalEntries.get(key);
      if (!o) failures.push({ part: name, message: `${name}: unchanged part has no original entry` });
      else if (o.crc32 !== e.crc32 || o.compressedSize !== e.compressedSize || o.uncompressedSize !== e.uncompressedSize || o.method !== e.method) {
        failures.push({ part: name, message: `${name}: unchanged part's entry differs from the original` });
      }
    }
  }
  for (const [key, name] of expected) {
    if (!seen.has(key)) failures.push({ part: name, message: `${name}: part is missing from the output` });
  }
  if (failures.length > 0) return failures;

  // 4. Re-open and re-parse changed XML parts.
  let reopened: OfficePackage;
  try {
    reopened = OfficePackage.open(`verify.${pkg.kind}`, bytes);
  } catch (e) {
    return [{ message: `Output does not re-open: ${e instanceof OfficeLoadError ? `${e.failure}: ${e.detail}` : errText(e)}` }];
  }
  if (reopened.kind !== pkg.kind) return [{ message: `Output re-opens as ${reopened.kind}, not ${pkg.kind}` }];
  for (const part of touched) {
    if (!reopened.has(part) || !isXmlPart(reopened, part)) continue;
    try {
      const text = decodePart(reopened.bytes(part)).text;
      const doc = parseXml(text);
      if (serializeXml(doc) !== text) failures.push({ part, message: `${part}: does not round-trip through the XML parser` });
    } catch (e) {
      failures.push({ part, message: `${part}: not well-formed XML: ${e instanceof XmlError ? `${e.code}: ${e.message}` : errText(e)}` });
    }
  }
  if (failures.length > 0) return failures;

  // 5. Validators (packageValidator always, once).
  let original: OfficePackage | undefined | null = null;
  const ctx: ValidatorContext = {
    original: () => {
      if (original === null) {
        try { original = OfficePackage.open(`original.${pkg.kind}`, pkg.originalBytes); } catch { original = undefined; }
      }
      return original;
    },
  };
  const known = new Set([...reopened.partNames().map(lower), ...touchedSet]);
  const all = [packageValidator, ...validators.filter((v) => v !== packageValidator)];
  for (const v of all) {
    let messages: string[];
    try {
      messages = v(reopened, touched.slice(), ctx);
    } catch (e) {
      failures.push({ message: `Validator ${v.name || '(anonymous)'} threw: ${errText(e)}` });
      continue;
    }
    if (!Array.isArray(messages)) { failures.push({ message: `Validator ${v.name || '(anonymous)'} returned no message list` }); continue; }
    for (const m of messages) failures.push(toFailure(String(m), known));
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------
// Async variants (spec §6.5 step 4 "in stages with a yield to the event loop between them", §10.2)

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * As `serializeAndVerify` (same result for the same package), with `OfficePackage.serializeAsync` and
 * `verifyBytesAsync`: no single synchronous block covers a whole stage of a large part. The package
 * must not change until it resolves (it is compared with the output); a save holds edits off for that.
 */
export async function serializeAndVerifyAsync(pkg: OfficePackage, validators: Validator[], hooks?: { corrupt?(bytes: Uint8Array): Uint8Array }): Promise<VerifyResult> {
  let bytes: Uint8Array;
  try {
    bytes = await pkg.serializeAsync();
  } catch (e) {
    return { ok: false, failures: [{ message: `Serialisation failed: ${errText(e)}` }] };
  }
  if (hooks?.corrupt) bytes = hooks.corrupt(bytes.slice());
  await yieldToEventLoop();
  const failures = await verifyBytesAsync(pkg, bytes, validators);
  return failures.length > 0 ? { ok: false, failures } : { ok: true, bytes };
}

/**
 * As `verifyBytes` (the same failures, in the same order), yielding between entries and stages,
 * inflating and CRC-checking large entries with `inflateEntryAsync`, re-parsing large parts with the
 * async parser and running each validator's `async` variant when it has one.
 */
export async function verifyBytesAsync(pkg: OfficePackage, bytes: Uint8Array, validators: Validator[]): Promise<VerifyFailure[]> {
  const yieldMs = LIMITS.parseYieldMs;
  const failures: VerifyFailure[] = [];
  const touched = pkg.touchedParts();
  const touchedSet = new Set(touched.map(lower));
  const expected = new Map(pkg.partNames().map((n) => [lower(n), n] as const));

  // 1. Container.
  let zip: ZipArchive;
  try {
    zip = readZip(bytes, zipLimits());
  } catch (e) {
    return [{ message: `Output is not a readable ZIP: ${e instanceof ZipError ? `${e.code}: ${e.message}` : errText(e)}` }];
  }
  let originalEntries: Map<string, ZipEntry> | undefined;
  try {
    originalEntries = new Map(readZip(pkg.originalBytes, zipLimits()).entries.map((e) => [lower(e.name), e] as const));
  } catch {
    originalEntries = undefined;
  }
  await yieldToEventLoop();

  // 2–3. Every entry. The inflated data of changed parts is kept for the re-parse below.
  const inflated = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let deadline = Date.now() + yieldMs;
  for (const e of zip.entries) {
    if (Date.now() >= deadline) { await yieldToEventLoop(); deadline = Date.now() + yieldMs; }
    const key = lower(e.name);
    seen.add(key);
    const large = e.uncompressedSize > LIMITS.asyncParseThresholdBytes;
    let data: Uint8Array;
    try {
      if (large) {
        // Checks the CRC-32 itself: a mismatch is reported as the sync path's `inflateEntry` does.
        data = await inflateEntryAsync(zip, e, yieldMs);
      } else {
        data = inflateEntry(zip, e);
      }
    } catch (err) {
      failures.push({ part: e.name, message: `${e.name}: entry does not inflate: ${err instanceof ZipError ? `${err.code}: ${err.message}` : errText(err)}` });
      continue;
    }
    if (!large && crc32(data) !== e.crc32) failures.push({ part: e.name, message: `${e.name}: CRC-32 mismatch` });
    if (e.name.endsWith('/')) continue;
    const name = expected.get(key);
    if (name === undefined) { failures.push({ part: e.name, message: `${e.name}: unexpected entry in the output` }); continue; }
    if (name !== e.name) failures.push({ part: e.name, message: `${e.name}: entry name case differs from part ${name}` });
    if (touchedSet.has(key)) {
      let want: Uint8Array;
      try { want = pkg.bytes(name); } catch (err) { failures.push({ part: name, message: `${name}: cannot read the part: ${errText(err)}` }); continue; }
      if (!sameBytes(data, want)) failures.push({ part: name, message: `${name}: entry content differs from the edited part` });
      else inflated.set(key, data);
      if (large) { await yieldToEventLoop(); deadline = Date.now() + yieldMs; }
    } else if (originalEntries) {
      const o = originalEntries.get(key);
      if (!o) failures.push({ part: name, message: `${name}: unchanged part has no original entry` });
      else if (o.crc32 !== e.crc32 || o.compressedSize !== e.compressedSize || o.uncompressedSize !== e.uncompressedSize || o.method !== e.method) {
        failures.push({ part: name, message: `${name}: unchanged part's entry differs from the original` });
      }
    }
  }
  for (const [key, name] of expected) {
    if (!seen.has(key)) failures.push({ part: name, message: `${name}: part is missing from the output` });
  }
  if (failures.length > 0) return failures;
  await yieldToEventLoop();

  // 4. Re-open and re-parse changed XML parts. The tree parsed here is the re-opened package's own
  // (xmlAsync caches it), so the validators do not parse the part again.
  let reopened: OfficePackage;
  try {
    reopened = OfficePackage.open(`verify.${pkg.kind}`, bytes);
  } catch (e) {
    return [{ message: `Output does not re-open: ${e instanceof OfficeLoadError ? `${e.failure}: ${e.detail}` : errText(e)}` }];
  }
  if (reopened.kind !== pkg.kind) return [{ message: `Output re-opens as ${reopened.kind}, not ${pkg.kind}` }];
  for (const part of touched) {
    if (!reopened.has(part) || !isXmlPart(reopened, part)) continue;
    await yieldToEventLoop();
    try {
      const data = inflated.get(lower(part)) ?? reopened.bytes(part);
      const text = decodePart(data).text;
      const doc = data.length > LIMITS.asyncParseThresholdBytes ? await reopened.xmlAsync(part) : parseXml(text);
      if (serializeXml(doc) !== text) failures.push({ part, message: `${part}: does not round-trip through the XML parser` });
    } catch (e) {
      failures.push({ part, message: `${part}: not well-formed XML: ${e instanceof XmlError ? `${e.code}: ${e.message}` : errText(e)}` });
    }
  }
  if (failures.length > 0) return failures;

  // 5. Validators (packageValidator always, once), one at a time with a yield before each.
  let original: OfficePackage | undefined | null = null;
  const ctx: ValidatorContext = {
    original: () => {
      if (original === null) {
        try { original = OfficePackage.open(`original.${pkg.kind}`, pkg.originalBytes); } catch { original = undefined; }
      }
      return original;
    },
  };
  const known = new Set([...reopened.partNames().map(lower), ...touchedSet]);
  const all = [packageValidator, ...validators.filter((v) => v !== packageValidator)];
  for (const v of all) {
    await yieldToEventLoop();
    let messages: string[];
    try {
      messages = v.async ? await v.async(reopened, touched.slice(), ctx) : v(reopened, touched.slice(), ctx);
    } catch (e) {
      failures.push({ message: `Validator ${v.name || '(anonymous)'} threw: ${errText(e)}` });
      continue;
    }
    if (!Array.isArray(messages)) { failures.push({ message: `Validator ${v.name || '(anonymous)'} returned no message list` }); continue; }
    for (const m of messages) failures.push(toFailure(String(m), known));
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------
// packageValidator (spec §13.3 "Both")

interface Problem { key: string; message: string; }

const isRelsPart = (name: string): boolean => sourcePartOfRels(name) !== undefined;

/** Package-level problems of `p`. `created` (lower-case names) enables the orphan check for new parts. */
function packageProblems(p: OfficePackage, created: ReadonlySet<string> | undefined): Problem[] {
  const out: Problem[] = [];
  // Content-type overrides resolve to existing parts.
  if (p.has(CONTENT_TYPES_PART)) {
    let root;
    try { root = p.xml(CONTENT_TYPES_PART).root; } catch (e) { root = undefined; out.push({ key: 'ct-malformed', message: `${CONTENT_TYPES_PART}: ${errText(e)}` }); }
    if (root) {
      for (const el of childrenOf(root, NS_CONTENT_TYPES, 'Override')) {
        const name = attr(el, '', 'PartName');
        if (name === undefined) { out.push({ key: 'override-noname', message: `${CONTENT_TYPES_PART}: an Override has no PartName` }); continue; }
        if (!p.has(name)) out.push({ key: `override:${lower(name)}`, message: `${CONTENT_TYPES_PART}: Override for ${name} names a part that does not exist` });
      }
    }
  } else {
    out.push({ key: 'ct-missing', message: `${CONTENT_TYPES_PART} is missing` });
  }
  // Relationship parts: source exists; internal targets resolve to existing parts.
  const referenced = new Set<string>();
  for (const relsPart of p.partNames()) {
    const source = sourcePartOfRels(relsPart);
    if (source === undefined) continue;
    if (source !== '' && !p.has(source)) out.push({ key: `orphan-rels:${lower(relsPart)}`, message: `${relsPart}: relationships of a part that does not exist (${source})` });
    let rels;
    try { rels = readRelationships(p, source); } catch (e) { out.push({ key: `rels-malformed:${lower(relsPart)}`, message: `${relsPart}: ${errText(e)}` }); continue; }
    for (const r of rels) {
      if (r.external) continue;
      let target: string;
      try {
        target = partNameFromTarget(source, r.target);
      } catch (e) {
        out.push({ key: `rel-bad:${lower(relsPart)}:${r.id}`, message: `${relsPart}: relationship ${r.id} target "${r.target}" is invalid: ${errText(e)}` });
        continue;
      }
      referenced.add(target.toLowerCase());
      if (!p.has(target)) out.push({ key: `rel:${lower(relsPart)}:${r.id}:${target.toLowerCase()}`, message: `${relsPart}: relationship ${r.id} targets ${target}, which does not exist` });
    }
  }
  // Parts created by the operation: reachable through a relationship and with a content type.
  if (created) {
    for (const name of p.partNames()) {
      const key = lower(name);
      if (!created.has(key) || key === lower(CONTENT_TYPES_PART)) continue;
      if (!isRelsPart(name) && !referenced.has(key)) out.push({ key: `orphan:${key}`, message: `${name}: created part is not the target of any relationship` });
      let ct: string | undefined;
      try { ct = contentTypeOf(p, name); } catch { ct = undefined; }
      if (ct === undefined) out.push({ key: `no-ct:${key}`, message: `${name}: created part has no content type` });
    }
  }
  return out;
}

/**
 * Content-type overrides and internal relationship targets resolve to existing parts, every
 * relationships part belongs to an existing part, and no part created by an operation is orphaned
 * (unreachable through relationships, or without a content type). With a ValidatorContext, problems
 * the original package already had are not reported (a file that arrived with a dangling
 * relationship can still be saved; an edit cannot add one).
 */
export const packageValidator: Validator = function packageValidator(pkg, touched, ctx) {
  const original = ctx?.original();
  let created: Set<string> | undefined;
  if (original) {
    created = new Set();
    for (const t of touched) if (pkg.has(t) && !original.has(t)) created.add(lower(t));
  }
  let problems = packageProblems(pkg, created);
  if (problems.length > 0 && original) {
    const before = new Set(packageProblems(original, undefined).map((q) => q.key));
    problems = problems.filter((q) => !before.has(q.key));
  }
  return problems.map((q) => q.message);
};
