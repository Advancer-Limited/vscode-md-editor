<#
  make-producers.ps1 - "real producer" PDF fixtures of spec 13.3.
    word.pdf    desktop Word via COM, ExportAsFixedFormat with document structure tags (tagged PDF) and bookmarks
    chrome.pdf  Edge headless --print-to-pdf (Chromium/Skia producer)
  Usage: pwsh scripts/pdf-fixtures/make-producers.ps1 [-OutDir <dir>] [-Only word,chrome]
  Word: starts its OWN hidden instance (Visible=false, DisplayAlerts=0), never attaches to a running Word,
  and always Quit()s it in finally. Edge: a throwaway --user-data-dir, so a running Edge is untouched.
  Not byte-reproducible (producer timestamps, ids).
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\tests\fixtures\pdf'),
  [string[]]$Only = @()
)
$ErrorActionPreference = 'Stop'
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$OutDir = [IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force $OutDir | Out-Null
$Work = Join-Path ([IO.Path]::GetTempPath()) ('vsmd-pdfprod-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Work | Out-Null
$Lorem = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. Sphinx of black quartz, judge my vow.'
function Want([string]$n) { return ($Only.Count -eq 0 -or $Only -contains $n) }

function Invoke-Retry([scriptblock]$Block, [int]$Tries = 12) {
  for ($i = 1; ; $i++) {
    try { return & $Block }
    catch {
      $m = $_.Exception.Message
      if (($m -notmatch '0x80010001|0x8001010A|RPC_E_CALL_REJECTED|busy|rejected the call') -or $i -ge $Tries) { throw }
      Start-Sleep -Milliseconds (150 * $i)
    }
  }
}

function New-WordPdf([string]$Dest) {
  $word = $null; $doc = $null
  try {
    $word = New-Object -ComObject Word.Application   # always a new, private instance
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $doc = $word.Documents.Add()
    $sel = $word.Selection
    $heading = { param($text, $style) $sel.Style = $doc.Styles.Item($style); $sel.TypeText($text); $sel.TypeParagraph() }
    $body = { param($text) $sel.Style = $doc.Styles.Item('Normal'); $sel.TypeText($text); $sel.TypeParagraph() }
    & $heading 'Word-produced document' 'Title'
    & $heading 'Introduction' 'Heading 1'
    & $body "$Lorem $Lorem"
    & $heading 'A list' 'Heading 2'
    $sel.Style = $doc.Styles.Item('List Bullet'); $sel.TypeText('First item'); $sel.TypeParagraph(); $sel.TypeText('Second item'); $sel.TypeParagraph()
    & $heading 'A table' 'Heading 2'
    $sel.Style = $doc.Styles.Item('Normal')
    $t = $doc.Tables.Add($sel.Range, 3, 3); $t.Borders.Enable = $true
    for ($r = 1; $r -le 3; $r++) { for ($c = 1; $c -le 3; $c++) { $t.Cell($r, $c).Range.Text = "R${r}C${c}" } }
    $sel.EndKey(6) | Out-Null  # wdStory
    $sel.TypeParagraph()
    & $body 'A hyperlink follows: '
    $doc.Hyperlinks.Add($sel.Range, 'https://example.com/', '', '', 'example.com') | Out-Null
    $sel.EndKey(6) | Out-Null
    $sel.InsertBreak(7)  # page break
    & $heading 'Second page' 'Heading 1'
    & $body "$Lorem $Lorem $Lorem"
    $miss = [Type]::Missing
    # Path, Format 17=PDF, OpenAfterExport, OptimizeFor 0=print, Range 0=all, From, To, Item 0=content,
    # IncludeDocProps, KeepIRM, CreateBookmarks 1=headings, DocStructureTags (tagged PDF)
    Invoke-Retry { $doc.ExportAsFixedFormat($Dest, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false) }
  }
  finally {
    if ($doc) { try { $doc.Close(0) } catch {} }
    if ($word) { try { $word.Quit(0) } catch {} ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
  }
}

function New-EdgePdf([string]$Dest) {
  $edge = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $edge) { throw 'Edge not found' }
  $body = '<h1>Chrome-produced document</h1><p>Printed by Edge headless. It is a <b>tagged</b> PDF with <i>embedded</i> fonts and a <a href="https://example.com/">link</a>.</p><table border="1"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><ul><li>One</li><li>Two</li></ul>'
  for ($i = 1; $i -le 40; $i++) { $body += "<h2>Section $i</h2><p>$Lorem $Lorem</p>" }
  $html = Join-Path $Work 'page.html'
  Set-Content -Path $html -Encoding UTF8 -Value "<!doctype html><html lang=`"en`"><head><meta charset=`"utf-8`"><title>chrome</title><style>body{font-family:Segoe UI,Arial,sans-serif;font-size:12pt}</style></head><body>$body</body></html>"
  $args = @('--headless=new', '--disable-gpu', '--no-first-run', "--user-data-dir=$(Join-Path $Work 'edge-profile')", '--no-pdf-header-footer', "--print-to-pdf=$Dest", ('file:///' + ($html -replace '\\', '/')))
  $p = Start-Process -FilePath $edge -ArgumentList $args -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch {} }
  for ($i = 0; $i -lt 20 -and -not (Test-Path $Dest); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path $Dest)) { throw 'Edge produced no PDF' }
}

try {
  if (Want 'word')   { $d = Join-Path $OutDir 'word.pdf';   New-WordPdf $d; '{0,-12} {1,9}' -f 'word.pdf', (Get-Item $d).Length }
  if (Want 'chrome') { $d = Join-Path $OutDir 'chrome.pdf'; New-EdgePdf $d; '{0,-12} {1,9}' -f 'chrome.pdf', (Get-Item $d).Length }
}
finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
