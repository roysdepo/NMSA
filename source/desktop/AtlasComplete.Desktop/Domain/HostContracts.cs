using System.Text.Json;

namespace Nmsa.Desktop.Domain;

public sealed record HostStatus(
    bool Native,
    string Version,
    int ApiVersion,
    bool GameRunning,
    bool SteamRunning,
    IReadOnlyList<string> Capabilities);

public sealed record ClientFileRecord(
    string Token,
    string Name,
    string OriginalName,
    string ExportName,
    string RelativePath,
    long Size,
    long LastModified,
    string Platform,
    string Adapter,
    string Role,
    bool Native);

public sealed record XboxSaveSet(
    string Id,
    string Adapter,
    string Platform,
    string Directory,
    string ProfileName,
    int LogicalSlot,
    int StorageOrdinal,
    ClientFileRecord? Save,
    ClientFileRecord? SaveMeta,
    ClientFileRecord? Account,
    ClientFileRecord? AccountMeta,
    IReadOnlyList<string> Missing,
    bool Complete);

public sealed record DiscoveryResult(
    IReadOnlyList<ClientFileRecord> Files,
    IReadOnlyList<XboxSaveSet> XboxSets,
    IReadOnlyList<string> Warnings,
    HostStatus Status,
    string? Label = null,
    bool? Cancelled = null);

public sealed record InstallFileRequest(
    string Token,
    string Role,
    string Sha256,
    string BytesBase64);

public sealed record OutputVerification(
    bool Semantic,
    bool Metadata,
    bool ProtectedMetadataFieldsPreserved,
    bool InactiveContextPreserved,
    bool ActiveContextPreserved,
    bool PlatformSettings,
    bool TemplateState,
    bool AccountChanged,
    bool PlatformSettingsChanged);

public sealed record InstallReport(
    string Platform,
    bool PlatformSettingsRequired,
    OutputVerification Verification,
    string? Operation,
    IReadOnlyList<string>? PlatformRewards,
    JsonElement LogicalSlot,
    JsonElement Context,
    JsonElement Additions,
    JsonElement HealthBefore,
    JsonElement HealthAfter,
    JsonElement Template);

public sealed record InstallRequest(
    IReadOnlyList<InstallFileRequest> Files,
    InstallReport Report);

public sealed record InstallResult(string Status, string BackupId, int VerifiedFiles);

public sealed record BackupSummary(
    string BackupId,
    string CreatedAt,
    string Platform,
    string PlatformLabel,
    string Reason,
    int FileCount);

public sealed record BackupListResult(IReadOnlyList<BackupSummary> Backups);

public sealed record RollbackRequest(string BackupId);

public sealed record RollbackResult(
    string Status,
    int RestoredCount,
    string BackupId,
    string SafetyBackupId);

internal sealed record XboxTokenMetadata(
    string IndexPath,
    string SlotIdentifier,
    int LastModifiedOffset,
    int TotalSizeOffset,
    int SyncStateOffset,
    int GlobalLastWriteOffset,
    int GlobalSyncOffset);

internal sealed record FileTokenTarget(
    string Token,
    string Path,
    string Root,
    string Platform,
    string Role,
    DateTimeOffset IssuedAt,
    long SourceLength,
    long SourceLastWriteUtcTicks,
    string SourceSha256,
    XboxTokenMetadata? XboxMetadata = null);

internal sealed record BackupEntry(
    string TargetPath,
    string BackupFile,
    string OriginalSha256,
    long Size);

internal sealed record BackupManifest(
    string BackupId,
    string CreatedAt,
    string Platform,
    string PlatformLabel,
    string Reason,
    int FileCount,
    IReadOnlyList<BackupEntry> Files);
