using System.Collections.Concurrent;
using System.IO;
using System.Security.Cryptography;
using Nmsa.Desktop.Domain;

namespace Nmsa.Desktop.Infrastructure.Host;

internal sealed class FileTokenStore
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(30);
    private const int MaximumTargets = 4096;
    private readonly ConcurrentDictionary<string, FileTokenTarget> _targets =
        new(StringComparer.Ordinal);
    private int _additions;

    public void Clear() => _targets.Clear();

    public FileTokenTarget Add(
        string path,
        string root,
        string platform,
        string role,
        XboxTokenMetadata? xboxMetadata = null)
    {
        if ((Interlocked.Increment(ref _additions) & 127) == 0 || _targets.Count >= MaximumTargets)
        {
            RemoveExpired();
        }
        if (_targets.Count >= MaximumTargets)
        {
            throw new InvalidOperationException("Too many save files were discovered in one session.");
        }

        string fullPath = Path.GetFullPath(path);
        SourceSnapshot source = CaptureSourceSnapshot(fullPath);
        string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var target = new FileTokenTarget(
            token,
            fullPath,
            Path.GetFullPath(root),
            platform,
            role,
            DateTimeOffset.UtcNow,
            source.Length,
            source.LastWriteUtcTicks,
            source.Sha256,
            xboxMetadata);
        if (!_targets.TryAdd(token, target))
        {
            throw new InvalidOperationException("NMSA could not create a unique file token.");
        }

        return target;
    }

    public FileTokenTarget GetRequired(string token)
    {
        if (string.IsNullOrWhiteSpace(token)
            || token.Length != 64
            || token.Any(character => !Uri.IsHexDigit(character))
            || !_targets.TryGetValue(token, out FileTokenTarget? target))
        {
            throw new InvalidOperationException("File token expired. Scan saves again.");
        }

        if (DateTimeOffset.UtcNow - target.IssuedAt > Lifetime)
        {
            _targets.TryRemove(token, out _);
            throw new InvalidOperationException("File token expired. Scan saves again.");
        }

        return target;
    }

    public void RefreshPaths(IEnumerable<string> paths)
    {
        var snapshots = new Dictionary<string, SourceSnapshot>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in paths.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            snapshots.Add(path, CaptureSourceSnapshot(path));
        }

        foreach ((string token, FileTokenTarget target) in _targets)
        {
            if (!snapshots.TryGetValue(target.Path, out SourceSnapshot? source)) continue;
            var refreshed = target with
            {
                SourceLength = source.Length,
                SourceLastWriteUtcTicks = source.LastWriteUtcTicks,
                SourceSha256 = source.Sha256,
            };
            _targets.TryUpdate(token, refreshed, target);
        }
    }

    private void RemoveExpired()
    {
        DateTimeOffset cutoff = DateTimeOffset.UtcNow - Lifetime;
        foreach ((string token, FileTokenTarget target) in _targets)
        {
            if (target.IssuedAt < cutoff)
            {
                _targets.TryRemove(token, out _);
            }
        }
    }

    private static SourceSnapshot CaptureSourceSnapshot(string path)
    {
        var before = new FileInfo(path);
        if (!before.Exists)
        {
            throw new FileNotFoundException("Save file no longer exists.", path);
        }
        long beforeLength = before.Length;
        long beforeLastWriteUtcTicks = before.LastWriteTimeUtc.Ticks;

        long length;
        string hash;
        using (var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            64 * 1024,
            FileOptions.SequentialScan))
        {
            length = stream.Length;
            hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }

        var after = new FileInfo(path);
        after.Refresh();
        if (!after.Exists
            || beforeLength != length
            || after.Length != length
            || beforeLastWriteUtcTicks != after.LastWriteTimeUtc.Ticks)
        {
            throw new IOException("A save file changed while it was being scanned. Scan again.");
        }

        return new SourceSnapshot(length, after.LastWriteTimeUtc.Ticks, hash);
    }

    private sealed record SourceSnapshot(long Length, long LastWriteUtcTicks, string Sha256);
}
