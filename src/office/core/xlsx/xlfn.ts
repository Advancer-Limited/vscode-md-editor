// `_xlfn.` future-function prefixes (spec §9.5 third bullet).
//
// Functions added to Excel after the 2007 file format are stored in `<f>` with a `_xlfn.` prefix
// (`_xlfn.XLOOKUP(…)`); FILTER, SORT and PY additionally carry `_xlws.` (`_xlfn._xlws.FILTER(…)`), and
// the parameter names of LET and LAMBDA carry `_xlpm.` (`_xlfn.LET(_xlpm.x,1,_xlpm.x+1)`). The editor
// shows and accepts formulas without any of these prefixes and adds them back on write:
//
//   stripXlfnPrefixes(fileText)  -> what the formula bar shows (every `_xlfn.`/`_xlws.` on a function
//                                   name and every `_xlpm.` on a name is removed)
//   addXlfnPrefixes(userText)    -> what is written to the file (canonical: known future functions get
//                                   their prefix and upper-case name; LET/LAMBDA parameters and their
//                                   uses get `_xlpm.`; everything else is preserved character for
//                                   character)
//
// `addXlfnPrefixes(stripXlfnPrefixes(f)) === f` for every formula Excel writes whose future functions
// are all in the list, which is what makes "open the cell editor, commit unchanged" a no-op. A
// function missing from the list is written bare and shows `#NAME?` in Excel until re-entered there;
// `learnedPrefixes` lets a caller keep the prefixes the cell already had for such functions.
//
// Source of FUTURE_FUNCTIONS: [MS-XLSX] §2.2.2.1 "Functions" (Microsoft Open Specifications, revision
// of 2024-04-16, https://learn.microsoft.com/openspecs/office_standards/ms-xlsx/5d1b6d44-6fc1-4ecd-8fef-0b27406cc2bf),
// copied verbatim, including the four names that list writes without a prefix (ECMA.CEILING,
// ISO.CEILING, NETWORKDAYS.INTL, WORKDAY.INTL: they are ISO/IEC 29500 functions and so are not
// listed here). SUPPLEMENTARY_FUNCTIONS are Excel 365 functions that the 2024 revision does not list
// but that Excel writes with `_xlfn.` (every function newer than the 2007 format is a future function).
//
// No `vscode` import here (core rule).

import { parse, tokenize } from '@borgar/fx/xlsx';

type Token = ReturnType<typeof tokenize>[number];

/** [MS-XLSX] future functions with `_xlfn.` (name without the prefix). */
const XLFN_FUNCTIONS = [
  'ACOT', 'ACOTH', 'AGGREGATE', 'ARABIC', 'BASE', 'BETA.DIST', 'BETA.INV', 'BINOM.DIST', 'BINOM.DIST.RANGE',
  'BINOM.INV', 'BITAND', 'BITLSHIFT', 'BITOR', 'BITRSHIFT', 'BITXOR', 'BYCOL', 'BYROW', 'CEILING.MATH',
  'CEILING.PRECISE', 'CHISQ.DIST', 'CHISQ.DIST.RT', 'CHISQ.INV', 'CHISQ.INV.RT', 'CHISQ.TEST', 'CHOOSECOLS',
  'CHOOSEROWS', 'COMBINA', 'CONCAT', 'CONFIDENCE.NORM', 'CONFIDENCE.T', 'COT', 'COTH', 'COVARIANCE.P',
  'COVARIANCE.S', 'CSC', 'CSCH', 'DAYS', 'DECIMAL', 'DROP', 'ERF.PRECISE', 'ERFC.PRECISE', 'EXPAND',
  'EXPON.DIST', 'F.DIST', 'F.DIST.RT', 'F.INV', 'F.INV.RT', 'F.TEST', 'FIELDVALUE', 'FILTERXML', 'FLOOR.MATH',
  'FLOOR.PRECISE', 'FORECAST.ETS', 'FORECAST.ETS.CONFINT', 'FORECAST.ETS.SEASONALITY', 'FORECAST.ETS.STAT',
  'FORECAST.LINEAR', 'FORMULATEXT', 'GAMMA', 'GAMMA.DIST', 'GAMMA.INV', 'GAMMALN.PRECISE', 'GAUSS', 'HSTACK',
  'HYPGEOM.DIST', 'IFNA', 'IFS', 'IMCOSH', 'IMCOT', 'IMCSC', 'IMCSCH', 'IMSEC', 'IMSECH', 'IMSINH', 'IMTAN',
  'ISFORMULA', 'ISOMITTED', 'ISOWEEKNUM', 'LAMBDA', 'LET', 'LOGNORM.DIST', 'LOGNORM.INV', 'MAKEARRAY', 'MAP',
  'MAXIFS', 'MINIFS', 'MODE.MULT', 'MODE.SNGL', 'MUNIT', 'NEGBINOM.DIST', 'NORM.DIST', 'NORM.INV',
  'NORM.S.DIST', 'NORM.S.INV', 'NUMBERVALUE', 'PDURATION', 'PERCENTILE.EXC', 'PERCENTILE.INC',
  'PERCENTRANK.EXC', 'PERCENTRANK.INC', 'PERMUTATIONA', 'PHI', 'POISSON.DIST', 'PQSOURCE', 'PYTHON_STR',
  'PYTHON_TYPE', 'PYTHON_TYPENAME', 'QUARTILE.EXC', 'QUARTILE.INC', 'QUERYSTRING', 'RANDARRAY', 'RANK.AVG',
  'RANK.EQ', 'REDUCE', 'RRI', 'SCAN', 'SEC', 'SECH', 'SEQUENCE', 'SHEET', 'SHEETS', 'SKEW.P', 'SORTBY',
  'STDEV.P', 'STDEV.S', 'SWITCH', 'T.DIST', 'T.DIST.2T', 'T.DIST.RT', 'T.INV', 'T.INV.2T', 'T.TEST', 'TAKE',
  'TEXTAFTER', 'TEXTBEFORE', 'TEXTJOIN', 'TEXTSPLIT', 'TOCOL', 'TOROW', 'UNICHAR', 'UNICODE', 'UNIQUE', 'VAR.P',
  'VAR.S', 'VSTACK', 'WEBSERVICE', 'WEIBULL.DIST', 'WRAPCOLS', 'WRAPROWS', 'XLOOKUP', 'XOR', 'Z.TEST',
] as const;

