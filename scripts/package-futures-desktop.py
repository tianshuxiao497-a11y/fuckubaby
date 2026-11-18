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
native = root / f'exports/futures-native-qa-{system}-{arch}'
qa = json.loads((native / 'RESULT.json').read_text(encoding='utf-8'))
assert qa['passed'] and qa['version'] == '0.1.0-futures-personal' and qa['unconfiguredStartBlocked']
assert qa['realAccountReads'] == qa['exchangeOrders'] == 0 and qa['uiFontLoaded']
build = root / 'exports/futures-desktop-build-0.1.0'
docs = root / 'products/futures-live-pilot/live'
out = root / 'exports/AdaptiveFuturesBot-Desktop-0.1.0'
out.mkdir(parents=True, exist_ok=True)
destination = out / f'AdaptiveFuturesBot-Personal-{system}-{arch}-0.1.0.zip'
assert not destination.exists()
sums = []
with ZipFile(destination, 'w', ZIP_DEFLATED) as z:
    if system == 'Mac':
        target = build / f'AdaptiveFuturesBot-0.1.0-mac-{arch}.zip'
        assert target.is_file()
        with ZipFile(target) as app:
            assert app.testzip() is None
            for info in app.infolist():
                path = PurePosixPath(info.filename)
                assert not path.is_absolute() and '..' not in path.parts
                assert info.filename.startswith('Adaptive Futures Bot.app/')
                data = app.read(info)
                z.writestr(copy.copy(info), data)
                if not info.is_dir():
                    sums.append(sha256(data).hexdigest() + '  ' + info.filename)
    else:
        extension = 'exe' if system == 'Windows' else 'deb'
        os_name = 'win' if system == 'Windows' else 'linux'
        package_arch = 'amd64' if system == 'Linux' and arch == 'x64' else arch
        target = build / f'AdaptiveFuturesBot-0.1.0-{os_name}-{package_arch}.{extension}'
        assert target.is_file()
        z.write(target, target.name)
        sums.append(sha256(target.read_bytes()).hexdigest() + '  ' + target.name)
    for language in ['ZH', 'EN']:
        text = (docs / f'README-{language}.md').read_text(encoding='utf-8')
        z.writestr(f'Guides/START-HERE-{language}.md', text)
        html = '<!doctype html><meta charset="utf-8"><title>Adaptive Futures Bot</title><style>@font-face{font-family:AdaptiveNoto;src:url(fonts/AdaptiveNotoSansSC.woff2)}body{max-width:900px;margin:40px auto;padding:20px;font:16px/1.7 AdaptiveNoto,system-ui}pre{font-family:inherit;white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>' + escape(text) + '</pre>'
        z.writestr(f'Guides/START-HERE-{language}.html', html)
    z.write(docs / 'example-futures-strategy.json', 'Guides/example-futures-strategy.json')
    for name in ['AdaptiveNotoSansSC.woff2', 'OFL.txt', 'DERIVATION.json']:
        z.write(docs / 'fonts' / name, 'Guides/fonts/' + name)
    z.writestr('NATIVE-ACCEPTANCE.json', json.dumps(qa, indent=2))
    z.writestr('SHA256SUMS.txt', '\n'.join(sums) + '\n')
with ZipFile(destination) as z:
    assert z.testzip() is None
report = {'version': '0.1.0-futures-personal', 'platform': system, 'arch': arch,
          'file': destination.name, 'bytes': destination.stat().st_size,
          'sha256': sha256(destination.read_bytes()).hexdigest(),
          'nativeSelfTestPassed': True, 'realOrdersSubmitted': 0, 'actualCredentialsUsed': False,
          'customerSubscriptionIntegrated': False, 'whopProductChanged': False,
          'unsigned': True, 'macZipPermissionsPreserved': system == 'Mac'}
(out / f'RESULT-{system}-{arch}.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
