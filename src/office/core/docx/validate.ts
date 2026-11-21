// WP-31: docx format validators (spec §13.3 "Docx"), run on the re-opened output of every save and
// backup (§6.5 step 4) after core/save.ts `packageValidator`.
//
// Rules (messages are prefixed with the part they concern):
//   order      w:pPr and w:rPr children (every WordprocessingML part, whatever the parent: a paragraph,
//              style, numbering level, run or paragraph mark) appear in schema order, none repeated
//   numbering  every w:numPr/w:numId resolves to a w:num (0 = "no list" is legal), every w:num to a
//              w:abstractNum, every w:abstractNum precedes the first w:num
//   styles     every w:pStyle / w:rStyle id exists in styles.xml
//   ranges     bookmarkStart/End and commentRangeStart/End balance, ids unique per start
//   markers    no bookmark named `__vsmd_...` (the render copy's marker, §8.2) in a saved part; one with
//              the same name the loaded file already had is forgiven like any other problem (review N5:
//              otherwise such a file could never be saved; a leaked render marker still has a new name)
//   paraId     w14:paraId values unique within a part
//   cells      every w:tc ends with a w:p
//   tables     the table census (model.census: w:tbl/w:tr/w:tc counts and the text of every
//              tblPr/tblGrid/trPr/tcPr) equals the census of the package as loaded
//
// Scope: the main part always, plus every other WordprocessingML part in `touched` (styles and
// numbering are also scanned when either is touched, because their cross-references move together).
// A problem the loaded package (ctx.original()) already had is not reported. Forgiveness is by
// identity, not by count (review S1): a problem is forgiven when the original had a problem of the
// same part, rule and detail (the message without its part prefix: the style id, the numId, the order
// signature "w:b comes after w:i", the bookmark id, ...). Splitting a paragraph copies its pPr/rPr, so
// a pre-existing problem can appear twice after an edit; it is still the same problem. A problem with
// a new detail is reported. Without a context every problem is reported and the census rule is skipped
// (there is nothing to compare with).
//
// The validator reads the XML trees directly and shares no code with the writers it checks other than
// the lossless parser and `census`. No `vscode` import here (core rule).

import type { Validator, ValidatorContext } from '../save.js';
import { LIMITS } from '../limits.js';
import type { OfficePackage } from '../package.js';
import { attr, childrenOf } from '../xml.js';
import type { XmlElement, XmlNode } from '../xml.js';
import { contentTypeOf, mainPart, normalizePartName } from '../opc.js';
import { census } from './model.js';
import { relatedPart, W_NS } from './styles.js';

const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
const MARKER_PREFIX = '__vsmd_';

const lower = (s: string): string => normalizePartName(s).toLowerCase();
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------------------------------
// Schema order (ECMA-376 Part 1 §17.3.1.26 CT_PPr, §17.3.2.28 CT_RPr / CT_ParaRPr)

function ranks(names: string): Map<string, number> {
  return new Map(names.split(/\s+/).filter(Boolean).map((n, i) => [n, i] as const));
}

const PPR_RANK = ranks(`pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers
  pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi
  adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection
  textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange`);

const RPR_RANK = ranks(`ins del moveFrom moveTo rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline
  shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u
  effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange`);

// ---------------------------------------------------------------------------------------------------
// Stepping (same scheme as the xlsx validator): rules are generators so one body serves the
// synchronous validator and `.async`, which yields to the event loop (§10.2).

const TICK = 0;
interface Need { pkg: OfficePackage; part: string }
type Step = typeof TICK | Need;
type Steps<T> = Generator<Step, T, void>;
const TICK_NODES = 4000;

function runSync<T>(g: Steps<T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

async function runAsync<T>(g: Steps<T>, yieldEveryMs: number): Promise<T> {
  let deadline = Date.now() + yieldEveryMs;
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (r.value !== TICK) {
      const { pkg, part } = r.value;
      if (pkg.has(part)) await pkg.xmlAsync(part).catch(() => undefined);   // errors surface from the generator's own pkg.xml
      deadline = Date.now() + yieldEveryMs;
    } else if (Date.now() >= deadline) {
      await yieldToEventLoop();
      deadline = Date.now() + yieldEveryMs;
    }
  }
}

// ---------------------------------------------------------------------------------------------------

