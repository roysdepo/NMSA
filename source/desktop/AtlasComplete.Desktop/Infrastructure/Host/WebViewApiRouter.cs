using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Nmsa.Desktop.Application;
using Nmsa.Desktop.Domain;
using Nmsa.Desktop.Infrastructure;

namespace Nmsa.Desktop.Infrastructure.Host;

public sealed class WebViewApiRouter(
    CoreWebView2Environment environment,
    IAtlasHostApi hostApi,
    IHostFolderPicker folderPicker,
    string session,
    CancellationToken applicationStopping) : IDisposable
{
    public const string VirtualHost = "nmsa.local";
    public static readonly Uri ApplicationOrigin = new($"https://{VirtualHost}/");
    private const long DefaultBodyLimit = 64 * 1024;
    private const long InstallBodyLimit = 192L * 1024L * 1024L;
    private readonly byte[] _expectedSessionBytes = ValidateSession(session);
    private CoreWebView2? _browser;
    private bool _disposed;

    public void Attach(CoreWebView2 browser)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_browser is not null) throw new InvalidOperationException("The in-process API router is already attached.");
        _browser = browser;
        browser.AddWebResourceRequestedFilter(
            $"https://{VirtualHost}/api/*",
            CoreWebView2WebResourceContext.All);
        browser.WebResourceRequested += Browser_WebResourceRequested;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_browser is not null)
        {
            _browser.WebResourceRequested -= Browser_WebResourceRequested;
            _browser = null;
        }
        GC.SuppressFinalize(this);
    }

    private async void Browser_WebResourceRequested(
        object? sender,
        CoreWebView2WebResourceRequestedEventArgs e)
    {
        CoreWebView2Deferral deferral = e.GetDeferral();
        try
        {
            e.Response = await RouteAsync(e.Request, applicationStopping).ConfigureAwait(true);
        }
        catch (OperationCanceledException) when (applicationStopping.IsCancellationRequested)
        {
            e.Response = JsonResponse(new { error = "NMSA is shutting down." }, 503, "Service Unavailable");
        }
        catch (Exception exception)
        {
            (int status, string reason, string code, string message) = MapError(exception);
            await DesktopLog.WriteHostFailureAsync(exception).ConfigureAwait(true);
            e.Response = JsonResponse(new { error = message, code }, status, reason);
        }
        finally
        {
            deferral.Complete();
        }
    }

    private async ValueTask<CoreWebView2WebResourceResponse> RouteAsync(
        CoreWebView2WebResourceRequest request,
        CancellationToken cancellationToken)
    {
        if (!HasValidSession(request))
        {
            return JsonResponse(new { error = "Invalid NMSA desktop session." }, 403, "Forbidden");
        }
        if (!Uri.TryCreate(request.Uri, UriKind.Absolute, out Uri? uri)
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.Ordinal)
            || !string.Equals(uri.Host, VirtualHost, StringComparison.Ordinal)
            || !uri.IsDefaultPort
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Fragment))
        {
            return JsonResponse(new { error = "Not found." }, 404, "Not Found");
        }

        return (request.Method, uri.AbsolutePath) switch
        {
            ("GET", "/api/status") => JsonResponse(hostApi.GetStatus()),
            ("GET", "/api/discover") => JsonResponse(await hostApi.DiscoverAsync(cancellationToken)),
            ("POST", "/api/select-folder") => await SelectFolderAsync(cancellationToken),
            ("GET", "/api/file") => await ReadFileAsync(uri, cancellationToken),
            ("POST", "/api/install") => await InstallAsync(request, cancellationToken),
            ("GET", "/api/backups") => JsonResponse(await hostApi.GetBackupsAsync(cancellationToken)),
            ("POST", "/api/rollback") => await RollbackAsync(request, cancellationToken),
            (_, "/api/status" or "/api/discover" or "/api/select-folder" or "/api/file"
                or "/api/install" or "/api/backups" or "/api/rollback") =>
                JsonResponse(new { error = "Method not allowed." }, 405, "Method Not Allowed"),
            _ => JsonResponse(new { error = "Not found." }, 404, "Not Found"),
        };
    }

    private async ValueTask<CoreWebView2WebResourceResponse> SelectFolderAsync(
        CancellationToken cancellationToken)
    {
        string? folder = folderPicker.PickFolder();
        if (folder is null)
        {
            var cancelled = new DiscoveryResult([], [], [], hostApi.GetStatus(), Cancelled: true);
            return JsonResponse(cancelled);
        }

        return JsonResponse(await hostApi.DiscoverFolderAsync(folder, cancellationToken));
    }

    private async ValueTask<CoreWebView2WebResourceResponse> ReadFileAsync(
        Uri uri,
        CancellationToken cancellationToken)
    {
        string token = QueryValue(uri.Query, "token")
            ?? throw new InvalidOperationException("File token is missing.");
        byte[] bytes = await hostApi.ReadFileAsync(token, cancellationToken);
        return CreateResponse(
            new MemoryStream(bytes, writable: false),
            200,
            "OK",
            "application/octet-stream");
    }

    private async ValueTask<CoreWebView2WebResourceResponse> InstallAsync(
        CoreWebView2WebResourceRequest request,
        CancellationToken cancellationToken)
    {
        RequireJsonContentType(request);
        InstallRequest payload = await DeserializeBodyAsync<InstallRequest>(
            request.Content,
            InstallBodyLimit,
            cancellationToken);
        return JsonResponse(await hostApi.InstallAsync(payload, cancellationToken));
    }

    private async ValueTask<CoreWebView2WebResourceResponse> RollbackAsync(
        CoreWebView2WebResourceRequest request,
        CancellationToken cancellationToken)
    {
        RequireJsonContentType(request);
        RollbackRequest payload = await DeserializeBodyAsync<RollbackRequest>(
            request.Content,
            DefaultBodyLimit,
            cancellationToken);
        return JsonResponse(await hostApi.RollbackAsync(payload.BackupId, cancellationToken));
    }

    private bool HasValidSession(CoreWebView2WebResourceRequest request)
    {
        string provided;
        try
        {
            provided = request.Headers.Contains("X-NMSA-Session")
                ? request.Headers.GetHeader("X-NMSA-Session")
                : string.Empty;
        }
        catch (ArgumentException)
        {
            return false;
        }

        if (provided.Length != _expectedSessionBytes.Length)
        {
            return false;
        }
        Span<byte> providedBytes = stackalloc byte[64];
        int written = Encoding.ASCII.GetBytes(provided.AsSpan(), providedBytes);
        return written == _expectedSessionBytes.Length
            && CryptographicOperations.FixedTimeEquals(
                _expectedSessionBytes,
                providedBytes[..written]);
    }

    private CoreWebView2WebResourceResponse JsonResponse<T>(
        T value,
        int statusCode = 200,
        string reason = "OK")
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, HostJson.Options);
        return CreateResponse(
            new MemoryStream(bytes, writable: false),
            statusCode,
            reason,
            "application/json; charset=utf-8");
    }

    private CoreWebView2WebResourceResponse CreateResponse(
        Stream content,
        int statusCode,
        string reason,
        string contentType)
    {
        string headers = string.Join("\r\n",
            $"Content-Type: {contentType}",
            "Cache-Control: no-store",
            "Content-Security-Policy: default-src 'none'; frame-ancestors 'none'",
            "X-Content-Type-Options: nosniff",
            "Referrer-Policy: no-referrer",
            "Cross-Origin-Resource-Policy: same-origin");
        return environment.CreateWebResourceResponse(content, statusCode, reason, headers);
    }

    private static async ValueTask<T> DeserializeBodyAsync<T>(
        Stream? body,
        long maximumBytes,
        CancellationToken cancellationToken)
    {
        if (body is null) throw new InvalidDataException("Request body is missing.");
        if (body.CanSeek && body.Length > maximumBytes)
        {
            throw new InvalidDataException("Request body exceeds the safety limit.");
        }
        await using var limited = new LimitedReadStream(body, maximumBytes);
        return await JsonSerializer.DeserializeAsync<T>(limited, HostJson.Options, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidDataException("Request body is empty.");
    }

    private static string? QueryValue(string query, string key)
    {
        foreach (string pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            string[] parts = pair.Split('=', 2);
            if (parts.Length == 2 && string.Equals(parts[0], key, StringComparison.Ordinal))
            {
                return Uri.UnescapeDataString(parts[1]);
            }
        }
        return null;
    }

    private static void RequireJsonContentType(CoreWebView2WebResourceRequest request)
    {
        string contentType;
        try
        {
            contentType = request.Headers.Contains("Content-Type")
                ? request.Headers.GetHeader("Content-Type")
                : string.Empty;
        }
        catch (ArgumentException exception)
        {
            throw new InvalidDataException("Request content type is invalid.", exception);
        }

        string mediaType = contentType.Split(';', 2)[0].Trim();
        if (!string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Request content type must be application/json.");
        }
    }

    private static byte[] ValidateSession(string value)
    {
        if (value.Length != 64 || value.Any(character => !Uri.IsHexDigit(character)))
        {
            throw new ArgumentException("Desktop session must be a 256-bit hexadecimal value.", nameof(value));
        }
        return Encoding.ASCII.GetBytes(value);
    }

    private static (int Status, string Reason, string Code, string Message) MapError(
        Exception exception) => exception switch
    {
        UnauthorizedAccessException => (
            403,
            "Forbidden",
            "file_access_denied",
            "Windows denied access to a required save or backup file."),
        FileNotFoundException or DirectoryNotFoundException => (
            404,
            "Not Found",
            "file_not_found",
            "A required save or backup file is no longer available. Scan saves again."),
        IOException => (
            409,
            "Conflict",
            "file_conflict",
            "A save file changed, is locked, or could not be updated safely."),
        InvalidOperationException or InvalidDataException or JsonException
            or FormatException or ArgumentException => (
                400,
                "Bad Request",
                "invalid_request",
                SafeClientMessage(exception)),
        _ => (
            500,
            "Internal Server Error",
            "host_failure",
            "NMSA could not complete the local operation. No unverified result was accepted."),
    };

    private static string SafeClientMessage(Exception exception)
    {
        string message = exception.Message.Trim();
        if (message.Length is 0 or > 240
            || message.IndexOfAny(['\r', '\n', '\0']) >= 0
            || message.Contains("\\\\", StringComparison.Ordinal)
            || message.Contains(":\\", StringComparison.Ordinal)
            || message.Contains(":/", StringComparison.Ordinal))
        {
            return "The request failed local safety validation.";
        }
        return message;
    }
}
