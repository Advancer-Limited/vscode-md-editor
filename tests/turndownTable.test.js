// Round-trip tests for the WYSIWYG table fix.
//
// In WYSIWYG mode the editor renders markdown -> HTML (markdown-it), the user
// edits the HTML (contenteditable), and Turndown converts it back to markdown.
// Turndown has no native table support, so without the rules in
// media/turndownTableRules.js a table is flattened and destroyed. These tests
// exercise the exact render->edit->serialize pipeline to ensure tables (and the
// editor's wikilink syntax) survive an edit.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const MarkdownIt = require('markdown-it');
const TurndownService = require('turndown');
const { installTurndownTableRules } = require('../media/turndownTableRules.js');

/** Build markdown-it + Turndown configured like media/editor.js. */
function makeServices(withTableRules = true) {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: true });
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  // Mirror the wikilink rule from editor.js so cell interactions are realistic.
  td.addRule('wikilink', {
    filter: (node) => node.nodeName === 'A' && node.classList.contains('wikilink'),
    replacement: (content, node) => {
      const target = node.getAttribute('data-target');
      return content === target ? '[[' + target + ']]' : '[[' + target + '|' + content + ']]';
    },
  });
  if (withTableRules) {
    installTurndownTableRules(td);
  }
  return { md, td };
}

/** Mirror of editor.js preprocessWikilinks (runs before markdown-it). */
function preprocessWikilinks(text) {
  return text.replace(/\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g, (m, target, display) => {
    const label = display || target;
    return '<a class="wikilink" data-target="' + target.trim() + '">' + label.trim() + '</a>';
  });
}

/** Full render -> serialize round trip, returning the resulting markdown. */
function roundTrip(src, withTableRules = true) {
  const { md, td } = makeServices(withTableRules);
  const html = md.render(preprocessWikilinks(src));
  return td.turndown(html).trim();
}

/** A markdown string is a GFM table if it has a row and a separator row. */
function looksLikeTable(mdText) {
  const lines = mdText.split('\n').filter((l) => l.trim().startsWith('|'));
  const hasSeparator = lines.some((l) => /\|[\s:-]+\|/.test(l) && l.includes('-'));
  return lines.length >= 2 && hasSeparator;
}

test('basic table survives the round trip', () => {
  const src = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
  const out = roundTrip(src);
  assert.ok(looksLikeTable(out), `expected a table, got:\n${out}`);
  assert.match(out, /\| Alice \| 30 \|/);
  assert.match(out, /\| Bob \| 25 \|/);
});

test('column alignment is preserved', () => {
  const src = '| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |';
  const out = roundTrip(src);
  assert.match(out, /\| :--- \| :---: \| ---: \|/, `alignment lost:\n${out}`);
});

test('inline formatting inside cells is preserved', () => {
  const src = '| Col |\n| --- |\n| **bold** and *italic* |';
  const out = roundTrip(src);
  assert.match(out, /\*\*bold\*\*/);
  assert.match(out, /\*italic\*/);
  assert.ok(looksLikeTable(out));
});

test('literal pipes in cell text are escaped', () => {
  const src = '| A | B |\n| --- | --- |\n| has \\| pipe | ok |';
  const out = roundTrip(src);
  assert.match(out, /has \\\| pipe/, `pipe not escaped:\n${out}`);
  // Re-rendering the escaped output must still be a single 2-column table.
  assert.ok(looksLikeTable(roundTrip(out)));
});

test('wikilink with alias inside a cell keeps its pipe UNescaped', () => {
  // The editor preprocesses [[a|b]] into <a> before the table parser runs, so
  // the pipe must stay literal — escaping it to \| breaks the wikilink regex.
  const src = '| Link |\n| --- |\n| [[Note|Display]] |';
  const out = roundTrip(src);
  assert.match(out, /\[\[Note\|Display\]\]/, `wikilink mangled:\n${out}`);
  assert.doesNotMatch(out, /\[\[Note\\\|Display\]\]/, 'wikilink pipe was wrongly escaped');
});

test('plain wikilink (no alias) inside a cell is preserved', () => {
  const src = '| Link |\n| --- |\n| [[Note]] |';
  const out = roundTrip(src);
  assert.match(out, /\[\[Note\]\]/);
});

test('round trip is idempotent (repeated edits do not corrupt the table)', () => {
  const cases = [
    '| Name | Age |\n| --- | --- |\n| Alice | 30 |',
    '| Left | Right |\n| :--- | ---: |\n| a | b |',
    '| Link |\n| --- |\n| [[Note|Display]] |',
  ];
  for (const src of cases) {
    const once = roundTrip(src);
    const twice = roundTrip(once);
    assert.strictEqual(twice, once, `not idempotent for:\n${src}`);
  }
});

test('regression guard: without the table rules a table IS destroyed', () => {
  // Proves the rules are what fix the bug — not markdown-it/turndown defaults.
  const src = '| Name | Age |\n| --- | --- |\n| Alice | 30 |';
  const out = roundTrip(src, /* withTableRules */ false);
  assert.ok(!looksLikeTable(out), `table unexpectedly survived without rules:\n${out}`);
});

test('non-table content is unaffected by the table rules', () => {
  const src = '# Heading\n\nA paragraph with **bold** text.\n\n- item one\n- item two';
  const out = roundTrip(src);
  assert.match(out, /# Heading/);
  assert.match(out, /\*\*bold\*\*/);
  assert.match(out, /-\s+item one/);
  assert.match(out, /-\s+item two/);
});
