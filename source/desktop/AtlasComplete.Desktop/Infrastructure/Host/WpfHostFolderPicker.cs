using System.Windows;
using Microsoft.Win32;

namespace Nmsa.Desktop.Infrastructure.Host;

public sealed class WpfHostFolderPicker(Window owner) : IHostFolderPicker
{
    public string? PickFolder()
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Choose a No Man's Sky profile, NMS root, Xbox container, or extracted console save folder",
            Multiselect = false,
        };
        return dialog.ShowDialog(owner) == true ? dialog.FolderName : null;
    }
}
