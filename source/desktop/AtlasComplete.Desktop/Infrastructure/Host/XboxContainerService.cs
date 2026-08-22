using System.Buffers.Binary;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Nmsa.Desktop.Domain;

namespace Nmsa.Desktop.Infrastructure.Host;

internal sealed partial class XboxContainerService(ClientFileFactory fileFactory)
{
    private const int MaximumIndexBytes = 8 * 1024 * 1024;
    private const int MaximumDiscoveredPaths = 4096;
    private const int MaximumDynamicStringCharacters = 4096;

    public IReadOnlyList<XboxSaveSet> GetSaveSets(string indexPath)
    {
        List<XboxSlot> slots = ParseIndex(indexPath);
        XboxSlot? accountSlot = slots.FirstOrDefault(
            slot => string.Equals(slot.Identifier, "AccountData", StringComparison.OrdinalIgnoreCase));
        if (accountSlot?.DataPath is null)
        {
            return [];
        }

        ClientFileRecord? accountData = CreateRecord(
            accountSlot, "account", accountSlot.DataPath, indexPath, "AccountData-data.blob");
        ClientFileRecord? accountMeta = accountSlot.MetaPath is null
            ? null
            : CreateRecord(accountSlot, "accountMeta", accountSlot.MetaPath, indexPath, "AccountData-meta.blob");

        var sets = new List<XboxSaveSet>();
        foreach (XboxSlot slot in slots)
        {
            Match match = SlotIdentifier().Match(slot.Identifier);
            if (!match.Success)
            {
                continue;
            }

            int slotNumber = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            string snapshot = match.Groups[2].Value;
            var missing = new List<string>();
            if (slot.DataPath is null) missing.Add("data blob");
            if (slot.MetaPath is null) missing.Add("meta blob");
            if (accountData is null) missing.Add("AccountData");
            if (accountMeta is null) missing.Add("AccountData metadata");

            ClientFileRecord? saveData = slot.DataPath is null
                ? null
                : CreateRecord(slot, "save", slot.DataPath, indexPath, $"{slot.Identifier}-data.blob");
            ClientFileRecord? saveMeta = slot.MetaPath is null
                ? null
                : CreateRecord(slot, "saveMeta", slot.MetaPath, indexPath, $"{slot.Identifier}-meta.blob");
            int storageOrdinal = ((slotNumber - 1) * 2)
                + (string.Equals(snapshot, "Auto", StringComparison.OrdinalIgnoreCase) ? 1 : 2);
            string profileDirectory = Path.GetFileName(Path.GetDirectoryName(indexPath)) ?? "Xbox";

            sets.Add(new XboxSaveSet(
                $"xbox|{profileDirectory}|{slot.Identifier}",
                "xbox-game-pass",
                "xbox-game-pass",
                $"Xbox/{profileDirectory}",
                "Xbox Game Pass",
                slotNumber,
                storageOrdinal,
                saveData,
                saveMeta,
                accountData,
                accountMeta,
                missing,
                missing.Count == 0));
        }

        return sets;
    }

    public static IReadOnlyList<string> FindInstalledIndexes()
    {
        string packages = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Packages");
        if (!Directory.Exists(packages))
        {
            return [];
        }

        var results = new List<string>();
        foreach (string package in SafeEnumerateDirectories(packages, "HelloGames*"))
        {
            string wgs = Path.Combine(package, "SystemAppData", "wgs");
            if (!Directory.Exists(wgs))
            {
                continue;
            }

            results.AddRange(SafeEnumerateFiles(wgs, "containers.index", SearchOption.AllDirectories));
        }

        return results;
    }

    private static List<XboxSlot> ParseIndex(string indexPath)
    {
        FileAttributes attributes = File.GetAttributes(indexPath);
        long indexLength = new FileInfo(indexPath).Length;
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0
            || indexLength is < 200 or > MaximumIndexBytes)
        {
            throw new InvalidDataException("Xbox containers.index exceeds the safety limit.");
        }
        byte[] bytes = File.ReadAllBytes(indexPath);
        if (bytes.Length < 200 || ReadInt32(bytes, 0) != 14)
        {
            throw new InvalidDataException("Invalid Xbox containers.index header.");
        }

        long count = ReadInt64(bytes, 4);
        if (count is < 0 or > 1000)
        {
            throw new InvalidDataException("Invalid Xbox container count.");
        }

        int offset = 12;
        (_, offset) = ReadDynamicUtf16String(bytes, offset);
        int globalLastWriteOffset = offset;
        int globalSyncOffset = offset + 8;
        offset += 12;
        (_, offset) = ReadDynamicUtf16String(bytes, offset);
        offset += 8;
        string baseDirectory = Path.GetDirectoryName(indexPath)
            ?? throw new InvalidDataException("Xbox index has no containing directory.");
        var slots = new List<XboxSlot>();

        for (long index = 0; index < count && offset < bytes.Length; index++)
        {
            (string identifier, offset) = ReadDynamicUtf16String(bytes, offset);
            (string secondIdentifier, offset) = ReadDynamicUtf16String(bytes, offset);
            (_, offset) = ReadDynamicUtf16String(bytes, offset);
            if (offset + 45 > bytes.Length)
            {
                break;
            }

            int fixedOffset = offset;
            var directoryGuid = new Guid(bytes.AsSpan(offset + 5, 16));
            long lastModifiedFileTime = ReadInt64(bytes, offset + 21);
            offset += 45;
            string blobDirectory = ResolveGuidPath(baseDirectory, directoryGuid);
            (string? dataPath, string? metaPath) = ReadBlobContainer(blobDirectory);
            DateTime lastModified;
            try
            {
                lastModified = DateTime.FromFileTimeUtc(lastModifiedFileTime);
            }
            catch (ArgumentOutOfRangeException)
            {
                lastModified = DateTime.UtcNow;
            }

            slots.Add(new XboxSlot(
                identifier,
                secondIdentifier,
                directoryGuid.ToString("N"),
                blobDirectory,
                dataPath,
                metaPath,
                lastModified,
                fixedOffset + 21,
                fixedOffset + 37,
                fixedOffset + 1,
                globalLastWriteOffset,
                globalSyncOffset));
        }

