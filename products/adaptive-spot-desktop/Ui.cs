using System;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;

internal static class Ui {
    internal static Brush Brush(string hex) { return (Brush)new BrushConverter().ConvertFromString(hex); }
    internal static void Apply(Window window) {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("theme.xaml")) {
            if (stream == null) throw new InvalidOperationException("Application theme missing. Please repair installation.");
            window.Resources = (ResourceDictionary)XamlReader.Load(stream);
        }
        window.Background = Brush("#0B1020"); window.Foreground = Brush("#EDF3FF");
        window.FontFamily = new FontFamily("Segoe UI, Microsoft YaHei UI"); window.FontSize = 13;
        window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        window.UseLayoutRounding = true; window.SnapsToDevicePixels = true;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico")) {
            if (stream != null) { var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.StreamSource = stream; bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.EndInit(); bitmap.Freeze(); window.Icon = bitmap; }
        }
    }
    internal static TextBlock Text(string text, double size = 13, string hex = "#EDF3FF", bool bold = false) {
        return new TextBlock { Text = text, FontSize = size, Foreground = Brush(hex), FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, TextWrapping = TextWrapping.Wrap };
    }
    internal static Button Button(string text, RoutedEventHandler handler, bool primary = false) {
        var b = new Button { Content = text, Margin = new Thickness(0,0,8,8), Padding = new Thickness(18,11,18,11), MinHeight = 42 };
        b.SetResourceReference(FrameworkElement.StyleProperty, primary ? "PrimaryButton" : "SecondaryButton"); if (handler != null) b.Click += handler; return b;
    }
    internal static Border Card(UIElement content, int padding = 20) {
        return new Border { Background = Brush("#131B2F"), BorderBrush = Brush("#26334D"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(16), Padding = new Thickness(padding), Child = content };
    }
    internal static Image Brand(double size = 48) {
        var image = new Image { Width = size, Height = size, Stretch = Stretch.Uniform };
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("brand.png")) {
            if (stream != null) { var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.StreamSource = stream; bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.EndInit(); bitmap.Freeze(); image.Source = bitmap; }
        }
        return image;
    }
}
