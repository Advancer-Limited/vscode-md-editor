// Tests for the standalone print page built for the Markdown WYSIWYG
// editor's Print button. The page embeds the editor's own webview
// stylesheet wholesale (not just the preview-specific rules) so that
// headings/code blocks/tables etc. render the same as the live preview —
// but that stylesheet also contains app-shell rules (a fixed-height,
// overflow-hidden html/body, colors resolved from --vscode-* theme
// variables that don't exist in a real browser) that would otherwise clip
// the printed output to one screenful and render illegible dark-theme
// fallback colors on the page's white background. These tests guard the
// print-safe overrides that neutralize that shell CSS.
import { test } from 'node:test';
import assert from 'node:assert';

const { buildMarkdownPrintHtml } = await import('../src/utils.ts');

// A minimal stand-in for editor.css's shell rules — the actual file's
// app-shell block that must be neutralized by the print overrides.
const SHELL_CSS = `
html, body {
  height: 100%;
  overflow: hidden;
  background: var(--editor-bg, #1e1e1e);
  color: var(--editor-fg, #d4d4d4);
}
`;

test('the print page overrides the embedded shell CSS height/overflow (no page-1 clipping)', () => {
  const html = buildMarkdownPrintHtml('Doc', '<h1>Hi</h1>', SHELL_CSS);
  const shellIndex = html.indexOf('height: 100%');
  const overrideIndex = html.indexOf('height: auto !important');
  assert.ok(shellIndex !== -1, 'shell CSS should be present (it is embedded wholesale)');
  assert.ok(overrideIndex !== -1, 'a height:auto !important override must be present');
  assert.ok(overrideIndex > shellIndex, 'the override must come after the shell CSS in source order');
  assert.match(html, /overflow:\s*visible\s*!important/, 'overflow:hidden must be overridden to visible');
});

test('the print page forces a light, readable background and text color', () => {
  const html = buildMarkdownPrintHtml('Doc', '<p>Body</p>', SHELL_CSS);
  assert.match(html, /background:\s*#ffffff\s*!important/i, 'background must be forced to white');
  assert.match(html, /color:\s*#1f1f1f\s*!important/i, 'text color must be forced to a readable dark color');
});

test('the print page does not rely on --vscode-* CSS variables it cannot supply', () => {
  // The override block itself must use literal colors, not var(--vscode-*,
  // ...) — those variables don't exist in a plain browser tab, which is
  // exactly the bug being guarded against.
  const html = buildMarkdownPrintHtml('Doc', '<p>Body</p>', SHELL_CSS);
  const overrideBlockStart = html.indexOf('html, body {\n  height: auto');
  const overrideBlockEnd = html.indexOf('}', overrideBlockStart);
  const overrideBlock = html.slice(overrideBlockStart, overrideBlockEnd);
  assert.doesNotMatch(overrideBlock, /var\(--vscode-/, 'override block should use literal colors, not vscode theme vars');
});

test('carries the live preview HTML through into the markdown-body wrapper', () => {
  const html = buildMarkdownPrintHtml('My Doc', '<h1>Hello</h1><p>World</p>', SHELL_CSS);
  assert.match(html, /<div class="markdown-body"><h1>Hello<\/h1><p>World<\/p><\/div>/);
});

test('escapes the title for safe interpolation', () => {
  const html = buildMarkdownPrintHtml('<script>alert(1)</script>', '<p>x</p>', SHELL_CSS);
  assert.doesNotMatch(html, /<title><script>/);
  assert.match(html, /<title>&lt;script&gt;/);
});

test('CSP has no script-src (default-src none blocks script execution) and blocks form submission', () => {
  const html = buildMarkdownPrintHtml('Doc', '<p>x</p>', SHELL_CSS);
  const cspMatch = /content="([^"]+)"/.exec(html);
  assert.ok(cspMatch, 'a CSP meta tag must be present');
  const csp = cspMatch[1];
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/, 'no script-src directive should be added (default-src none already blocks scripts)');
  assert.match(csp, /form-action 'none'/);
});

test('grammar-check squiggle decoration is suppressed in the printed output', () => {
  const html = buildMarkdownPrintHtml('Doc', '<p>x</p>', SHELL_CSS);
  assert.match(html, /\.grammar-error\s*\{\s*text-decoration:\s*none\s*!important;?\s*\}/);
});
