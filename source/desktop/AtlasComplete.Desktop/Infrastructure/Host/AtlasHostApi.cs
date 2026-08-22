using Nmsa.Desktop.Application;
using Nmsa.Desktop.Domain;

namespace Nmsa.Desktop.Infrastructure.Host;

public sealed class AtlasHostApi : IAtlasHostApi
{
    public const string ProductVersion = "3.0.6";
    public const int ContractVersion = 1;

    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private readonly FileTokenStore _tokenStore = new();
    private readonly SaveDiscoveryService _discovery;
    private readonly TransactionService _transactions;
    private bool _disposed;

    public AtlasHostApi(string? dataRoot = null)
    {
        var fileFactory = new ClientFileFactory(_tokenStore);
        var xboxContainers = new XboxContainerService(fileFactory);
        _discovery = new SaveDiscoveryService(_tokenStore, fileFactory, xboxContainers, GetStatus);
        _transactions = new TransactionService(_tokenStore, dataRoot);
    }

    public HostStatus GetStatus()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return new HostStatus(
            Native: true,
            ProductVersion,
            ContractVersion,
            SaveDiscoveryService.IsProcessRunning("NMS"),
            SaveDiscoveryService.IsProcessRunning("steam"),
            [
                "auto-discovery",
                "direct-install",
                "transactional-backup",
                "post-write-verification",
                "rollback",
                "xbox-containers",
                "portable-console-folders",
                "pc-platform-settings",
                "in-process-host",
            ]);
    }

    public ValueTask<DiscoveryResult> DiscoverAsync(CancellationToken cancellationToken) =>
        RunExclusiveAsync(_discovery.DiscoverInstalled, cancellationToken);

    public ValueTask<DiscoveryResult> DiscoverFolderAsync(
        string folderPath,
        CancellationToken cancellationToken) =>
        RunExclusiveAsync(() => _discovery.DiscoverFolder(folderPath), cancellationToken);

    public async ValueTask<byte[]> ReadFileAsync(
        string token,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await _transactions.ReadFileAsync(token, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public ValueTask<InstallResult> InstallAsync(
        InstallRequest request,
        CancellationToken cancellationToken) =>
        RunExclusiveAsync(() => _transactions.Install(request), cancellationToken);

    public ValueTask<BackupListResult> GetBackupsAsync(CancellationToken cancellationToken) =>
        RunExclusiveAsync(_transactions.GetBackups, cancellationToken);

    public ValueTask<RollbackResult> RollbackAsync(
        string backupId,
        CancellationToken cancellationToken) =>
        RunExclusiveAsync(() => _transactions.Rollback(backupId), cancellationToken);

    public ValueTask DisposeAsync()
    {
        if (_disposed) return ValueTask.CompletedTask;
        _disposed = true;
        _operationGate.Dispose();
        GC.SuppressFinalize(this);
        return ValueTask.CompletedTask;
    }

    private async ValueTask<T> RunExclusiveAsync<T>(Func<T> operation, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await Task.Run(operation, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _operationGate.Release();
        }
    }
}