/** One problem. Part + rule + detail are its identity (compared with the original's problems). */
interface Problem { rule: string; part: string; message: string; detail: string }

function problem(rule: string, part: string, detail: string): Problem {
  return { rule, part, detail, message: `${part}: ${detail}` };
}
const identity = (p: Problem): string => `${lower(p.part)}|${p.rule}|${p.detail}`;

/** Rules never forgiven because the loaded package had them. */
const UNFORGIVEN = new Set(['census']);

const WML_CT = /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.[a-z.]+\+xml$/;

function isWmlPart(pkg: OfficePackage, part: string): boolean {
  let ct: string | undefined;
  try { ct = contentTypeOf(pkg, part); } catch { ct = undefined; }
  return ct !== undefined && WML_CT.test(ct.toLowerCase().split(';')[0].trim());
}

interface NumberingFacts {
  part: string;
  nums: Map<number, number | null>;     // numId -> abstractNumId
  abstracts: Set<number>;
  problems: Problem[];
}

function intOf(v: string | undefined): number | null {
  if (v === undefined || !/^\s*-?\d+\s*$/.test(v)) return null;
  return parseInt(v, 10);
}

/** The numbering part's ids and its own structural problems, or null when the package has none / it is unusable. */
function numberingFacts(pkg: OfficePackage, main: string): NumberingFacts | null {
  const part = relatedPart(pkg, main, 'numbering');
  if (!part) return null;
  let root: XmlElement;
  try { root = pkg.xml(part).root; } catch { return null; }
  if (root.ns !== W_NS || root.local !== 'numbering') return null;
  const nums = new Map<number, number | null>();
  const abstracts = new Set<number>();
  const problems: Problem[] = [];
  const add = (rule: string, message: string): void => { problems.push(problem(rule, part, message)); };
  let sawNum = false;
  for (const c of root.children) {
    if (c.type !== 'el' || c.ns !== W_NS) continue;
    if (c.local === 'abstractNum') {
      if (sawNum) add('numbering-order', 'w:abstractNum appears after a w:num (abstractNums must precede nums)');
      const id = intOf(attr(c, W_NS, 'abstractNumId'));
      if (id !== null) abstracts.add(id);
    } else if (c.local === 'num') {
      sawNum = true;
      const id = intOf(attr(c, W_NS, 'numId'));
      const a = childrenOf(c, W_NS, 'abstractNumId')[0];
      const aid = a ? intOf(attr(a, W_NS, 'val')) : null;
      if (id !== null) nums.set(id, aid);
    }
  }
  for (const [id, aid] of nums) {
    if (aid === null || !abstracts.has(aid)) add('numbering-abstract', `w:num ${id} refers to ${aid === null ? 'no w:abstractNumId' : `missing w:abstractNum ${aid}`}`);
  }
  return { part, nums, abstracts, problems };
}