        return slots;
    }

    private ClientFileRecord? CreateRecord(
        XboxSlot slot,
        string kind,
        string path,
        string indexPath,
        string exportName)
    {
        var metadata = new XboxTokenMetadata(
            Path.GetFullPath(indexPath),
            slot.Identifier,
            slot.LastModifiedOffset,
            slot.TotalSizeOffset,
            slot.SyncStateOffset,
            slot.GlobalLastWriteOffset,
            slot.GlobalSyncOffset);
        string root = Path.GetDirectoryName(indexPath)
            ?? throw new InvalidDataException("Xbox index has no containing directory.");
        string relative = $"Xbox/{slot.Identifier}/{Path.GetFileName(path)}";
        return fileFactory.Create(path, relative, "xbox-game-pass", root, exportName, kind, metadata);
    }

    private static (string? DataPath, string? MetaPath) ReadBlobContainer(string blobDirectory)
    {
        if (!Directory.Exists(blobDirectory))
        {
            return (null, null);
        }

        string? dataPath = null;
        string? metaPath = null;
        IEnumerable<string> containers = SafeEnumerateFiles(blobDirectory, "container.*", SearchOption.TopDirectoryOnly)
            .OrderByDescending(path => ParseContainerOrdinal(Path.GetExtension(path)));
        foreach (string container in containers)
        {
            var containerInfo = new FileInfo(container);
            if (containerInfo.Length != 328
                || (containerInfo.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            {
                continue;
            }
            byte[] bytes = File.ReadAllBytes(container);
            if (bytes.Length != 328 || ReadInt32(bytes, 0) != 4)
            {
                continue;
            }

            int count = ReadInt32(bytes, 4);
            if (count is < 0 or > 2)
            {
                continue;
            }
            int offset = 8;
            for (int index = 0; index < count; index++)
            {
                if (offset + 160 > bytes.Length)
                {
                    break;
                }

                string identifier = Encoding.Unicode.GetString(bytes, offset, 128).TrimEnd('\0');
                offset += 144;
                var localGuid = new Guid(bytes.AsSpan(offset, 16));
                offset += 16;
                string blobPath = ResolveGuidPath(blobDirectory, localGuid);
                if (identifier.StartsWith("data", StringComparison.OrdinalIgnoreCase)) dataPath = blobPath;
                else if (identifier.StartsWith("meta", StringComparison.OrdinalIgnoreCase)) metaPath = blobPath;
            }

            if (dataPath is not null && File.Exists(dataPath))
            {
                break;
            }
        }

        return (dataPath, metaPath);
    }

    private static (string Value, int NextOffset) ReadDynamicUtf16String(byte[] bytes, int offset)
    {
        if (offset < 0 || offset + 4 > bytes.Length)
        {
            return (string.Empty, bytes.Length);
        }

        int length = ReadInt32(bytes, offset);
        if (length <= 0)
        {
            return (string.Empty, offset + 4);
        }

        if (length > MaximumDynamicStringCharacters
            || length > (bytes.Length - offset - 4) / 2)
        {
            throw new InvalidDataException("Truncated UTF-16 string in containers.index.");
        }
        int byteLength = length * 2;

        return (Encoding.Unicode.GetString(bytes, offset + 4, byteLength), offset + 4 + byteLength);
    }

    private static string ResolveGuidPath(string directory, Guid guid)
    {
        string[] candidates =
        [
            Path.Combine(directory, guid.ToString("N").ToUpperInvariant()),
            Path.Combine(directory, guid.ToString("N").ToLowerInvariant()),
            Path.Combine(directory, guid.ToString("D")),
        ];
        return candidates.FirstOrDefault(path => File.Exists(path) || Directory.Exists(path)) ?? candidates[0];
    }

    private static int ReadInt32(byte[] bytes, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset, sizeof(int)));

    private static long ReadInt64(byte[] bytes, int offset) =>
        BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(offset, sizeof(long)));

    private static int ParseContainerOrdinal(string extension) =>
        int.TryParse(extension.TrimStart('.'), NumberStyles.None, CultureInfo.InvariantCulture, out int value)
            ? value
            : int.MinValue;

    private static string[] SafeEnumerateDirectories(string path, string pattern)
    {
        try
        {
            var options = new EnumerationOptions
            {
                IgnoreInaccessible = true,
                RecurseSubdirectories = false,
                AttributesToSkip = FileAttributes.ReparsePoint,
            };
            return Directory.EnumerateDirectories(path, pattern, options)
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

    [GeneratedRegex(@"^Slot(\d+)(Auto|Manual)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SlotIdentifier();

    private sealed record XboxSlot(
        string Identifier,
        string SecondIdentifier,
        string DirectoryGuid,
        string BlobDirectory,
        string? DataPath,
        string? MetaPath,
        DateTime LastModified,
        int LastModifiedOffset,
        int TotalSizeOffset,
        int SyncStateOffset,
        int GlobalLastWriteOffset,
        int GlobalSyncOffset);
}
