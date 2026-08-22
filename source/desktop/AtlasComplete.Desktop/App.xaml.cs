using System.Windows;
using System.Windows.Threading;
using Nmsa.Desktop.Infrastructure;

namespace Nmsa.Desktop;

public partial class App : System.Windows.Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += Application_DispatcherUnhandledException;
        TaskScheduler.UnobservedTaskException += TaskScheduler_UnobservedTaskException;
        AppDomain.CurrentDomain.UnhandledException += CurrentDomain_UnhandledException;
        base.OnStartup(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        DispatcherUnhandledException -= Application_DispatcherUnhandledException;
        TaskScheduler.UnobservedTaskException -= TaskScheduler_UnobservedTaskException;
        AppDomain.CurrentDomain.UnhandledException -= CurrentDomain_UnhandledException;
        base.OnExit(e);
    }

    private async void Application_DispatcherUnhandledException(
        object sender,
        DispatcherUnhandledExceptionEventArgs e)
    {
        e.Handled = true;
        await DesktopLog.WriteHostFailureAsync(e.Exception).ConfigureAwait(true);
        MessageBox.Show(
            "NMSA stopped an unexpected local operation. No unverified save result was accepted. "
            + "Restart NMSA and use Recovery if needed.",
            "NMSA safety stop",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
        Shutdown(-1);
    }

    private static void TaskScheduler_UnobservedTaskException(
        object? sender,
        UnobservedTaskExceptionEventArgs e)
    {
        _ = DesktopLog.WriteHostFailureAsync(e.Exception);
        e.SetObserved();
    }

    private static void CurrentDomain_UnhandledException(
        object sender,
        UnhandledExceptionEventArgs e)
    {
        if (e.ExceptionObject is Exception exception)
        {
            _ = DesktopLog.WriteHostFailureAsync(exception);
        }
    }
}