/** Style ids of the styles part (empty when the package has none), or null when it is unusable (nothing to check against). */
function styleIds(pkg: OfficePackage, main: string): Set<string> | null {
  const part = relatedPart(pkg, main, 'styles');
  if (!part) return new Set();
  let root: XmlElement;
  try { root = pkg.xml(part).root; } catch { return null; }
  if (root.ns !== W_NS || root.local !== 'styles') return null;
  const ids = new Set<string>();
  for (const s of childrenOf(root, W_NS, 'style')) {
    const id = attr(s, W_NS, 'styleId');
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

interface Facts {
  styles: Set<string> | null;
  numbering: NumberingFacts | null;
}

function orderProblem(el: XmlElement, table: Map<string, number>): string | undefined {
  let last = -1;
  let lastName = '';
  for (const c of el.children) {
    if (c.type !== 'el' || c.ns !== W_NS) continue;
    const r = table.get(c.local);
    if (r === undefined) continue;       // unknown or extension element: not ours to order
    if (r === last) return `w:${c.local} is repeated`;
    if (r < last) return `w:${c.local} comes after w:${lastName}`;
    last = r;
    lastName = c.local;
  }
  return undefined;
}

/** Every per-part rule except the table census, for one part. */
function* scanPart(pkg: OfficePackage, part: string, facts: Facts): Steps<Problem[]> {
  const problems: Problem[] = [];
  yield { pkg, part };
  let root: XmlElement;
  try { root = pkg.xml(part).root; } catch (e) {
    return [problem('parse', part, `cannot be parsed (${errText(e)})`)];
  }
  const add = (rule: string, message: string): void => { problems.push(problem(rule, part, message)); };
  const isStyles = root.local === 'styles' && root.ns === W_NS;
  const isNumbering = root.local === 'numbering' && root.ns === W_NS;

  const bookmarkStarts = new Map<string, number>();
  const bookmarkEnds = new Map<string, number>();
  const commentStarts = new Map<string, number>();
  const commentEnds = new Map<string, number>();
  const paraIds = new Set<string>();
  const bump = (m: Map<string, number>, k: string): number => { const n = (m.get(k) ?? 0) + 1; m.set(k, n); return n; };

  let seen = 0;
  const stack: XmlNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type !== 'el') continue;
    if (++seen % TICK_NODES === 0) yield TICK;
    if (n.ns === W_NS) {
      switch (n.local) {
        case 'pPr': { const m = orderProblem(n, PPR_RANK); if (m) add('order', `w:pPr children out of schema order (${m})`); break; }
        case 'rPr': { const m = orderProblem(n, RPR_RANK); if (m) add('order', `w:rPr children out of schema order (${m})`); break; }
        case 'numId': {
          if (isNumbering || !n.parent || n.parent.local !== 'numPr' || n.parent.ns !== W_NS) break;
          const id = intOf(attr(n, W_NS, 'val'));
          if (id === null) add('numbering', 'w:numId has no integer w:val');
          else if (id !== 0 && !(facts.numbering && facts.numbering.nums.has(id))) add('numbering', `w:numId ${id} does not resolve to a w:num`);
          break;
        }
        case 'pStyle': case 'rStyle': {
          const want = n.local === 'pStyle' ? 'pPr' : 'rPr';
          if (isStyles || !n.parent || n.parent.local !== want || n.parent.ns !== W_NS || facts.styles === null) break;
          const id = attr(n, W_NS, 'val');
          if (id === undefined || !facts.styles.has(id)) add('styles', `w:${n.local} "${id ?? ''}" does not exist in styles.xml`);
          break;
        }
        case 'bookmarkStart': {
          const id = attr(n, W_NS, 'id');
          if (id === undefined) add('ranges', 'w:bookmarkStart has no w:id');
          else if (bump(bookmarkStarts, id) === 2) add('ranges', `w:bookmarkStart id ${id} is not unique`);
          const name = attr(n, W_NS, 'name');
          if (name !== undefined && name.startsWith(MARKER_PREFIX)) add('marker', `marker bookmark "${name}" is present`);
          break;
        }
        case 'bookmarkEnd': { const id = attr(n, W_NS, 'id'); if (id === undefined) add('ranges', 'w:bookmarkEnd has no w:id'); else bump(bookmarkEnds, id); break; }
        case 'commentRangeStart': {
          const id = attr(n, W_NS, 'id');
          if (id === undefined) add('ranges', 'w:commentRangeStart has no w:id');
          else if (bump(commentStarts, id) === 2) add('ranges', `w:commentRangeStart id ${id} is not unique`);
          break;
        }
        case 'commentRangeEnd': { const id = attr(n, W_NS, 'id'); if (id === undefined) add('ranges', 'w:commentRangeEnd has no w:id'); else bump(commentEnds, id); break; }
        case 'p': {
          const pid = attr(n, W14_NS, 'paraId');
          if (pid !== undefined) {
            const k = pid.toLowerCase();
            if (paraIds.has(k)) add('paraId', `w14:paraId ${pid} is not unique`); else paraIds.add(k);
          }
          break;
        }
        case 'tc': {
          let lastEl: XmlElement | undefined;
          for (let k = n.children.length - 1; k >= 0; k--) { const c = n.children[k]; if (c.type === 'el') { lastEl = c; break; } }
          if (!lastEl || lastEl.ns !== W_NS || lastEl.local !== 'p') add('cells', `w:tc ends with ${lastEl ? `w:${lastEl.local}` : 'nothing'} instead of w:p`);
          break;
        }
      }
    }
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }

  const balance = (what: string, starts: Map<string, number>, ends: Map<string, number>): void => {
    for (const id of starts.keys()) if (!ends.has(id)) add('ranges', `${what}Start id ${id} has no ${what}End`);
    for (const id of ends.keys()) if (!starts.has(id)) add('ranges', `${what}End id ${id} has no ${what}Start`);
  };
  balance('w:bookmark', bookmarkStarts, bookmarkEnds);
  balance('w:commentRange', commentStarts, commentEnds);
  return problems;
}

