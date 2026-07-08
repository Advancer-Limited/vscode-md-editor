// Diff viewer — renders markdown hunks with diff highlighting
(function () {
  'use strict';

  // Match the live editor's markdown-it configuration (media/editor.js) so the
  // diff view renders line breaks, links, and typography the same way the user
  // sees them in the editor — otherwise the diff can misrepresent content.
  // html stays OFF: unlike editor.js this view has no sanitizeHtml() pass, so
  // enabling raw HTML here would inject file content straight into innerHTML.
  var md = window.markdownit({
    linkify: true,
    typographer: true,
    breaks: true,
  });
  var diffContent = document.getElementById('diff-content');
  var dataEl = document.getElementById('diff-data');

  var hunks = JSON.parse(dataEl.value);
  renderDiff(hunks);

  function renderDiff(hunks) {
    var html = '';
    for (var i = 0; i < hunks.length; i++) {
      var hunk = hunks[i];
      var rendered = md.render(hunk.content);
      var className = 'diff-hunk diff-' + hunk.type;
      var marker = hunk.type === 'added' ? '+' : hunk.type === 'removed' ? '−' : ' ';

      html += '<div class="' + className + '">';
      html += '<div class="diff-gutter">' + marker + '</div>';
      html += '<div class="diff-body">' + rendered + '</div>';
      html += '</div>';
    }
    diffContent.innerHTML = html;
  }
})();
