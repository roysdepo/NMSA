using System.Buffers.Binary;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using Nmsa.Desktop.Domain;

namespace Nmsa.Desktop.Infrastructure.Host;

internal sealed partial class TransactionService(FileTokenStore tokenStore, string? dataRoot = null)
{
    private const int MaximumInputFileBytes = 64 * 1024 * 1024;
    private const int MaximumOutputFileBytes = 64 * 1024 * 1024;
    private const long MaximumTransactionOutputBytes = 128L * 1024L * 1024L;
    private const int MaximumPlatformSettingsBytes = 10 * 1024 * 1024;
    private const int MaximumBackupManifestBytes = 1024 * 1024;
    private const int MaximumBackupFiles = 8;
    private const int MaximumPlatformRewards = 4096;
    private const long MaximumHistoryBytes = 10 * 1024 * 1024;
    // Keep the v2 directory so existing backups and rollback history survive the v3 rename.
    private readonly string _dataRoot = dataRoot ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Atlas Complete");

    private string BackupRoot => Path.Combine(_dataRoot, "Backups");

    private string HistoryPath => Path.Combine(_dataRoot, "native-history.jsonl");

    public async ValueTask<byte[]> ReadFileAsync(
        string token,
        CancellationToken cancellationToken)
    {
        FileTokenTarget target = tokenStore.GetRequired(token);
        if (!File.Exists(target.Path))
        {
            throw new FileNotFoundException("Save file no longer exists.");
        }
        EnsureRegularFile(target.Path, MaximumInputFileBytes, "Save file");
        await using var stream = new FileStream(
            target.Path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (stream.Length > MaximumInputFileBytes)
        {
            throw new InvalidDataException("Save file exceeds the 64 MB safety limit.");
        }
        byte[] bytes = GC.AllocateUninitializedArray<byte>(checked((int)stream.Length));
        await stream.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
        if (bytes.LongLength != target.SourceLength
            || !string.Equals(Sha256(bytes), target.SourceSha256, StringComparison.Ordinal)
            || File.GetLastWriteTimeUtc(target.Path).Ticks != target.SourceLastWriteUtcTicks)
        {
            throw new InvalidOperationException(
                "This save file changed after it was scanned. Scan your saves again before editing.");
        }
        return bytes;
    }

    public InstallResult Install(InstallRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (SaveDiscoveryService.IsProcessRunning("NMS"))
        {
            throw new InvalidOperationException("No Man's Sky is running. Fully close it before installation.");
        }
        if (request.Files is null || request.Files.Count is < 2 or > 4)
        {
            throw new InvalidOperationException(
                "Installation requires one save data file, its matching metadata, and only required account companions.");
        }
        if (request.Report is null)
        {
            throw new InvalidOperationException("Installation is missing its verified completion report.");
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var targets = new List<FileTokenTarget>(request.Files.Count);
        foreach (InstallFileRequest file in request.Files)
        {
            if (file is null || string.IsNullOrWhiteSpace(file.Token) || !seen.Add(file.Token))
            {
                throw new InvalidOperationException("Installation contains a missing or duplicate target token.");
            }

            FileTokenTarget target = tokenStore.GetRequired(file.Token);
            if (!string.Equals(file.Role, target.Role, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("An installation file does not match its verified target role.");
            }
            targets.Add(target);
        }

        string[] roots = targets.Select(target => target.Root)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (roots.Length != 1)
        {
            throw new InvalidOperationException("Save and account files are not from the same verified profile.");
        }
        string[] platforms = targets.Select(target => target.Platform)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (platforms.Length != 1)
        {
            throw new InvalidOperationException("Installation mixes platform adapters.");
        }

        string platform = platforms[0];
        if (platform is not ("steam" or "gog"))
        {
            throw new InvalidOperationException(
                "Writing this platform format is disabled until its native container can be preserved exactly. Analysis remains available.");
        }
        InstallReport report = request.Report;
        if (string.IsNullOrWhiteSpace(report.Platform)
            || !string.Equals(report.Platform, platform, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Installation report does not match the target platform.");
        }

        bool templateOperation = string.Equals(report.Operation, "save-template", StringComparison.Ordinal);
        if (!templateOperation && !string.Equals(report.Operation, "completion", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Installation operation is not supported.");
        }
        if (report.PlatformRewards is { Count: > MaximumPlatformRewards }
            || (report.PlatformRewards?.Any(reward =>
                string.IsNullOrWhiteSpace(reward) || reward.Length > 128) ?? false))
        {
            throw new InvalidOperationException("Platform reward verification input exceeds the safety limit.");
        }
        ValidateReportSummary(report);
        if (report.PlatformSettingsRequired && platform is not ("steam" or "gog"))
        {
            throw new InvalidOperationException("Platform settings were requested for a platform that does not use them.");
        }

        OutputVerification verification = report.Verification
            ?? throw new InvalidOperationException("Installation is missing its verified output checks.");
        if (!verification.Semantic
            || !verification.Metadata
            || !verification.ProtectedMetadataFieldsPreserved
            || !verification.InactiveContextPreserved
            || !verification.ActiveContextPreserved
            || (report.PlatformSettingsRequired && !verification.PlatformSettings)
            || (templateOperation && !verification.TemplateState))
        {
            throw new InvalidOperationException("The editor did not provide a complete verified output report.");
        }

        FileTokenTarget[] saveTargets = targets.Where(target => target.Role == "save").ToArray();
        FileTokenTarget[] saveMetaTargets = targets.Where(target => target.Role == "saveMeta").ToArray();
        ValidateMatchedSavePointTargets(saveTargets, saveMetaTargets, platform);

        var expectedRoles = new List<string> { "save", "saveMeta" };
        if (verification.AccountChanged)
        {
            expectedRoles.Add("account");
            if (platform is "playstation-extracted" or "xbox-game-pass") expectedRoles.Add("accountMeta");
        }
        if (verification.PlatformSettingsChanged) expectedRoles.Add("platformSettings");
        string[] actualRoles = targets.Select(target => target.Role).Order(StringComparer.Ordinal).ToArray();
        string[] sortedExpectedRoles = expectedRoles.Order(StringComparer.Ordinal).ToArray();
        if (!actualRoles.SequenceEqual(sortedExpectedRoles, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("Installation targets are not one complete save/account companion set.");
        }

        string[] additionalPaths = targets
            .Where(target => target.XboxMetadata is not null)
            .Select(target => target.XboxMetadata!.IndexPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        string[] backupPaths = targets.Select(target => target.Path)
            .Concat(additionalPaths)
            .ToArray();
        ValidateSourcesUnchanged(targets);
        BackupManifest backup = CreateBackup(backupPaths, platform, "install");
        string backupDirectory = Path.Combine(BackupRoot, backup.BackupId);
        var prepared = new List<PreparedWrite>();
        long transactionOutputBytes = 0;
        bool commitStarted = false;

        try
        {
            for (int index = 0; index < request.Files.Count; index++)
            {
                InstallFileRequest requestFile = request.Files[index];
                FileTokenTarget target = targets[index];
                if (string.IsNullOrWhiteSpace(requestFile.Sha256)
                    || requestFile.Sha256.Length != 64
                    || !Sha256Value().IsMatch(requestFile.Sha256)
                    || string.IsNullOrWhiteSpace(requestFile.BytesBase64))
                {
                    throw new InvalidOperationException("An installation output is missing its verified bytes or hash.");
                }
                if (requestFile.BytesBase64.Length > ((MaximumOutputFileBytes + 2L) / 3L) * 4L)
                {
                    throw new InvalidOperationException("One output file exceeds the safety limit.");
                }

                byte[] bytes;
                try
                {
                    bytes = Convert.FromBase64String(requestFile.BytesBase64);
                }
                catch (FormatException exception)
                {
                    throw new InvalidOperationException("An installation output is not valid base64 data.", exception);
                }
                if (bytes.Length > MaximumOutputFileBytes)
                {
                    throw new InvalidOperationException("One output file exceeds the safety limit.");
                }
                transactionOutputBytes = checked(transactionOutputBytes + bytes.Length);
                if (transactionOutputBytes > MaximumTransactionOutputBytes)
                {
                    throw new InvalidOperationException("The installation output exceeds the transaction safety limit.");
                }
                if (target.Role == "platformSettings"
                    && !VerifyPlatformSettings(bytes, report.PlatformRewards ?? []))
                {
                    throw new InvalidOperationException("PC platform settings failed XML or reward verification.");
                }

                string hash = Sha256(bytes);
                if (!string.Equals(hash, requestFile.Sha256.ToLowerInvariant(), StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Output hash does not match the verified editor result.");
                }

                string temporaryPath = target.Path + ".nmsa-write-" + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllBytes(temporaryPath, bytes);
                if (!string.Equals(Sha256File(temporaryPath), hash, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Temporary output failed verification.");
                }
                prepared.Add(new PreparedWrite(temporaryPath, target, hash));
            }

            ValidateSourcesUnchanged(targets);
            commitStarted = true;
            foreach (PreparedWrite item in prepared)
            {
                EnsureRegularFile(item.Target.Path, MaximumInputFileBytes, "Installation target");
                MoveFileIntoPlace(item.TemporaryPath, item.Target.Path);
            }
            if (platform == "xbox-game-pass") UpdateXboxIndexes(targets);
            foreach (PreparedWrite item in prepared)
            {
                if (!string.Equals(Sha256File(item.Target.Path), item.Hash, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Installed file failed post-write verification.");
                }
            }
            tokenStore.RefreshPaths(prepared.Select(item => item.Target.Path));
        }
        catch (Exception exception)
        {
            if (commitStarted)
            {
                BackupManifest manifest = ReadManifest(Path.Combine(backupDirectory, "backup.json"));
                RestoreBackupManifest(manifest, backupDirectory);
                tokenStore.RefreshPaths(manifest.Files.Select(entry => entry.TargetPath));
                throw new InvalidOperationException(
                    $"Installation failed and the original files were restored: {exception.Message}",
                    exception);
            }
            throw new InvalidOperationException(
                $"Installation stopped before any save file was replaced: {exception.Message}",
                exception);
        }
        finally
        {
            foreach (PreparedWrite item in prepared)
            {
                TryDelete(item.TemporaryPath);
            }
        }

        try
        {
            AppendHistory(backup.BackupId, platform, report);
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or JsonException)
        {
            // History is secondary. A verified save transaction must not be reported as failed.
        }
        return new InstallResult("installed", backup.BackupId, prepared.Count);
    }

    public BackupListResult GetBackups()
    {
        Directory.CreateDirectory(BackupRoot);
        var results = new List<BackupSummary>();
        foreach (string directory in Directory.EnumerateDirectories(BackupRoot)
            .OrderByDescending(Directory.GetLastWriteTimeUtc)
            .Take(200))
        {
            string manifestPath = Path.Combine(directory, "backup.json");
            if (!File.Exists(manifestPath)) continue;
            try
            {
                BackupManifest manifest = ReadManifest(manifestPath);
                results.Add(new BackupSummary(
                    manifest.BackupId,
                    manifest.CreatedAt,
                    manifest.Platform,
                    manifest.PlatformLabel,
                    manifest.Reason,
                    manifest.FileCount));
            }
            catch (Exception exception) when (exception is IOException
                or UnauthorizedAccessException
                or JsonException
                or InvalidDataException
                or ArgumentException)
            {
                // A damaged backup remains on disk but is omitted from the recovery list.
            }
        }

        return new BackupListResult(results);
    }

    public RollbackResult Rollback(string backupId)
    {
        if (SaveDiscoveryService.IsProcessRunning("NMS"))
        {
            throw new InvalidOperationException("No Man's Sky is running. Fully close it before rollback.");
        }
        if (string.IsNullOrWhiteSpace(backupId) || !BackupIdentifier().IsMatch(backupId))
        {
            throw new InvalidOperationException("Invalid backup identifier.");
        }

        string root = Path.GetFullPath(BackupRoot).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        string directory = Path.GetFullPath(Path.Combine(BackupRoot, backupId));
        if (!directory.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Backup path is outside the NMSA backup root.");
        }
        string manifestPath = Path.Combine(directory, "backup.json");
        if (!File.Exists(manifestPath))
        {
            throw new FileNotFoundException("Backup was not found.");
        }

        BackupManifest manifest = ReadManifest(manifestPath);
        string[] currentPaths = manifest.Files
            .Select(entry => entry.TargetPath)
            .Where(File.Exists)
            .ToArray();
        BackupManifest safety = CreateBackup(currentPaths, manifest.Platform, "pre-rollback");
        try
        {
            int count = RestoreBackupManifest(manifest, directory);
            tokenStore.RefreshPaths(manifest.Files.Select(entry => entry.TargetPath));
            return new RollbackResult("restored", count, backupId, safety.BackupId);
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or InvalidDataException
            or CryptographicException)
        {
            string safetyDirectory = Path.Combine(BackupRoot, safety.BackupId);
            BackupManifest safetyManifest = ReadManifest(Path.Combine(safetyDirectory, "backup.json"));
            RestoreBackupManifest(safetyManifest, safetyDirectory);
            tokenStore.RefreshPaths(safetyManifest.Files.Select(entry => entry.TargetPath));
            throw new InvalidOperationException(
                $"Rollback failed; the pre-rollback state was restored: {exception.Message}",
                exception);
        }
    }

    private BackupManifest CreateBackup(IEnumerable<string> paths, string platform, string reason)
    {
        string[] uniquePaths = paths.Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (uniquePaths.Length > MaximumBackupFiles)
        {
            throw new InvalidOperationException("Backup contains too many files.");
        }
        if (!IsSupportedPlatform(platform) || reason is not ("install" or "pre-rollback"))
        {
            throw new InvalidOperationException("Backup metadata is not supported.");
        }
        string id = "nmsa-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmssfff", CultureInfo.InvariantCulture)
            + "-" + Guid.NewGuid().ToString("N")[..8];
        string directory = Path.Combine(BackupRoot, id);
        string filesDirectory = Path.Combine(directory, "files");
        Directory.CreateDirectory(filesDirectory);
        var entries = new List<BackupEntry>(uniquePaths.Length);
        for (int index = 0; index < uniquePaths.Length; index++)
        {
            string path = uniquePaths[index];
            if (!File.Exists(path)) throw new FileNotFoundException("Backup target is missing.", path);
            EnsureRegularFile(path, MaximumInputFileBytes, "Backup target");
            string backupName = index.ToString("D3", CultureInfo.InvariantCulture) + ".bin";
            string backupPath = Path.Combine(filesDirectory, backupName);
            File.Copy(path, backupPath, overwrite: true);
            entries.Add(new BackupEntry(
                path,
                $"files/{backupName}",
                Sha256File(backupPath),
                new FileInfo(backupPath).Length));
        }

        var manifest = new BackupManifest(
            id,
            DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            platform,
            PlatformLabel(platform),
            reason,
            entries.Count,
            entries);
        string manifestPath = Path.Combine(directory, "backup.json");
        string temporaryManifest = manifestPath + ".tmp";
        File.WriteAllText(
            temporaryManifest,
            JsonSerializer.Serialize(manifest, HostJson.Options),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        File.Move(temporaryManifest, manifestPath);
        return manifest;
    }

    private static int RestoreBackupManifest(BackupManifest manifest, string directory)
    {
        string sourceRoot = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var prepared = new List<PreparedRestore>();
        try
        {
            foreach (BackupEntry entry in manifest.Files)
            {
                string relative = entry.BackupFile.Replace('/', Path.DirectorySeparatorChar);
                string source = Path.GetFullPath(Path.Combine(directory, relative));
                if (!source.StartsWith(sourceRoot, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("Backup manifest contains an unsafe source path.");
                }
                string target = Path.GetFullPath(entry.TargetPath);
                if (!File.Exists(source)) throw new FileNotFoundException("Backup file is missing.", source);
                EnsureRegularFile(source, MaximumInputFileBytes, "Backup file");
                if (new FileInfo(source).Length != entry.Size)
                {
                    throw new InvalidDataException("Backup size verification failed.");
                }
                if (!string.Equals(Sha256File(source), entry.OriginalSha256, StringComparison.Ordinal))
                {
                    throw new CryptographicException("Backup hash verification failed.");
                }
                if (File.Exists(target))
                {
                    EnsureRegularFile(target, MaximumInputFileBytes, "Restore target");
                }
                string? targetDirectory = Path.GetDirectoryName(target);
                if (string.IsNullOrWhiteSpace(targetDirectory) || !Directory.Exists(targetDirectory))
                {
                    throw new DirectoryNotFoundException("Restore target directory is unavailable.");
                }
                string temporary = target + ".nmsa-restore-" + Guid.NewGuid().ToString("N") + ".tmp";
                File.Copy(source, temporary, overwrite: true);
                prepared.Add(new PreparedRestore(temporary, target, entry.OriginalSha256));
            }

            foreach (PreparedRestore item in prepared) MoveFileIntoPlace(item.TemporaryPath, item.TargetPath);
            foreach (PreparedRestore item in prepared)
            {
                if (!string.Equals(Sha256File(item.TargetPath), item.Hash, StringComparison.Ordinal))
                {
                    throw new CryptographicException("Restored file failed verification.");
                }
            }
            return prepared.Count;
        }
        finally
        {
            foreach (PreparedRestore item in prepared) TryDelete(item.TemporaryPath);
        }
    }

    private static void MoveFileIntoPlace(string temporaryPath, string targetPath)
    {
        EnsureRegularFile(temporaryPath, MaximumInputFileBytes, "Prepared transaction file");
        if (File.Exists(targetPath))
        {
            EnsureRegularFile(targetPath, MaximumInputFileBytes, "Transaction target");
        }
        if (!File.Exists(targetPath))
        {
            File.Move(temporaryPath, targetPath);
            return;
        }

        try
        {
            File.Replace(temporaryPath, targetPath, destinationBackupFileName: null, ignoreMetadataErrors: true);
        }
        catch (PlatformNotSupportedException)
        {
            MoveWithFallback(temporaryPath, targetPath);
        }
        catch (IOException)
        {
            MoveWithFallback(temporaryPath, targetPath);
        }
    }

    private static void MoveWithFallback(string temporaryPath, string targetPath)
    {
        string previous = targetPath + ".nmsa-previous-" + Guid.NewGuid().ToString("N") + ".tmp";
        File.Move(targetPath, previous);
        try
        {
            File.Move(temporaryPath, targetPath);
            File.Delete(previous);
        }
        catch
        {
            TryDelete(targetPath);
            if (File.Exists(previous)) File.Move(previous, targetPath);
            throw;
        }
    }

    private static void UpdateXboxIndexes(IReadOnlyList<FileTokenTarget> targets)
    {
        foreach (IGrouping<string, FileTokenTarget> indexGroup in targets
            .Where(target => target.XboxMetadata is not null)
            .GroupBy(target => target.XboxMetadata!.IndexPath, StringComparer.OrdinalIgnoreCase))
        {
            string indexPath = indexGroup.Key;
            EnsureRegularFile(indexPath, MaximumInputFileBytes, "Xbox container index");
            byte[] bytes = File.ReadAllBytes(indexPath);
            long nowFileTime = DateTime.UtcNow.ToFileTimeUtc();
            FileTokenTarget first = indexGroup.First();
            XboxTokenMetadata firstMetadata = first.XboxMetadata!;
            WriteInt64(bytes, firstMetadata.GlobalLastWriteOffset, nowFileTime);
            WriteInt32(bytes, firstMetadata.GlobalSyncOffset, 2);

            foreach (IGrouping<string, FileTokenTarget> slotGroup in indexGroup.GroupBy(
                target => target.XboxMetadata!.SlotIdentifier,
                StringComparer.Ordinal))
            {
                XboxTokenMetadata metadata = slotGroup.First().XboxMetadata!;
                long totalSize = slotGroup.Where(target => File.Exists(target.Path))
                    .Sum(target => new FileInfo(target.Path).Length);
                WriteInt64(bytes, metadata.LastModifiedOffset, nowFileTime);
                WriteInt32(bytes, metadata.SyncStateOffset, 2);
                WriteInt64(bytes, metadata.TotalSizeOffset, totalSize);
            }

            string temporary = indexPath + ".nmsa-index-" + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllBytes(temporary, bytes);
            MoveFileIntoPlace(temporary, indexPath);
        }
    }

    private static bool VerifyPlatformSettings(byte[] bytes, IReadOnlyList<string> expectedRewards)
    {
        if (bytes.Length > MaximumPlatformSettingsBytes || expectedRewards.Count == 0) return false;
        try
        {
            var actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
                MaxCharactersInDocument = MaximumPlatformSettingsBytes,
                IgnoreComments = true,
            };
            using var stream = new MemoryStream(bytes, writable: false);
            using XmlReader reader = XmlReader.Create(stream, settings);
            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element
                    || reader.Name != "Property"
                    || reader.GetAttribute("name") != "UnlockedPlatformRewards")
                {
                    continue;
                }
                string? value = reader.GetAttribute("value");
                if (string.IsNullOrWhiteSpace(value)) continue;
                actual.Add(value.StartsWith('^') ? value : "^" + value);
            }
            return expectedRewards.All(actual.Contains);
        }
        catch (XmlException)
        {
            return false;
        }
    }

    private static void ValidateReportSummary(InstallReport report)
    {
        foreach ((string name, JsonElement element) in new[]
        {
            ("logical slot", report.LogicalSlot),
            ("context", report.Context),
            ("additions", report.Additions),
            ("health before", report.HealthBefore),
            ("health after", report.HealthAfter),
        })
        {
            if (element.ValueKind is JsonValueKind.Object or JsonValueKind.Array
                || (element.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null)
                    && element.GetRawText().Length > 1024))
            {
                throw new InvalidOperationException($"Installation {name} summary is invalid.");
            }
        }
        if (report.Template.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null)
            && report.Template.GetRawText().Length > 32 * 1024)
        {
            throw new InvalidOperationException("Installation template summary exceeds the safety limit.");
        }
    }

    private void AppendHistory(string backupId, string platform, InstallReport report)
    {
        Directory.CreateDirectory(_dataRoot);
        if (File.Exists(HistoryPath) && new FileInfo(HistoryPath).Length >= MaximumHistoryBytes)
        {
            File.Move(HistoryPath, HistoryPath + ".previous", overwrite: true);
        }

        var history = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["generatedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            ["backupId"] = backupId,
            ["platform"] = platform,
            ["logicalSlot"] = ElementOrNull(report.LogicalSlot),
            ["context"] = ElementOrNull(report.Context),
            ["additions"] = ElementOrNull(report.Additions),
            ["healthBefore"] = ElementOrNull(report.HealthBefore),
            ["healthAfter"] = ElementOrNull(report.HealthAfter),
            ["operation"] = report.Operation,
            ["template"] = ElementOrNull(report.Template),
            ["verified"] = true,
        };
        File.AppendAllText(
            HistoryPath,
            JsonSerializer.Serialize(history, HostJson.Options) + Environment.NewLine,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    private static JsonElement? ElementOrNull(JsonElement element) =>
        element.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? null : element;

    private BackupManifest ReadManifest(string path)
    {
        EnsureRegularFile(path, MaximumBackupManifestBytes, "Backup manifest");
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            16 * 1024,
            FileOptions.SequentialScan);
        if (stream.Length is <= 0 or > MaximumBackupManifestBytes)
        {
            throw new InvalidDataException("Backup manifest exceeds the safety limit.");
        }
        BackupManifest manifest = JsonSerializer.Deserialize<BackupManifest>(stream, HostJson.Options)
            ?? throw new InvalidDataException("Backup manifest is empty.");
        ValidateManifest(manifest, Path.GetDirectoryName(path)
            ?? throw new InvalidDataException("Backup manifest has no containing directory."));
        return manifest;
    }

    private void ValidateManifest(BackupManifest manifest, string directory)
    {
        if (string.IsNullOrWhiteSpace(manifest.BackupId)
            || !BackupIdentifier().IsMatch(manifest.BackupId)
            || string.IsNullOrWhiteSpace(manifest.CreatedAt)
            || !string.Equals(
                Path.GetFileName(Path.GetFullPath(directory)),
                manifest.BackupId,
                StringComparison.OrdinalIgnoreCase)
            || !DateTimeOffset.TryParse(
                manifest.CreatedAt,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out _)
            || !IsSupportedPlatform(manifest.Platform)
            || manifest.Reason is not ("install" or "pre-rollback")
            || manifest.Files is null
            || manifest.Files.Count != manifest.FileCount
            || manifest.FileCount is < 0 or > MaximumBackupFiles)
        {
            throw new InvalidDataException("Backup manifest metadata is invalid.");
        }

        string backupRoot = Path.GetFullPath(BackupRoot);
        var targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < manifest.Files.Count; index++)
        {
            BackupEntry? entry = manifest.Files[index];
            if (entry is null
                || string.IsNullOrWhiteSpace(entry.TargetPath)
                || string.IsNullOrWhiteSpace(entry.BackupFile)
                || string.IsNullOrWhiteSpace(entry.OriginalSha256))
            {
                throw new InvalidDataException("Backup manifest contains an empty file entry.");
            }
            string expectedBackupFile = $"files/{index:D3}.bin";
            string target = Path.GetFullPath(entry.TargetPath);
            string pathRoot = Path.GetPathRoot(target) ?? string.Empty;
            if (!string.Equals(entry.BackupFile, expectedBackupFile, StringComparison.Ordinal)
                || entry.Size is < 0 or > MaximumInputFileBytes
                || !Sha256Value().IsMatch(entry.OriginalSha256)
                || !targets.Add(target)
                || IsChildPath(backupRoot, target)
                || target.AsSpan(pathRoot.Length).Contains(':')
                || !IsAllowedRestoreTarget(manifest.Platform, target))
            {
                throw new InvalidDataException("Backup manifest contains an unsafe file entry.");
            }
        }
    }

    private static bool IsSupportedPlatform(string platform) => platform is
        "steam" or "gog" or "xbox-game-pass" or "playstation-extracted" or "switch-extracted";

    private static bool IsAllowedRestoreTarget(string platform, string target)
    {
        string name = Path.GetFileName(target);
        return platform switch
        {
            "steam" or "gog" => PcRestoreTarget().IsMatch(name),
            "playstation-extracted" => PortableRestoreTarget().IsMatch(name),
            "switch-extracted" => PortableRestoreTarget().IsMatch(name)
                || string.Equals(name, "accountdata.hg", StringComparison.OrdinalIgnoreCase),
            "xbox-game-pass" => string.Equals(name, "containers.index", StringComparison.OrdinalIgnoreCase)
                || Guid.TryParseExact(name, "N", out _)
                || Guid.TryParseExact(name, "D", out _),
            _ => false,
        };
    }

    private static bool IsChildPath(string root, string candidate)
    {
        string relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(candidate));
        return !Path.IsPathRooted(relative)
            && !string.Equals(relative, "..", StringComparison.Ordinal)
            && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    private static void ValidateMatchedSavePointTargets(
        FileTokenTarget[] saves,
        FileTokenTarget[] metadata,
        string platform)
    {
        if (saves.Length != 1 || metadata.Length != 1)
        {
            throw new InvalidOperationException(
                "Installation requires exactly one save data file and its matching metadata file.");
        }

        foreach (FileTokenTarget save in saves)
        {
            bool matched = metadata.Any(meta => IsMatchingSaveMetadata(save, meta, platform));
            if (!matched)
            {
                throw new InvalidOperationException("Installation save metadata does not match its verified snapshot.");
            }
        }
    }

    private static void ValidateSourcesUnchanged(IEnumerable<FileTokenTarget> targets)
    {
        foreach (FileTokenTarget target in targets)
        {
            EnsureRegularFile(target.Path, MaximumInputFileBytes, "Installation target");
            var info = new FileInfo(target.Path);
            if (info.Length != target.SourceLength
                || info.LastWriteTimeUtc.Ticks != target.SourceLastWriteUtcTicks
                || !string.Equals(Sha256File(target.Path), target.SourceSha256, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"{Path.GetFileName(target.Path)} changed after it was scanned. "
                    + "No files were replaced; scan your saves again.");
            }
        }
    }

    private static bool IsMatchingSaveMetadata(
        FileTokenTarget save,
        FileTokenTarget metadata,
        string platform)
    {
        if (platform is "steam" or "gog")
        {
            string expected = $"mf_{Path.GetFileName(save.Path)}";
            return string.Equals(
                Path.GetFileName(metadata.Path),
                expected,
                StringComparison.OrdinalIgnoreCase);
        }

        if (platform is "playstation-extracted" or "switch-extracted")
        {
            string saveName = Path.GetFileName(save.Path);
            string metadataName = Path.GetFileName(metadata.Path);
            return PortableSaveName().Match(saveName) is { Success: true } saveMatch
                && PortableManifestName().Match(metadataName) is { Success: true } metadataMatch
                && string.Equals(
                    saveMatch.Groups[1].Value,
                    metadataMatch.Groups[1].Value,
                    StringComparison.Ordinal);
        }

        return string.Equals(
            save.XboxMetadata?.SlotIdentifier,
            metadata.XboxMetadata?.SlotIdentifier,
            StringComparison.OrdinalIgnoreCase);
    }

    private static void EnsureRegularFile(string path, long maximumBytes, string description)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
        {
            throw new InvalidDataException($"{description} must be a regular local file.");
        }
        long length = new FileInfo(path).Length;
        if (length < 0 || length > maximumBytes)
        {
            throw new InvalidDataException($"{description} exceeds the safety limit.");
        }
    }

    private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string Sha256File(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string PlatformLabel(string platform) => platform switch
    {
        "steam" => "Steam",
        "gog" => "GOG",
        "xbox-game-pass" => "Xbox Game Pass",
        "playstation-extracted" => "Extracted PlayStation",
        "switch-extracted" => "Extracted Nintendo Switch",
        _ => "No Man's Sky",
    };

    private static void WriteInt32(byte[] bytes, int offset, int value)
    {
        EnsureWritableRange(bytes, offset, sizeof(int));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(offset, sizeof(int)), value);
    }

    private static void WriteInt64(byte[] bytes, int offset, long value)
    {
        EnsureWritableRange(bytes, offset, sizeof(long));
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(offset, sizeof(long)), value);
    }

    private static void EnsureWritableRange(byte[] bytes, int offset, int length)
    {
        if (offset < 0 || offset > bytes.Length - length)
        {
            throw new InvalidDataException("Xbox index contains an invalid update offset.");
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException)
        {
            // Cleanup is best-effort; transaction state has already been verified or restored.
        }
        catch (UnauthorizedAccessException)
        {
            // Cleanup is best-effort; transaction state has already been verified or restored.
        }
    }

    [GeneratedRegex(@"^(?:atlas|nmsa)-\d{8}-\d{9}-[a-f0-9]{8}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BackupIdentifier();

    [GeneratedRegex(@"^[a-f0-9]{64}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Value();

    [GeneratedRegex(@"^(?:(?:mf_)?(?:accountdata|save\d*)(?:\(\d+\))?\.hg|GCUSERSETTINGSDATA\.MXML)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PcRestoreTarget();

    [GeneratedRegex(@"^(?:savedata|manifest)\d{2}\.hg$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PortableRestoreTarget();

    [GeneratedRegex(@"^savedata(\d{2})\.hg$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PortableSaveName();

    [GeneratedRegex(@"^manifest(\d{2})\.hg$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PortableManifestName();

    private sealed record PreparedWrite(string TemporaryPath, FileTokenTarget Target, string Hash);

    private sealed record PreparedRestore(string TemporaryPath, string TargetPath, string Hash);
}