/** [MS-XLSX] future functions with `_xlfn._xlws.` (worksheet-only functions). */
const XLWS_FUNCTIONS = ['FILTER', 'PY', 'SORT'] as const;

/** Excel 365 functions written with `_xlfn.` that the 2024 [MS-XLSX] revision does not list. */
const SUPPLEMENTARY_FUNCTIONS = [
  'ANCHORARRAY', 'ARRAYTOTEXT', 'DETECTLANGUAGE', 'ENCODEURL', 'GROUPBY', 'IMAGE', 'PERCENTOF', 'PIVOTBY',
  'REGEXEXTRACT', 'REGEXREPLACE', 'REGEXTEST', 'SINGLE', 'STOCKHISTORY', 'TRANSLATE', 'TRIMRANGE',
  'VALUETOTEXT', 'XMATCH',
] as const;

const XLFN = '_xlfn.';
const XLWS = '_xlws.';
const XLPM = '_xlpm.';

/** Upper-case function name -> the prefix it is stored with. */
export const FUTURE_FUNCTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  ...XLFN_FUNCTIONS.map((n) => [n, XLFN] as [string, string]),
  ...SUPPLEMENTARY_FUNCTIONS.map((n) => [n, XLFN] as [string, string]),
  ...XLWS_FUNCTIONS.map((n) => [n, XLFN + XLWS] as [string, string]),
]);

/** Function-name prefixes stripped for display (repeatable: `_xlfn._xlws.`). */
const FN_PREFIX_RE = /^(?:_xlfn\.|_xlws\.)+/i;
const XLPM_RE = /^_xlpm\./i;

function tokens(text: string): Token[] | null {
  let t: Token[];
  try { t = tokenize(text, { withLocation: true, allowTernary: false }); } catch { return null; }
  // The token values must cover the text exactly, or rebuilding from them would change it.
  let joined = '';
  for (const k of t) joined += k.value;
  return joined === text ? t : null;
}

/** Remove `_xlfn.`/`_xlws.` from function names and `_xlpm.` from names. Text that cannot be tokenised is returned as is. */
export function stripXlfnPrefixes(text: string): string {
  if (!/_xl(?:fn|ws|pm)\./i.test(text)) return text;
  const t = tokens(text);
  if (!t) return text;
  let out = '';
  for (const k of t) {
    if (k.type === 'func') out += k.value.replace(FN_PREFIX_RE, '');
    else if (k.type === 'range_named') out += k.value.replace(XLPM_RE, '');
    else out += k.value;
  }
  return out;
}

