// Diff viewer — renders markdown hunks with diff highlighting
(function () {
  'use strict';

  var md = window.markdownit();
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
