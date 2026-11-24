"""Publish the same verified ZIPs built by the four native jobs in this run."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


version = "0.4.1"
tag = f"v{version}-live-customer.2"
repo = os.environ["GITHUB_REPOSITORY"]
commit = os.environ["GITHUB_SHA"]
if repo != "tianshuxiao497-a11y/fuckubaby" or os.environ["GITHUB_REF"] != "refs/heads/codex/live-customer-031":
    raise RuntimeError("Unexpected release target")
root = Path("native-results")
packages = {}
reports = []
for runner, platform, arch, native_os in [
    ("windows-latest", "Windows", "x64", "win32"),
    ("ubuntu-24.04", "Linux", "x64", "linux"),
    ("macos-15", "Mac", "arm64", "darwin"),
    ("macos-15-intel", "Mac", "x64", "darwin"),
]:
    directory = root / f"live-customer-desktop-031-{runner}-{arch}"
    report = json.loads((directory / f"RESULT-{platform}-{arch}.json").read_text())
    name = f"AdaptiveTradingBot-Live-Buyer-{platform}-{arch}-{version}.zip"
    path = directory / name
    assert (report["version"], report["platform"], report["arch"], report["file"]) == (version+"-customer", platform, arch, name)
    assert report["nativeSelfTestPassed"] and report["customerSubscriptionIntegrated"]
    assert report["futuresSettingsRoundTripVerified"] is True
    assert report["tradeReportingVerified"] is True
    assert report["actualCredentialsUsed"] is False and report["realOrdersSubmitted"] == 0
    assert path.stat().st_size == report["bytes"] and digest(path) == report["sha256"]
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        assert "Multi-Assets" in archive.read("Guides/START-HERE-EN.md").decode()
        assert "多资产" in archive.read("Guides/START-HERE-ZH.md").decode()
        assert "allow positions on other contracts" in archive.read("Guides/START-HERE-EN.md").decode()
        assert "允许其他合约持仓共存" in archive.read("Guides/START-HERE-ZH.md").decode()
        native = json.loads(archive.read("NATIVE-ACCEPTANCE.json"))
        assert (native["version"], native["platform"], native["arch"]) == (report["version"], native_os, arch)
        assert native["passed"] and native["assetModes"] == {"single": True, "multi": True, "cross": True}
        assert native["externalPositions"] == {"defaultBlocks": True, "saved": True, "restored": True}
        assert all(native["settingsRoundTrip"].get(key) is True for key in ("restored","localTarget","exchangeValue","summaryVisible","detailsCollapsed","contractLimits","manualPosition","orderCounts","makerDefault","makerRestored"))
        assert all(native["tradeReporting"].get(key) is True for key in ('perOrder','roundTrip','fees','funding','longLeg','shortLeg','estimatedExitSeparate','unknownNotZero'))
        assert native["unlicensedStartBlocked"] and native["realAccountReads"] == native["exchangeOrders"] == 0
    if platform == "Linux":
        qa_dir = root / f"live-customer-desktop-031-qa-{runner}-{arch}"
        installed, = qa_dir.rglob("live-customer-native-qa-Linux-installed-x64/RESULT.json")
        installed_qa = json.loads(installed.read_text())
        assert installed_qa["passed"] and installed_qa["assetModes"] == native["assetModes"]
        assert installed_qa["externalPositions"] == native["externalPositions"]
        assert installed_qa["settingsRoundTrip"] == native["settingsRoundTrip"]
        assert installed_qa["tradeReporting"] == native["tradeReporting"]
    packages[name] = path
    reports.append(report)

metadata = root / "CUSTOMER-BUILDS.json"
metadata.write_text(json.dumps({"commit": commit, "run": os.environ["GITHUB_RUN_ID"], "packages": reports}, indent=2))
packages[metadata.name] = metadata
releases = json.loads(gh("api", f"repos/{repo}/releases?per_page=100"))
existing = next((r for r in releases if r["tag_name"] == tag), None)
if existing:
    assert existing["target_commitish"] == commit
else:
    gh("release", "create", tag, "--target", commit, "--draft", "--prerelease", "--title",
       f"Adaptive Trading Bot Live {version}", "--notes",
       "Review order fills, closed-trade profit and loss, actual commissions and funding, plus separate live long/short position costs. Windows, Linux and both Mac builds passed offline native checks. Existing settings keep their execution preference. Maker-first entry is available in Futures settings.")
release_id = gh("release", "view", tag, "--json", "databaseId", "--jq", ".databaseId")
def assets():
    return {a["name"]: a for a in json.loads(gh("api", f"repos/{repo}/releases/{release_id}/assets"))}

uploaded = assets()
for name, path in packages.items():
    if name not in uploaded:
        gh("release", "upload", tag, str(path))
verified = assets()
assert verified.keys() == packages.keys()
for name, path in packages.items():
    a = verified[name]
    assert a["state"] == "uploaded" and a["size"] == path.stat().st_size and a["digest"] == "sha256:" + digest(path)
gh("release", "edit", tag, "--draft=false", "--prerelease", "--latest=false")
