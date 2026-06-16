// @ts-nocheck
// GFM table rules for Turndown (HTML -> Markdown).
//
// Turndown's core has NO table support — without these rules a <table> is
// flattened to plain concatenated cell text, so editing a table in WYSIWYG
// mode destroys its markdown formatting. This is a self-contained adaptation
// of turndown-plugin-gfm's table rules.
//
// Exposed as a UMD-style module so it can be loaded both by the webview
// (as a global `installTurndownTableRules`) and by the Node test runner
// (via `require`).
(function (global) {
  'use strict';

  /**
   * Serialize a single cell, prefixing the row's leading `|`.
   * Pipes are escaped so they aren't read as column separators — EXCEPT pipes
   * inside a [[wikilink|alias]], which this editor preprocesses into <a> tags
   * before the markdown table parser ever runs, so they must stay literal.
   */
  function tableCellMarkup(content, node) {
    const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
    const prefix = index === 0 ? '| ' : ' ';
    const cellText = content
      .replace(/\r?\n/g, ' ')
      .replace(/\[\[[^\]]*\]\]|\|/g, function (m) {
        return m === '|' ? '\\|' : m;
      })
      .trim();
    return prefix + cellText + ' |';
  }

  /** A <tbody> with no preceding content-bearing <thead> acts as the header. */
  function isFirstTbody(element) {
    const previousSibling = element.previousSibling;
    return (
      element.nodeName === 'TBODY' &&
      (!previousSibling ||
        (previousSibling.nodeName === 'THEAD' && /^\s*$/.test(previousSibling.textContent)))
    );
  }

  /** Is this <tr> the table's heading row (the one followed by `---` separators)? */
  function isHeadingRow(tr) {
    if (!tr) {
      return false;
    }
    const parent = tr.parentNode;
    return (
      parent.nodeName === 'THEAD' ||
      (parent.firstChild === tr &&
        (parent.nodeName === 'TABLE' || isFirstTbody(parent)) &&
        Array.prototype.every.call(tr.childNodes, function (n) {
          return n.nodeName === 'TH';
        }))
    );
  }

  /** Column alignment, from the `align` attribute or `text-align` style. */
  function cellAlignment(node) {
    const attr = node.getAttribute && node.getAttribute('align');
    const style = (node.style && node.style.textAlign) || '';
    return (attr || style || '').toLowerCase();
  }

  function installTurndownTableRules(turndownService) {
    turndownService.addRule('tableCell', {
      filter: ['th', 'td'],
      replacement: function (content, node) {
        return tableCellMarkup(content, node);
      },
    });

    turndownService.addRule('tableRow', {
      filter: 'tr',
      replacement: function (content, node) {
        let borderCells = '';
        const alignMap = { left: ':---', right: '---:', center: ':---:' };
        if (isHeadingRow(node)) {
          for (let i = 0; i < node.childNodes.length; i++) {
            const child = node.childNodes[i];
            if (child.nodeName !== 'TH' && child.nodeName !== 'TD') {
              continue;
            }
            let border = '---';
            const align = cellAlignment(child);
            if (align) {
              border = alignMap[align] || border;
            }
            borderCells += tableCellMarkup(border, child);
          }
        }
        return '\n' + content + (borderCells ? '\n' + borderCells : '');
      },
    });

    turndownService.addRule('tableSection', {
      filter: ['thead', 'tbody', 'tfoot'],
      replacement: function (content) {
        return content;
      },
    });

    // Only tables with a heading row can be expressed as GFM markdown; others
    // are left to Turndown's default handling.
    turndownService.addRule('table', {
      filter: function (node) {
        return node.nodeName === 'TABLE' && isHeadingRow(node.rows[0]);
      },
      replacement: function (content) {
        // Collapse the blank line Turndown inserts between the header row and
        // the separator so the table stays contiguous.
        return '\n\n' + content.replace(/\n+/g, '\n') + '\n\n';
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { installTurndownTableRules };
  } else {
    global.installTurndownTableRules = installTurndownTableRules;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
