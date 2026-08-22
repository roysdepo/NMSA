using System.IO;
using System.Security;
using System.Text;

namespace Nmsa.Desktop.Infrastructure;

public static class DesktopLog
{
    private const long MaximumLogBytes = 1024 * 1024;

    public static Task<string?> WriteStartupFailureAsync(Exception exception) =>
        WriteFailureAsync("startup", exception);

    public static Task<string?> WriteHostFailureAsync(Exception exception) =>
        WriteFailureAsync("host-api", exception);

    private static async Task<string?> WriteFailureAsync(string operation, Exception exception)
    {
        try
        {
            string directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NMSA");
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, "nmsa-wpf.log");
            if (File.Exists(path) && new FileInfo(path).Length >= MaximumLogBytes)
            {
                File.Move(path, path + ".previous", overwrite: true);
            }
            string entry = $"[{DateTimeOffset.UtcNow:O}] [{operation}] {Redact(exception.ToString())}\n";
            await File.AppendAllTextAsync(path, entry, Encoding.UTF8, CancellationToken.None)
                .ConfigureAwait(false);
            return path;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (SecurityException)
        {
            return null;
        }
    }

    private static string Redact(string value)
    {
        (string Path, string Replacement)[] roots =
        [
            (Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "%USERPROFILE%"),
            (Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar), "%TEMP%"),
            (AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), "%APPDIR%"),
        ];
        string result = value.Replace('\0', '\uFFFD');
        foreach ((string root, string replacement) in roots
            .Where(item => !string.IsNullOrWhiteSpace(item.Path))
            .OrderByDescending(item => item.Path.Length))
        {
            result = result.Replace(root, replacement, StringComparison.OrdinalIgnoreCase);
        }
        return result;
    }
}
