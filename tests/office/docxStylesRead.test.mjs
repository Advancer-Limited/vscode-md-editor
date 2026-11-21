// WP-26: Word styles + numbering read side (src/office/core/docx/styles.ts, numbering.ts), spec §8.3 / §8.6.
import { test } from 'node:test';
import assert from 'node:assert';
import { core, fixture, allFixtures } from './_helpers.mjs';

const { OfficePackage } = core.pkg;
const { DocxStyles } = core.docx.styles;
const { DocxNumbering } = core.docx.numbering;
const enc = new TextEncoder();
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NSDECL = `xmlns:w="${W}"`;

const open = (name) => OfficePackage.open(name, fixture(name));
const mainOf = (p) => core.opc.mainPart(p).name;
const load = (p) => ({ s: DocxStyles.load(p, mainOf(p)), n: DocxNumbering.load(p, mainOf(p)) });
const rPr = (inner) => core.xml.parseXml(`<w:rPr ${NSDECL}>${inner}</w:rPr>`).root;

/** basic.docx whose styles.xml is replaced by `body` (children of w:styles), numbering.xml by `numbering` when given. */
function synth(body, numbering) {
  const p = open('basic.docx');
  p.setPart('word/styles.xml', enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NSDECL}>${body}</w:styles>`));
  if (numbering !== undefined) {
    p.setPart('word/numbering.xml', enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NSDECL}>${numbering}</w:numbering>`));
  }
  return p;
}
const pstyle = (id, name, extra = '', attrs = '') =>
  `<w:style w:type="paragraph" ${attrs} w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const NORMAL = pstyle('Normal', 'Normal', '', 'w:default="1"');

test('every docx fixture loads: styles found, Normal is the default, nothing throws', () => {
  let n = 0;
  for (const f of allFixtures('docx')) {
    let p;
    try { p = open(f); } catch { continue; }   // encrypted / legacy / truncated are refused by open()
    const { s, n: num } = load(p);
    assert.strictEqual(s.part, 'word/styles.xml', f);
    assert.strictEqual(s.damaged, false, f);
    assert.strictEqual(s.defaultParagraphStyleId(), 'Normal', f);
    assert.deepStrictEqual(s.styleInfo(null), { kind: 'normal', name: 'Normal' }, f);
    assert.strictEqual(s.listParagraphStyleId(), 'ListParagraph', f);
    assert.strictEqual(num.damaged, false, f);
    assert.ok(num.part === null || num.part === 'word/numbering.xml', f);
    for (let l = 1; l <= 3; l++) assert.ok(s.headingStyleId(l), `${f} heading ${l}`);
    n++;
  }
  assert.ok(n >= 10, `loaded ${n} fixtures`);
});

test('localised-de (synthetic): Heading 1-3 found by name, never by id', () => {
  const p = open('localised-de.synthetic.docx');
  const { s } = load(p);
  assert.deepStrictEqual([1, 2, 3].map((l) => s.headingStyleId(l)), ['berschrift1', 'berschrift2', 'berschrift3']);
  assert.deepStrictEqual(s.styleInfo('berschrift2'), { kind: 'heading', level: 2, name: 'heading 2' });
  assert.strictEqual(s.styleInfo('Heading1').kind, 'other');   // no such id here; ids carry no meaning
  // An id that LOOKS like a heading but whose name is not one is not a heading.
  const p2 = synth(NORMAL + pstyle('Heading1', 'Custom Thing') + pstyle('Titre1', 'Heading 1'));
  assert.strictEqual(load(p2).s.headingStyleId(1), 'Titre1');
  assert.strictEqual(load(p2).s.styleInfo('Heading1').kind, 'other');
});

test('no-heading-styles.docx and no-numbering.docx load with nulls', () => {
  const nn = load(open('no-numbering.docx'));
  assert.strictEqual(nn.n.part, null);
  assert.strictEqual(nn.n.maxAbstractNumId(), -1);
  assert.strictEqual(nn.n.maxNumId(), 0);
  assert.strictEqual(nn.n.findOwnAbstract('bullet'), null);
  assert.deepStrictEqual(nn.n.listInfo(1, 0), { kind: 'none', level: 0 });
  assert.strictEqual(nn.s.styleNumPr(null), null);

  // The Word-authored fixture still carries Word's built-in heading definitions; strip them to prove the nulls.
  const p = open('no-heading-styles.docx');
  const stripped = p.text('word/styles.xml')
    .replace(/<w:style [^>]*w:type="paragraph"[^>]*><w:name w:val="(?:heading \d|List Paragraph)"\/>.*?<\/w:style>/gs, '');
  assert.notStrictEqual(stripped, p.text('word/styles.xml'));
  p.setPart('word/styles.xml', enc.encode(stripped));
  const { s } = load(p);
  for (let l = 1; l <= 9; l++) assert.strictEqual(s.headingStyleId(l), null, `level ${l}`);
  assert.strictEqual(s.listParagraphStyleId(), null);
  assert.strictEqual(s.defaultParagraphStyleId(), 'Normal');
  // No styles part at all.
  const q = open('basic.docx');
  q.setPart('word/styles.xml', null);
  const { s: s2 } = load(q);
  assert.strictEqual(s2.part, null);
  assert.strictEqual(s2.defaultParagraphStyleId(), null);
  assert.strictEqual(s2.headingStyleId(1), null);
  assert.deepStrictEqual(s2.styleInfo(null), { kind: 'normal', name: 'Normal' });
  assert.deepStrictEqual(s2.effectiveToggles(null, null), { b: false, i: false, u: false });
});

test('outlineLvl fallback', () => {
  const { s } = load(synth(NORMAL
    + pstyle('Kopf2', 'Mein Kopf', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')
    + pstyle('Body', 'Body Text', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>')
    + pstyle('Sub', 'Sub Kopf', '<w:basedOn w:val="Kopf2"/>')));
  assert.strictEqual(s.headingStyleId(2), 'Kopf2');
  assert.strictEqual(s.headingStyleId(1), null);
  assert.deepStrictEqual(s.styleInfo('Kopf2'), { kind: 'heading', level: 2, name: 'Mein Kopf' });
  assert.strictEqual(s.styleInfo('Sub').level, 2, 'outline level is inherited through basedOn');
  assert.strictEqual(s.styleInfo('Body').kind, 'other', 'outlineLvl 9 is body text');
  // A name match wins over an outline-level match.
  const { s: s2 } = load(synth(NORMAL + pstyle('A', 'Mein Kopf', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>') + pstyle('H1', 'heading 1')));
  assert.strictEqual(s2.headingStyleId(1), 'H1');
  assert.strictEqual(s2.headingStyleId(0), null);
  assert.strictEqual(s2.headingStyleId(10), null);
});

test('effective bold through basedOn chains and docDefaults; w:b w:val="0|false|off" is off', () => {
  const dd = '<w:docDefaults><w:rPrDefault><w:rPr><w:i/></w:rPr></w:rPrDefault></w:docDefaults>';
  const { s } = load(synth(dd + NORMAL
    + pstyle('Base', 'Base', '<w:rPr><w:b/></w:rPr>')
    + pstyle('Mid', 'Mid', '<w:basedOn w:val="Base"/>')
    + pstyle('Off0', 'Off0', '<w:basedOn w:val="Base"/><w:rPr><w:b w:val="0"/></w:rPr>')
    + pstyle('OffF', 'OffF', '<w:basedOn w:val="Base"/><w:rPr><w:b w:val="false"/></w:rPr>')
    + pstyle('OffO', 'OffO', '<w:basedOn w:val="Base"/><w:rPr><w:b w:val="off"/></w:rPr>')
    + pstyle('OnT', 'OnT', '<w:basedOn w:val="Off0"/><w:rPr><w:b w:val="true"/></w:rPr>')
    + pstyle('Cyc1', 'Cyc1', '<w:basedOn w:val="Cyc2"/>') + pstyle('Cyc2', 'Cyc2', '<w:basedOn w:val="Cyc1"/>')
    + '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Plain"><w:name w:val="Plain"/><w:rPr><w:b w:val="0"/></w:rPr></w:style>'));
  const T = (b, i = false, u = false) => ({ b, i, u });
  assert.deepStrictEqual(s.effectiveToggles(null, null), T(false, true), 'docDefaults italic');
  assert.deepStrictEqual(s.effectiveToggles('Base', null), T(true, true));
  assert.deepStrictEqual(s.effectiveToggles('Mid', null), T(true, true), 'inherited through basedOn');
  for (const id of ['Off0', 'OffF', 'OffO']) assert.deepStrictEqual(s.effectiveToggles(id, null), T(false, true), id);
  assert.deepStrictEqual(s.effectiveToggles('OnT', null), T(true, true), 'nearest style wins over its ancestors');
  assert.deepStrictEqual(s.effectiveToggles('Cyc1', null), T(false, true), 'cycle terminates');
  // Direct rPr wins over everything.
  assert.deepStrictEqual(s.effectiveToggles('Base', rPr('<w:b w:val="0"/>')), T(false, true));
  assert.deepStrictEqual(s.effectiveToggles(null, rPr('<w:b/><w:i w:val="off"/><w:u w:val="single"/>')), T(true, false, true));
  assert.deepStrictEqual(s.effectiveToggles(null, rPr('<w:u w:val="none"/>')), T(false, true, false));
  assert.deepStrictEqual(s.effectiveToggles(null, rPr('<w:u/>')), T(false, true, true), 'u without val is single');
  // Character style sits between direct rPr and the paragraph style.
  assert.deepStrictEqual(s.effectiveToggles('Base', rPr('<w:rStyle w:val="Plain"/>')), T(false, true));
  assert.deepStrictEqual(s.effectiveToggles(null, rPr('<w:rStyle w:val="Strong"/>')), T(true, true, true));
  assert.deepStrictEqual(s.effectiveToggles(null, rPr('<w:rStyle w:val="Strong"/><w:b w:val="0"/>')), T(false, true, true));
  // inheritedToggles: styles only.
  assert.deepStrictEqual(s.inheritedToggles('Base', null), T(true, true));
  assert.deepStrictEqual(s.inheritedToggles('Base', 'Plain'), T(false, true));
  assert.deepStrictEqual(s.inheritedToggles(null, 'Strong'), T(true, true, true));
  assert.deepStrictEqual(s.inheritedToggles('Nope', 'Nope'), T(false, true), 'unknown ids fall back to docDefaults');
});

test('effective toggles on the real basic.docx styles are coherent', () => {
  const { s } = load(open('basic.docx'));
  const t = s.effectiveToggles('Heading1', null);
  assert.deepStrictEqual(Object.keys(t).sort(), ['b', 'i', 'u']);
  assert.deepStrictEqual(s.inheritedToggles('Heading1', null), t);
  assert.deepStrictEqual(s.effectiveToggles(null, null), { b: false, i: false, u: false });
});

test('runCss: direct and character-style properties only', () => {
  const { s } = load(synth(NORMAL
    + '<w:style w:type="character" w:styleId="Fancy"><w:name w:val="Fancy"/><w:rPr><w:color w:val="00FF00"/><w:sz w:val="28"/><w:vertAlign w:val="subscript"/></w:rPr></w:style>'));
  assert.deepStrictEqual(s.runCss(null), {});
  assert.deepStrictEqual(s.runCss(rPr('<w:b/>')), {});
  assert.deepStrictEqual(s.runCss(rPr('<w:color w:val="ff0000"/><w:sz w:val="21"/><w:rFonts w:ascii="Arial" w:hAnsi="Calibri"/><w:highlight w:val="yellow"/><w:strike/><w:vertAlign w:val="superscript"/>')),
    { color: '#FF0000', fontSizePt: 10.5, fontFamily: 'Arial', highlight: 'yellow', strike: true, vertAlign: 'super' });
  assert.deepStrictEqual(s.runCss(rPr('<w:rStyle w:val="Fancy"/>')), { styleClass: 'Fancy', color: '#00FF00', fontSizePt: 14, vertAlign: 'sub' });
  assert.deepStrictEqual(s.runCss(rPr('<w:rStyle w:val="Fancy"/><w:sz w:val="20"/>')), { styleClass: 'Fancy', color: '#00FF00', fontSizePt: 10, vertAlign: 'sub' });
  assert.strictEqual(s.runCss(rPr('<w:strike w:val="0"/>')).strike, undefined);
  assert.strictEqual(s.runCss(rPr('<w:color w:val="auto"/>')).color, undefined);
  assert.strictEqual(s.runCss(rPr('<w:highlight w:val="none"/>')).highlight, undefined);
  assert.strictEqual(s.runCss(rPr('<w:highlight w:val="darkYellow"/>')).highlight, 'olive');
});

test('numPr via paragraph style', () => {
  const { s } = load(synth(NORMAL
    + pstyle('Bul', 'Bul', '<w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr>')
    + pstyle('BulKid', 'BulKid', '<w:basedOn w:val="Bul"/>')
    + pstyle('Cancel', 'Cancel', '<w:basedOn w:val="Bul"/><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>')
    + pstyle('NoLvl', 'NoLvl', '<w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr>')));
  assert.deepStrictEqual(s.styleNumPr('Bul'), { numId: 5, ilvl: 1 });
  assert.deepStrictEqual(s.styleNumPr('BulKid'), { numId: 5, ilvl: 1 });
  assert.strictEqual(s.styleNumPr('Cancel'), null, 'numId 0 in a nearer style cancels inheritance');
  assert.deepStrictEqual(s.styleNumPr('NoLvl'), { numId: 7, ilvl: 0 });
  assert.strictEqual(s.styleNumPr(null), null);
  assert.strictEqual(s.styleNumPr('Unknown'), null);
});

const lvl = (i, fmt) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/>${fmt === null ? '' : `<w:numFmt w:val="${fmt}"/>`}</w:lvl>`;
const NUMBERING =
  `<w:abstractNum w:abstractNumId="0"><w:name w:val="VSMDBullet"/>${lvl(0, 'bullet')}${lvl(1, 'decimal')}</w:abstractNum>`
  + `<w:abstractNum w:abstractNumId="3"><w:name w:val="VSMDNumber"/>${lvl(0, 'decimal')}${lvl(1, 'lowerRoman')}${lvl(2, 'upperLetter')}${lvl(3, 'lowerLetter')}${lvl(4, 'upperRoman')}${lvl(5, 'ordinal')}${lvl(6, null)}${lvl(7, 'none')}</w:abstractNum>`
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
  + '<w:num w:numId="2"><w:abstractNumId w:val="3"/></w:num>'
  + '<w:num w:numId="6"><w:abstractNumId w:val="3"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>'
  + '<w:lvlOverride w:ilvl="1"><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:lvlOverride></w:num>'
  + '<w:num w:numId="7"><w:abstractNumId w:val="99"/></w:num>';

