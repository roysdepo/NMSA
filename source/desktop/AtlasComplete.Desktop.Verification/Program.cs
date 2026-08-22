using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nmsa.Desktop.Domain;
using Nmsa.Desktop.Infrastructure.Host;
using Nmsa.Desktop.Presentation;

namespace Nmsa.Desktop.Verification;

internal static class Program
{
    private static int _assertions;

    public static async Task<int> Main()
    {
        string root = Path.Combine(Path.GetTempPath(), $"nmsa-verification-{Guid.NewGuid():N}");
        string profile = Path.Combine(root, "profile");
        string dataRoot = Path.Combine(root, "data");

        try
        {
            Directory.CreateDirectory(profile);
            byte[] originalSave = Encoding.UTF8.GetBytes("original-save");
            byte[] originalMetadata = Encoding.UTF8.GetBytes("original-metadata");
            string savePath = Path.Combine(profile, "save.hg");
            string metadataPath = Path.Combine(profile, "mf_save.hg");
            string oversizedPath = Path.Combine(profile, "oversized.hg");
            await File.WriteAllBytesAsync(savePath, originalSave);
            await File.WriteAllBytesAsync(metadataPath, originalMetadata);
            await using (FileStream oversized = File.Create(oversizedPath))
            {
                oversized.SetLength((64L * 1024L * 1024L) + 1);
            }

            await using (var host = new AtlasHostApi(dataRoot))
            {
                VerifyStatus(host.GetStatus());

                DiscoveryResult discovery = await host.DiscoverFolderAsync(profile, CancellationToken.None);
                Check(discovery.Cancelled is false, "Manual discovery completes without cancellation.");
                Check(discovery.Status.Native, "Manual discovery reports the native host.");
                Check(discovery.Files.Count == 2, "Manual discovery skips oversized inputs and returns the save pair.");

                ClientFileRecord save = discovery.Files.Single(file => file.Role == "save");
                ClientFileRecord metadata = discovery.Files.Single(file => file.Role == "saveMeta");
                Check(save.Platform == metadata.Platform, "Companion files share one platform adapter.");
                Check(save.Token.Length == 64, "Discovery returns a 256-bit opaque file token.");

                byte[] loaded = await host.ReadFileAsync(save.Token, CancellationToken.None);
                Check(loaded.AsSpan().SequenceEqual(originalSave), "Tokenized reads return the expected bytes.");

                byte[] changedSave = Encoding.UTF8.GetBytes("updated-save");
                byte[] changedMetadata = Encoding.UTF8.GetBytes("updated-metadata");
                InstallRequest installRequest = CreateInstallRequest(save, metadata, changedSave, changedMetadata);

                byte[] externalChange = Encoding.UTF8.GetBytes("external-change-after-scan");
                await File.WriteAllBytesAsync(savePath, externalChange);
                await CheckThrowsAsync<InvalidOperationException>(
                    () => host.InstallAsync(installRequest, CancellationToken.None).AsTask(),
                    "Installation rejects a save changed after discovery.");
                Check(
                    (await File.ReadAllBytesAsync(savePath)).AsSpan().SequenceEqual(externalChange),
                    "A stale-input rejection does not overwrite the external change.");
                Check(
                    (await File.ReadAllBytesAsync(metadataPath)).AsSpan().SequenceEqual(originalMetadata),
                    "A stale-input rejection does not touch matching metadata.");

                await File.WriteAllBytesAsync(savePath, originalSave);
                discovery = await host.DiscoverFolderAsync(profile, CancellationToken.None);
                save = discovery.Files.Single(file => file.Role == "save");
                metadata = discovery.Files.Single(file => file.Role == "saveMeta");
                installRequest = CreateInstallRequest(save, metadata, changedSave, changedMetadata);
                InstallResult installed = await host.InstallAsync(installRequest, CancellationToken.None);

                Check(installed.Status == "installed", "The in-process transaction reports installation.");
                Check(installed.VerifiedFiles == 2, "Both companion files pass post-write verification.");
                Check(installed.BackupId.StartsWith("nmsa-", StringComparison.Ordinal), "New backups use the NMSA identifier.");
                Check((await File.ReadAllBytesAsync(savePath)).AsSpan().SequenceEqual(changedSave), "The save output is committed.");
                Check((await File.ReadAllBytesAsync(metadataPath)).AsSpan().SequenceEqual(changedMetadata), "The metadata output is committed.");
                Check(
                    (await host.ReadFileAsync(save.Token, CancellationToken.None)).AsSpan().SequenceEqual(changedSave),
                    "The original save token rereads the committed save bytes.");
                Check(
                    (await host.ReadFileAsync(metadata.Token, CancellationToken.None)).AsSpan().SequenceEqual(changedMetadata),
                    "The original metadata token rereads the committed metadata bytes.");

                BackupListResult backups = await host.GetBackupsAsync(CancellationToken.None);
                Check(backups.Backups.Any(item => item.BackupId == installed.BackupId), "The transaction is discoverable in backup history.");

                string manifestPath = Path.Combine(dataRoot, "Backups", installed.BackupId, "backup.json");
                string originalManifest = await File.ReadAllTextAsync(manifestPath);
                string unrelatedPath = Path.Combine(root, "unrelated.txt");
                await File.WriteAllTextAsync(unrelatedPath, "must-not-change");
                JsonObject tampered = JsonNode.Parse(originalManifest)?.AsObject()
                    ?? throw new InvalidOperationException("Verification manifest could not be parsed.");
                tampered["files"]!.AsArray()[0]!["targetPath"] = unrelatedPath;
                await File.WriteAllTextAsync(manifestPath, tampered.ToJsonString());
                await CheckThrowsAsync<InvalidDataException>(
                    () => host.RollbackAsync(installed.BackupId, CancellationToken.None).AsTask(),
                    "Rollback rejects a manifest redirected to an unrelated file.");
                Check(await File.ReadAllTextAsync(unrelatedPath) == "must-not-change", "Rejected rollback leaves unrelated files untouched.");
                await File.WriteAllTextAsync(manifestPath, originalManifest);

                RollbackResult rollback = await host.RollbackAsync(installed.BackupId, CancellationToken.None);
                Check(rollback.Status == "restored", "Rollback reports a restored transaction.");
                Check(rollback.RestoredCount == 2, "Rollback restores both companion files.");
                Check(rollback.SafetyBackupId.StartsWith("nmsa-", StringComparison.Ordinal), "Rollback creates a safety backup first.");
                Check((await File.ReadAllBytesAsync(savePath)).AsSpan().SequenceEqual(originalSave), "Rollback restores the original save.");
                Check((await File.ReadAllBytesAsync(metadataPath)).AsSpan().SequenceEqual(originalMetadata), "Rollback restores the original metadata.");
                Check(
                    (await host.ReadFileAsync(save.Token, CancellationToken.None)).AsSpan().SequenceEqual(originalSave),
                    "The original save token rereads the rolled-back save bytes.");
                Check(
                    (await host.ReadFileAsync(metadata.Token, CancellationToken.None)).AsSpan().SequenceEqual(originalMetadata),
                    "The original metadata token rereads the rolled-back metadata bytes.");
            }

            VerifyViewModel();
            Console.WriteLine($"NMSA desktop verification passed ({_assertions} assertions).");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"NMSA desktop verification failed after {_assertions} assertions: {exception}");
            return 1;
        }
        finally
        {
            DeleteVerificationRoot(root);
        }
    }

    private static InstallRequest CreateInstallRequest(
        ClientFileRecord save,
        ClientFileRecord metadata,
        byte[] saveBytes,
        byte[] metadataBytes)
    {
        using JsonDocument document = JsonDocument.Parse("null");
        JsonElement empty = document.RootElement.Clone();
        var verification = new OutputVerification(
            Semantic: true,
            Metadata: true,
            ProtectedMetadataFieldsPreserved: true,
            InactiveContextPreserved: true,
            ActiveContextPreserved: true,
            PlatformSettings: false,
            TemplateState: false,
            AccountChanged: false,
            PlatformSettingsChanged: false);
        var report = new InstallReport(
            save.Platform,
            PlatformSettingsRequired: false,
            verification,
            Operation: "completion",
            PlatformRewards: [],
            empty,
            empty,
            empty,
            empty,
            empty,
            empty);

        return new InstallRequest(
        [
            CreateInstallFile(save, saveBytes),
            CreateInstallFile(metadata, metadataBytes),
        ], report);
    }

    private static InstallFileRequest CreateInstallFile(ClientFileRecord target, byte[] bytes) =>
        new(target.Token, target.Role, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), Convert.ToBase64String(bytes));

    private static void VerifyStatus(HostStatus status)
    {
        Check(status.Native, "Host status identifies native mode.");
        Check(status.Version == "3.0.6", "Host status exposes version 3.0.6.");
        Check(status.ApiVersion == 1, "Host status exposes API contract v1.");
        Check(status.Capabilities.Contains("in-process-host", StringComparer.Ordinal), "Host advertises the in-process capability.");
    }

    private static void VerifyViewModel()
    {
        var viewModel = new MainWindowViewModel();
        Check(viewModel.IsBusy && !viewModel.HasError, "The shell begins in a busy, non-error state.");

        viewModel.SetNavigating();
        Check(viewModel.IsBrowserVisible && !viewModel.CanRefresh, "Navigation reveals the browser while refresh stays disabled.");

        viewModel.SetReady();
        Check(!viewModel.IsBusy && viewModel.CanRefresh, "Ready state enables refresh and clears busy state.");

        viewModel.SetError("verification error");
        Check(viewModel.HasError && viewModel.ErrorMessage == "verification error", "Error state surfaces actionable copy.");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }

        _assertions++;
    }

    private static async Task CheckThrowsAsync<TException>(Func<Task> action, string message)
        where TException : Exception
    {
        try
        {
            await action();
        }
        catch (TException)
        {
            _assertions++;
            return;
        }

        throw new InvalidOperationException(message);
    }

    private static void DeleteVerificationRoot(string root)
    {
        string fullRoot = Path.GetFullPath(root);
        string temporaryRoot = Path.GetFullPath(Path.GetTempPath());
        if (!fullRoot.StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
            || !Path.GetFileName(fullRoot).StartsWith("nmsa-verification-", StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            if (Directory.Exists(fullRoot)) Directory.Delete(fullRoot, recursive: true);
        }
        catch (IOException)
        {
            // A failed cleanup must not conceal verification results.
        }
        catch (UnauthorizedAccessException)
        {
            // A failed cleanup must not conceal verification results.
        }
    }
}
