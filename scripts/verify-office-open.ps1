<#
.SYNOPSIS
  Release gate (spec 13.5 layer 1): open every .docx/.xlsx under tests/.out in real Word/Excel with repair disabled.

.DESCRIPTION
  Dev-only, Windows, needs desktop Office. Creates its OWN hidden Word/Excel instances (never attaches to or kills
  running ones), DisplayAlerts off, files opened read-only, closed without saving, apps quit in `finally`.
  Fails (exit 1) on any open error, any detected repair/corruption, or any .expect.json mismatch.
  A sibling <name>.expect.json ({"cells":[{"sheet":"Sheet1","ref":"B2","value":42}]}) is read back after Excel
  recalculates (written by tests/office/_helpers.mjs writeOut(..., expect)).

.PARAMETER Path      Root folder or single file. Default: <repo>/tests/.out
.PARAMETER Kind      All | Word | Excel. Default All.
.PARAMETER DryRun    List the files that would be opened and exit 0 without creating any COM object. (-WhatIf is an alias.)
.PARAMETER JsonPath  Also write the summary JSON to this file.
.PARAMETER Tolerance Numeric comparison tolerance for expect.json values (default 1e-9).

  Exit codes: 0 all passed (or dry run), 1 any failure, 2 usage / no files / Office unavailable.
#>
[CmdletBinding()]
param(
  [string]$Path,
  [ValidateSet('All', 'Word', 'Excel')][string]$Kind = 'All',
  [Alias('WhatIf')][switch]$DryRun,
  [string]$JsonPath,
  [double]$Tolerance = 1e-9
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
if (-not $Path) { $Path = Join-Path $repo 'tests\.out' }
if (-not (Test-Path -LiteralPath $Path)) { Write-Error "Path not found: $Path (run npm test first)"; exit 2 }

function Get-OfficeFiles {
  param([string]$Root, [string]$Kind)
  $exts = @()
  if ($Kind -in 'All', 'Word') { $exts += '.docx' }
  if ($Kind -in 'All', 'Excel') { $exts += '.xlsx' }
  $item = Get-Item -LiteralPath $Root
  $all = if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $Root -Recurse -File } else { @($item) }
  # Skip Office lock files (~$name.docx).
  $all | Where-Object { ($exts -contains $_.Extension.ToLowerInvariant()) -and -not $_.Name.StartsWith('~$') } |
    Sort-Object FullName
}

function Get-ExpectPath {
  param([string]$File)
  return [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($File), [System.IO.Path]::GetFileNameWithoutExtension($File) + '.expect.json')
}

function Add-Result {
  param($List, [string]$File, [string]$App, [bool]$Ok, [string]$Detail)
  $List.Add([pscustomobject]@{ file = $File; app = $App; ok = $Ok; detail = $Detail })
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("[{0}] {1}: {2} {3}" -f $tag, $App, $File, $Detail)
}

function Remove-ComObject {
  param($Obj)
  if ($null -ne $Obj) {
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Obj) } catch { }
  }
}

