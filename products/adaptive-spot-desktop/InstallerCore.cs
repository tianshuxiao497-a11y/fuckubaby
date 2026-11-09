using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

// Every repair stages and verifies first. The whole previous application tree
// is retained as a named backup; the separate account profile is never reset.
internal static class InstallerCore {
    internal const string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AdaptiveSpotBotTestnet";
    internal sealed class Result {
        internal string Backup = "";
        internal readonly List<string> Notices = new List<string>();
    }
    internal sealed class Options {
        internal string Install, Profile, Setup;
        internal Action<string> Extract;
        internal Action<string, Result> Integrate;
        internal Action RollbackIntegration;
        internal Action<string> AfterStage;
    }
    internal static string Menu { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Adaptive Spot Bot Testnet.lnk"); } }
    internal static string DesktopLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Adaptive Spot Bot Testnet.lnk"); } }
    internal static string EntryName(string path) {
        if (String.IsNullOrWhiteSpace(path) || path.Contains("\\") || path.Contains(":") || path.StartsWith("/") || path.Contains("..") || path.Split('/').Length > 12) throw new IOException("Invalid payload path.");
        foreach (string part in path.Split('/')) if (part.Length == 0 || part.EndsWith(".") || part.EndsWith(" ")) throw new IOException("Invalid payload component.");
        return path;
    }
    internal static string SafePath(string root, string entry) {
        string full = Path.GetFullPath(Path.Combine(root, EntryName(entry).Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(Path.GetFullPath(root).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) throw new IOException("Payload escaped the application folder.");
        return full;
    }
    internal static void NoLinkedAncestors(string path) {
        string current = Path.GetFullPath(path);
        while (!String.IsNullOrEmpty(current)) {
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked folders/files are not supported. Nothing was removed: " + current);
            current = Path.GetDirectoryName(current);
        }
    }
    internal static void NoLinkedTree(string path) {
        NoLinkedAncestors(path); if (!Directory.Exists(path)) return;
        var dirs = new Stack<string>(); dirs.Push(path); int count = 0;
        while (dirs.Count > 0) foreach (string entry in Directory.GetFileSystemEntries(dirs.Pop())) {
            if (++count > 10000) throw new IOException("Too many files for a safe automatic repair. Review the folder manually.");
            var attr = File.GetAttributes(entry);
            if ((attr & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked files/folders found. Review them before repairing; no files were removed.");
            if ((attr & FileAttributes.Directory) != 0) dirs.Push(entry);
        }
    }
    internal static Dictionary<string, object> Manifest(ZipArchive zip) {
        var item = zip.GetEntry("INSTALL-MANIFEST.json"); if (item == null || item.Length > 1000000) throw new IOException("Installer manifest is missing.");
        using (var r = new StreamReader(item.Open(), Encoding.UTF8)) return ParseManifest(r.ReadToEnd());
    }
    static Dictionary<string, object> ParseManifest(string text) {
        var files = Shared.Json.DeserializeObject(text) as Dictionary<string, object>;
        if (files == null || files.Count < 10 || files.Count > 200) throw new IOException("Invalid application manifest.");
        foreach (var pair in files) {
            EntryName(pair.Key); string hash = Convert.ToString(pair.Value);
            if (hash.Length != 64) throw new IOException("Invalid manifest checksum.");
            foreach (char c in hash) if (!(c >= '0' && c <= '9' || c >= 'a' && c <= 'f')) throw new IOException("Invalid manifest checksum.");
        }
        return files;
    }
    internal static void VerifyAndExtract(string target) {
        target = Path.GetFullPath(target); NoLinkedAncestors(target);
        if (Directory.Exists(target) || File.Exists(target)) throw new IOException("Extraction requires a fresh directory; no files were overwritten.");
        Directory.CreateDirectory(target);
        using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
            if (resource == null) throw new IOException("Installer payload unavailable.");
            using (var zip = new ZipArchive(resource, ZipArchiveMode.Read)) {
                var files = Manifest(zip); var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (zip.Entries.Count != files.Count + 1) throw new IOException("Payload file count mismatch.");
                long total = 0;
                foreach (var entry in zip.Entries) {
                    string name = EntryName(entry.FullName); if (!seen.Add(name)) throw new IOException("Duplicate payload entry.");
                    if (name == "INSTALL-MANIFEST.json") continue;
                    if (!files.ContainsKey(name) || entry.Length > 150000000 || (total += entry.Length) > 250000000) throw new IOException("Unexpected payload file.");
                    string path = SafePath(target, name); Directory.CreateDirectory(Path.GetDirectoryName(path));
                    using (var src = entry.Open()) using (var dst = new FileStream(path, FileMode.CreateNew)) src.CopyTo(dst);
                    if (Shared.Hash(path) != Convert.ToString(files[name])) throw new IOException("Payload checksum mismatch: " + name);
                }
                using (var r = zip.GetEntry("INSTALL-MANIFEST.json").Open()) using (var w = new FileStream(Path.Combine(target, "INSTALL-MANIFEST.json"), FileMode.CreateNew)) r.CopyTo(w);
            }
        }
    }
    internal static bool ValidApplication(string path) {
        try {
            NoLinkedTree(path); string manifest = Path.Combine(path, "INSTALL-MANIFEST.json");
            if (!File.Exists(manifest) || new FileInfo(manifest).Length > 1000000) return false;
            var files = ParseManifest(File.ReadAllText(manifest, Encoding.UTF8));
            foreach (string required in new[] { "AdaptiveSpotBot.exe", "node.exe", "engine/products/adaptive-spot-desktop/controller.mjs" }) if (!files.ContainsKey(required)) return false;
            foreach (var pair in files) { string file = SafePath(path, pair.Key); if (!File.Exists(file) || Shared.Hash(file) != Convert.ToString(pair.Value)) return false; }
            return true;
        } catch { return false; }
    }
    internal static bool CurrentApplication(string path) {
        if (!ValidApplication(path)) return false;
        try {
            using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) using (var zip = new ZipArchive(resource, ZipArchiveMode.Read)) {
                var files = Manifest(zip);
                foreach (var pair in files) if (Shared.Hash(SafePath(path, pair.Key)) != Convert.ToString(pair.Value)) return false;
            }
            return true;
        } catch { return false; }
    }
    static void ReviewExisting(string path) {
        if (!Directory.Exists(path)) return; NoLinkedTree(path);
        if (Directory.GetFileSystemEntries(path).Length == 0) return;
        bool recognized = File.Exists(Path.Combine(path, "INSTALL-MANIFEST.json")) || File.Exists(Path.Combine(path, "AdaptiveSpotBot.exe")) || File.Exists(Path.Combine(path, "node.exe")) && Directory.Exists(Path.Combine(path, "engine"));
        if (!recognized) throw new IOException("The target contains unrelated files and is not a recognized bot installation. Nothing was overwritten.");
    }
    static FileStream IdleLock(string profile) {
        NoLinkedTree(profile); Directory.CreateDirectory(profile);
        var stream = new FileStream(Path.Combine(profile, "desktop.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        try {
            if (File.Exists(Path.Combine(profile, ".paper-data", "testnet-bot.lock")) || Directory.Exists(Path.Combine(profile, ".paper-data", "testnet-bot.lock"))) throw new IOException("A bot safety lock is retained. Stop and reconcile first. This installer will not delete locks, positions or pending orders.");
            string markets=Path.Combine(profile,"markets");
            if(Directory.Exists(markets))foreach(string market in Directory.GetDirectories(markets)) {
                string marketLock=Path.Combine(market,".paper-data","testnet-bot.lock");
                if(File.Exists(marketLock)||Directory.Exists(marketLock))throw new IOException("A market bot safety lock is retained. Stop and reconcile first; no records were changed.");
            }
            return stream;
        } catch { stream.Dispose(); throw; }
    }
    internal static Result Install(Options o) {
        string target = Path.GetFullPath(o.Install), parent = Path.GetDirectoryName(target), profile = Path.GetFullPath(o.Profile);
        if (target.Equals(profile, StringComparison.OrdinalIgnoreCase) || profile.StartsWith(target.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) || target.StartsWith(profile.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) throw new IOException("Application and account folders must be separate.");
        NoLinkedAncestors(parent); NoLinkedAncestors(o.Setup); ReviewExisting(target);
        var result = new Result(); string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        string stage = target + ".stage-" + stamp, backup = target + ".backup-" + stamp;
        bool movedOld = false, activated = false, integrated = false;
        using (IdleLock(profile)) {
            Directory.CreateDirectory(parent);
            try {
                o.Extract(stage);
                if (!ValidApplication(stage)) throw new IOException("Staged application did not pass its checksums. Existing installation was not changed.");
                File.Copy(o.Setup, Path.Combine(stage, "Uninstall.exe"), false);
                if (o.AfterStage != null) o.AfterStage(stage);
                ReviewExisting(target); NoLinkedTree(stage);
                if (Directory.Exists(target)) { Directory.Move(target, backup); movedOld = true; result.Backup = backup; }
                Directory.Move(stage, target); activated = true;
                if (o.Integrate != null) { integrated = true; o.Integrate(target, result); }
                if (movedOld) result.Notices.Add("Previous application files, including unknown additions, remain in: " + backup);
                return result;
            } catch (Exception e) {
                var failures = new List<string>();
                if (integrated && o.RollbackIntegration != null) try { o.RollbackIntegration(); } catch (Exception r) { failures.Add("Shortcut/registration rollback requires review: " + r.Message); }
                try {
                    if (activated && Directory.Exists(target)) Directory.Move(target, target + ".failed-" + stamp);
                    if (movedOld && Directory.Exists(backup) && !Directory.Exists(target)) Directory.Move(backup, target);
                } catch (Exception r) { failures.Add("Directory rollback requires manual review: " + r.Message); }
                string retained = Directory.Exists(stage) ? " Staged files were retained for review in: " + stage : "";
                throw new IOException(e.Message + retained + (failures.Count == 0 ? " Existing files and account records were preserved." : " " + String.Join(" ", failures)), e);
            }
        }
    }
    internal static bool OwnShortcut(string path, string target) {
        if (!File.Exists(path)) return false; NoLinkedAncestors(path); object shell = null, link = null;
        try {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")); dynamic s = shell; link = s.CreateShortcut(path); dynamic l = link;
            return String.Equals(Path.GetFullPath(Convert.ToString(l.TargetPath)), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase) && String.IsNullOrEmpty(Convert.ToString(l.Arguments));
        } catch { return false; }
        finally { if (link != null) Marshal.FinalReleaseComObject(link); if (shell != null) Marshal.FinalReleaseComObject(shell); }
    }
    internal static bool Link(string path, string target, Result result) {
        NoLinkedAncestors(path);
        if (File.Exists(path) && !OwnShortcut(path, target)) { result.Notices.Add("An unrelated shortcut was left unchanged: " + path); return false; }
        object shell = null, link = null;
        try {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")); dynamic s = shell; link = s.CreateShortcut(path); dynamic l = link;
            l.TargetPath = target; l.WorkingDirectory = Path.GetDirectoryName(target); l.Arguments = ""; l.IconLocation = target + ",0"; l.Description = "Adaptive Spot Bot - Testnet virtual funds only"; l.Save(); return true;
        } finally { if (link != null) Marshal.FinalReleaseComObject(link); if (shell != null) Marshal.FinalReleaseComObject(shell); }
    }
    internal sealed class Integration {
        readonly bool desktop;
        readonly Dictionary<string, byte[]> links = new Dictionary<string, byte[]>();
        readonly Dictionary<string, object> values = new Dictionary<string, object>();
        readonly Dictionary<string, RegistryValueKind> kinds = new Dictionary<string, RegistryValueKind>();
        bool registered, existed;
        internal Integration(bool createDesktop) { desktop = createDesktop; }
        internal void Apply(string target, Result result) {
            using (var k = Registry.CurrentUser.OpenSubKey(RegistryPath)) {
                existed = k != null;
                if (k != null) {
                    string oldLocation = Convert.ToString(k.GetValue("InstallLocation"));
                    if (!String.IsNullOrEmpty(oldLocation) && !String.Equals(Path.GetFullPath(oldLocation), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) throw new IOException("An unrelated registration occupies this application name. No registration was overwritten.");
                    foreach (string name in k.GetValueNames()) { values[name] = k.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames); kinds[name] = k.GetValueKind(name); }
                }
            }
            foreach (string path in desktop ? new[] { Menu, DesktopLink } : new[] { Menu }) {
                NoLinkedAncestors(path); bool exists = File.Exists(path);
                if (exists && !OwnShortcut(path, Path.Combine(target, "AdaptiveSpotBot.exe"))) { result.Notices.Add("Unrelated shortcut preserved: " + path); continue; }
                links[path] = exists ? File.ReadAllBytes(path) : null; Link(path, Path.Combine(target, "AdaptiveSpotBot.exe"), result);
            }
            registered = true;
            using (var k = Registry.CurrentUser.CreateSubKey(RegistryPath)) {
                k.SetValue("DisplayName", "Adaptive Spot Bot - Testnet Edition"); k.SetValue("DisplayVersion", Shared.Version); k.SetValue("Publisher", "Adaptive Spot Bot"); k.SetValue("InstallLocation", target); k.SetValue("DisplayIcon", Path.Combine(target, "AdaptiveSpotBot.exe") + ",0");
                k.SetValue("UninstallString", "\"" + Path.Combine(target, "Uninstall.exe") + "\" --uninstall"); k.SetValue("NoModify", 1); k.SetValue("NoRepair", 0);
            }
        }
        internal void Rollback() {
            foreach (var pair in links) { if (pair.Value == null) { if (File.Exists(pair.Key)) File.Delete(pair.Key); } else File.WriteAllBytes(pair.Key, pair.Value); }
            if (!registered) return;
            if (!existed) Registry.CurrentUser.DeleteSubKeyTree(RegistryPath, false);
            else using (var k = Registry.CurrentUser.CreateSubKey(RegistryPath)) { foreach (string name in k.GetValueNames()) k.DeleteValue(name, false); foreach (var pair in values) k.SetValue(pair.Key, pair.Value, kinds[pair.Key]); }
        }
    }
    internal static Result InstallDefault(bool desktop) {
        var integration = new Integration(desktop);
        return Install(new Options { Install = Shared.Install, Profile = Shared.Profile, Setup = Assembly.GetExecutingAssembly().Location, Extract = VerifyAndExtract, Integrate = integration.Apply, RollbackIntegration = integration.Rollback });
    }
    internal static void UninstallDefault() {
        string root = Path.GetFullPath(Shared.Install); NoLinkedTree(root);
        using (IdleLock(Shared.Profile)) {
            if (!Directory.Exists(root)) throw new IOException("Application folder is already absent. Account records remain untouched.");
            using (var k = Registry.CurrentUser.OpenSubKey(RegistryPath)) if (k != null && !String.Equals(Convert.ToString(k.GetValue("InstallLocation")), root, StringComparison.OrdinalIgnoreCase)) throw new IOException("Unrelated registration retained; no application files removed.");
            using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) using (var zip = new ZipArchive(resource, ZipArchiveMode.Read)) {
                var files = Manifest(zip);
                foreach (var pair in files) { string path = SafePath(root, pair.Key); if (File.Exists(path) && Shared.Hash(path) != Convert.ToString(pair.Value)) throw new IOException("Modified or newer application file was preserved: " + pair.Key); }
                string installedManifest = Path.Combine(root, "INSTALL-MANIFEST.json");
                bool same = false;
                if (File.Exists(installedManifest)) {
                    var existing = ParseManifest(File.ReadAllText(installedManifest, Encoding.UTF8)); same = existing.Count == files.Count;
                    foreach (var pair in files) same &= existing.ContainsKey(pair.Key) && Convert.ToString(existing[pair.Key]) == Convert.ToString(pair.Value);
                    if (!same) throw new IOException("Installed manifest differs; no application files removed.");
                }
                foreach (var pair in files) { string path = SafePath(root, pair.Key); if (File.Exists(path)) File.Delete(path); }
                if (same) File.Delete(installedManifest);
            }
            foreach (string path in new[] { Menu, DesktopLink }) if (OwnShortcut(path, Path.Combine(root, "AdaptiveSpotBot.exe"))) File.Delete(path);
            string original = Path.Combine(root, "Uninstall.exe"); if (File.Exists(original) && Shared.Hash(original) == Shared.Hash(Assembly.GetExecutingAssembly().Location)) File.Delete(original);
            Registry.CurrentUser.DeleteSubKeyTree(RegistryPath, false);
        }
    }
    internal static int SelfTest(string directory) {
        bool created = false;
        try {
            directory = Path.GetFullPath(directory); NoLinkedAncestors(directory); if (Directory.Exists(directory) || File.Exists(directory)) return 2;
            Directory.CreateDirectory(directory); created = true;
            string install = Path.Combine(directory, "Programs", "Bot"), profile = Path.Combine(directory, "LocalProfile");
            Directory.CreateDirectory(profile); string privateRecord = Path.Combine(profile, "fake-private-record.txt"); File.WriteAllText(privateRecord, "OFFLINE-TEST-DATA-NOT-A-KEY");
            var options = new Options { Install = install, Profile = profile, Setup = Assembly.GetExecutingAssembly().Location, Extract = VerifyAndExtract };
            Install(options); if (!ValidApplication(install) || !CurrentApplication(install)) throw new Exception("Fresh install checksum failure.");
            string unknown = Path.Combine(install, "user-notes.txt"); File.WriteAllText(unknown, "DO-NOT-DELETE"); var repair = Install(options);
            if (!ValidApplication(install) || File.ReadAllText(Path.Combine(repair.Backup, "user-notes.txt")) != "DO-NOT-DELETE") throw new Exception("Repair did not retain unknown files.");
            string hash = Shared.Hash(Path.Combine(install, "AdaptiveSpotBot.exe")); options.AfterStage = p => { throw new IOException("injected staging failure"); };
            bool refused = false; try { Install(options); } catch (IOException) { refused = true; }
            if (!refused || hash != Shared.Hash(Path.Combine(install, "AdaptiveSpotBot.exe"))) throw new Exception("Staging failure changed existing install.");
            options.AfterStage = null; options.Integrate = (p,r) => { throw new IOException("injected post-activation failure"); };
            refused = false; try { Install(options); } catch (IOException) { refused = true; } if (!refused || !ValidApplication(install)) throw new Exception("Activated-stage rollback failed."); options.Integrate = null;
            using (var held = new FileStream(Path.Combine(profile, "desktop.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { refused = false; try { Install(options); } catch (IOException) { refused = true; } if (!refused) throw new Exception("Active GUI lock ignored."); }
            string data = Path.Combine(profile, ".paper-data"); Directory.CreateDirectory(data); string botLock = Path.Combine(data, "testnet-bot.lock"); File.WriteAllText(botLock, "999999");
            refused = false; try { Install(options); } catch (IOException) { refused = true; } if (!refused || File.ReadAllText(botLock) != "999999") throw new Exception("Retained safety lock changed.");
            string shortcut = Path.Combine(directory, "own.lnk"), unrelated = Path.Combine(directory, "unrelated.lnk"); var r1 = new Result();
            if (!Link(shortcut, Path.Combine(install, "AdaptiveSpotBot.exe"), r1) || !Link(shortcut, Path.Combine(install, "AdaptiveSpotBot.exe"), r1)) throw new Exception("Repeated own shortcut repair failed.");
            File.WriteAllText(unrelated, "UNRELATED-NOT-A-SHORTCUT"); if (Link(unrelated, Path.Combine(install, "AdaptiveSpotBot.exe"), r1) || File.ReadAllText(unrelated) != "UNRELATED-NOT-A-SHORTCUT") throw new Exception("Unrelated shortcut modified.");
            string marketData=Path.Combine(profile,"markets","ETHUSDT",".paper-data");Directory.CreateDirectory(marketData);string marketLock=Path.Combine(marketData,"testnet-bot.lock");File.WriteAllText(marketLock,"offline-eth-lock");
            refused=false;try{Install(options);}catch(IOException){refused=true;}if(!refused||File.ReadAllText(marketLock)!="offline-eth-lock")throw new Exception("Market safety lock was not preserved.");File.Delete(marketLock);
            if (File.ReadAllText(privateRecord) != "OFFLINE-TEST-DATA-NOT-A-KEY") throw new Exception("Profile data changed.");
            File.WriteAllText(Path.Combine(directory, "RESULT.txt"), "PASS: fresh install; repeat repair; retained old/unknown files; staging failure preservation; activation rollback; active GUI lock refusal; retained bot lock refusal; idempotent own shortcut repair; unrelated shortcut preservation; fake profile preserved. No real profile, registry, network, account, orders or app launch.\r\n", Encoding.UTF8); return 0;
        } catch (Exception e) { try { if (created) File.WriteAllText(Path.Combine(directory, "FAILED.txt"), e.ToString(), Encoding.UTF8); } catch { } return 1; }
    }
}
