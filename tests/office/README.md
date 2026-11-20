# Office verification (dev-only, Windows)

Edit tests write their outputs to `tests/.out/<test-name>/<case>.{docx,xlsx}` (git-ignored). Two scripts check those files outside Node. Neither runs in `npm test`.

`writeOut(testName, caseName, bytes, expect)` in `_helpers.mjs` takes an optional `expect` list, `[{ sheet: 'Sheet1', ref: 'B2', value: 42 }]`, and writes `<case>.expect.json` beside the workbook.

## Layer 1: open in real Word/Excel (release gate)

Needs desktop Office. Run before each release PR and record the result in `log.md`.

```powershell
npm test
pwsh scripts/verify-office-open.ps1 -DryRun            # list files, create no Office objects
pwsh scripts/verify-office-open.ps1                     # real run over tests/.out
pwsh scripts/verify-office-open.ps1 -Path tests/.out/xlsx-edit -Kind Excel -JsonPath out.json
```

It starts its own hidden Word/Excel instances (never touches ones you have open), opens each file read-only with repair disabled (Word `OpenAndRepair=$false`, `NoEncodingDialog`, `ConfirmConversions=$false`; Excel `CorruptLoad=xlNormalLoad`, `UpdateLinks=0`), closes without saving and quits in `finally`. For workbooks with an `.expect.json` it recalculates and compares the listed cells. Exit code 0 = all passed, 1 = any failure, 2 = no files or Office not available.

## Layer 2: Open XML SDK schema validation (optional)

Needs the .NET SDK and NuGet access on first build. Opens no Office UI.

```powershell
dotnet run -c Release --project scripts/validate-openxml -- tests/.out
dotnet run -c Release --project scripts/validate-openxml -- tests/fixtures/office/basic.docx
```

Prints one JSON document (per-file `ok`, `fatal`, `errors[]` with part, XPath, description); exit 0 = all valid, 1 = any invalid or unreadable. Optional `--version Office2019` selects the schema set (default `Microsoft365`). The SDK reports some false positives on extension elements (for example "The 'uri' attribute is not declared" on `x14` `extLst` entries), so compare against the same file before your change.