$files = @(Get-OfficeFiles -Root $Path -Kind $Kind)
$rootItem = Get-Item -LiteralPath $Path
$rootFull = if ($rootItem.PSIsContainer) { $rootItem.FullName } else { $rootItem.DirectoryName }
function Get-RelName {
  param([string]$F)
  if ($F.StartsWith($rootFull)) { return $F.Substring($rootFull.Length).TrimStart('\', '/') }
  return $F
}

if ($files.Count -eq 0) { Write-Host "No .docx/.xlsx files under $Path"; exit 2 }

if ($DryRun) {
  Write-Host 'DRY RUN: no Office objects will be created. Files that would be opened:'
  foreach ($f in $files) {
    $app = if ($f.Extension -ieq '.docx') { 'Word' } else { 'Excel' }
    $note = if (($app -eq 'Excel') -and (Test-Path -LiteralPath (Get-ExpectPath $f.FullName))) { ' (+expect.json)' } else { '' }
    Write-Host ("  {0,-5} {1}{2}" -f $app, (Get-RelName $f.FullName), $note)
  }
  Write-Host ("{0} file(s)." -f $files.Count)
  exit 0
}

$results = New-Object 'System.Collections.Generic.List[object]'
$docx = @($files | Where-Object { $_.Extension -ieq '.docx' })
$xlsx = @($files | Where-Object { $_.Extension -ieq '.xlsx' })
$officeMissing = $false

# ---------- Word ----------
if ($docx.Count -gt 0) {
  $word = $null
  try {
    try {
      $word = New-Object -ComObject Word.Application   # always a new instance
      $word.Visible = $false
      $word.DisplayAlerts = 0                           # wdAlertsNone
      try { $word.AutomationSecurity = 3 } catch { }    # msoAutomationSecurityForceDisable: no macros
    } catch {
      $officeMissing = $true
      Add-Result $results '(Word)' 'Word' $false "Cannot start Word: $($_.Exception.Message)"
      $word = $null
    }
    if ($word) {
      foreach ($f in $docx) {
        $doc = $null
        $name = Get-RelName $f.FullName
        try {
          $missing = [Type]::Missing
          # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate,
          #      Revert, WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible, OpenAndRepair,
          #      DocumentDirection, NoEncodingDialog, XMLTransform)
          # OpenAndRepair=$false: a damaged file raises an error instead of being silently repaired.
          $doc = $word.Documents.Open([ref]$f.FullName, [ref]$false, [ref]$true, [ref]$false, [ref]'', [ref]'',
            [ref]$false, [ref]'', [ref]'', [ref]$missing, [ref]$missing, [ref]$false, [ref]$false,
            [ref]$missing, [ref]$true, [ref]$missing)
          $problems = @()
          try { [void]$doc.Paragraphs.Count; [void]$doc.Content.Text.Length } catch { $problems += "content unreadable: $($_.Exception.Message)" }
          if ($problems.Count -eq 0) { Add-Result $results $name 'Word' $true 'opened without repair' }
          else { Add-Result $results $name 'Word' $false ($problems -join '; ') }
        } catch {
          Add-Result $results $name 'Word' $false $_.Exception.Message
        } finally {
          if ($doc) {
            try { $doc.Close([ref]0) } catch { }          # wdDoNotSaveChanges
            Remove-ComObject $doc
          }
        }
      }
    }
  } finally {
    if ($word) {
      try { $word.Quit([ref]0) } catch { }
      Remove-ComObject $word
    }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
}

# ---------- Excel ----------
function Test-ExpectCells {
  param($Workbook, [string]$ExpectPath, [double]$Tol)
  $problems = @()
  $spec = Get-Content -LiteralPath $ExpectPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Workbook.Application.CalculateFull()
  foreach ($c in @($spec.cells)) {
    $ws = $null; $rng = $null
    try {
      $ws = if ($c.PSObject.Properties['sheet'] -and $c.sheet) { $Workbook.Worksheets.Item([string]$c.sheet) } else { $Workbook.Worksheets.Item(1) }
      $rng = $ws.Range([string]$c.ref)
      $actual = $rng.Value2
      $want = $c.value
      $ok = $false
      if ($null -eq $want) { $ok = ($null -eq $actual) }
      elseif ($want -is [bool]) { $ok = ($actual -is [bool]) -and ($actual -eq $want) }
      elseif ($want -is [string]) { $ok = ($actual -is [string]) -and ([string]$actual -ceq $want) }
      elseif ($actual -is [double] -or $actual -is [int] -or $actual -is [decimal]) {
        $ok = ([math]::Abs([double]$actual - [double]$want) -le $Tol)
      }
      if (-not $ok) { $problems += ("{0}!{1}: expected {2}, got {3}" -f $c.sheet, $c.ref, $want, $actual) }
    } catch {
      $problems += ("{0}!{1}: read failed: {2}" -f $c.sheet, $c.ref, $_.Exception.Message)
    } finally { Remove-ComObject $rng; Remove-ComObject $ws }
  }
  return ,$problems
}

if ($xlsx.Count -gt 0) {
  $excel = $null
  try {
    try {
      $excel = New-Object -ComObject Excel.Application  # always a new instance
      $excel.Visible = $false
      $excel.DisplayAlerts = $false
      $excel.ScreenUpdating = $false
      $excel.EnableEvents = $false
      try { $excel.AutomationSecurity = 3 } catch { }
      try { $excel.AskToUpdateLinks = $false } catch { }
    } catch {
      $officeMissing = $true
      Add-Result $results '(Excel)' 'Excel' $false "Cannot start Excel: $($_.Exception.Message)"
      $excel = $null
    }
    if ($excel) {
      foreach ($f in $xlsx) {
        $wb = $null
        $name = Get-RelName $f.FullName
        try {
          $missing = [Type]::Missing
          # Open(Filename, UpdateLinks=0, ReadOnly=true, Format, Password, WriteResPassword, IgnoreReadOnlyRecommended,
          #      Origin, Delimiter, Editable, Notify, Converter, AddToMru, Local, CorruptLoad=xlNormalLoad(0))
          # xlNormalLoad never auto-repairs: damaged files raise an error instead of opening in a repaired state.
          $wb = $excel.Workbooks.Open($f.FullName, 0, $true, $missing, $missing, $missing, $true,
            $missing, $missing, $missing, $missing, $missing, $false, $missing, 0)
          $problems = @()
          try { [void]$wb.Worksheets.Count } catch { $problems += "sheets unreadable: $($_.Exception.Message)" }
          $exp = Get-ExpectPath $f.FullName
          if (Test-Path -LiteralPath $exp) {
            try { $problems += @(Test-ExpectCells -Workbook $wb -ExpectPath $exp -Tol $Tolerance) }
            catch { $problems += "expect.json: $($_.Exception.Message)" }
          }
          if ($problems.Count -eq 0) { Add-Result $results $name 'Excel' $true 'opened without repair' }
          else { Add-Result $results $name 'Excel' $false ($problems -join '; ') }
        } catch {
          Add-Result $results $name 'Excel' $false $_.Exception.Message
        } finally {
          if ($wb) {
            try { $wb.Close($false) } catch { }
            Remove-ComObject $wb
          }
        }
      }
    }
  } finally {
    if ($excel) {
      try { $excel.Quit() } catch { }
      Remove-ComObject $excel
    }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
}

$failed = @($results | Where-Object { -not $_.ok })
$summary = [pscustomobject]@{
  root    = $rootFull
  total   = $results.Count
  passed  = $results.Count - $failed.Count
  failed  = $failed.Count
  ok      = ($failed.Count -eq 0)
  results = $results
}
$json = $summary | ConvertTo-Json -Depth 5
if ($JsonPath) { Set-Content -LiteralPath $JsonPath -Value $json -Encoding UTF8 }
Write-Host ("Summary: {0} passed, {1} failed of {2}" -f $summary.passed, $summary.failed, $summary.total)
if ($officeMissing) { exit 2 }
if ($failed.Count -gt 0) { exit 1 }
exit 0
