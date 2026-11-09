using System;
using System.IO;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Diagnostics;

internal static class Shared {
    internal const string Version = "0.5.2";
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8388608 };
    internal static string Profile { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AdaptiveSpotBot", "Testnet"); } }
    internal static string Install { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "AdaptiveSpotBotTestnet"); } }
    internal static string Hash(string path) { using (var s = File.OpenRead(path)) using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant(); }
    internal static void PrivateDirectory(string path) {
        Directory.CreateDirectory(path);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked profile folders are not supported.");
        var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(path, acl);
    }
    internal static ProcessStartInfo Node(string install, string profile) {
        var p = new ProcessStartInfo(Path.Combine(install, "node.exe"), "\"" + Path.Combine(install, "engine", "products", "adaptive-spot-desktop", "controller.mjs") + "\" \"" + profile + "\"");
        p.WorkingDirectory = profile; p.UseShellExecute = false; p.CreateNoWindow = true;
        p.RedirectStandardInput = p.RedirectStandardOutput = p.RedirectStandardError = true;
        p.StandardOutputEncoding = p.StandardErrorEncoding = new UTF8Encoding(false);
        var keys = new[] { "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE" };
        p.EnvironmentVariables.Clear(); foreach (var key in keys) { var v = Environment.GetEnvironmentVariable(key); if (v != null) p.EnvironmentVariables[key] = v; }
        return p;
    }
    internal static void SaveCredentials(string path, object value) {
        var bytes = Encoding.UTF8.GetBytes(Json.Serialize(value));
        var cipher = ProtectedData.Protect(bytes, Encoding.UTF8.GetBytes("AdaptiveSpotBot.Testnet.v1"), DataProtectionScope.CurrentUser);
        Array.Clear(bytes, 0, bytes.Length);
        string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllBytes(temp, cipher);
        if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
    }
    internal static object LoadCredentials(string path) {
        var bytes = ProtectedData.Unprotect(File.ReadAllBytes(path), Encoding.UTF8.GetBytes("AdaptiveSpotBot.Testnet.v1"), DataProtectionScope.CurrentUser);
        try { return Json.DeserializeObject(Encoding.UTF8.GetString(bytes)); } finally { Array.Clear(bytes, 0, bytes.Length); }
    }
}
