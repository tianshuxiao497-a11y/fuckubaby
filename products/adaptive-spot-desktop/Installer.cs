using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

internal sealed class Installer : Window {
    readonly bool remove;
    TextBlock headline, status;
    Button action, open, close;
    CheckBox desktopLink;
    ProgressBar progress;
    bool busy;
    Installer(bool uninstall) {
        remove = uninstall; Title = uninstall ? "Uninstall Adaptive Spot Bot" : "Adaptive Spot Bot - Windows Setup";
        var area = SystemParameters.WorkArea;
        Width = Math.Min(940, area.Width - 30); Height = Math.Min(720, area.Height - 30); MinWidth = Math.Min(820, area.Width - 30); MinHeight = Math.Min(600, area.Height - 30); WindowStartupLocation = WindowStartupLocation.CenterScreen; Ui.Apply(this);
        var frame = new Grid { Margin = new Thickness(30) };
        frame.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); frame.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); frame.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); Content = frame;
        var header = new Grid { Margin = new Thickness(0, 0, 0, 24) }; header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(68) }); header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var brand = Ui.Brand(); brand.Width = 48; brand.Height = 48; brand.VerticalAlignment = VerticalAlignment.Center; header.Children.Add(brand);
        var heading = new StackPanel(); Grid.SetColumn(heading, 1); header.Children.Add(heading);
        heading.Children.Add(Ui.Text("ADAPTIVE  /  TESTNET EDITION", 13, "#51E7CC", true));
        var title = Ui.Text(remove ? "卸载应用，保留交易记录" : "你的策略工作台，即将就绪。", 29, "#F4F7FF", true); title.Margin = new Thickness(0, 8, 0, 8); heading.Children.Add(title);
        heading.Children.Add(Ui.Text("WINDOWS DESKTOP  " + Shared.Version + "   ·   仅虚拟资金   ·   安装不会开始交易", 12, "#9AAAC8")); frame.Children.Add(header);
        var body = new Grid(); body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(5, GridUnitType.Star) }); body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(12) }); body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3, GridUnitType.Star) }); Grid.SetRow(body, 1); frame.Children.Add(body);
        var content = new StackPanel(); headline = Ui.Text(remove ? "安全卸载" : Directory.Exists(Shared.Install) ? "检测到已安装版本" : "一键安装，无需配置编程环境", 20, "#F4F7FF", true); content.Children.Add(headline);
        var detail = Ui.Text(remove ? "只移除校验通过的应用文件和本程序快捷方式。API 密钥、持仓及订单记录保留。卸载不平仓、不撤单。" : "内置运行环境和交易工作台。旧版可以直接修复 / 升级；旧应用文件和未知附加文件会完整保存在备份文件夹，不清除密钥或交易记录。", 14, "#B4C0D8"); detail.TextWrapping = TextWrapping.Wrap; detail.Margin = new Thickness(0, 14, 0, 20); content.Children.Add(detail);
        content.Children.Add(Ui.Text("应用安装位置", 12, "#8395B8", true)); var location = Ui.Text(Shared.Install, 12, "#DCE5F7"); location.TextWrapping = TextWrapping.Wrap; location.Margin = new Thickness(0, 6, 0, 18); content.Children.Add(location);
        desktopLink = new CheckBox { Content = "创建 / 修复桌面快捷方式", IsChecked = true, Margin = new Thickness(0, 0, 0, 18), Visibility = remove ? Visibility.Collapsed : Visibility.Visible }; content.Children.Add(desktopLink);
        progress = new ProgressBar { Height = 5, Minimum = 0, Maximum = 100, Value = 0, Margin = new Thickness(0, 0, 0, 14) }; content.Children.Add(progress);
        status = Ui.Text(remove ? "请先停止机器人并关闭交易窗口。" : "准备就绪。先安装，再配置你自己的测试网密钥。", 13, "#93A8C7"); status.TextWrapping = TextWrapping.Wrap;
        content.Children.Add(new ScrollViewer { Content = status, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = 180 }); body.Children.Add(Ui.Card(new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled }, 24));
        var aside = new StackPanel(); aside.Children.Add(Ui.Text("从安装到策略运行", 16, "#E8EEFD", true));
        AddStep(aside, "01", "安装应用", "无需另装 Node、Python 或命令行工具。", "#51E7CC"); AddStep(aside, "02", "配置测试网", "密钥保存在本机，先做只读连接检查。", "#8B8CFF"); AddStep(aside, "03", "查看交易工作台", "手动确认后启动虚拟策略，不连接实盘。", "#FFB66D");
        var caution = Ui.Text("Windows 10/11 x64 · .NET Framework 4.8\n未签名候选版，不是 Windows 认证产品。\n联网订阅校验 · 到期停止新任务。\n不含云端托管或盈利保证。", 11, "#8296B9"); caution.TextWrapping = TextWrapping.Wrap; caution.Margin = new Thickness(0, 22, 0, 0); aside.Children.Add(caution);
        var right = Ui.Card(new ScrollViewer { Content = aside, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled }, 22); Grid.SetColumn(right, 2); body.Children.Add(right);
        var footer = new DockPanel { LastChildFill = false, Margin = new Thickness(0, 22, 0, 0) }; Grid.SetRow(footer, 2); frame.Children.Add(footer);
        close = Ui.Button("关闭", (s,e) => Close()); close.Margin = new Thickness(0, 0, 12, 0); DockPanel.SetDock(close, Dock.Right); footer.Children.Add(close);
        action = Ui.Button(remove ? "确认卸载" : Directory.Exists(Shared.Install) ? "修复 / 升级应用" : "安装到本机", InstallClick, true); DockPanel.SetDock(action, Dock.Right); footer.Children.Add(action);
        open = Ui.Button("打开交易工作台  →", (s,e) => OpenDashboard(), true); open.Margin = new Thickness(0, 0, 12, 0); open.Visibility = Visibility.Collapsed; DockPanel.SetDock(open, Dock.Left); footer.Children.Add(open);
        Loaded += async (s,e) => { if (!remove && Directory.Exists(Shared.Install)) { bool valid = await Task.Run(() => InstallerCore.CurrentApplication(Shared.Install)); open.Visibility = valid ? Visibility.Visible : Visibility.Collapsed; status.Text = valid ? "当前版本已就绪，可直接打开交易工作台；不会自动开始交易。" : "检测到旧版或不完整安装。请点击“修复 / 升级应用”，完成后再打开新版交易工作台。密钥和交易记录不会清空。"; } };
        Closing += (s,e) => { if (busy) { e.Cancel = true; status.Text = "正在完成安全安装，请稍等。不要强制结束安装程序。"; } };
    }
    static void AddStep(Panel panel, string number, string text, string description, string color) {
        var block = new StackPanel { Margin = new Thickness(0, 22, 0, 0) }; block.Children.Add(Ui.Text(number + "  " + text, 15, color, true)); var d = Ui.Text(description, 12, "#9CAFCF"); d.TextWrapping = TextWrapping.Wrap; d.Margin = new Thickness(0, 6, 0, 0); block.Children.Add(d); panel.Children.Add(block);
    }
    async void InstallClick(object sender, RoutedEventArgs e) {
        busy = true; action.IsEnabled = close.IsEnabled = open.IsEnabled = false; desktopLink.IsEnabled = false; progress.IsIndeterminate = true; status.Text = remove ? "正在核验应用文件；保留账户记录…" : "正在校验、暂存并安全切换应用文件…"; bool desktop = desktopLink.IsChecked == true;
        try {
            InstallerCore.Result result = null; await Task.Run(() => { if (remove) InstallerCore.UninstallDefault(); else result = InstallerCore.InstallDefault(desktop); });
            progress.IsIndeterminate = false; progress.Value = 100; headline.Text = remove ? "应用已卸载，记录已保留" : "安装完成，打开你的交易工作台。";
            status.Text = remove ? "本机密钥、持仓与订单记录未删除。未知文件与备份文件夹会保留，不执行清仓或撤单。" : "没有启动任何交易。点击下方按钮打开工作台，再配置测试网密钥。\n" + String.Join("\n", result.Notices.ToArray());
            action.Visibility = Visibility.Collapsed; if (!remove) open.Visibility = Visibility.Visible;
        } catch (Exception ex) {
            progress.IsIndeterminate = false; progress.Value = 0; headline.Text = "安装未完成，文件和记录已保留"; status.Text = ex.Message + "\n\n如机器人仍在运行，请先安全停止并关闭窗口后重试。不要删除交易锁、密钥或订单文件来强行安装。"; action.IsEnabled = true; action.Content = "重新检查并重试";
            if (!remove) open.Visibility = InstallerCore.CurrentApplication(Shared.Install) ? Visibility.Visible : Visibility.Collapsed;
        } finally { busy = false; close.IsEnabled = open.IsEnabled = true; desktopLink.IsEnabled = true; }
    }
    void OpenDashboard() {
        try {
            if (!InstallerCore.CurrentApplication(Shared.Install)) throw new IOException("当前安装不是这份安装包的新版本，或文件校验失败。请先修复 / 升级后再打开。");
            Process.Start(new ProcessStartInfo(Path.Combine(Shared.Install, "AdaptiveSpotBot.exe")) { UseShellExecute = false, WorkingDirectory = Shared.Install }); Close();
        } catch (Exception e) { status.Text = "未能打开工作台：" + e.Message; }
    }
    [STAThread] static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--verify-payload") { try { InstallerCore.VerifyAndExtract(args[1]); return 0; } catch { return 1; } }
        if (args.Length == 2 && args[0] == "--self-test-install") return InstallerCore.SelfTest(args[1]);
        if (args.Length == 1 && args[0] == "--uninstall") {
            string temp = Path.Combine(Path.GetTempPath(), "AdaptiveSpotBot-Uninstall-" + Guid.NewGuid().ToString("N") + ".exe"); File.Copy(Assembly.GetExecutingAssembly().Location, temp, false); Process.Start(new ProcessStartInfo(temp, "--remove-installed") { UseShellExecute = false }); return 0;
        }
        if (args.Length > 1 || args.Length == 1 && args[0] != "--remove-installed") return 2;
        var app = new Application(); app.Run(new Installer(args.Length == 1)); return 0;
    }
}
