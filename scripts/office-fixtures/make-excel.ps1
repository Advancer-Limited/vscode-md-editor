<#
  make-excel.ps1 - authors the "real Excel" fixtures of spec 13.4 through desktop Excel COM.
  Usage: pwsh scripts/office-fixtures/make-excel.ps1 [-OutDir <dir>] [-Only basic,styles,...]
  Deterministic: fixed content, no Now(), personal information removed on save, fixed user name.
  (Excel still stamps modified dates and calcId; compare unzipped content ignoring docProps.)
  Creates its own hidden Excel instance, never touches other EXCEL processes, always Quit()s it.
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\tests\fixtures\office'),
  [string[]]$Only = @()
)
$ErrorActionPreference = 'Stop'
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$OutDir = [IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force $OutDir | Out-Null
New-Item -ItemType Directory -Force (Join-Path $OutDir 'expected') | Out-Null
$Work = Join-Path ([IO.Path]::GetTempPath()) ('vsmd-excel-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Work | Out-Null
$Missing = [Reflection.Missing]::Value

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
function Set-DocProp($wb, [string]$name, [string]$value) {
  $props = $wb.BuiltInDocumentProperties
  $bf = [Reflection.BindingFlags]
  $p = [System.__ComObject].InvokeMember('Item', $bf::GetProperty, $null, $props, @($name))
  [System.__ComObject].InvokeMember('Value', $bf::SetProperty, $null, $p, @($value)) | Out-Null
}
function New-Book([int]$sheets = 1) {
  $wb = Invoke-Retry { $script:xl.Workbooks.Add() }
  while ($wb.Worksheets.Count -gt 1) { $wb.Worksheets.Item($wb.Worksheets.Count).Delete() }
  while ($wb.Worksheets.Count -lt $sheets) {
    $last = $wb.Worksheets.Item($wb.Worksheets.Count)
    [void]$wb.Worksheets.Add($Missing, $last)
  }
  for ($i = 1; $i -le $sheets; $i++) { $wb.Worksheets.Item($i).Name = "Sheet$i" }
  return $wb
}
function Save-Book($wb, [string]$name, [string]$password = $null) {
  $path = Join-Path $OutDir $name
  if (Test-Path $path) { Remove-Item $path -Force }
  try { Set-DocProp $wb 'Title' 'Fixture'; Set-DocProp $wb 'Author' 'Fixture Author'; Set-DocProp $wb 'Company' '' } catch {}
  $wb.CheckCompatibility = $false
  $wb.RemovePersonalInformation = $true
  $wb.Worksheets.Item(1).Activate()
  Invoke-Retry {
    if ($password) { $wb.SaveAs([string]$path, [int]51, [string]$password) }
    else { $wb.SaveAs([string]$path, [int]51) }
  }
  Write-Host ("  wrote {0}" -f $name)
}
function Close-Book($wb) { Invoke-Retry { $wb.Close($false) } | Out-Null; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wb) }

# Write a jagged array of rows starting at (row, col) in one COM call.
function Set-Rows($ws, [int]$row, [int]$col, $rows) {
  $nr = $rows.Count; $nc = ($rows | ForEach-Object { $_.Count } | Measure-Object -Maximum).Maximum
  $arr = New-Object 'object[,]' $nr, $nc
  for ($i = 0; $i -lt $nr; $i++) { for ($j = 0; $j -lt $rows[$i].Count; $j++) { $arr[$i, $j] = $rows[$i][$j] } }
  $rng = $ws.Range($ws.Cells.Item($row, $col), $ws.Cells.Item($row + $nr - 1, $col + $nc - 1))
  $rng.Value2 = $arr
  return $rng
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
function Serial([string]$iso, [bool]$is1904 = $false) {
  $v = ([datetime]::ParseExact($iso, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)).ToOADate()
  if ($is1904) { $v -= 1462 }
  return $v
}
# RGB as Excel colour (BGR integer)
function Rgb([int]$r, [int]$g, [int]$b) { return $r + 256 * $g + 65536 * $b }

# Remove cached <v> values from every cell of one worksheet (to produce formulas with no cached value).
function Remove-CachedValues([string]$xlsx, [string]$sheetName) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::Open($xlsx, 'Update')
  try {
    $rd = { param($n) $e = $zip.GetEntry($n); $s = New-Object IO.StreamReader($e.Open(), [Text.Encoding]::UTF8); $t = $s.ReadToEnd(); $s.Close(); $t }
    $wbx = [xml](& $rd 'xl/workbook.xml'); $rels = [xml](& $rd 'xl/_rels/workbook.xml.rels')
    $sheet = @($wbx.workbook.sheets.sheet) | Where-Object { $_.name -eq $sheetName }
    $rid = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    $target = (@($rels.Relationships.Relationship) | Where-Object { $_.Id -eq $rid }).Target
    $partName = 'xl/' + $target.TrimStart('/').Replace('xl/', '')
    $xml = & $rd $partName
    $new = [regex]::Replace($xml, '(<f[^>]*>[^<]*</f>|<f[^>]*/>)<v>[^<]*</v>', '$1')
    $zip.GetEntry($partName).Delete()
    $e = $zip.CreateEntry($partName, [IO.Compression.CompressionLevel]::Optimal)
    $w = New-Object IO.StreamWriter($e.Open(), (New-Object Text.UTF8Encoding($false))); $w.Write($new); $w.Close()
  } finally { $zip.Dispose() }
}

# --- the fixtures ------------------------------------------------------------------------
function Make-Basic {
  $wb = New-Book 2
  $ws = $wb.Worksheets.Item(1); $ws.Name = 'Values'
  [void](Set-Rows $ws 1 1 @(
    ,@('Kind', 'Value', 'Note')
    ,@('Integer', 42, 'plain integer')
    ,@('Decimal', 3.14159, 'pi-ish')
    ,@('Negative', -17.5, 'negative')
    ,@('Large', 1234567890123, 'big integer')
    ,@('Text', 'Hello, world', 'ascii text')
    ,@('Unicode', "caf$([char]0xE9) $([char]0x65E5)$([char]0x672C)$([char]0x8A9E) $([char]::ConvertFromUtf32(0x1F600))", 'non-ascii')
    ,@('Padded', '  leading and trailing  ', 'whitespace preserved')
    ,@('Boolean TRUE', $true, 'boolean')
    ,@('Boolean FALSE', $false, 'boolean')
    ,@('Error div0', '#DIV/0!', 'constant error')
    ,@('Error N/A', '#N/A', 'constant error')
    ,@('Date', (Serial '2024-03-15 00:00'), 'short date')
    ,@('Date time', (Serial '2024-03-15 13:45'), 'date and time')
    ,@('Time', 0.75, 'time of day')
    ,@('Percent', 0.256, 'percent')
    ,@('Currency', 1234.5, 'currency')
    ,@('Custom unit', 12.5, 'custom format')
    ,@('Scientific', 0.000123, 'scientific')
    ,@('Fraction', 0.75, 'fraction')
    ,@('Text format', '007', 'text-formatted')
    ,@('Colour format', -3.5, 'colour sections')
    ,@('Empty next', $null, 'blank cell in B')
  ))
  $ws.Range('B13').NumberFormat = 'yyyy-mm-dd'
  $ws.Range('B14').NumberFormat = 'dd/mm/yyyy hh:mm'
  $ws.Range('B15').NumberFormat = 'h:mm AM/PM'
  $ws.Range('B16').NumberFormat = '0.00%'
  $ws.Range('B17').NumberFormat = '$#,##0.00'
  $ws.Range('B18').NumberFormat = '#,##0.00 "kg"'
  $ws.Range('B19').NumberFormat = '0.00E+00'
  $ws.Range('B20').NumberFormat = '# ?/?'
  $ws.Range('B21').NumberFormat = '@'; $ws.Range('B21').Value2 = '007'
  $ws.Range('B22').NumberFormat = '[Red]-0.0;[Blue]0.0'
  $ws.Range('A1:C1').Font.Bold = $true
  $ws.Columns.Item(1).ColumnWidth = 16; $ws.Columns.Item(2).ColumnWidth = 24; $ws.Columns.Item(3).ColumnWidth = 26
  $ws2 = $wb.Worksheets.Item(2); $ws2.Name = 'Second Sheet'
  [void](Set-Rows $ws2 1 1 @(,@('a', 'b'), ,@(1, 2), ,@(3, 4)))
  Save-Book $wb 'basic.xlsx'; Close-Book $wb
}

function Make-Styles {
  $png = $null
  $wb = New-Book 1
  $ws = $wb.Worksheets.Item(1); $ws.Name = 'Styles'
  $ws.Range('A1').Value2 = 'Fonts'; $ws.Range('A1').Font.Bold = $true; $ws.Range('A1').Font.Size = 14
  $ws.Range('A2').Value2 = 'Bold'; $ws.Range('A2').Font.Bold = $true
  $ws.Range('B2').Value2 = 'Italic'; $ws.Range('B2').Font.Italic = $true
  $ws.Range('C2').Value2 = 'Underline'; $ws.Range('C2').Font.Underline = 2
  $ws.Range('D2').Value2 = 'Strike'; $ws.Range('D2').Font.Strikethrough = $true
  $ws.Range('E2').Value2 = 'Courier 12'; $ws.Range('E2').Font.Name = 'Courier New'; $ws.Range('E2').Font.Size = 12
  $ws.Range('F2').Value2 = 'Red'; $ws.Range('F2').Font.Color = (Rgb 255 0 0)
  $ws.Range('A4').Value2 = 'Fills'; $ws.Range('A4').Font.Bold = $true
  $ws.Range('A5').Value2 = 'Yellow'; $ws.Range('A5').Interior.Color = (Rgb 255 255 0)
  $ws.Range('B5').Value2 = 'Accent1 tint +40%'; $ws.Range('B5').Interior.ThemeColor = 5; $ws.Range('B5').Interior.TintAndShade = 0.4
  $ws.Range('C5').Value2 = 'Accent2 tint -25%'; $ws.Range('C5').Interior.ThemeColor = 6; $ws.Range('C5').Interior.TintAndShade = -0.25
  $ws.Range('D5').Value2 = 'Text theme colour'; $ws.Range('D5').Font.ThemeColor = 7; $ws.Range('D5').Font.TintAndShade = -0.25
  $ws.Range('A7').Value2 = 'Borders'; $ws.Range('A7').Font.Bold = $true
  $ws.Range('A8').Value2 = 'Thin'; $ws.Range('A8').Borders.LineStyle = 1; $ws.Range('A8').Borders.Weight = 2
  $ws.Range('B8').Value2 = 'Thick bottom'; $ws.Range('B8').Borders.Item(9).LineStyle = 1; $ws.Range('B8').Borders.Item(9).Weight = 4
  $ws.Range('C8').Value2 = 'Dashed'; $ws.Range('C8').Borders.LineStyle = -4115
  $ws.Range('D8').Value2 = 'Double'; $ws.Range('D8').Borders.Item(8).LineStyle = -4119
  $ws.Range('D8').Borders.Item(8).Color = (Rgb 0 0 255)
  $ws.Range('A10').Value2 = 'Alignment'; $ws.Range('A10').Font.Bold = $true
  $ws.Range('A11').Value2 = 'Left'; $ws.Range('A11').HorizontalAlignment = -4131
  $ws.Range('B11').Value2 = 'Center'; $ws.Range('B11').HorizontalAlignment = -4108
  $ws.Range('C11').Value2 = 'Right'; $ws.Range('C11').HorizontalAlignment = -4152
  $ws.Range('D11').Value2 = 'Indented'; $ws.Range('D11').IndentLevel = 2
  $ws.Range('E11').Value2 = 'Wrapped text that needs several lines in a narrow column'; $ws.Range('E11').WrapText = $true
  $ws.Range('F11').Value2 = 'Rotated'; $ws.Range('F11').Orientation = 45
  $ws.Range('G11').Value2 = 'Top'; $ws.Range('G11').VerticalAlignment = -4160
  $ws.Range('H11').Value2 = 'Bottom'; $ws.Range('H11').VerticalAlignment = -4107
  $ws.Range('A13').Value2 = 'Merged'; $ws.Range('A13').Font.Bold = $true
  $ws.Range('A14:C14').Merge(); $ws.Range('A14').Value2 = 'Merged across A14:C14'; $ws.Range('A14').HorizontalAlignment = -4108
  $ws.Range('E13:E15').Merge(); $ws.Range('E13').Value2 = 'Merged down'; $ws.Range('E13').VerticalAlignment = -4108
  $ws.Range('A16:B17').Merge(); $ws.Range('A16').Value2 = '2x2 merge'; $ws.Range('A16:B17').Interior.Color = (Rgb 221 235 247)
  $ws.Range('A19').Value2 = 'Hidden / sizes'; $ws.Range('A19').Font.Bold = $true
  $ws.Range('A20').Value2 = 'Row 21 is hidden'; $ws.Range('A22').Value2 = 'Row 22 tall'
  $ws.Rows.Item(21).Hidden = $true; $ws.Rows.Item(22).RowHeight = 42
  $ws.Columns.Item(9).ColumnWidth = 3; $ws.Columns.Item(10).ColumnWidth = 30
  $ws.Range('I1').Value2 = 'narrow col'; $ws.Range('J1').Value2 = 'wide col'
  $ws.Range('K1').Value2 = 'col L hidden'; $ws.Columns.Item(12).Hidden = $true
  $ws.Columns.Item(1).ColumnWidth = 14; $ws.Columns.Item(5).ColumnWidth = 18
  $ws.Range('A24').Value2 = 'Frozen panes: row 1 and column A'
  # freeze row 1 and column A
  $xl.ActiveWindow.FreezePanes = $false
  $ws.Activate(); $xl.ActiveWindow.SplitColumn = 1; $xl.ActiveWindow.SplitRow = 1; $xl.ActiveWindow.FreezePanes = $true
  Save-Book $wb 'styles.xlsx'
  $pdf = Join-Path $OutDir 'expected\styles.pdf'
  if (Test-Path $pdf) { Remove-Item $pdf -Force }
  Invoke-Retry { $ws.ExportAsFixedFormat(0, [string]$pdf) }
  Write-Host '  wrote expected/styles.pdf'
  Close-Book $wb
}

function Make-Formulas {
  $wb = New-Book 4
  $d = $wb.Worksheets.Item(1); $d.Name = 'Data'
  $o = $wb.Worksheets.Item(2); $o.Name = 'My Sheet'
  $q = $wb.Worksheets.Item(3); $q.Name = "O'Brien"
  $n = $wb.Worksheets.Item(4); $n.Name = 'NoCache'
  [void](Set-Rows $d 1 1 @(,@('n', 'double', 'cross', 'name'), ,@(1), ,@(2), ,@(3), ,@(4), ,@(5), ,@(6), ,@(7), ,@(8), ,@(9)))
  $d.Range('B2:B10').Formula = '=A2*2'                                   # filled range => shared formula
  $d.Range('C2:C10').Formula = "='My Sheet'!A1+Data!A2"                 # cross-sheet + quoted sheet name
  [void]$wb.Names.Add('TaxRate', '=Data!$G$1'); $d.Range('G1').Value2 = 0.2
  [void]$wb.Names.Add('LocalName', '=Data!$G$2'); $wb.Names.Item('LocalName').Name = 'Data!LocalName'
  $d.Range('G2').Value2 = 7
  $d.Range('D2').Formula = '=A2*TaxRate'
  $d.Range('D3').Formula = '=A3+Data!LocalName'
  $d.Range('E2:E4').FormulaArray = '=A2:A4*10'                           # legacy array (CSE) formula
  $d.Range('F2').Formula = '=CONCAT("a",A2)'                              # _xlfn.CONCAT
  $d.Range('F3').Formula = '=IFS(A3>5,"big",TRUE,"small")'                # _xlfn.IFS
  $d.Range('F4').Formula = '=TEXTJOIN(",",TRUE,A2:A4)'                    # _xlfn.TEXTJOIN
  $d.Range('F5').Formula = '=STDEV.S(A2:A10)'                             # _xlfn.STDEV.S
  $d.Range('F6').Formula = '=XLOOKUP(3,A2:A10,B2:B10)'                    # _xlfn.XLOOKUP
  $d.Range('F7').Formula = '=SUM(A2:A10)'
  $d.Range('F8').Formula = '=IF(A8>5,"hi","lo")'
  $d.Range('F9').Formula = '=VLOOKUP(2,A2:B10,2,FALSE)'
  $o.Range('A1').Value2 = 10; $o.Range('A2').Formula = "=Data!A2+'O''Brien'!A1"
  $q.Range('A1').Value2 = 5; $q.Range('B1').Formula = "='My Sheet'!A1*TaxRate"
  # cells that will have their cached value stripped after saving
  $n.Range('A1').Formula = '=1+1'; $n.Range('A2').Formula = '=Data!A2*3'; $n.Range('A3').Formula = '=CONCAT("x","y")'
  $n.Range('A4').Formula = '=SUM(Data!A2:A10)'
  Save-Book $wb 'formulas.xlsx'; Close-Book $wb
  Remove-CachedValues (Join-Path $OutDir 'formulas.xlsx') 'NoCache'
  Write-Host '  stripped cached values from sheet NoCache'
}

function Make-Tables {
  $wb = New-Book 1
  $ws = $wb.Worksheets.Item(1); $ws.Name = 'Sales'
  [void](Set-Rows $ws 1 1 @(
    ,@('Region', 'Product', 'Units', 'Price', 'Total')
    ,@('North', 'Widget', 10, 2.5, $null)
    ,@('North', 'Gadget', 4, 9.99, $null)
    ,@('South', 'Widget', 7, 2.5, $null)
    ,@('South', 'Gadget', 12, 9.99, $null)
    ,@('East', 'Widget', 3, 2.5, $null)
  ))
  $lo = $ws.ListObjects.Add(1, $ws.Range('A1:E6'), $Missing, 1)
  $lo.Name = 'SalesTable'; $lo.TableStyle = 'TableStyleMedium2'
  $lo.ListColumns.Item(5).DataBodyRange.Formula = '=[@Units]*[@Price]'      # calculated column
  $lo.ShowTotals = $true
  $lo.ListColumns.Item(3).TotalsCalculation = 1                               # sum
  $lo.ListColumns.Item(5).TotalsCalculation = 1
  [void](Set-Rows $ws 10 1 @(,@('Name', 'Score'), ,@('Ann', 90), ,@('Bob', 85), ,@('Cy', 77)))
  $lo2 = $ws.ListObjects.Add(1, $ws.Range('A10:B13'), $Missing, 1)
  $lo2.Name = 'Scores'; $lo2.TableStyle = 'TableStyleLight9'; $lo2.ShowAutoFilter = $false
  $ws.Columns.Item(1).ColumnWidth = 12
  Save-Book $wb 'tables.xlsx'; Close-Book $wb
}

function Make-Features {
  $png = Join-Path $Work 'pic.png'; New-Png $png 96 64 ([int]0xFF70AD47)
  $wb = New-Book 3
  $ws = $wb.Worksheets.Item(1); $ws.Name = 'Features'
  $pd = $wb.Worksheets.Item(2); $pd.Name = 'PivotData'
  $pv = $wb.Worksheets.Item(3); $pv.Name = 'Pivot'
  [void](Set-Rows $ws 1 1 @(
    ,@('Item', 'Q1', 'Q2', 'Q3', 'Q4', 'Trend')
    ,@('Apples', 10, 25, 40, 55, $null)
    ,@('Pears', 60, 45, 30, 15, $null)
    ,@('Plums', 20, 50, 20, 50, $null)
  ))
  # chart
  $co = $ws.ChartObjects().Add(20, 160, 360, 200)
  $co.Name = 'Chart1'; $co.Chart.ChartType = 51; $co.Chart.SetSourceData($ws.Range('A1:E4'))
  $co.Chart.HasTitle = $true; $co.Chart.ChartTitle.Text = 'Quarterly units'
  # image
  [void]$ws.Shapes.AddPicture($png, $false, $true, 420, 160, 96, 64)
  # conditional formats
  $db = $ws.Range('B2:B4').FormatConditions.AddDatabar()
  $cs = $ws.Range('C2:C4').FormatConditions.AddColorScale(3)
  $cv = $ws.Range('D2:D4').FormatConditions.Add(1, 5, '=30')                  # cell value > 30
  $cv.Interior.Color = (Rgb 255 199 206); $cv.Font.Color = (Rgb 156 0 6)
  [void]$ws.Range('E2:E4').FormatConditions.AddIconSetCondition()
  # data validation
  [void]$ws.Range('H2').Value2; $ws.Range('H1').Value2 = 'Choice'
  $v = $ws.Range('H2').Validation; $v.Delete(); $v.Add(3, 1, 1, 'Yes,No,Maybe'); $ws.Range('H2').Value2 = 'Yes'
  $ws.Range('I1').Value2 = 'Whole 1-10'
  $v2 = $ws.Range('I2').Validation; $v2.Delete(); $v2.Add(1, 1, 1, '1', '10'); $v2.ErrorMessage = 'Enter 1 to 10'; $ws.Range('I2').Value2 = 5
  # comment (note)
  [void]$ws.Range('A2').AddComment('A note on Apples.')
  # hyperlinks
  $ws.Range('K1').Value2 = 'Links'
  [void]$ws.Hyperlinks.Add($ws.Range('K2'), 'https://example.com/', $Missing, 'Example', 'Example site')
  [void]$ws.Hyperlinks.Add($ws.Range('K3'), '', "'PivotData'!A1", 'Go to data', 'Internal link')
  # sparklines
  [void]$ws.Range('F2:F4').SparklineGroups.Add(1, 'Features!B2:E4')
  # pivot
  [void](Set-Rows $pd 1 1 @(
    ,@('Region', 'Product', 'Sales')
    ,@('North', 'Widget', 100) ,@('North', 'Gadget', 150) ,@('South', 'Widget', 80)
    ,@('South', 'Gadget', 120) ,@('East', 'Widget', 60) ,@('East', 'Gadget', 90) ,@('West', 'Widget', 70)
  ))
  $pc = $wb.PivotCaches().Create(1, 'PivotData!R1C1:R8C3')
  $pt = $pc.CreatePivotTable($pv.Range('A3'), 'PivotTable1')
  $pt.PivotFields('Region').Orientation = 1
  $pt.PivotFields('Product').Orientation = 2
  $df = $pt.AddDataField($pt.PivotFields('Sales'), 'Sum of Sales', -4157)
  Save-Book $wb 'features.xlsx'; Close-Book $wb
}

function Make-Date1904 {
  $wb = New-Book 1
  $wb.Date1904 = $true
  $ws = $wb.Worksheets.Item(1); $ws.Name = 'Dates1904'
  $ws.Range('A1').Value2 = 'Date (1904 system)'; $ws.Range('A1').Font.Bold = $true
  $ws.Range('A2').Value2 = (Serial '2024-03-15 00:00' $true); $ws.Range('A2').NumberFormat = 'yyyy-mm-dd'
  $ws.Range('A3').Value2 = (Serial '2000-01-01 00:00' $true); $ws.Range('A3').NumberFormat = 'yyyy-mm-dd'
  $ws.Range('A4').Value2 = (Serial '2024-12-31 18:30' $true); $ws.Range('A4').NumberFormat = 'dd/mm/yyyy hh:mm'
  $ws.Range('A5').Value2 = (Serial '1904-01-01 00:00' $true); $ws.Range('A5').NumberFormat = 'yyyy-mm-dd'
  $ws.Columns.Item(1).ColumnWidth = 22
  Save-Book $wb 'date1904.xlsx'; Close-Book $wb
}

function Make-ProtectedSheet {
  $wb = New-Book 1
  $ws = $wb.Worksheets.Item(1); $ws.Name = 'Locked'
  [void](Set-Rows $ws 1 1 @(,@('A', 'B'), ,@(1, 2), ,@(3, 4)))
  $ws.Range('B3').Locked = $false
  $ws.Protect()                                                # no password
  Save-Book $wb 'protected-sheet.xlsx'; Close-Book $wb
}
function Make-ProtectedStructure {
  $wb = New-Book 2
  $wb.Worksheets.Item(1).Range('A1').Value2 = 'structure is protected'
  $wb.Protect($Missing, $true, $false)                         # no password, protect structure
  Save-Book $wb 'protected-structure.xlsx'; Close-Book $wb
}

function Make-Large {
  $wb = New-Book 1
  $ws = $wb.Worksheets.Item(1); $ws.Name = 'Large'
  $rows = 4000; $cols = 50
  $arr = New-Object 'object[,]' $rows, $cols
  for ($i = 0; $i -lt $rows; $i++) {
    for ($j = 0; $j -lt $cols; $j++) {
      if ($j -eq 0) { $arr[$i, $j] = "row $($i + 1)" }
      elseif ($j % 7 -eq 0) { $arr[$i, $j] = "t$(($i * 31 + $j * 17) % 997)" }
      else { $arr[$i, $j] = [double]((($i + 1) * 131 + ($j + 1) * 7919) % 100003) / 100 }
    }
  }
  $ws.Range($ws.Cells.Item(1, 1), $ws.Cells.Item($rows, $cols)).Value2 = $arr
  Save-Book $wb 'large.xlsx'; Close-Book $wb
}

function Make-Encrypted {
  $wb = New-Book 1
  $ws = $wb.Worksheets.Item(1); $ws.Name = 'Secret'
  [void](Set-Rows $ws 1 1 @(,@('Password is', 'test'), ,@('Value', 123)))
  Save-Book $wb 'encrypted.xlsx' 'test'; Close-Book $wb
}

# --- driver ------------------------------------------------------------------------------
$xl = $null; $origUser = $null
try {
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false
  $origUser = $xl.UserName
  $xl.UserName = 'Fixture Author'
  $jobs = [ordered]@{
    'basic' = { Make-Basic }; 'styles' = { Make-Styles }; 'formulas' = { Make-Formulas }; 'tables' = { Make-Tables }
    'features' = { Make-Features }; 'date1904' = { Make-Date1904 }; 'protected-sheet' = { Make-ProtectedSheet }
    'protected-structure' = { Make-ProtectedStructure }; 'large' = { Make-Large }; 'encrypted' = { Make-Encrypted }
  }
  foreach ($k in $jobs.Keys) {
    if (Want $k) { Write-Host "== $k"; & $jobs[$k] }
  }
}
finally {
  if ($xl) {
    try { $xl.UserName = $origUser } catch {}
    try { foreach ($b in @($xl.Workbooks)) { $b.Close($false) } } catch {}
    try { $xl.Quit() } catch {}
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}