test('list kind for bullet/decimal/roman/other', () => {
  const { n } = load(synth(NORMAL, NUMBERING));
  assert.deepStrictEqual(n.listInfo(1, 0), { kind: 'bullet', level: 0 });
  assert.deepStrictEqual(n.listInfo(2, 0), { kind: 'number', level: 0 });
  assert.deepStrictEqual(n.listInfo(2, 1), { kind: 'number', level: 1 }, 'lowerRoman');
  assert.strictEqual(n.listInfo(2, 2).kind, 'number', 'upperLetter');
  assert.strictEqual(n.listInfo(2, 3).kind, 'number', 'lowerLetter');
  assert.strictEqual(n.listInfo(2, 4).kind, 'number', 'upperRoman');
  assert.strictEqual(n.listInfo(2, 5).kind, 'other', 'ordinal');
  assert.strictEqual(n.listInfo(2, 6).kind, 'number', 'missing numFmt defaults to decimal');
  assert.strictEqual(n.listInfo(2, 7).kind, 'other', 'none');
  assert.deepStrictEqual(n.listInfo(2, 8), { kind: 'other', level: 8 }, 'undefined level of a known list');
  assert.deepStrictEqual(n.listInfo(1, 1), { kind: 'number', level: 1 });
  assert.deepStrictEqual(n.listInfo(6, 1), { kind: 'bullet', level: 1 }, 'lvlOverride/lvl replaces the abstract level');
  assert.deepStrictEqual(n.listInfo(6, 0), { kind: 'number', level: 0 }, 'startOverride keeps the abstract format');
  assert.deepStrictEqual(n.listInfo(7, 0), { kind: 'other', level: 0 }, 'dangling abstractNumId');
  assert.deepStrictEqual(n.listInfo(0, 0), { kind: 'none', level: 0 });
  assert.deepStrictEqual(n.listInfo(42, 3), { kind: 'none', level: 0 });
  assert.strictEqual(n.listInfo(1, 12).level, 8, 'level clamped');
  assert.strictEqual(n.maxAbstractNumId(), 3);
  assert.strictEqual(n.maxNumId(), 7);
  assert.strictEqual(n.findOwnAbstract('bullet'), 0);
  assert.strictEqual(n.findOwnAbstract('number'), 3);
});

