using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Nmsa.Desktop.Domain;

namespace Nmsa.Desktop.Infrastructure.Host;

internal sealed partial class SaveDiscoveryService(
    FileTokenStore tokenStore,
    ClientFileFactory fileFactory,
    XboxContainerService xboxContainers,
    Func<HostStatus> statusProvider)
{
    private const int MaximumDiscoveredPaths = 4096;

    public DiscoveryResult DiscoverInstalled()
    {
        tokenStore.Clear();
        var files = new List<ClientFileRecord>();
        var xboxSets = new List<XboxSaveSet>();
        var warnings = new List<string>();
        (string steamSettings, string gogSettings) = FindPcPlatformSettings();
        string pcRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "HelloGames",
            "NMS");

        foreach (string profile in SafeEnumerateDirectories(pcRoot))
        {
            string profileName = Path.GetFileName(profile);
            string settings = string.Equals(profileName, "DefaultUser", StringComparison.OrdinalIgnoreCase)
                ? gogSettings
                : steamSettings;
            files.AddRange(GetPcProfileFiles(profile, string.Empty, settings));
        }

        foreach (string indexPath in XboxContainerService.FindInstalledIndexes())
        {
            try
            {
                xboxSets.AddRange(xboxContainers.GetSaveSets(indexPath));
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
            {
                warnings.Add($"Xbox profile could not be indexed: {exception.Message}");
            }
        }

        if (IsProcessRunning("steam"))
        {
            warnings.Add(
                "Steam is running. NMSA will still refuse installation while No Man's Sky is open; "
                + "Steam Cloud may ask which copy to keep after an edit.");
        }

        if (files.Count == 0 && xboxSets.Count == 0)
        {
            warnings.Add("No installed Steam, GOG, or Xbox save profile was found in the standard Windows locations.");
        }

        return new DiscoveryResult(files, xboxSets, warnings, statusProvider());
    }

    public DiscoveryResult DiscoverFolder(string folderPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(folderPath);
        string selectedPath = Path.GetFullPath(folderPath);
        if (!Directory.Exists(selectedPath))
        {
            throw new DirectoryNotFoundException("The selected save folder no longer exists.");
        }

        tokenStore.Clear();
        string indexPath = Path.Combine(selectedPath, "containers.index");
        if (File.Exists(indexPath))
        {
            return new DiscoveryResult(
                [],
                xboxContainers.GetSaveSets(indexPath),
                ["This Xbox container was loaded manually. Automatic writes remain transactional and local."],
                statusProvider(),
                Path.GetFileName(selectedPath),
                Cancelled: false);
        }

        (string steamSettings, string gogSettings) = FindPcPlatformSettings();
        bool hasNestedProfiles = SafeEnumerateDirectories(selectedPath)
            .Any(path => File.Exists(Path.Combine(path, "accountdata.hg")));
        var records = new List<ClientFileRecord>();
        if (hasNestedProfiles)
        {
            foreach (string profile in SafeEnumerateDirectories(selectedPath))
            {
                if (!File.Exists(Path.Combine(profile, "accountdata.hg")))
                {
                    continue;
                }

                string profileName = Path.GetFileName(profile);
                string settings = string.Equals(profileName, "DefaultUser", StringComparison.OrdinalIgnoreCase)
                    ? gogSettings
                    : steamSettings;
                records.AddRange(GetPcProfileFiles(profile, Path.GetFileName(selectedPath), settings));
            }
        }
        else
        {
            string profileName = Path.GetFileName(selectedPath);
            string settings = string.Empty;
            string pcSaveRoot = Path.GetFullPath(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "HelloGames",
                "NMS"));
            if (IsChildPath(pcSaveRoot, selectedPath))
            {
                settings = string.Equals(profileName, "DefaultUser", StringComparison.OrdinalIgnoreCase)
                    ? gogSettings
                    : steamSettings;
            }

            records.AddRange(GetPortableFolderFiles(selectedPath, settings));
        }

        return new DiscoveryResult(
            records,
            [],
            [],
            statusProvider(),
            Path.GetFileName(selectedPath),
            Cancelled: false);
    }

    public static bool IsProcessRunning(string processName)
    {
        Process[] processes = Process.GetProcessesByName(processName);
        try
        {
            return processes.Length > 0;
        }
        finally
        {
            foreach (Process process in processes)
            {
                process.Dispose();
            }
        }
    }

    private List<ClientFileRecord> GetPcProfileFiles(
        string profilePath,
        string labelPrefix,
        string platformSettingsPath)
    {
        string profileName = Path.GetFileName(profilePath);
        string platform = string.Equals(profileName, "DefaultUser", StringComparison.OrdinalIgnoreCase)
            ? "gog"
            : "steam";
        string prefix = string.IsNullOrWhiteSpace(labelPrefix)
            ? profileName
            : $"{labelPrefix}/{profileName}";
        var records = new List<ClientFileRecord>();
        foreach (string file in SafeEnumerateFiles(profilePath, "*.hg", SearchOption.TopDirectoryOnly))
        {
            ClientFileRecord? record = fileFactory.Create(
                file,
                $"{prefix}/{Path.GetFileName(file)}",
                platform,
                profilePath);
            if (record is not null) records.Add(record);
        }

        if (!string.IsNullOrWhiteSpace(platformSettingsPath) && File.Exists(platformSettingsPath))
        {
            ClientFileRecord? record = fileFactory.Create(
                platformSettingsPath,
                $"{prefix}/GCUSERSETTINGSDATA.MXML",
                platform,
                profilePath,
                "GCUSERSETTINGSDATA.MXML",
                "platformSettings");
            if (record is not null) records.Add(record);
        }

        return records;
    }

    private List<ClientFileRecord> GetPortableFolderFiles(string folderPath, string platformSettingsPath)
    {
        bool hasAccount = File.Exists(Path.Combine(folderPath, "accountdata.hg"));
        bool hasSavedata = SafeEnumerateFiles(folderPath, "savedata*.hg", SearchOption.TopDirectoryOnly).Length > 0;
        string folderName = Path.GetFileName(folderPath);
        string platform = hasSavedata && !hasAccount
            ? "playstation-extracted"
            : hasSavedata
                ? "switch-extracted"
                : string.Equals(folderName, "DefaultUser", StringComparison.OrdinalIgnoreCase)
                    ? "gog"
                    : "steam";
        var records = new List<ClientFileRecord>();
        foreach (string file in SafeEnumerateFiles(folderPath, "*.hg", SearchOption.TopDirectoryOnly))
        {
            ClientFileRecord? record = fileFactory.Create(
                file,
                $"{folderName}/{Path.GetFileName(file)}",
                platform,
                folderPath);
            if (record is not null) records.Add(record);
        }

        if (platform is "steam" or "gog")
        {
            string settings = string.IsNullOrWhiteSpace(platformSettingsPath)
                ? Path.Combine(folderPath, "GCUSERSETTINGSDATA.MXML")
                : platformSettingsPath;
            if (File.Exists(settings))
            {
                ClientFileRecord? record = fileFactory.Create(
                    settings,
                    $"{folderName}/GCUSERSETTINGSDATA.MXML",
                    platform,
                    folderPath,
                    "GCUSERSETTINGSDATA.MXML",
                    "platformSettings");
                if (record is not null) records.Add(record);
            }
        }

        return records;
    }

    private static (string Steam, string Gog) FindPcPlatformSettings() =>
        (FindSteamPlatformSettings(), FindGogPlatformSettings());

    private static string FindSteamPlatformSettings()
    {
        string installLocation = GetRegistryString(
            [
                new RegistryLocation(RegistryHive.LocalMachine, RegistryView.Registry64,
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 275850"),
                new RegistryLocation(RegistryHive.LocalMachine, RegistryView.Registry32,
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 275850"),
                new RegistryLocation(RegistryHive.CurrentUser, RegistryView.Default,
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 275850"),
            ],
            ["InstallLocation"]);
        if (!string.IsNullOrWhiteSpace(installLocation))
        {
            string direct = Path.Combine(installLocation, "Binaries", "SETTINGS", "GCUSERSETTINGSDATA.MXML");
            if (File.Exists(direct)) return Path.GetFullPath(direct);
        }

        foreach (string library in GetSteamLibraryRoots())
        {
            string steamApps = Path.Combine(library, "steamapps");
            string installDirectory = "No Man's Sky";
            string manifest = Path.Combine(steamApps, "appmanifest_275850.acf");
            if (File.Exists(manifest))
            {
                try
                {
                    Match match = SteamInstallDirectory().Match(File.ReadAllText(manifest));
                    if (match.Success) installDirectory = match.Groups[1].Value;
                }
                catch (IOException)
                {
                    // Continue with Steam's default install directory.
                }
            }

            string candidate = Path.Combine(
                steamApps,
                "common",
                installDirectory,
                "Binaries",
                "SETTINGS",
                "GCUSERSETTINGSDATA.MXML");
            if (File.Exists(candidate)) return Path.GetFullPath(candidate);
        }

        return string.Empty;
    }

    private static string FindGogPlatformSettings()
    {
        var roots = new[]
        {
            new RegistryLocation(RegistryHive.LocalMachine, RegistryView.Registry64, @"Software\GOG.com\Games"),
            new RegistryLocation(RegistryHive.LocalMachine, RegistryView.Registry32, @"Software\GOG.com\Games"),
            new RegistryLocation(RegistryHive.CurrentUser, RegistryView.Default, @"Software\GOG.com\Games"),
        };
        foreach (RegistryLocation location in roots)
        {
            try
            {
                using RegistryKey? baseKey = RegistryKey.OpenBaseKey(location.Hive, location.View);
                using RegistryKey? root = baseKey.OpenSubKey(location.Path);
                if (root is null) continue;
                foreach (string subKeyName in root.GetSubKeyNames())
                {
                    using RegistryKey? game = root.OpenSubKey(subKeyName);
                    if (game is null) continue;
                    string name = Convert.ToString(game.GetValue("gameName"), CultureInfo.InvariantCulture) ?? string.Empty;
                    if (string.IsNullOrWhiteSpace(name))
                    {
                        name = Convert.ToString(game.GetValue("name"), CultureInfo.InvariantCulture) ?? string.Empty;
                    }
                    if (!name.Contains("No Man's Sky", StringComparison.OrdinalIgnoreCase)) continue;
                    string path = Convert.ToString(game.GetValue("path"), CultureInfo.InvariantCulture) ?? string.Empty;
                    if (string.IsNullOrWhiteSpace(path))
                    {
                        path = Convert.ToString(game.GetValue("installLocation"), CultureInfo.InvariantCulture) ?? string.Empty;
                    }
                    if (string.IsNullOrWhiteSpace(path)) continue;
                    string candidate = Path.Combine(path, "Binaries", "SETTINGS", "GCUSERSETTINGSDATA.MXML");
                    if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                }
            }
            catch (UnauthorizedAccessException)
            {
                // Registry discovery is best-effort.
            }
        }

        return string.Empty;
    }

    private static string[] GetSteamLibraryRoots()
    {
        string registryPath = GetRegistryString(
            [
                new RegistryLocation(RegistryHive.CurrentUser, RegistryView.Default, @"Software\Valve\Steam"),
                new RegistryLocation(RegistryHive.LocalMachine, RegistryView.Registry64, @"Software\Valve\Steam"),
                new RegistryLocation(RegistryHive.LocalMachine, RegistryView.Registry32, @"Software\Valve\Steam"),
            ],
            ["SteamPath", "InstallPath"]);
        var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(registryPath)) candidates.Add(registryPath);
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!string.IsNullOrWhiteSpace(programFilesX86)) candidates.Add(Path.Combine(programFilesX86, "Steam"));
        if (!string.IsNullOrWhiteSpace(programFiles)) candidates.Add(Path.Combine(programFiles, "Steam"));

        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string candidate in candidates)
        {
            if (!Directory.Exists(candidate)) continue;
            roots.Add(Path.GetFullPath(candidate));
            string librariesPath = Path.Combine(candidate, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(librariesPath)) continue;
            try
            {
                string text = File.ReadAllText(librariesPath);
                foreach (Match match in SteamLibraryPath().Matches(text).Cast<Match>()
                    .Concat(LegacySteamLibraryPath().Matches(text).Cast<Match>()))
                {
                    string library = match.Groups[1].Value.Replace("\\\\", "\\", StringComparison.Ordinal);
                    if (Directory.Exists(library)) roots.Add(Path.GetFullPath(library));
                }
            }
            catch (IOException)
            {
                // A running Steam client can briefly lock its library manifest.
            }
        }

        return roots.ToArray();
    }

    private static string GetRegistryString(
        IEnumerable<RegistryLocation> locations,
        IEnumerable<string> valueNames)
    {
        foreach (RegistryLocation location in locations)
        {
            try
            {
                using RegistryKey baseKey = RegistryKey.OpenBaseKey(location.Hive, location.View);
                using RegistryKey? key = baseKey.OpenSubKey(location.Path);
                if (key is null) continue;
                foreach (string valueName in valueNames)
                {
                    string value = Convert.ToString(key.GetValue(valueName), CultureInfo.InvariantCulture) ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(value)) return value;
                }
            }
            catch (UnauthorizedAccessException)
            {
                // Registry discovery is best-effort.
            }
        }

        return string.Empty;
    }

    private static bool IsChildPath(string root, string candidate)
    {
        string rootPrefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        return Path.GetFullPath(candidate).StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase);
    }

    private static string[] SafeEnumerateDirectories(string path)
    {
        if (!Directory.Exists(path)) return [];
        try
        {
            var options = new EnumerationOptions
            {
                IgnoreInaccessible = true,
                RecurseSubdirectories = false,
                AttributesToSkip = FileAttributes.ReparsePoint,
            };
            return Directory.EnumerateDirectories(path, "*", options)
                .Take(MaximumDiscoveredPaths)
                .ToArray();
        }
        catch (UnauthorizedAccessException)
        {
            return [];
        }
        catch (IOException)
        {
            return [];
        }
    }

    private static string[] SafeEnumerateFiles(string path, string pattern, SearchOption option)
    {
        if (!Directory.Exists(path)) return [];
        try
        {
            var options = new EnumerationOptions
            {
                IgnoreInaccessible = true,
                RecurseSubdirectories = option == SearchOption.AllDirectories,
                AttributesToSkip = FileAttributes.ReparsePoint,
            };
            return Directory.EnumerateFiles(path, pattern, options)
                .Take(MaximumDiscoveredPaths)
                .ToArray();
        }
        catch (UnauthorizedAccessException)
        {
            return [];
        }
        catch (IOException)
        {
            return [];
        }
    }

    [GeneratedRegex("\"installdir\"\\s+\"([^\"]+)\"", RegexOptions.CultureInvariant)]
    private static partial Regex SteamInstallDirectory();

    [GeneratedRegex("\"path\"\\s+\"([^\"]+)\"", RegexOptions.CultureInvariant)]
    private static partial Regex SteamLibraryPath();

    [GeneratedRegex("\"\\d+\"\\s+\"([A-Za-z]:\\\\[^\"]+)\"", RegexOptions.CultureInvariant)]
    private static partial Regex LegacySteamLibraryPath();

    private sealed record RegistryLocation(RegistryHive Hive, RegistryView View, string Path);
}
