using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace Nmsa.Desktop.Presentation;

public sealed class MainWindowViewModel : INotifyPropertyChanged
{
    private string _statusText = "Preparing NMSA…";
    private string _errorMessage = string.Empty;
    private bool _isBusy = true;
    private bool _hasError;
    private bool _isBrowserVisible;
    private bool _canRefresh;

    public event PropertyChangedEventHandler? PropertyChanged;

    public string StatusText
    {
        get => _statusText;
        private set => SetField(ref _statusText, value);
    }

    public string ErrorMessage
    {
        get => _errorMessage;
        private set => SetField(ref _errorMessage, value);
    }

    public bool IsBusy
    {
        get => _isBusy;
        private set => SetField(ref _isBusy, value);
    }

    public bool HasError
    {
        get => _hasError;
        private set => SetField(ref _hasError, value);
    }

    public bool IsBrowserVisible
    {
        get => _isBrowserVisible;
        private set => SetField(ref _isBrowserVisible, value);
    }

    public bool CanRefresh
    {
        get => _canRefresh;
        private set => SetField(ref _canRefresh, value);
    }

    public void SetStarting(string status)
    {
        StatusText = status;
        ErrorMessage = string.Empty;
        IsBusy = true;
        HasError = false;
        IsBrowserVisible = false;
        CanRefresh = false;
    }

    public void SetNavigating()
    {
        StatusText = "Loading the NMSA workspace…";
        IsBusy = true;
        HasError = false;
        IsBrowserVisible = true;
        CanRefresh = false;
    }

    public void SetReady()
    {
        StatusText = "Ready";
        IsBusy = false;
        HasError = false;
        IsBrowserVisible = true;
        CanRefresh = true;
    }

    public void SetError(string message)
    {
        StatusText = "Startup failed";
        ErrorMessage = message;
        IsBusy = false;
        HasError = true;
        IsBrowserVisible = false;
        CanRefresh = false;
    }

    private void SetField<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value))
        {
            return;
        }

        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}