/**
 * Function prefixes a stored formula carries for functions that are not in FUTURE_FUNCTIONS (upper-case
 * name -> prefix), so that re-writing an edited version of it keeps them.
 */
export function learnedPrefixes(fileText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!/_xl(?:fn|ws)\./i.test(fileText)) return out;
  const t = tokens(fileText);
  if (!t) return out;
  for (const k of t) {
    if (k.type !== 'func') continue;
    const m = FN_PREFIX_RE.exec(k.value);
    if (!m) continue;
    const name = k.value.slice(m[0].length).toUpperCase();
    if (!FUTURE_FUNCTIONS.has(name)) out.set(name, m[0]);
  }
  return out;
}

/**
 * The file form of `text` (a formula without '='): every known future function gets its prefix (and
 * its canonical upper-case name), LET/LAMBDA parameters and their uses get `_xlpm.`. Idempotent.
 * Prefixes already present on unknown functions are kept. `extra` adds prefixes for more functions
 * (upper-case name -> prefix, e.g. from `learnedPrefixes`). Text that cannot be tokenised is returned
 * unchanged (callers validate first).
 */
export function addXlfnPrefixes(text: string, extra?: ReadonlyMap<string, string>): string {
  // 1. Canonical starting point: no prefixes on known functions, no `_xlpm.` anywhere.
  const t0 = tokens(text);
  if (!t0) return text;
  const known = (name: string): string | undefined => FUTURE_FUNCTIONS.get(name) ?? extra?.get(name);
  let base = '';
  for (const k of t0) {
    if (k.type === 'func') {
      const m = FN_PREFIX_RE.exec(k.value);
      const bare = m ? k.value.slice(m[0].length) : k.value;
      base += m && known(bare.toUpperCase()) !== undefined ? bare : k.value;
    } else if (k.type === 'range_named') base += k.value.replace(XLPM_RE, '');
    else base += k.value;
  }
  const t = tokens(base);
  if (!t) return text;

  // 2. LET/LAMBDA parameter positions (token start offsets), from the parse tree.
  const params = new Set<number>();
  try { markParams(parse(t) as unknown as AstNode, new Set(), params); } catch { /* unparseable: no _xlpm */ }

  // 3. Rebuild.
  let out = '';
  for (const k of t) {
    const at = k.loc ? k.loc[0] : -1;
    if (k.type === 'func' && !FN_PREFIX_RE.test(k.value)) {
      const name = k.value.toUpperCase();
      const p = known(name);
      out += p !== undefined ? p + name : k.value;
    } else if (k.type === 'range_named' && params.has(at)) {
      out += XLPM + k.value;
    } else out += k.value;
  }
  return out;
}

interface AstNode { type: string; loc?: [number, number]; [key: string]: unknown }

const isNode = (x: unknown): x is AstNode => typeof x === 'object' && x !== null && typeof (x as AstNode).type === 'string';

/** Collect the start offsets of LET/LAMBDA parameter declarations and of the names bound to them. */
function markParams(node: AstNode, scope: ReadonlySet<string>, out: Set<number>): void {
  switch (node.type) {
    case 'LetExpression': {
      const s = new Set(scope);
      for (const d of (node.declarations as AstNode[] | undefined) ?? []) {
        if (isNode(d.init)) markParams(d.init, s, out);
        const id = d.id as AstNode | undefined;
        if (id && id.loc && typeof id.name === 'string') { out.add(id.loc[0]); s.add(id.name.toLowerCase()); }
      }
      if (isNode(node.body)) markParams(node.body, s, out);
      return;
    }
    case 'LambdaExpression': {
      const s = new Set(scope);
      for (const p of (node.params as AstNode[] | undefined) ?? []) {
        if (p.loc && typeof p.name === 'string') { out.add(p.loc[0]); s.add(p.name.toLowerCase()); }
      }
      if (isNode(node.body)) markParams(node.body, s, out);
      return;
    }
    case 'ReferenceIdentifier':
      if (node.kind === 'name' && typeof node.value === 'string' && node.loc && scope.has(node.value.toLowerCase())) out.add(node.loc[0]);
      return;
  }
  for (const [key, v] of Object.entries(node)) {
    if (key === 'loc') continue;
    walkValue(v, scope, out);
  }
}

function walkValue(v: unknown, scope: ReadonlySet<string>, out: Set<number>): void {
  if (Array.isArray(v)) { for (const x of v) walkValue(x, scope, out); return; }
  if (isNode(v)) markParams(v, scope, out);
}
