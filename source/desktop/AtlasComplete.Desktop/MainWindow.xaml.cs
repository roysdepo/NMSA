using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Nmsa.Desktop.Infrastructure;
using Nmsa.Desktop.Infrastructure.Host;
using Nmsa.Desktop.Presentation;

namespace Nmsa.Desktop;

public partial class MainWindow : Window, IAsyncDisposable
{
    private readonly MainWindowViewModel _viewModel = new();
    private readonly AtlasHostApi _hostApi = new();
    private readonly CancellationTokenSource _lifetime = new();
    private WebViewApiRouter? _apiRouter;
    private bool _initialized;
    private bool _browserConfigured;
    private bool _closed;
    private bool _disposed;

    public MainWindow()
    {
        InitializeComponent();
        DataContext = _viewModel;
        Loaded += MainWindow_Loaded;
        Closed += MainWindow_Closed;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        await InitializeNmsaAsync().ConfigureAwait(true);
    }

    private async Task InitializeNmsaAsync()
    {
        if (_initialized || _closed)
        {
            return;
        }

        _initialized = true;
        _viewModel.SetStarting("Starting the secure in-process NMSA host…");

        try
        {
            string contentRoot = Path.Combine(AppContext.BaseDirectory, "Web");
            string contentPath = Path.Combine(contentRoot, "NMSA.html");
            if (!File.Exists(contentPath))
            {
                throw new FileNotFoundException("The verified NMSA editor is missing from the application package.");
            }

            string userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NMSA",
                "WebView2");
            CoreWebView2Environment environment = await CoreWebView2Environment
                .CreateAsync(browserExecutableFolder: null, userDataFolder: userDataFolder)
                .ConfigureAwait(true);
            await Browser.EnsureCoreWebView2Async(environment).ConfigureAwait(true);

            if (!_browserConfigured)
            {
                ConfigureBrowser(Browser.CoreWebView2);
                Browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    WebViewApiRouter.VirtualHost,
                    contentRoot,
                    CoreWebView2HostResourceAccessKind.DenyCors);
                string session = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
                _apiRouter = new WebViewApiRouter(
                    environment,
                    _hostApi,
                    new WpfHostFolderPicker(this),
                    session,
                    _lifetime.Token);
                _apiRouter.Attach(Browser.CoreWebView2);
                Browser.Tag = session;
                _browserConfigured = true;
            }

            string expectedSession = Browser.Tag as string
                ?? throw new InvalidOperationException("The NMSA host session is unavailable.");
            _viewModel.SetNavigating();
            Browser.Source = ApplicationUri(expectedSession);
        }
        catch (OperationCanceledException) when (_closed || _lifetime.IsCancellationRequested)
        {
            // Window shutdown cancels startup without displaying a stale error.
        }
        catch (Exception exception)
        {
            _initialized = false;
            string? logPath = await DesktopLog.WriteStartupFailureAsync(exception).ConfigureAwait(true);
            string logHint = logPath is null ? string.Empty : $" Technical details were written to {logPath}.";
            _viewModel.SetError(UserFacingMessage(exception) + logHint);
        }
    }

    private void ConfigureBrowser(CoreWebView2 browser)
    {
        browser.Settings.AreBrowserAcceleratorKeysEnabled = Debugger.IsAttached;
        browser.Settings.AreDefaultContextMenusEnabled = false;
        browser.Settings.AreDefaultScriptDialogsEnabled = false;
        browser.Settings.AreDevToolsEnabled = Debugger.IsAttached;
        browser.Settings.AreHostObjectsAllowed = false;
        browser.Settings.IsBuiltInErrorPageEnabled = false;
        browser.Settings.IsGeneralAutofillEnabled = false;
        browser.Settings.IsPasswordAutosaveEnabled = false;
        browser.Settings.IsStatusBarEnabled = false;
        browser.Settings.IsSwipeNavigationEnabled = false;
        browser.Settings.IsWebMessageEnabled = false;
        browser.Settings.IsZoomControlEnabled = true;

        browser.NavigationStarting += Browser_NavigationStarting;
        browser.NavigationCompleted += Browser_NavigationCompleted;
        browser.NewWindowRequested += Browser_NewWindowRequested;
        browser.PermissionRequested += Browser_PermissionRequested;
        browser.ProcessFailed += Browser_ProcessFailed;
    }

    private void Browser_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? target)
            || !IsApplicationDocument(target))
        {
            e.Cancel = true;
            _viewModel.SetError("NMSA blocked an unexpected navigation outside its secure local workspace.");
            return;
        }

        _viewModel.SetNavigating();
    }

    private void Browser_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            _viewModel.SetReady();
            return;
        }

        _viewModel.SetError($"The NMSA workspace could not load ({e.WebErrorStatus}). Select Retry to restart it.");
    }

    private static void Browser_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
    }

    private static void Browser_PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        e.State = CoreWebView2PermissionState.Deny;
        e.SavesInProfile = false;
    }

    private void Browser_ProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        _viewModel.SetError("The Windows rendering process stopped unexpectedly. Select Retry to restart NMSA.");
    }

    private void RefreshButton_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.CanRefresh && Browser.CoreWebView2 is not null)
        {
            _viewModel.SetNavigating();
            NavigateToApplication();
        }
    }

    private async void RetryButton_Click(object sender, RoutedEventArgs e)
    {
        if (_closed)
        {
            return;
        }

        if (_browserConfigured && Browser.CoreWebView2 is not null)
        {
            _viewModel.SetNavigating();
            NavigateToApplication();
            return;
        }

        _initialized = false;
        await InitializeNmsaAsync().ConfigureAwait(true);
    }

    private async void MainWindow_Closed(object? sender, EventArgs e)
    {
        _closed = true;
        try
        {
            await DisposeAsync().ConfigureAwait(true);
        }
        catch (Exception)
        {
            // Application shutdown is already in progress; owned resources are best-effort.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _lifetime.Cancel();
        _apiRouter?.Dispose();
        Browser.Dispose();

        try
        {
            await _hostApi.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            _lifetime.Dispose();
        }

        GC.SuppressFinalize(this);
    }

    private static bool HasSameOrigin(Uri expected, Uri target) =>
        string.Equals(expected.Scheme, target.Scheme, StringComparison.Ordinal)
        && string.Equals(expected.Host, target.Host, StringComparison.Ordinal)
        && expected.Port == target.Port;

    private static bool IsApplicationDocument(Uri target) =>
        HasSameOrigin(WebViewApiRouter.ApplicationOrigin, target)
        && string.Equals(target.AbsolutePath, "/NMSA.html", StringComparison.Ordinal)
        && string.IsNullOrEmpty(target.Query)
        && string.IsNullOrEmpty(target.UserInfo);

    private static Uri ApplicationUri(string session) => new(
        $"https://{WebViewApiRouter.VirtualHost}/NMSA.html#session={session}");

    private void NavigateToApplication()
    {
        string session = Browser.Tag as string
            ?? throw new InvalidOperationException("The NMSA host session is unavailable.");
        Browser.Source = ApplicationUri(session);
    }

    private static string UserFacingMessage(Exception exception) => exception switch
    {
        FileNotFoundException => exception.Message,
        TimeoutException => exception.Message,
        WebView2RuntimeNotFoundException =>
            "The Microsoft Edge WebView2 Runtime is required. Install the Evergreen Runtime, then select Retry.",
        _ => "NMSA encountered an unexpected startup error. Close the application and try again. "
             + "Technical details were intentionally withheld to protect local file paths.",
    };
}