test('real fixtures: basic.docx bullet and numbered lists', () => {
  const p = open('basic.docx');
  const { n } = load(p);
  assert.strictEqual(n.part, 'word/numbering.xml');
  const kinds = new Set();
  const levels = new Set();
  const doc = p.text('word/document.xml');
  for (const m of doc.matchAll(/<w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/>/g)) {
    const info = n.listInfo(Number(m[2]), Number(m[1]));
    kinds.add(info.kind);
    levels.add(info.level);
  }
  assert.ok(kinds.has('bullet') && kinds.has('number'), [...kinds].join());
  // The fixture's "nested" numbered items are w:ilvl 0 with an indent, not a deeper level.
  assert.deepStrictEqual([...levels], [0]);
  assert.strictEqual(n.listInfo(2, 1).kind, 'other', 'the fixture defines level 0 only, so level 1 is undefined');
  assert.strictEqual(n.findOwnAbstract('bullet'), null, 'Word lists are never ours');
  assert.strictEqual(n.maxNumId(), 2);
  const t = load(open('tables.docx')).n;   // a list inside a table cell
  assert.ok(t.part && t.maxNumId() >= 1);
});

test('reload() sees edits to the parts', () => {
  const p = open('no-heading-styles.docx');
  const { s } = load(p);
  p.setPart('word/styles.xml', enc.encode(`<w:styles ${NSDECL}>${NORMAL}${pstyle('Ueb1', 'heading 1')}</w:styles>`));
  assert.strictEqual(s.headingStyleId(1), 'Heading1', 'stale until reload');
  s.reload();
  assert.strictEqual(s.headingStyleId(1), 'Ueb1');
  assert.strictEqual(s.headingStyleId(2), null);
  const q = synth(NORMAL);
  const n2 = DocxNumbering.load(q, mainOf(q));
  q.setPart('word/numbering.xml', enc.encode(`<w:numbering ${NSDECL}>${NUMBERING}</w:numbering>`));
  n2.reload();
  assert.strictEqual(n2.maxNumId(), 7);
});

