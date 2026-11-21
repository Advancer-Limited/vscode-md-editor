// Layer 2 of spec 13.5: schema-validate .docx/.xlsx files with the Open XML SDK. Opens no Office UI.
// Usage: dotnet run --project scripts/validate-openxml -- [--version Office2019] <file|dir>...
// Prints one JSON document to stdout; exit code 0 = all valid, 1 = any invalid/unreadable, 2 = usage.
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

var versionName = "Microsoft365";
var inputs = new List<string>();
for (int i = 0; i < args.Length; i++)
{
    if (args[i] == "--version" && i + 1 < args.Length) versionName = args[++i];
    else inputs.Add(args[i]);
}
if (inputs.Count == 0)
{
    Console.Error.WriteLine("usage: validate-openxml [--version Office2019|Microsoft365] <file|dir>...");
    return 2;
}
if (!Enum.TryParse<FileFormatVersions>(versionName, true, out var version)) version = FileFormatVersions.Microsoft365;

var files = new List<string>();
foreach (var input in inputs)
{
    if (Directory.Exists(input))
        files.AddRange(Directory.EnumerateFiles(input, "*.*", SearchOption.AllDirectories)
            .Where(f => f.EndsWith(".docx", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase)));
    else files.Add(input);
}
files.Sort(StringComparer.OrdinalIgnoreCase);

var results = new List<object>();
bool anyFail = false;
foreach (var file in files)
{
    var errors = new List<object>();
    string? fatal = null;
    try
    {
        using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        OpenXmlPackage pkg = file.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase)
            ? SpreadsheetDocument.Open(fs, false)
            : WordprocessingDocument.Open(fs, false);
        using (pkg)
        {
            var validator = new OpenXmlValidator(version);
            foreach (var e in validator.Validate(pkg))
                errors.Add(new { description = e.Description, part = e.Part?.Uri.ToString(), path = e.Path?.XPath, node = e.Node?.LocalName, errorType = e.ErrorType.ToString() });
        }
    }
    catch (Exception ex)
    {
        fatal = ex.GetType().Name + ": " + ex.Message;
    }
    bool ok = fatal == null && errors.Count == 0;
    if (!ok) anyFail = true;
    results.Add(new { file, ok, fatal, errorCount = errors.Count, errors });
}
Console.WriteLine(JsonSerializer.Serialize(new { version = version.ToString(), ok = !anyFail, results }, new JsonSerializerOptions { WriteIndented = true }));
return anyFail ? 1 : 0;
