using System.IO;
using System.Text.RegularExpressions;
using Nmsa.Desktop.Domain;

namespace Nmsa.Desktop.Infrastructure.Host;

internal sealed partial class ClientFileFactory(FileTokenStore tokenStore)
{
    private const long MaximumFileBytes = 64L * 1024L * 1024L;

    public ClientFileRecord? Create(
        string path,
        string relativePath,
        string platform,
        string root,
        string? exportName = null,
        string? role = null,
        XboxTokenMetadata? xboxMetadata = null)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        var file = new FileInfo(path);
        if (file.Length > MaximumFileBytes
            || (file.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
        {
            return null;
        }
        string resolvedRole = string.IsNullOrWhiteSpace(role)
            ? InferRole(file.Name, platform)
            : role;
        FileTokenTarget target = tokenStore.Add(path, root, platform, resolvedRole, xboxMetadata);

        return new ClientFileRecord(
            target.Token,
            file.Name,
            file.Name,
            string.IsNullOrWhiteSpace(exportName) ? file.Name : exportName,
            relativePath,
            file.Length,
            new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
            platform,
            platform,
            resolvedRole,
            Native: true);
    }

    private static string InferRole(string name, string platform)
    {
        string lowerName = name.ToLowerInvariant();
        if (platform == "playstation-extracted")
        {
            if (lowerName == "savedata00.hg") return "account";
            if (lowerName == "manifest00.hg") return "accountMeta";
            if (PortableSaveName().IsMatch(lowerName)) return "save";
            if (PortableManifestName().IsMatch(lowerName)) return "saveMeta";
        }
        else if (platform == "switch-extracted")
        {
            if (lowerName == "accountdata.hg") return "account";
            if (PortableSaveName().IsMatch(lowerName)) return "save";
            if (PortableManifestName().IsMatch(lowerName)) return "saveMeta";
        }
        else
        {
            if (lowerName == "gcusersettingsdata.mxml") return "platformSettings";
            if (PcAccountManifestName().IsMatch(lowerName)) return "accountMeta";
            if (PcAccountName().IsMatch(lowerName)) return "account";
            if (PcSaveManifestName().IsMatch(lowerName)) return "saveMeta";
            if (PcSaveName().IsMatch(lowerName)) return "save";
        }

        return string.Empty;
    }

    [GeneratedRegex(@"^savedata\d{2}\.hg$", RegexOptions.CultureInvariant)]
    private static partial Regex PortableSaveName();

    [GeneratedRegex(@"^manifest\d{2}\.hg$", RegexOptions.CultureInvariant)]
    private static partial Regex PortableManifestName();

    [GeneratedRegex(@"^mf_accountdata(?:\(\d+\))?\.hg$", RegexOptions.CultureInvariant)]
    private static partial Regex PcAccountManifestName();

    [GeneratedRegex(@"^accountdata(?:\(\d+\))?\.hg$", RegexOptions.CultureInvariant)]
    private static partial Regex PcAccountName();

    [GeneratedRegex(@"^mf_save\d*(?:\(\d+\))?\.hg$", RegexOptions.CultureInvariant)]
    private static partial Regex PcSaveManifestName();

    [GeneratedRegex(@"^save\d*(?:\(\d+\))?\.hg$", RegexOptions.CultureInvariant)]
    private static partial Regex PcSaveName();
}