test('damaged styles / numbering parts answer as empty and are flagged', () => {
  const p = open('basic.docx');
  p.setPart('word/styles.xml', enc.encode('<w:styles'));
  p.setPart('word/numbering.xml', enc.encode(`<w:foo ${NSDECL}/>`));
  const { s, n } = load(p);
  assert.strictEqual(s.part, 'word/styles.xml');
  assert.strictEqual(s.damaged, true);
  assert.strictEqual(s.headingStyleId(1), null);
  assert.strictEqual(s.defaultParagraphStyleId(), null);
  assert.deepStrictEqual(s.runCss(rPr('<w:b/>')), {});
  assert.strictEqual(n.part, 'word/numbering.xml');
  assert.strictEqual(n.damaged, true);
  assert.deepStrictEqual(n.listInfo(1, 0), { kind: 'none', level: 0 });
  assert.strictEqual(n.maxNumId(), 0);
});

test('prefixed WordprocessingML namespaces are matched by URI', () => {
  const p = open('basic.docx');
  p.setPart('word/styles.xml', enc.encode(`<x:styles xmlns:x="${W}"><x:style x:type="paragraph" x:default="1" x:styleId="N"><x:name x:val="Normal"/></x:style>`
    + '<x:style x:type="paragraph" x:styleId="K"><x:name x:val="heading 3"/></x:style></x:styles>'));
  const s = DocxStyles.load(p, mainOf(p));
  assert.strictEqual(s.defaultParagraphStyleId(), 'N');
  assert.strictEqual(s.headingStyleId(3), 'K');
});
