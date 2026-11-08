using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

internal sealed class TradeRow {
    public string Time { get; set; } public string Side { get; set; } public string Quantity { get; set; }
    public string Quote { get; set; } public string Status { get; set; } public string Pnl { get; set; } public string Reason { get; set; }
}
internal sealed class Desktop : Window {
    readonly string install = AppDomain.CurrentDomain.BaseDirectory, profile;
    readonly bool preview;
    readonly Grid view;
    readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
    Process controller; StreamWriter input; FileStream profileLock;
    bool ready, configured, connected, running, closing, working, loading, connectAfterSave, connectAfterLicense, restoreOnly, disposed, licensed, licenseWorking;
    string pendingLicenseKey, restoredLicenseKey, selectedSymbol="BTCUSDT";
    Dictionary<string,object> pendingCredentials;
    List<double> prices = new List<double>();
    int ticks;
    T C<T>(string name) where T : FrameworkElement { return (T)view.FindName(name); }
    void Txt(string name,string text) { C<TextBlock>(name).Text = text; }
    static Dictionary<string,object> Obj(object x) { return x as Dictionary<string,object> ?? new Dictionary<string,object>(); }
    static object Get(Dictionary<string,object> d,string k) { object v; return d.TryGetValue(k,out v) ? v : null; }
    static string Str(object x) { return x == null ? "—" : Convert.ToString(x, CultureInfo.InvariantCulture); }
    static bool Yes(Dictionary<string,object> d,string k) { return Object.Equals(Get(d,k),true); }
    static double? Num(object x) { double n; return x != null && Double.TryParse(Str(x), NumberStyles.Float, CultureInfo.InvariantCulture,out n) && !Double.IsNaN(n) && !Double.IsInfinity(n) ? (double?)n : null; }
    static string F(object x,string format="0.########") { var n=Num(x); return n.HasValue ? n.Value.ToString(format,CultureInfo.InvariantCulture) : "—"; }
    static string Time(object x) { var n=Num(x); if(!n.HasValue || n<0 || n>253402300799999d) return "—"; return new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddMilliseconds(n.Value).ToLocalTime().ToString("MM-dd HH:mm:ss"); }
    public Desktop(bool demo) {
        preview=demo; profile=demo ? System.IO.Path.Combine(install,"qa-ui-profile") : Shared.Profile;
        Title="Adaptive Spot Bot — Testnet Edition | "+Shared.Version+(demo?" [OFFLINE PREVIEW]":"");
        Ui.Apply(this); var area=SystemParameters.WorkArea;
        Width=Math.Min(1250,area.Width-30); Height=Math.Min(840,area.Height-30); MinWidth=Math.Min(960,area.Width-30); MinHeight=Math.Min(640,area.Height-30);
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("desktop.xaml")) {
            if(stream==null) throw new IOException("Trading dashboard missing. Repair installation.");
            view=(Grid)XamlReader.Load(stream);
        }
        Content=view; C<Image>("BrandImage").Source=Ui.Brand(54).Source;
        Txt("VersionText","DESKTOP "+Shared.Version+(demo?" · OFFLINE PREVIEW":""));
        Action<string,string> nav=(button,page)=>C<Button>(button).Click+=(s,e)=>ShowPage(page);
        nav("NavOverview","Overview"); nav("NavConnection","Connection"); nav("NavLicense","License"); nav("NavActivity","Activity"); nav("NavHelp","Help");
        C<Button>("ManageSubscriptionButton").Click+=(s,e)=>Open("https://whop.com/orders/");
        C<Button>("ActivateLicenseButton").Click+=(s,e)=>ActivateLicense(C<PasswordBox>("LicenseKeyInput").Password.Trim(),false);
        C<Button>("ConfigureCta").Click+=(s,e)=>ShowPage(!licensed?"License":connected?"Overview":"Connection");
        C<Button>("SaveButton").Click+=(s,e)=>Save(false); C<Button>("SaveConnectButton").Click+=(s,e)=>Save(true);
        C<Button>("ConnectButton").Click+=(s,e)=>Read("connect"); C<Button>("RefreshButton").Click+=(s,e)=>Read("snapshot");
        C<Button>("StartButton").Click+=Start; C<Button>("StopButton").Click+=(s,e)=> { Send("stop"); Txt("StrategyState","正在停止"); Txt("SignalText","等待在途请求完成；不会平仓或撤单。"); Buttons(); };
        C<Button>("GenerateButton").Click+=(s,e)=> { if(!ready || running || working || licenseWorking || preview || closing) return; working=true; if(!Send("generateKey")) working=false; Buttons(); };
        C<Button>("BrowseButton").Click+=(s,e)=>BrowsePem();
        C<Button>("MarketsButton").Click+=(s,e)=> { if(!ready || working || running || preview || closing || licenseWorking)return;working=true;if(!Send("markets"))working=false;Buttons(); };
        C<ComboBox>("SymbolSelect").SelectionChanged+=(s,e)=> {
            if(loading||!ready||!configured||working||running||preview||closing)return;
            string symbol=Str(C<ComboBox>("SymbolSelect").SelectedValue);if(symbol==selectedSymbol)return;
            working=true;if(!Send("selectSymbol",new Dictionary<string,object>{{"symbol",symbol}})) {working=false;ApplySymbol(selectedSymbol);}Buttons();
        };
        C<Button>("OpenTestnetButton").Click+=(s,e)=>Open("https://testnet.binance.vision/");
        C<Button>("GuideChineseButton").Click+=(s,e)=>Open(System.IO.Path.Combine(install,"QUICKSTART-ZH.txt"));
        C<Button>("GuideEnglishButton").Click+=(s,e)=>Open(System.IO.Path.Combine(install,"QUICKSTART-EN.txt"));
        C<Button>("OpenDataButton").Click+=(s,e)=> { if(!preview) Open(profile); };
        C<PasswordBox>("ApiKeyInput").PasswordChanged+=(s,e)=>Dirty(); C<PasswordBox>("SecretInput").PasswordChanged+=(s,e)=>Dirty(); C<TextBox>("PemInput").TextChanged+=(s,e)=>Dirty();
        foreach(string name in new[]{"VirtualConsent","SingleConsent"}) { C<CheckBox>(name).Checked+=(s,e)=>Buttons(); C<CheckBox>(name).Unchecked+=(s,e)=>Buttons(); }
        C<Canvas>("PriceCanvas").SizeChanged+=(s,e)=>DrawChart();
        Txt("HelpCopy", HelpText); ShowPage("Overview"); ResetAccount(); Banner("订阅尚未核验，禁止启动交易","先在“订阅授权”验证许可证。授权服务未配置、到期或核验失败时保持锁定；仍可查看记录与只读连接。"); C<Button>("ConfigureCta").Content="核验订阅  →"; Buttons();
        Loaded+=async(s,e)=> { if(preview) { Banner("离线界面预览","没有读取账户、价格、密钥或订单。连接和交易按钮已禁用。"); Note("Offline UI preview. No account or synthetic trading performance displayed."); } else await Boot(); DrawChart(); };
        timer.Tick+=(s,e)=> { if(ready && !closing) { Send("licenseStatus"); if(configured) { Send("local"); if(++ticks%7==0 && connected && !working && !licenseWorking) Read("snapshot",false); } } };
        Closing+=CloseSafely;
    }
    void ShowPage(string page) {
        foreach(string p in new[]{"Overview","Connection","License","Activity","Help"}) { C<StackPanel>(p+"View").Visibility=p==page ? Visibility.Visible:Visibility.Collapsed; C<Button>("Nav"+p).Background=Ui.Brush(p==page?"#23304D":"#0E1528"); C<Button>("Nav"+p).Foreground=Ui.Brush(p==page?"#67E8F9":"#93A7C7"); }
        Txt("PageTitle",page=="Overview"?"交易总览":page=="Connection"?"密钥配置":page=="Activity"?"运行记录":"帮助与安全");
        Txt("PageSubtitle",page=="Overview"?"Your strategy. Your machine. Virtual funds only.":page=="Connection"?"Connect your own Spot Testnet. Credentials stay local.":page=="Activity"?"Local activity · strategy state and read-only monitoring":"Know the limits before you start.");
        if(page=="License") { Txt("PageTitle","订阅授权"); Txt("PageSubtitle","Online entitlement checks · no merchant secrets in the app"); }
        C<ScrollViewer>("MainScroll").ScrollToTop();
    }
    void Banner(string title,string detail) { Txt("BannerTitle",title); Txt("BannerDetail",detail); }
    void Note(string text) { var log=C<TextBox>("LogOutput"); log.AppendText(DateTime.Now.ToString("HH:mm:ss")+"  "+text+Environment.NewLine); if(log.Text.Length>90000) log.Text=log.Text.Substring(log.Text.Length-60000); log.ScrollToEnd(); }
    void Fail(string text) { Note(text); Banner("操作未完成，请核对提示",text); Txt("ConnectionNote",text); Txt("FooterState",running?"●  监控操作出错；交易进程状态单独显示，可请求停止":"●  未启动新交易；请检查配置或本机记录"); }
    void Open(string target) { try { Process.Start(new ProcessStartInfo(target) { UseShellExecute=true }); } catch { Fail("无法打开文件或页面，请查阅安装包内说明。"); } }
    void Buttons() {
        bool edit=ready && !preview && !working && !licenseWorking && !running && !closing;
        C<Button>("ActivateLicenseButton").IsEnabled=edit;
        C<ComboBox>("SymbolSelect").IsEnabled=edit && configured;
        C<Button>("MarketsButton").IsEnabled=edit;
        C<PasswordBox>("LicenseKeyInput").IsEnabled=edit;
        foreach(string n in new[]{"SaveButton","SaveConnectButton","GenerateButton","BrowseButton"}) C<Button>(n).IsEnabled=edit;
        C<PasswordBox>("ApiKeyInput").IsEnabled=C<PasswordBox>("SecretInput").IsEnabled=C<TextBox>("PemInput").IsEnabled=edit;
        C<Button>("ConnectButton").IsEnabled=C<Button>("RefreshButton").IsEnabled=ready && configured && !working && !licenseWorking && !preview && !closing;
        C<Button>("StartButton").IsEnabled=ready && configured && connected && licensed && !licenseWorking && !working && !running && !closing && !preview && C<CheckBox>("VirtualConsent").IsChecked==true && C<CheckBox>("SingleConsent").IsChecked==true;
        C<Button>("StopButton").IsEnabled=ready && !preview && !closing;
        C<Button>("OpenTestnetButton").IsEnabled=!preview; C<Button>("OpenDataButton").IsEnabled=!preview;
    }
    void ApplySymbol(string symbol) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(symbol??"","^[A-Z0-9]{1,20}USDT$") || symbol=="USDTUSDT")throw new InvalidOperationException("Invalid Testnet symbol");
        selectedSymbol=symbol;string asset=symbol.Substring(0,symbol.Length-4);bool wasLoading=loading;loading=true;
        var select=C<ComboBox>("SymbolSelect");bool found=false;foreach(var item in select.Items){var entry=item as ComboBoxItem;if(entry!=null&&Str(entry.Tag)==symbol)found=true;}
        if(!found)select.Items.Add(new ComboBoxItem{Tag=symbol,Content=asset+" / USDT"});select.SelectedValue=symbol;loading=wasLoading;
        Txt("PriceLabel",asset+" / USDT 价格");Txt("PositionLabel","程序持仓 / "+asset);C<DataGrid>("TradeGrid").Columns[2].Header=asset+" 数量";
        Txt("ChartRange","BINANCE SPOT TESTNET · "+symbol);
    }
    void ResetAccount() {
        foreach(string n in new[]{"PriceValue","BalanceValue","PositionValue","OrderValue"}) Txt(n,"— —");
        Txt("PriceDetail","尚未取得测试网行情"); Txt("BalanceDetail","未连接账户"); Txt("PositionDetail","只统计本程序记录"); Txt("OrderDetail","不是账户全部历史");
        C<DataGrid>("TradeGrid").ItemsSource=new List<TradeRow>(); C<TextBlock>("OrdersEmpty").Visibility=Visibility.Visible;
        prices.Clear(); DrawChart(); Txt("ChartSource","●  NO DATA"); Txt("UpdatedText","未刷新");
    }
    void Dirty() { if(loading || running) return; configured=connected=false; ResetAccount(); Txt("ConnectionNote","配置已修改，请重新保存并只读测试连接。"); Buttons(); }
    void BrowsePem() {
        if(!ready || running || working || licenseWorking || preview || closing) return;
        try {
            string value=C<TextBox>("PemInput").Text.Trim(), folder=System.IO.Path.Combine(profile,"keys");
            var dialog=new Microsoft.Win32.OpenFileDialog { Title="选择 Ed25519 私钥（testnet-private.pem）", Filter="PEM 私钥 (*.pem)|*.pem|所有文件 (*.*)|*.*", CheckFileExists=true, Multiselect=false, RestoreDirectory=true };
            if(File.Exists(value)) { dialog.InitialDirectory=System.IO.Path.GetDirectoryName(value); dialog.FileName=System.IO.Path.GetFileName(value); }
            else if(Directory.Exists(folder)) { dialog.InitialDirectory=folder; dialog.FileName="testnet-private.pem"; }
            if(dialog.ShowDialog(this)==true) C<TextBox>("PemInput").Text=dialog.FileName;
        } catch { Fail("无法打开文件选择器。可将本机 testnet-private.pem 的完整路径粘贴到 PEM 输入框；不要粘贴文件内容。"); }
    }
    bool Send(string command,Dictionary<string,object> data=null) {
        if(preview || controller==null || input==null) return false;
        if(data==null) data=new Dictionary<string,object>(); data["command"]=command;
        try { if(controller.HasExited) throw new IOException("Controller exited."); input.WriteLine(Shared.Json.Serialize(data)); input.Flush(); return true; } catch { ready=licensed=working=licenseWorking=false; pendingLicenseKey=null; connectAfterLicense=false; Fail("本机控制器连接中断；交易状态尚未确认。保留本机记录，不要另开副本。"); Buttons(); return false; }
    }
    void Save(bool connect) {
        if(!ready || running || working || licenseWorking || closing || preview) return;
        connectAfterSave=connect; restoreOnly=false; configured=false;
        pendingCredentials=new Dictionary<string,object>{{"apiKey",C<PasswordBox>("ApiKeyInput").Password.Trim()},{"apiSecret",C<PasswordBox>("SecretInput").Password.Trim()},{"privateKeyPath",C<TextBox>("PemInput").Text.Trim()}};
        working=true; connected=false; if(!Send("configure",new Dictionary<string,object>{{"credentials",pendingCredentials}})) working=false; Buttons();
    }
    void Read(string command,bool announce=true) {
        if(!ready || !configured || working || licenseWorking || closing || preview) return;
        working=true; if(announce) Banner("正在只读检查测试网","本次只读取账户和行情，不会提交订单。网络或地区限制不会被绕过。");
        if(!Send(command)) working=false; Buttons();
    }
    void Start(object sender,RoutedEventArgs e) {
        if(!licensed || licenseWorking) { ShowPage("License"); return; }
        if(MessageBox.Show(this,"开始 "+selectedSymbol+" 测试网虚拟自动交易？\n\n程序持仓预算最多 100 虚拟 USDT，约每 5 秒检查一次，符合策略才成交，不是固定频率买卖。\n\n一次只运行一个交易对。有程序持仓或待核对订单时不能切换；旧记录按交易对保留。\n\n到期或授权校验失败会停止交易，本机保护也停止。停止不会平仓或撤单。仅虚拟资金，不接入实盘。","确认开启虚拟交易",MessageBoxButton.YesNo,MessageBoxImage.Warning)!=MessageBoxResult.Yes) return;
        working=true; if(!Send("start",new Dictionary<string,object>{{"confirmVirtualOnly",true},{"confirmNoOtherBot",true}})) working=false; Buttons();
    }
    async Task Boot() {
        try {
            Shared.PrivateDirectory(profile); profileLock=new FileStream(System.IO.Path.Combine(profile,"desktop.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
            string savedPath=System.IO.Path.Combine(profile,"credentials.dpapi");
            if(File.Exists(savedPath)) { var saved=Obj(Shared.LoadCredentials(savedPath)); loading=true; C<PasswordBox>("ApiKeyInput").Password=Convert.ToString(Get(saved,"apiKey")); C<PasswordBox>("SecretInput").Password=Convert.ToString(Get(saved,"apiSecret")); C<TextBox>("PemInput").Text=Convert.ToString(Get(saved,"privateKeyPath")); loading=false; pendingCredentials=saved; restoreOnly=true; }
            string licensePath=System.IO.Path.Combine(profile,"subscription.dpapi");
            if(File.Exists(licensePath)) { try { var saved=Obj(Shared.LoadCredentials(licensePath)); restoredLicenseKey=Convert.ToString(Get(saved,"licenseKey")); C<PasswordBox>("LicenseKeyInput").Password=restoredLicenseKey; } catch { Note("无法恢复已保存的订阅许可证。请在授权页重新输入；旧文件和交易记录已保留，不会自动开始交易。"); } }
            controller=new Process{StartInfo=Shared.Node(install,profile),EnableRaisingEvents=true};
            controller.OutputDataReceived+=(s,e)=> { if(e.Data!=null && !disposed) Dispatcher.BeginInvoke((Action)(()=>Message(e.Data))); };
            controller.ErrorDataReceived+=(s,e)=> { if(e.Data!=null && !disposed) Dispatcher.BeginInvoke((Action)(()=>Fail("控制器错误；请保留记录并核对安装文件。"))); };
            controller.Exited+=(s,e)=> { if(!disposed) Dispatcher.BeginInvoke((Action)(()=> { ready=connected=licensed=working=licenseWorking=false; pendingLicenseKey=null; connectAfterLicense=false; if(!closing) Fail("控制器已退出。不会自动重启；持仓和在途订单需要核对。"); Buttons(); })); };
            controller.Start(); input=new StreamWriter(controller.StandardInput.BaseStream,new UTF8Encoding(false)){AutoFlush=true}; controller.BeginOutputReadLine(); controller.BeginErrorReadLine(); timer.Start(); await Task.Yield();
        } catch(Exception) { loading=false; if(profileLock!=null) { profileLock.Dispose(); profileLock=null; } Fail("无法打开本机配置或控制器。请检查是否已有窗口/机器人运行、安装文件是否完整；不要删除交易记录强行重开。"); Buttons(); }
    }
    void Message(string line) {
        if(disposed) return;
        try {
            var m=Obj(Shared.Json.DeserializeObject(line)); string type=Str(Get(m,"type"));
            if(type=="ready") { ApplySymbol(Str(Get(m,"symbol"))); ready=true; if(pendingCredentials!=null && restoreOnly) { working=true; if(!Send("configure",new Dictionary<string,object>{{"credentials",pendingCredentials}})) working=false; } else { Send("keyStatus"); RestoreLicense(); } }
            if(type=="markets") {
                working=false;loading=true;var select=C<ComboBox>("SymbolSelect");select.Items.Clear();var items=Get(m,"items") as object[];
                if(items!=null)foreach(var item in items){var entry=Obj(item);string symbol=Str(Get(entry,"symbol"));select.Items.Add(new ComboBoxItem{Tag=symbol,Content=Str(Get(entry,"baseAsset"))+" / USDT"+(Yes(entry,"eligible")?"":" · 仅记录")});}
                ApplySymbol(selectedSymbol);loading=false;Banner("币种列表已更新","仅列出币安测试网实际提供的可交易 USDT 现货对，以及本机已有记录。安全停止并处理持仓后可切换。");
            }
            if(type=="symbolChanged") {
                working=false;connected=false;ApplySymbol(Str(Get(m,"symbol")));ResetAccount();C<CheckBox>("VirtualConsent").IsChecked=false;C<CheckBox>("SingleConsent").IsChecked=false;
                if(Yes(m,"requiresCredentialRebind")) {configured=false;Banner("此交易对旧记录需要核对 API","到密钥配置重新保存，并完成同账户只读核验；原记录保留。");}
                else {Banner("已切换到 "+selectedSymbol,"订单、持仓与风险记录按交易对保存。需要重新只读连接；不会自动启动。");Send("local");}
            }
            if(type=="configured") {
                configured=true; working=false;
                C<TextBox>("PublicKeyOutput").Text=String.IsNullOrWhiteSpace(Str(Get(m,"publicKey")))?"当前使用 HMAC 签名，无需 PEM 公钥。":Str(Get(m,"publicKey"));
                if(!restoreOnly && pendingCredentials!=null) Shared.SaveCredentials(System.IO.Path.Combine(profile,"credentials.dpapi"),pendingCredentials);
                pendingCredentials=null; restoreOnly=false; Txt("ConnectionNote","配置已在本机就绪。连接只读，不会自动开始交易。");
                bool requestedConnect=connectAfterSave; connectAfterSave=false;
                Banner("本机配置已就绪，尚未连接","点击“重新测试连接”，只读检查账户；连接成功仍需有效订阅且不会自动交易。"); Send("local");
                if(RestoreLicense()) connectAfterLicense=requestedConnect;
                else if(requestedConnect) Read("connect");
                if(Yes(m,"accountRebound")) Note("已核对新旧 API 为同一账户，原订单、持仓和风险统计已接续。备份位置："+Str(Get(m,"backupPath")));
            }
            if(type=="connected") {
                working=false; connected=Yes(m,"canTrade"); Balance(Get(m,"balances"));
                Txt("ConnectionNote",connected?"连接正常，账户 canTrade=true。尚未启动交易。":"账户已连通，但 canTrade=false。请在测试网核对权限；不能开始交易。");
                Banner(connected?(licensed?"测试网与订阅已核验，交易尚未启动":"测试网已连接，但订阅未核验，交易锁定"):"账户已连通，但没有交易权限",connected?(licensed?"到总览核对持仓，勾选确认后可手动启动虚拟策略。":"可查看记录和只读快照；先到订阅授权页核验许可证。"):"请核对测试网交易权限，再重新测试连接。");
                C<Button>("ConfigureCta").Content=!licensed?"核验订阅  →":connected?"查看交易总览  →":"核对配置  →";
                if(connected) { ShowPage("Overview"); Read("snapshot",false); }
            }
            if(type=="snapshot") {
                working=false; var snap=Obj(Get(m,"snapshot")); Txt("PriceValue",F(Get(snap,"price"),"N2")); Txt("PriceDetail","测试网价格快照 · 非实盘报价"); Balance(Get(snap,"balances"));
                var values=Get(snap,"candles") as object[]; prices.Clear();
                if(values!=null) foreach(var item in values) { var close=Num(Get(Obj(item),"close")); if(close.HasValue && close>0) prices.Add(close.Value); }
                if(prices.Count>60) prices=prices.GetRange(prices.Count-60,60);
                Txt("ChartSource",prices.Count>1?"●  TESTNET API":"●  NO CHART DATA"); Txt("UpdatedText","快照 "+Time(Get(snap,"updatedAt"))); DrawChart();
            }
            if(type=="keyStatus" && Yes(m,"exists") && String.IsNullOrWhiteSpace(C<TextBox>("PemInput").Text) && String.IsNullOrWhiteSpace(C<PasswordBox>("SecretInput").Password)) { loading=true; C<TextBox>("PublicKeyOutput").Text=Str(Get(m,"publicKey")); C<TextBox>("PemInput").Text=Str(Get(m,"privateKeyPath")); loading=false; Txt("ConnectionNote","已自动找回本机 PEM。公钥需注册到币安测试网；上方填写测试网返回的 API Key。"); }
            if(type=="publicKey") { working=false; loading=true; C<TextBox>("PublicKeyOutput").Text=Str(Get(m,"publicKey")); C<TextBox>("PemInput").Text=Str(Get(m,"privateKeyPath")); C<PasswordBox>("SecretInput").Clear(); loading=false; configured=connected=false; Banner(Yes(m,"reused")?"已找回并复用原密钥，未覆盖文件":"本机密钥已生成","只复制公钥到币安测试网注册，再填测试网返回的 API Key。私钥路径已填好，私钥留本机。"); }
            if(type=="started") { working=false; running=true; Txt("StrategyState","运行中"); C<System.Windows.Shapes.Ellipse>("StateDot").Fill=Ui.Brush("#34D399"); Banner("虚拟策略已启动","每约 5 秒判断一次；只有符合信号时才下单，不保证盈利或成交频率。"); Note(Str(Get(m,"text"))); }
            if(type=="stopping") { Txt("StrategyState","正在停止"); }
            if(type=="workerExit") { running=working=connected=false; Txt("StrategyState","已停止"); C<System.Windows.Shapes.Ellipse>("StateDot").Fill=Ui.Brush("#FBBF24"); Banner("交易进程已退出","不会自动重启。先核对在途订单和持仓，重新测试连接后再决定是否开始。"); Note(Str(Get(m,"text"))); }
            if(type=="local") Local(m);
            if(type=="license") LicenseMessage(m);
            if(type=="error" && Str(Get(m,"code"))=="ACCOUNT_KEY_CHANGED" && pendingCredentials!=null && !restoreOnly) {
                working=false; connected=configured=false;
                bool accept=MessageBox.Show(this,"检测到你更换了 API Key。是否核对它与旧记录属于同一个币安测试网账户？\n\n只读核对账户身份，相同才接续全部订单、持仓与风险统计，并保存旧配置备份。不会清空记录或自动交易。\n\n账户不同、旧身份无法核实、签名错误或存在待核对委托时，保留原记录并停止更换。","更换同账户 API",MessageBoxButton.YesNo,MessageBoxImage.Question)==MessageBoxResult.Yes;
                if(accept) { working=true; if(!Send("rotateCredentials",new Dictionary<string,object>{{"credentials",pendingCredentials},{"confirmSameTestnetAccount",true}})) working=false; }
                else { pendingCredentials=null; connectAfterSave=false; Txt("ConnectionNote","已取消更换 API，原配置与交易记录保留。"); }
                Buttons(); return;
            }
            if(type=="error") { bool restoring=restoreOnly; working=false; connected=false;ApplySymbol(selectedSymbol); pendingCredentials=null; connectAfterSave=restoreOnly=false; Txt("ChartSource",prices.Count>1?"●  STALE / 旧快照":"●  NO DATA"); Fail(Str(Get(m,"text"))); if(restoring) RestoreLicense(); }
            if(type=="notice" || type=="log") Note(Str(Get(m,"text")));
            Buttons();
        } catch { working=false; Fail("无法解析本机控制器响应；请保留本机记录并核对。"); Buttons(); }
    }
    bool RestoreLicense() {
        if(String.IsNullOrWhiteSpace(restoredLicenseKey)) return false;
        string key=restoredLicenseKey; restoredLicenseKey=null; ActivateLicense(key,true); return licenseWorking;
    }
    void ActivateLicense(string key,bool restore) {
        if(preview || !ready || running || closing || working || licenseWorking) return;
        if(String.IsNullOrWhiteSpace(key)) { ShowPage("License"); Txt("LicenseState","请输入 Whop 软件许可证；不是交易所 API Key"); return; }
        licensed=false; licenseWorking=true; pendingLicenseKey=restore?null:key;
        if(!Send("activateLicense",new Dictionary<string,object>{{"licenseKey",key}})) { licenseWorking=false; pendingLicenseKey=null; }
        Buttons();
    }
    void LicenseMessage(Dictionary<string,object> m) {
        bool wasLicensed=licensed; licensed=Yes(m,"active"); string state=Str(Get(m,"status")); licenseWorking=state=="checking";
        bool serviceConfigured=Yes(m,"configured");
        Txt("LicenseState",licensed?"订阅有效 · 可在连接后手动开始":licenseWorking?"正在联网核验订阅…":!serviceConfigured?"授权服务未配置 · 交易已锁定":"授权无效或待核验 · 禁止启动交易");
        var expiry=Num(Get(m,"paidUntil"));
        Txt("LicenseUntil",expiry.HasValue && expiry.Value>=0 && expiry.Value<=253402300799999d?"本期有效至 "+new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddMilliseconds(expiry.Value).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss zzz")+(Yes(m,"cancelAtPeriodEnd")?" · 已取消自动续费":""):!serviceConfigured?"此安装包不能交易或作为已开通订阅销售；需要卖家完成正式服务配置与验收。":"有效期以联网核验为准。每 30 秒复查，签名租约最多 120 秒，无长期离线授权。");
        if(licensed && pendingLicenseKey!=null) { Shared.SaveCredentials(System.IO.Path.Combine(profile,"subscription.dpapi"),new Dictionary<string,object>{{"licenseKey",pendingLicenseKey}}); pendingLicenseKey=null; }
        if(!licensed && !licenseWorking) pendingLicenseKey=null;
        if(!licensed && running) Banner("授权到期或核验失败，正在安全停止","不平仓、不撤单；本机保护也会停止。请在测试网自行核对持仓和订单。记录保留可查看。");
        if(licensed && !wasLicensed && !running) { Banner("订阅已核验，不会自动开始交易","只读连接测试网并核对持仓后，由你明确确认启动。取消续费可用至本期结束；到期或核验失败会停止。"); C<Button>("ConfigureCta").Content=connected?"查看交易总览  →":"配置测试网  →"; }
        if(!licensed && !licenseWorking && !running && !working) { Banner(!serviceConfigured?"授权服务未配置，交易已锁定":"订阅尚未核验或已失效，交易锁定","记录与只读连接仍可使用。重新核验成功也不会自动恢复交易；到期停用不平仓或撤单。"); C<Button>("ConfigureCta").Content="核验订阅  →"; }
        if(!licenseWorking && connectAfterLicense) { connectAfterLicense=false; Read("connect"); }
    }
    void Balance(object rows) {
        var array=rows as object[]; if(array==null) return;
        foreach(var r in array) { var d=Obj(r); if(Str(Get(d,"asset"))=="USDT") { Txt("BalanceValue",F(Get(d,"free"),"N2")); Txt("BalanceDetail","锁定 "+F(Get(d,"locked"))+" USDT · 测试网"); } }
    }
    void Local(Dictionary<string,object> m) {
        var settings=Obj(Get(m,"config"));if(Get(settings,"symbol")!=null)ApplySymbol(Str(Get(settings,"symbol")));
        running=Yes(m,"running"); var activity=Obj(Get(m,"activity")); string state=Str(Get(activity,"status"));
        string label=running?(Yes(m,"stopping")?"正在停止":state=="reconnecting"?"行情重连中":state=="stale"?"进程存在 · 心跳陈旧":"运行中"):Yes(m,"locked")?"安全锁待核对":connected?"已连接 · 未启动":"未启动";
        Txt("StrategyState",label); C<System.Windows.Shapes.Ellipse>("StateDot").Fill=Ui.Brush(running && state=="running"?"#34D399":Yes(m,"locked")||state=="reconnecting"?"#FBBF24":"#64748B");
        Txt("SignalText",Get(activity,"action")!=null?Str(Get(activity,"action")):"等待你完成连接并手动开始；尚未执行信号交易。");
        var pos=Obj(Get(m,"position")); Txt("PositionValue",pos.Count==0?"0":F(Get(pos,"quantity"))); Txt("PositionDetail",pos.Count==0?"本机记录无程序持仓":"入场均价 "+F(Get(pos,"entryPrice"),"N2"));
        if(Get(m,"pending")!=null) Txt("PositionDetail","存在待核对委托；不要删记录重启");
        var array=Get(m,"orders") as object[]; var rows=new List<TradeRow>();
        if(array!=null) for(int i=array.Length-1;i>=0;i--) { var o=Obj(array[i]); rows.Add(new TradeRow{Time=Time(Get(o,"time")),Side=Str(Get(o,"side")),Quantity=F(Get(o,"executedQty")),Quote=F(Get(o,"quoteQty"),"0.####"),Status=Str(Get(o,"status")),Pnl=Yes(o,"realizedPnlComplete")?F(Get(o,"realizedUsdt"),"0.####"):"未核实",Reason=Str(Get(o,"reason"))}); }
        C<DataGrid>("TradeGrid").ItemsSource=rows; Txt("OrderValue",rows.Count.ToString()); C<TextBlock>("OrdersEmpty").Visibility=rows.Count==0?Visibility.Visible:Visibility.Collapsed;
        Txt("FooterState","●  本机进程: "+(running?"存在":"未运行")+"  ·  账户监控: "+(connected?"已连接":"未连接/需重试")+"  ·  仅虚拟资金");
    }
    void DrawChart() {
        var canvas=C<Canvas>("PriceCanvas"); canvas.Children.Clear(); double width=canvas.ActualWidth,height=canvas.ActualHeight;
        if(width<20 || height<20) return;
        for(int i=0;i<5;i++) { double y=14+i*(height-28)/4; canvas.Children.Add(new Line{X1=0,X2=width,Y1=y,Y2=y,Stroke=Ui.Brush("#24314A"),StrokeThickness=0.7,StrokeDashArray=new DoubleCollection{3,5}}); }
        C<StackPanel>("ChartEmpty").Visibility=prices.Count<2?Visibility.Visible:Visibility.Collapsed;
        if(prices.Count<2) return;
        double lo=Double.MaxValue,hi=Double.MinValue; foreach(double p in prices) { lo=Math.Min(lo,p); hi=Math.Max(hi,p); } double span=Math.Max(hi-lo,Math.Max(hi*0.0001,0.01));
        var line=new Polyline { Stroke=Ui.Brush("#37DEC3"),StrokeThickness=2.4,StrokeLineJoin=PenLineJoin.Round }; var fill=new Polygon { Fill=new LinearGradientBrush(Color.FromArgb(65,34,211,238),Color.FromArgb(0,34,211,238),90) };
        fill.Points.Add(new Point(0,height));
        for(int i=0;i<prices.Count;i++) { var point=new Point(i*(width-3)/(prices.Count-1),18+(hi-prices[i])*(height-36)/span); line.Points.Add(point); fill.Points.Add(point); }
        fill.Points.Add(new Point(width-3,height)); canvas.Children.Add(fill); canvas.Children.Add(line);
        Txt("ChartRange","已收盘 1m · "+lo.ToString("N2",CultureInfo.InvariantCulture)+" — "+hi.ToString("N2",CultureInfo.InvariantCulture));
    }
    async void CloseSafely(object sender,CancelEventArgs e) {
        if(preview || controller==null) { disposed=true; if(profileLock!=null) profileLock.Dispose(); return; }
        if(closing) { e.Cancel=true; return; }
        if(running && MessageBox.Show(this,"关闭会请求安全停止，但不会平仓或撤单。停止后本机止盈止损规则不再运行。\n\n是否停止并关闭？","停止并关闭",MessageBoxButton.YesNo,MessageBoxImage.Warning)!=MessageBoxResult.Yes) { e.Cancel=true; return; }
        e.Cancel=true; closing=true; timer.Stop(); Buttons(); Banner("正在安全停止，请稍等","等待在途请求与本机记录保存，不强制终止或重发订单。"); Send("close");
        try { if(input!=null) input.Close(); await Task.Run(()=>controller.WaitForExit()); } catch { closing=false; Fail("停止结果尚未确认，请保留记录并人工核对。"); Buttons(); return; }
        controller.Dispose(); controller=null; if(profileLock!=null) { profileLock.Dispose(); profileLock=null; } disposed=true; closing=false; Close();
    }
    const string HelpText="01  只使用 Binance Spot Testnet 虚拟资金。没有实盘开关、合约、杠杆、充值、提现或资金代管。\n\n02  本程序按确定的策略规则运行，不是 AI 每笔预测。每约 5 秒判断一次，不等于每 5 秒成交。更快、更复杂都不保证盈利。\n\n03  首次使用请用无旧程序持仓的新测试账户，或先完成经核对的人工迁移。旧源码版记录不会自动迁入；不要与同账户其他副本并行交易。升级保留原桌面数据。\n\n04  停止、关闭、卸载或授权停用不会平仓或撤单。本机止盈止损也会停止；断网、休眠、断电时保护无法持续执行。未知订单必须先核对，不要删除锁或记录强行重启。\n\n05  API Key、HMAC 配置和订阅许可证由当前 Windows 用户 DPAPI 加密；生成的 PEM 私钥是本机未额外加密文件。不要把交易所密钥发给卖家，不要把私有记录上传到 GitHub。\n\n06  地区拒绝、权限不足和网络错误不会被绕过。账户连接错误与交易进程状态分别显示；错误时仍可请求安全停止。\n\n07  0.3.0 启动前必须联网核验订阅，运行时每 30 秒复查；签名租约最多 120 秒，不是保证继续交易 120 秒的离线宽限。断网核验失败、到期或撤权会停止交易并停止本机保护，不自动恢复。记录与只读连接保留。取消续费可用到已付费期限结束，之后停用。\n\n08  授权服务配置不完整时，交易保持锁定。此版仍未签名；上线还需真实订阅/到期验收、平台与收款资格审核。新版不会远程停止已发出的 0.2.0 或旧源码，且本地软件不能保证绝对防篡改。不含云端托管、自动更新或盈利保证。";
    [STAThread] static int Main(string[] args) {
        try {
            var app=new Application { ShutdownMode=ShutdownMode.OnMainWindowClose };
            if(args.Length==2 && args[0]=="--self-test") return SelfTest(args[1]);
            if(args.Length>1 || args.Length==1 && args[0]!="--preview-ui") return 2;
            app.Run(new Desktop(args.Length==1)); return 0;
        } catch(Exception e) { MessageBox.Show("无法打开交易工作台，请运行新版安装器修复。\n\n"+e.Message,"Adaptive Spot Bot",MessageBoxButton.OK,MessageBoxImage.Error); return 1; }
    }
    static int SelfTest(string directory) {
        try {
            directory=System.IO.Path.GetFullPath(directory); if(Directory.Exists(directory)) throw new IOException("Fresh test directory required."); Shared.PrivateDirectory(directory);
            var ui=new Desktop(true); if(ui.C<StackPanel>("OverviewView").Visibility!=Visibility.Visible || ui.C<Button>("StartButton").IsEnabled || ui.C<Button>("ActivateLicenseButton").IsEnabled || ui.Icon==null) throw new Exception("Dashboard-first safety, license lock or icon failed");
            ui.ShowInTaskbar=false;ui.WindowStartupLocation=WindowStartupLocation.Manual;ui.Left=-32000;ui.Top=-32000;ui.Show();
            ui.Measure(new Size(1200,800)); ui.Arrange(new Rect(0,0,1200,800)); ui.UpdateLayout();
            foreach(string symbol in new[]{"ETHUSDT","DOGEUSDT","BTCUSDT"}) {
                ui.ApplySymbol(symbol);string asset=symbol.Substring(0,symbol.Length-4);
                if(!ui.C<TextBlock>("PriceLabel").Text.StartsWith(asset)||!ui.C<TextBlock>("PositionLabel").Text.EndsWith(asset)||!ui.C<DataGrid>("TradeGrid").Columns[2].Header.ToString().StartsWith(asset)||ui.C<ComboBox>("SymbolSelect").IsEnabled)throw new Exception("Multi-symbol labels or preview lock failed");
            }
            ui.UpdateLayout();ui.Dispatcher.Invoke(new Action(delegate{}),DispatcherPriority.Render);var picture=new System.Windows.Media.Imaging.RenderTargetBitmap(1200,800,96,96,PixelFormats.Pbgra32);picture.Render(ui.view);
            var pixels=new byte[1200*800*4];picture.CopyPixels(pixels,1200*4,0);bool visible=false;for(int index=3;index<pixels.Length;index+=4)if(pixels[index]>0){visible=true;break;}if(!visible)throw new Exception("Preview render is empty");
            var encoder=new System.Windows.Media.Imaging.PngBitmapEncoder();encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(picture));using(var screenshot=File.Create(System.IO.Path.Combine(directory,"DESKTOP-PREVIEW.png")))encoder.Save(screenshot);
            ui.LicenseMessage(new Dictionary<string,object>{{"type","license"},{"active",false},{"configured",false},{"status","not_activated"}});
            if(ui.C<Button>("StartButton").IsEnabled || !ui.C<TextBlock>("LicenseState").Text.Contains("锁定")) throw new Exception("Missing service must stay explicitly locked");
            string file=System.IO.Path.Combine(directory,"credentials.dpapi"); var sample=new Dictionary<string,object>{{"apiKey","offline-test-key-DO-NOT-USE"},{"apiSecret","offline-test-secret-DO-NOT-USE"},{"privateKeyPath",""}};
            Shared.SaveCredentials(file,sample); Shared.SaveCredentials(file,sample);
            if(Str(Get(Obj(Shared.LoadCredentials(file)),"apiKey"))!="offline-test-key-DO-NOT-USE" || Encoding.UTF8.GetString(File.ReadAllBytes(file)).Contains("DO-NOT-USE")) throw new Exception("DPAPI roundtrip failed");
            string subscription=System.IO.Path.Combine(directory,"subscription.dpapi"); Shared.SaveCredentials(subscription,new Dictionary<string,object>{{"licenseKey","offline-subscription-DO-NOT-USE"}});
            if(Str(Get(Obj(Shared.LoadCredentials(subscription)),"licenseKey"))!="offline-subscription-DO-NOT-USE" || Encoding.UTF8.GetString(File.ReadAllBytes(subscription)).Contains("DO-NOT-USE")) throw new Exception("Subscription DPAPI roundtrip failed");
            using(var p=Process.Start(Shared.Node(AppDomain.CurrentDomain.BaseDirectory,directory))) {
                if(p.StandardOutput.ReadLine().IndexOf("\"ready\"")<0) throw new Exception("No controller ready"); p.StandardInput.WriteLine("{\"command\":\"local\"}"); p.StandardInput.Flush();
                if(p.StandardOutput.ReadLine().IndexOf("\"running\":false")<0) throw new Exception("Unexpected trading state"); p.StandardInput.Close(); if(!p.WaitForExit(10000)||p.ExitCode!=0) throw new Exception("Controller shutdown failed");
            }
            File.WriteAllText(System.IO.Path.Combine(directory,"RESULT.txt"),"PASS: WPF dashboard first, multi-symbol labels, nonempty preview render and icon/theme/layout; trading and activation disabled in offline preview; missing service explicitly locked; CurrentUser DPAPI credential/subscription roundtrip and replacement; bundled controller empty local-state and EOF shutdown. No account reads, network or orders.\r\n",Encoding.UTF8);ui.Close(); return 0;
        } catch(Exception e) { Directory.CreateDirectory(directory); File.WriteAllText(System.IO.Path.Combine(directory,"FAILED.txt"),e.ToString()); return 1; }
    }
}
