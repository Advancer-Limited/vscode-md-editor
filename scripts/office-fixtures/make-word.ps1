<#
  make-word.ps1 - authors the "real Word" fixtures of spec 13.4 through desktop Word COM.
  Usage: pwsh scripts/office-fixtures/make-word.ps1 [-OutDir <dir>] [-Only basic,tables,...]
  Deterministic: fixed text, fixed author/user name, no RSIDs, no Now(). (Word still stamps
  creation/modified dates and revision dates; compare unzipped content ignoring those.)
  Creates its own hidden Word instance, never touches other WINWORD processes, always Quit()s it.
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\tests\fixtures\office'),
  [string[]]$Only = @()
)
$ErrorActionPreference = 'Stop'
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$OutDir = [IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force $OutDir | Out-Null
$Work = Join-Path ([IO.Path]::GetTempPath()) ('vsmd-word-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Work | Out-Null

# --- COM helpers -------------------------------------------------------------------------
function Invoke-Retry([scriptblock]$Block, [int]$Tries = 12) {
  for ($i = 1; ; $i++) {
    try { return & $Block }
    catch {
      $m = $_.Exception.Message
      $busy = ($m -match '0x80010001|0x8001010A|RPC_E_CALL_REJECTED|busy|rejected the call')
      if (-not $busy -or $i -ge $Tries) { throw }
      Start-Sleep -Milliseconds (150 * $i)
    }
  }
}
function Set-DocProp($doc, [string]$name, [string]$value) {
  $props = $doc.BuiltInDocumentProperties
  $bf = [Reflection.BindingFlags]
  $p = [System.__ComObject].InvokeMember('Item', $bf::GetProperty, $null, $props, @($name))
  [System.__ComObject].InvokeMember('Value', $bf::SetProperty, $null, $p, @($value)) | Out-Null
}
function Set-FixedProps($doc) {
  Set-DocProp $doc 'Title' 'Fixture'
  Set-DocProp $doc 'Author' 'Fixture Author'
  Set-DocProp $doc 'Last Author' 'Fixture Author'
  Set-DocProp $doc 'Company' ''
  Set-DocProp $doc 'Manager' ''
}
function Save-Doc($doc, [string]$name, [int]$format = 12, [string]$password = $null) {
  $path = Join-Path $OutDir $name
  if (Test-Path $path) { Remove-Item $path -Force }
  Set-FixedProps $doc
  Invoke-Retry {
    if ($password) {
      $doc.SaveAs2([string]$path, [int]$format, $false, [string]$password)
    } else {
      $doc.SaveAs2([string]$path, [int]$format)
    }
  }
  Write-Host ("  wrote {0}" -f $name)
}
function New-Doc {
  $d = Invoke-Retry { $script:word.Documents.Add() }
  $d.TrackRevisions = $false
  return $d
}
function Close-Doc($doc) { Invoke-Retry { $doc.Close(0) } | Out-Null; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }

# builtin style ids (locale independent)
$S_NORMAL = -1; $S_H1 = -2; $S_H2 = -3; $S_H3 = -4; $S_TITLE = -63

# Append a paragraph at the end of the document and return its range (text without the mark).
function Add-Para($doc, [string]$text, $style = $S_NORMAL) {
  $end = $doc.Content.End - 1
  $r = $doc.Range($end, $end)
  $r.InsertAfter($text)
  $r.Style = $doc.Styles.Item($style)
  $doc.Content.InsertParagraphAfter()
  # the fresh paragraph after must be Normal and unformatted
  $last = $doc.Paragraphs.Last.Range
  $last.Style = $doc.Styles.Item($S_NORMAL)
  $last.ListFormat.RemoveNumbers()
  $last.Font.Reset()
  return $r
}
# Append formatted text to the last paragraph (no new paragraph).
function Add-Run($doc, [string]$text, [hashtable]$fmt = @{}) {
  $end = $doc.Content.End - 1
  $r = $doc.Range($end, $end)
  $r.InsertAfter($text)
  $r.Font.Reset()
  foreach ($k in $fmt.Keys) { $r.Font.$k = $fmt[$k] }
  return $r
}
function End-Para($doc) { $doc.Content.InsertParagraphAfter(); $doc.Paragraphs.Last.Range.Font.Reset() }
# Range at the end of the text of the paragraph before the trailing empty one.
function Prev-ParaEnd($doc) {
  $r = $doc.Paragraphs.Item($doc.Paragraphs.Count - 1).Range
  $r.MoveEnd(1, -1) | Out-Null
  $r.Collapse(0)
  return $r
}

function New-Png([string]$path, [int]$w, [int]$h, [int]$argb) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb($argb))
  $g.DrawRectangle([System.Drawing.Pens]::Black, 1, 1, $w - 3, $h - 3)
  $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

function Want([string]$n) { return ($Only.Count -eq 0 -or $Only -contains $n) }

# --- the fixtures ------------------------------------------------------------------------
function Make-Basic {
  $d = New-Doc
  [void](Add-Para $d 'Fixture Basic' $S_TITLE)
  [void](Add-Para $d 'Heading One' $S_H1)
  [void](Add-Para $d 'A plain paragraph with ordinary text.')
  [void](Add-Para $d 'Heading Two' $S_H2)
  [void](Add-Run $d 'This paragraph has ' @{})
  [void](Add-Run $d 'bold' @{ Bold = 1 })
  [void](Add-Run $d ', ' @{})
  [void](Add-Run $d 'italic' @{ Italic = 1 })
  [void](Add-Run $d ' and ' @{})
  [void](Add-Run $d 'underlined' @{ Underline = 1 })
  [void](Add-Run $d ' text.' @{})
  End-Para $d
  [void](Add-Para $d 'Heading Three' $S_H3)
  # bullet list
  $start = $d.Content.End - 1
  [void](Add-Para $d 'Bullet one'); [void](Add-Para $d 'Bullet two'); [void](Add-Para $d 'Bullet three')
  $d.Range($start, $d.Content.End - 1).ListFormat.ApplyBulletDefault()
  $d.Paragraphs.Last.Range.ListFormat.RemoveNumbers()
  # numbered list with a nested level
  $start = $d.Content.End - 1
  [void](Add-Para $d 'Step one'); [void](Add-Para $d 'Step two'); [void](Add-Para $d 'Nested step A'); [void](Add-Para $d 'Nested step B'); [void](Add-Para $d 'Step three')
  $d.Range($start, $d.Content.End - 1).ListFormat.ApplyNumberDefault()
  $d.Paragraphs.Item($d.Paragraphs.Count - 3).Range.ListFormat.ListIndent()
  $d.Paragraphs.Item($d.Paragraphs.Count - 2).Range.ListFormat.ListIndent()
  $d.Paragraphs.Last.Range.ListFormat.RemoveNumbers()
  [void](Add-Para $d 'Final paragraph.')
  Save-Doc $d 'basic.docx'; Close-Doc $d
}

function Make-MultiRun {
  $d = New-Doc
  [void](Add-Para $d 'Multi-run paragraph' $S_H1)
  [void](Add-Run $d 'Plain ' @{})
  [void](Add-Run $d 'bold ' @{ Bold = 1 })
  [void](Add-Run $d 'italic ' @{ Italic = 1 })
  [void](Add-Run $d 'both ' @{ Bold = 1; Italic = 1 })
  [void](Add-Run $d 'underline ' @{ Underline = 1 })
  [void](Add-Run $d 'strike ' @{ StrikeThrough = 1 })
  [void](Add-Run $d 'big ' @{ Size = 18 })
  [void](Add-Run $d 'red ' @{ Color = 255 })
  [void](Add-Run $d 'mono ' @{ Name = 'Consolas' })
  [void](Add-Run $d 'sup' @{ Superscript = 1 })
  [void](Add-Run $d "`tafter-tab" @{})
  [void](Add-Run $d "`vsoft line break" @{})
  [void](Add-Run $d "`tsecond-tab end." @{ Bold = 1 })
  End-Para $d
  [void](Add-Para $d 'Another paragraph.')
  Save-Doc $d 'multi-run.docx'; Close-Doc $d
}

function Make-Rich {
  $png1 = Join-Path $Work 'p1.png'; $png2 = Join-Path $Work 'p2.png'
  New-Png $png1 120 60 ([int]0xFF4080C0); New-Png $png2 80 80 ([int]0xFFC08040)
  $d = New-Doc
  [void](Add-Para $d 'Rich document' $S_H1)
  [void](Add-Para $d 'Paragraph before the table.')
  $r = $d.Range($d.Content.End - 1, $d.Content.End - 1)
  $t = $d.Tables.Add($r, 3, 3)
  $t.Borders.Enable = $true
  for ($i = 1; $i -le 3; $i++) { for ($j = 1; $j -le 3; $j++) { $t.Cell($i, $j).Range.Text = "R${i}C${j}" } }
  [void](Add-Para $d 'Paragraph with an inline picture: ')
  $ins = Prev-ParaEnd $d
  [void]$d.InlineShapes.AddPicture($png1, $false, $true, $ins)
  [void](Add-Para $d 'Paragraph with a floating picture anchored here. This sentence wraps around the picture to show text flow.')
  $anchor = $d.Paragraphs.Item($d.Paragraphs.Count - 1).Range
  $sh = $d.Shapes.AddPicture($png2, $false, $true, 300, 20, 80, 80, $anchor)
  $sh.WrapFormat.Type = 0
  [void](Add-Para $d 'A paragraph with a footnote.')
  $fr = Prev-ParaEnd $d
  [void]$d.Footnotes.Add($fr, [Type]::Missing, 'Footnote text.')
  [void](Add-Para $d 'A hyperlink: ')
  $hr = Prev-ParaEnd $d
  [void]$d.Hyperlinks.Add($hr, 'https://example.com/', [Type]::Missing, 'Example', 'example link')
  $d.Paragraphs.Last.Range.InsertBreak(7)         # page break
  [void](Add-Para $d 'Page two paragraph.')
  $d.Paragraphs.Last.Range.InsertBreak(2)         # section break (next page)
  [void](Add-Para $d 'Section two paragraph.')
  $sec = $d.Sections.Item(1)
  $sec.Headers.Item(1).Range.Text = 'Fixture header'
  $sec.Footers.Item(1).Range.Text = 'Fixture footer'
  Save-Doc $d 'rich.docx'; Close-Doc $d
}

function Make-Fields {
  $d = New-Doc
  [void](Add-Para $d 'Fields document' $S_TITLE)
  [void](Add-Para $d 'Table of contents follows')
  [void](Add-Para $d 'Chapter One' $S_H1)
  [void](Add-Para $d 'Text of chapter one.')
  [void](Add-Para $d 'Chapter Two' $S_H1)
  [void](Add-Para $d 'Text of chapter two.')
  $d.Paragraphs.Last.Range.InsertBreak(7)
  [void](Add-Para $d 'Page number field: ')
  $pn = Prev-ParaEnd $d
  [void]$d.Fields.Add($pn, 33)                    # wdFieldPage
  [void](Add-Para $d 'Cross reference: ')
  $cr = Prev-ParaEnd $d
  $cr.InsertCrossReference('Heading', -1, 2, $true)  # heading item 2, wdContentText
  [void](Add-Para $d 'Date field: ')
  $dr = Prev-ParaEnd $d
  $df = $d.Fields.Add($dr, 31)                    # wdFieldDate
  $df.Result.Text = '1 January 2020'              # fixed cached result (determinism)
  # TOC after the "Table of contents follows" paragraph
  $tocPos = $d.Paragraphs.Item(2).Range; $tocPos.Collapse(0)
  [void]$d.TablesOfContents.Add($tocPos, $true, 1, 2)
  Invoke-Retry { $d.TablesOfContents.Item(1).Update() }
  Save-Doc $d 'fields.docx'; Close-Doc $d
}

function Make-Anchors {
  $d = New-Doc
  [void](Add-Para $d 'Anchors document' $S_H1)
  [void](Add-Para $d 'The quick brown fox jumps over the lazy dog near the riverbank.')
  $p = $d.Paragraphs.Item(2).Range
  [void]$d.Bookmarks.Add('fox_bm', $d.Range($p.Start + 4, $p.Start + 19))
  [void]$d.Comments.Add($d.Range($p.Start + 10, $p.Start + 19), 'Comment on brown fox.')
  [void](Add-Para $d 'A second paragraph with a bookmark and a comment on a short range.')
  $p2 = $d.Paragraphs.Item(3).Range
  [void]$d.Bookmarks.Add('second_bm', $d.Range($p2.Start + 2, $p2.Start + 11))
  [void]$d.Comments.Add($d.Range($p2.Start + 30, $p2.Start + 38), 'Comment two.')
  [void](Add-Para $d 'Third paragraph with a whole-paragraph bookmark.')
  [void]$d.Bookmarks.Add('whole_bm', $d.Paragraphs.Item(4).Range)
  Save-Doc $d 'anchors.docx'; Close-Doc $d
}

function Make-Tracked {
  $d = New-Doc
  [void](Add-Para $d 'Tracked changes document' $S_H1)
  [void](Add-Para $d 'This sentence stays. This one will be deleted. This one gets a word replaced.')
  [void](Add-Para $d 'A second paragraph that will receive an insertion.')
  $d.TrackRevisions = $true
  $p = $d.Paragraphs.Item(2).Range
  $find = 'This one will be deleted. '
  $idx = $p.Text.IndexOf($find)
  $d.Range($p.Start + $idx, $p.Start + $idx + $find.Length).Delete() | Out-Null
  $p = $d.Paragraphs.Item(2).Range
  $idx = $p.Text.IndexOf('replaced')
  $rr = $d.Range($p.Start + $idx, $p.Start + $idx + 8); $rr.Text = 'changed'
  $p3 = $d.Paragraphs.Item(3).Range
  $e = $d.Range($p3.End - 1, $p3.End - 1); $e.InsertAfter(' Inserted text here.')
  # Track Changes stays on when saved (spec: "Track Changes on")
  Save-Doc $d 'tracked.docx'; Close-Doc $d
}

function Make-Protected {
  $d = New-Doc
  [void](Add-Para $d 'Protected document' $S_H1)
  [void](Add-Para $d 'This document enforces read-only protection (no password).')
  $d.Protect(3)                                   # wdAllowOnlyReading
  Save-Doc $d 'protected.docx'; Close-Doc $d
}

function Make-NoHeading {
  $d = New-Doc
  [void](Add-Para $d 'Plain paragraph one. No heading styles are used anywhere in this document.')
  [void](Add-Para $d 'Plain paragraph two.')
  [void](Add-Para $d 'Plain paragraph three.')
  Save-Doc $d 'no-heading-styles.docx'; Close-Doc $d
}

function Make-NoNumbering {
  $d = New-Doc
  [void](Add-Para $d 'No numbering document' $S_H1)
  [void](Add-Para $d 'This document has no lists, so no numbering part is written.')
  Save-Doc $d 'no-numbering.docx'; Close-Doc $d
}

function Make-ContentControls {
  $d = New-Doc
  [void](Add-Para $d 'Content controls' $S_H1)
  [void](Add-Para $d 'Rich text control: ')
  $cc = $d.ContentControls.Add(0, (Prev-ParaEnd $d)); $cc.Title = 'Rich'; $cc.Range.Text = 'rich value'
  [void](Add-Para $d 'Plain text control: ')
  $cc = $d.ContentControls.Add(1, (Prev-ParaEnd $d)); $cc.Title = 'Plain'; $cc.Range.Text = 'plain value'
  [void](Add-Para $d 'Drop-down control: ')
  $cc = $d.ContentControls.Add(4, (Prev-ParaEnd $d)); $cc.Title = 'Choice'
  [void]$cc.DropdownListEntries.Add('Alpha', 'a'); [void]$cc.DropdownListEntries.Add('Beta', 'b')
  [void](Add-Para $d 'Checkbox control: ')
  $cc = $d.ContentControls.Add(8, (Prev-ParaEnd $d)); $cc.Title = 'Check'
  # block-level control wrapping a whole paragraph
  [void](Add-Para $d 'Paragraph wrapped in a block-level control.')
  $pr = $d.Paragraphs.Item($d.Paragraphs.Count - 1).Range
  $cc = $d.ContentControls.Add(0, $pr); $cc.Title = 'Block'
  [void](Add-Para $d 'Ordinary paragraph after the controls.')
  Save-Doc $d 'content-controls.docx'; Close-Doc $d
}

function New-TableHere($d, [int]$rows, [int]$cols) {
  $t = $d.Tables.Add($d.Range($d.Content.End - 1, $d.Content.End - 1), $rows, $cols)
  $t.Borders.Enable = $true
  return $t
}

$script:SdtRowXml = @'
<pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage"><pkg:part pkg:name="/_rels/.rels" pkg:contentType="application/vnd.openxmlformats-package.relationships+xml"><pkg:xmlData><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships></pkg:xmlData></pkg:part><pkg:part pkg:name="/word/document.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"><pkg:xmlData><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w:body><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>CC11</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CC12</w:t></w:r></w:p></w:tc></w:tr><w:sdt><w:sdtPr><w:alias w:val="Row section"/><w:tag w:val="rowsec"/><w:id w:val="1001"/><w15:repeatingSection/></w:sdtPr><w:sdtContent><w:sdt><w:sdtPr><w:id w:val="1002"/><w15:repeatingSectionItem/></w:sdtPr><w:sdtContent><w:tr><w:tc><w:p><w:r><w:t>CC21</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CC22</w:t></w:r></w:p></w:tc></w:tr></w:sdtContent></w:sdt></w:sdtContent></w:sdt><w:tr><w:tc><w:p><w:r><w:t>CC31</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CC32</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/></w:body></w:document></pkg:xmlData></pkg:part></pkg:package>
'@

function Make-Tables {
  $d = New-Doc
  [void](Add-Para $d 'Tables document' $S_H1)

  # 1. mixed run formatting in cells
  [void](Add-Para $d 'Table 1: mixed run formatting')
  $t = New-TableHere $d 2 2
  $t.Cell(1, 1).Range.Text = 'plain bold italic'
  $c = $t.Cell(1, 1).Range; $s = $c.Start
  $d.Range($s + 6, $s + 10).Font.Bold = 1
  $d.Range($s + 11, $s + 17).Font.Italic = 1
  $t.Cell(1, 2).Range.Text = 'second cell'
  $t.Cell(2, 1).Range.Text = "two`rparagraphs"
  $t.Cell(2, 2).Range.Text = 'underlined'; $t.Cell(2, 2).Range.Font.Underline = 1
  [void](Add-Para $d 'After table 1.')

  # 2. list inside a cell
  [void](Add-Para $d 'Table 2: list in a cell')
  $t = New-TableHere $d 1 2
  $t.Cell(1, 1).Range.Text = "Item one`rItem two`rItem three"
  $t.Cell(1, 1).Range.ListFormat.ApplyBulletDefault()
  $t.Cell(1, 2).Range.Text = 'neighbour'
  [void](Add-Para $d 'After table 2.')

  # 3. nested table, in a cell that ends with the nested table
  [void](Add-Para $d 'Table 3: nested table')
  $t = New-TableHere $d 2 2
  $t.Cell(1, 1).Range.Text = 'outer 1,1'
  $t.Cell(1, 2).Range.Text = 'outer 1,2'
  $t.Cell(2, 2).Range.Text = 'outer 2,2'
  $t.Cell(2, 1).Range.Text = "outer 2,1 (ends in a nested table)`r"
  $cr = $t.Cell(2, 1).Range; $cr.MoveEnd(1, -1) | Out-Null; $cr.Collapse(0)
  $nt = $d.Tables.Add($cr, 2, 2); $nt.Borders.Enable = $true
  $nt.Cell(1, 1).Range.Text = 'in 1,1'; $nt.Cell(1, 2).Range.Text = 'in 1,2'
  $nt.Cell(2, 1).Range.Text = 'in 2,1'; $nt.Cell(2, 2).Range.Text = 'in 2,2'
  [void](Add-Para $d 'After table 3.')

  # 4. gridSpan and vMerge
  [void](Add-Para $d 'Table 4: merged cells')
  $t = New-TableHere $d 4 4
  for ($i = 1; $i -le 4; $i++) { for ($j = 1; $j -le 4; $j++) { $t.Cell($i, $j).Range.Text = "M${i}${j}" } }
  $t.Cell(1, 1).Merge($t.Cell(1, 2))              # horizontal: gridSpan=2
  $t.Cell(2, 4).Merge($t.Cell(4, 4))              # vertical: vMerge restart/continue
  $t.Cell(3, 1).Merge($t.Cell(3, 3))              # gridSpan=3
  [void](Add-Para $d 'After table 4.')

  # 5. content-control row (repeating section => w:sdt around w:tr)
  [void](Add-Para $d 'Table 5: content-control row')
  # Word's COM cannot wrap a row in a repeating-section control, so insert the table as flat OPC XML.
  $d.Range($d.Content.End - 1, $d.Content.End - 1).InsertXML($script:SdtRowXml)
  [void](Add-Para $d 'After table 5.')

  # 6. table spanning a page break
  [void](Add-Para $d 'Table 6: spans a page break')
  $t = New-TableHere $d 70 2
  for ($i = 1; $i -le 70; $i++) { $t.Cell($i, 1).Range.Text = "Row $i"; $t.Cell($i, 2).Range.Text = "Value $($i * 7)" }
  [void](Add-Para $d 'After table 6.')

  # 7. tracked row insertion
  [void](Add-Para $d 'Table 7: tracked row insertion')
  $t = New-TableHere $d 2 2
  for ($i = 1; $i -le 2; $i++) { for ($j = 1; $j -le 2; $j++) { $t.Cell($i, $j).Range.Text = "T${i}${j}" } }
  $d.TrackRevisions = $true
  $nr = $t.Rows.Add()
  $nr.Cells.Item(1).Range.Text = 'inserted row A'; $nr.Cells.Item(2).Range.Text = 'inserted row B'
  $d.TrackRevisions = $false
  [void](Add-Para $d 'Final paragraph.')
  Save-Doc $d 'tables.docx'; Close-Doc $d
}

function Make-Large {
  $d = New-Doc
  $words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.Split(' ')
  $chapters = 48
  for ($c = 1; $c -le $chapters; $c++) {
    [void](Add-Para $d "Chapter $c" $S_H1)
    $sb = New-Object Text.StringBuilder
    for ($p = 1; $p -le 40; $p++) {
      for ($w = 0; $w -lt 70; $w++) { [void]$sb.Append($words[($c * 7 + $p * 3 + $w) % $words.Count]).Append(' ') }
      if ($p -lt 40) { [void]$sb.Length--; [void]$sb.Append("`r") }
    }
    $end = $d.Content.End - 1
    $d.Range($end, $end).InsertAfter($sb.ToString().TrimEnd())
    $d.Content.InsertParagraphAfter()
    $d.Paragraphs.Last.Range.Style = $d.Styles.Item($S_NORMAL)
  }
  Write-Host ("  large.docx pages: {0}" -f $d.ComputeStatistics(2))
  Save-Doc $d 'large.docx'; Close-Doc $d
}

function Make-Encrypted {
  $d = New-Doc
  [void](Add-Para $d 'Encrypted document' $S_H1)
  [void](Add-Para $d 'Password is: test')
  Save-Doc $d 'encrypted.docx' 12 'test'; Close-Doc $d
}

function Make-LegacyRenamed {
  $d = New-Doc
  [void](Add-Para $d 'Legacy binary document' $S_H1)
  [void](Add-Para $d 'This is a Word 97-2003 .doc saved with a .docx extension.')
  $tmp = Join-Path $Work 'legacy.doc'
  Set-FixedProps $d
  Invoke-Retry { $d.SaveAs2([string]$tmp, [int]0) }  # wdFormatDocument97
  Close-Doc $d
  Copy-Item $tmp (Join-Path $OutDir 'legacy-renamed.docx') -Force
  Write-Host '  wrote legacy-renamed.docx'
}

# --- driver ------------------------------------------------------------------------------
$word = $null; $origUser = $null; $origInit = $null; $origRsid = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $origUser = $word.UserName; $origInit = $word.UserInitials; $origRsid = $word.Options.StoreRSIDOnSave; $origSpell = $word.Options.CheckSpellingAsYouType; $origGram = $word.Options.CheckGrammarAsYouType
  $origLocal = $word.Options.UseLocalUserInfo
  $word.Options.UseLocalUserInfo = $true
  $word.UserName = 'Fixture Author'; $word.UserInitials = 'FA'
  $word.Options.StoreRSIDOnSave = $false
  $word.Options.CheckSpellingAsYouType = $false; $word.Options.CheckGrammarAsYouType = $false   # no w:proofState noise

  $jobs = [ordered]@{
    'basic' = { Make-Basic }; 'multi-run' = { Make-MultiRun }; 'rich' = { Make-Rich }; 'fields' = { Make-Fields }
    'anchors' = { Make-Anchors }; 'tracked' = { Make-Tracked }; 'protected' = { Make-Protected }
    'no-heading-styles' = { Make-NoHeading }; 'no-numbering' = { Make-NoNumbering }
    'content-controls' = { Make-ContentControls }; 'tables' = { Make-Tables }; 'large' = { Make-Large }
    'encrypted' = { Make-Encrypted }; 'legacy-renamed' = { Make-LegacyRenamed }
  }
  foreach ($k in $jobs.Keys) {
    if (Want $k) { Write-Host "== $k"; & $jobs[$k] }
  }
}
finally {
  if ($word) {
    try { $word.UserName = $origUser; $word.UserInitials = $origInit; $word.Options.StoreRSIDOnSave = $origRsid; $word.Options.UseLocalUserInfo = $origLocal; $word.Options.CheckSpellingAsYouType = $origSpell; $word.Options.CheckGrammarAsYouType = $origGram } catch {}
    try { foreach ($doc in @($word.Documents)) { $doc.Close(0) } } catch {}
    try { $word.Quit(0) } catch {}
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}
