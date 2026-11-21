// The live read model must describe the tree (Gate R2 F1): after any edit, refusal, undo or redo the
// workbook's loaded sheets and style table must read exactly what a model freshly built from the
// serialised package reads.
//
//   assertViewMatchesFile(wb, pkg, styles, msg, range?)
//     wb.sheets (names, parts, kinds, states) equals a fresh load's; for every loaded worksheet of
//     `wb` (paired by position): Sheet.cellsIn over `range` (value, style, formula, shared group),
//     every cell node still attached to the current tree, the editor seed of every cell, and
//     view.cellWindow DTOs (links, notes, locked ranges) equal those of a model loaded from
//     pkg.serialize().
import assert from 'node:assert';
import { core } from './_helpers.mjs';

const { OfficePackage } = core.pkg;
const { Workbook } = core.xlsx.workbook;
const { StyleTable } = core.xlsx.styles;
const { editSeed } = core.xlsx.format;
const { cellWindow } = core.xlsx.view;
const { displayFormula } = core.xlsx.sharedFormula;

const rootOf = (n) => { while (n.parent) n = n.parent; return n; };

function dump(wb, sheet, styles, range) {
  const cells = sheet.cellsIn(range).map((c) => JSON.stringify({
    r: c.r, c: c.c, value: c.value, s: c.styleIndex, f: c.formula, shared: c.shared, arrayRef: c.arrayRef,
    seed: editSeed(c, styles, wb.date1904), shown: displayFormula(sheet, c),
  }));
  const window = cellWindow(wb, sheet, styles, range, false).cells.map((c) => JSON.stringify(c));
  return { cells, window };
}

export async function assertViewMatchesFile(wb, pkg, styles, msg, range = [0, 0, 59, 15]) {
  const fp = OfficePackage.open('fresh.xlsx', pkg.serialize());
  const fwb = Workbook.load(fp);
  const fst = StyleTable.load(fp, fwb.stylesPart, fwb.themePart);
  assert.strictEqual(styles.xfCount, fst.xfCount, `${msg}: style table record count`);
  // The sheet list (re-read after add/rename/delete and their undo/redo). Sheets are paired by
  // position: session ids of a live workbook drift from a fresh load's once sheets come and go.
  const strip = (e) => ({ name: e.name, part: e.part, kind: e.kind, state: e.state, rId: e.rId, fileSheetId: e.fileSheetId });
  assert.deepStrictEqual(wb.sheets.map(strip), fwb.sheets.map(strip), `${msg}: sheet list`);
  for (let i = 0; i < wb.sheets.length; i++) {
    const e = wb.sheets[i];
    if (e.kind !== 'worksheet') continue;
    const live = wb.loadedSheet(e.id);
    if (!live) continue;
    assert.strictEqual(live.doc, pkg.xml(live.part), `${msg}: sheet ${e.id} model is on the current tree`);
    const root = pkg.xml(live.part).root;
    for (const c of live.cellsIn(range)) {
      const node = live.cellNode(c.r, c.c);
      assert.ok(node && rootOf(node) === root, `${msg}: sheet ${e.id} cell (${c.r}, ${c.c}) is indexed to a node outside the tree`);
    }
    const a = dump(wb, live, styles, range);
    const b = dump(fwb, await fwb.sheet(fwb.sheets[i].id), fst, range);
    assert.deepStrictEqual(a.cells, b.cells, `${msg}: sheet ${e.id} cells differ from the file`);
    assert.deepStrictEqual(a.window, b.window, `${msg}: sheet ${e.id} grid differs from the file`);
  }
}
