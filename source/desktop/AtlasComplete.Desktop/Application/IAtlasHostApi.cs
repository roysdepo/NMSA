using Nmsa.Desktop.Domain;

namespace Nmsa.Desktop.Application;

public interface IAtlasHostApi : IAsyncDisposable
{
    HostStatus GetStatus();

    ValueTask<DiscoveryResult> DiscoverAsync(CancellationToken cancellationToken);

    ValueTask<DiscoveryResult> DiscoverFolderAsync(string folderPath, CancellationToken cancellationToken);

    ValueTask<byte[]> ReadFileAsync(string token, CancellationToken cancellationToken);

    ValueTask<InstallResult> InstallAsync(InstallRequest request, CancellationToken cancellationToken);

    ValueTask<BackupListResult> GetBackupsAsync(CancellationToken cancellationToken);

    ValueTask<RollbackResult> RollbackAsync(string backupId, CancellationToken cancellationToken);
}