/** First difference between two table censuses, in words ('' when equal). */
function censusDiff(was: string, now: string): string {
  if (was === now) return '';
  const a = was.split('\n');
  const b = now.split('\n');
  if (a[0] !== b[0]) return `counts changed (${a[0]} -> ${b[0]})`;
  if (a.length !== b.length) return 'the number of table property elements changed';
  const tag = (s: string): string => /^<([^\s>/]+)/.exec(s)?.[1] ?? 'property';
  for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return `the text of table property element ${i} (${tag(a[i])}) changed`;
  return 'changed';
}

function factsOf(pkg: OfficePackage, main: string): Facts {
  return { styles: styleIds(pkg, main), numbering: numberingFacts(pkg, main) };
}

function* scanAll(pkg: OfficePackage, main: string, scope: ReadonlySet<string>): Steps<Problem[]> {
  const facts = factsOf(pkg, main);
  const out: Problem[] = [];
  const parts = [main];
  const stylesPart = relatedPart(pkg, main, 'styles');
  const numberingPart = relatedPart(pkg, main, 'numbering');
  const linked = new Set([stylesPart, numberingPart].filter((p): p is string => p !== null).map(lower));
  const crossRefsMoved = [...linked].some((p) => scope.has(p));
  for (const name of pkg.partNames()) {
    const key = lower(name);
    if (key === lower(main)) continue;
    if ((scope.has(key) || (crossRefsMoved && linked.has(key))) && isWmlPart(pkg, name)) parts.push(name);
  }
  for (const part of parts) out.push(...(yield* scanPart(pkg, part, facts)));
  if (facts.numbering && (scope.has(lower(facts.numbering.part)) || scope.has(lower(main)) || crossRefsMoved)) out.push(...facts.numbering.problems);
  return out;
}

function* docxChecks(pkg: OfficePackage, touched: string[], ctx: ValidatorContext | undefined): Steps<string[]> {
  if (pkg.kind !== 'docx') return [];
  let main: string;
  try { main = mainPart(pkg).name; } catch (e) { return [`Main part not found: ${errText(e)}`]; }
  const scope = new Set(touched.map(lower));
  let problems = yield* scanAll(pkg, main, scope);

  const original = ctx?.original();

  // Forgive what the loaded package already had (by identity: part, rule and detail; review S1).
  if (original && problems.some((p) => !UNFORGIVEN.has(p.rule))) {
    let omain: string | undefined;
    try { omain = mainPart(original).name; } catch { omain = undefined; }
    if (omain !== undefined) {
      const before = new Set<string>();
      for (const p of yield* scanAll(original, omain, scope)) before.add(identity(p));
      problems = problems.filter((p) => UNFORGIVEN.has(p.rule) || !before.has(identity(p)));
    }
  }
  const out = problems.map((p) => p.message);

  // Table structure is never edited: the census equals the loaded package's.
  if (original) {
    try {
      const omain = mainPart(original).name;
      yield { pkg: original, part: omain };
      const was = census(original.xml(omain).root);
      yield { pkg, part: main };
      const diff = censusDiff(was, census(pkg.xml(main).root));
      if (diff) out.push(`${main}: table structure or properties changed since load (${diff})`);
    } catch { /* the original (or the main part) is unreadable: packageValidator reports the latter */ }
  }
  return out;
}

/**
 * Every §13.3 docx rule. Messages are prefixed with the part they concern. See the header for scope and
 * the comparison with the loaded package.
 */
export const docxValidator: Validator = Object.assign(
  // A method, so the function's name stays "docxValidator" whatever a bundler renames.
  {
    docxValidator(pkg: OfficePackage, touched: string[], ctx?: ValidatorContext): string[] {
      return runSync(docxChecks(pkg, touched, ctx));
    },
  }.docxValidator,
  {
    /** The same checks and messages, yielding to the event loop while a large part is scanned (§10.2). */
    async: (pkg: OfficePackage, touched: string[], ctx?: ValidatorContext): Promise<string[]> =>
      runAsync(docxChecks(pkg, touched, ctx), LIMITS.parseYieldMs),
  },
);
