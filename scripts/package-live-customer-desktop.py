"""Collect only a native-tested, unconfigured personal mainnet desktop app."""
from pathlib import Path, PurePosixPath
from zipfile import ZipFile, ZIP_DEFLATED
from hashlib import sha256
from html import escape
import copy
import json
import platform

root = Path(__file__).resolve().parent.parent
system = {'Windows': 'Windows', 'Linux': 'Linux', 'Darwin': 'Mac'}[platform.system()]
arch = {'AMD64': 'x64', 'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine()]
native = root / f'exports/live-customer-native-qa-{system}-{arch}'
qa = json.loads((native / 'RESULT.json').read_text(encoding='utf-8'))
assert qa['passed'] and qa['version'] == '0.4.1-customer' and qa['unconfiguredStartBlocked']
assert qa['customerSubscriptionIntegrated'] and qa['unlicensedStartBlocked']
assert qa['twoWorkspaces'] and qa['legs']['closeLong'] and qa['legs']['closeShort'] and qa['margin']['manualEnabled'] and qa['margin']['autoDisabled']
assert qa['margin']['selectFontLoaded']
assert qa['externalPositions'] == {'defaultBlocks': True, 'saved': True, 'restored': True}
assert all(qa['settingsRoundTrip'].get(key) is True for key in ('restored','localTarget','exchangeValue','summaryVisible','detailsCollapsed','contractLimits','manualPosition','orderCounts','makerDefault','makerRestored'))
assert all(qa['tradeReporting'].get(key) is True for key in ('perOrder','roundTrip','fees','funding','longLeg','shortLeg','estimatedExitSeparate','unknownNotZero'))
assert qa['realAccountReads'] == qa['exchangeOrders'] == 0 and qa['uiFontLoaded']
build = root / 'exports/live-customer-build-0.4.1'
docs = root / 'products/live-customer-license'
out = root / 'exports/AdaptiveTradingBot-Live-0.4.1'
out.mkdir(parents=True, exist_ok=True)
destination = out / f'AdaptiveTradingBot-Live-Buyer-{system}-{arch}-0.4.1.zip'
assert not destination.exists()
sums = []
with ZipFile(destination, 'w', ZIP_DEFLATED) as z:
    if system == 'Mac':
        target = build / f'AdaptiveTradingBot-Live-Customer-0.4.1-mac-{arch}.zip'
        assert target.is_file()
        with ZipFile(target) as app:
            assert app.testzip() is None
            for info in app.infolist():
                path = PurePosixPath(info.filename)
                assert not path.is_absolute() and '..' not in path.parts
                assert info.filename.startswith('Adaptive Trading Bot Live Customer.app/')
                data = app.read(info)
                z.writestr(copy.copy(info), data)
                if not info.is_dir():
                    sums.append(sha256(data).hexdigest() + '  ' + info.filename)
    else:
        extension = 'exe' if system == 'Windows' else 'deb'
        os_name = 'win' if system == 'Windows' else 'linux'
        package_arch = 'amd64' if system == 'Linux' and arch == 'x64' else arch
        target = build / f'AdaptiveTradingBot-Live-Customer-0.4.1-{os_name}-{package_arch}.{extension}'
        assert target.is_file()
        z.write(target, target.name)
        sums.append(sha256(target.read_bytes()).hexdigest() + '  ' + target.name)
    for language in ['ZH', 'EN']:
        text = (docs / f'README-{language}.md').read_text(encoding='utf-8')
        z.writestr(f'Guides/START-HERE-{language}.md', text)
        html = '<!doctype html><meta charset="utf-8"><title>Adaptive Trading Bot Live</title><style>@font-face{font-family:AdaptiveNoto;src:url(fonts/AdaptiveNotoSansSC.woff2)}body{max-width:900px;margin:40px auto;padding:20px;font:16px/1.7 AdaptiveNoto,system-ui}pre{font-family:inherit;white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>' + escape(text) + '</pre>'
        z.writestr(f'Guides/START-HERE-{language}.html', html)
    for folder,name in [('spot-live-pilot/live','example-live-strategy.json'),('futures-live-pilot/live','example-futures-strategy.json'),('futures-live-pilot/live','example-auto-margin.json')]:
        z.write(root / 'products' / folder / name, 'Guides/' + name)
    for name in ['AdaptiveNotoSansSC.woff2', 'OFL.txt', 'DERIVATION.json']:
        z.write(root / 'products/futures-live-pilot/live/fonts' / name, 'Guides/fonts/' + name)
    z.writestr('NATIVE-ACCEPTANCE.json', json.dumps(qa, indent=2))
    z.writestr('SHA256SUMS.txt', '\n'.join(sums) + '\n')
with ZipFile(destination) as z:
    assert z.testzip() is None
report = {'version': '0.4.1-customer', 'platform': system, 'arch': arch,
          'file': destination.name, 'bytes': destination.stat().st_size,
          'sha256': sha256(destination.read_bytes()).hexdigest(),
          'nativeSelfTestPassed': True, 'futuresSettingsRoundTripVerified': True, 'tradeReportingVerified': True, 'realOrdersSubmitted': 0, 'actualCredentialsUsed': False,
          'customerSubscriptionIntegrated': True, 'whopProductChanged': False,
          'unsigned': True, 'macZipPermissionsPreserved': system == 'Mac'}
(out / f'RESULT-{system}-{arch}.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
