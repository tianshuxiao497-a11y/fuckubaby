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
native = root / f'exports/live-native-qa-{system}-{arch}'
qa = json.loads((native / 'RESULT.json').read_text(encoding='utf-8'))
assert qa['passed'] and qa['version'] == '0.2.0-personal' and qa['unconfiguredStartBlocked']
assert qa['realAccountReads'] == qa['exchangeOrders'] == 0
build = root / 'exports/live-desktop-build-0.2.0'
docs = root / 'products/spot-live-pilot/live'
out = root / 'exports/AdaptiveSpotBot-Live-Desktop-0.2.0'
out.mkdir(parents=True, exist_ok=True)
destination = out / f'AdaptiveSpotBot-Live-Personal-{system}-{arch}-0.2.0.zip'
assert not destination.exists()
sums = []
with ZipFile(destination, 'w', ZIP_DEFLATED) as z:
    if system == 'Mac':
        target = build / f'AdaptiveSpotBot-Live-0.2.0-mac-{arch}.zip'
        assert target.is_file()
        with ZipFile(target) as app:
            assert app.testzip() is None
            for info in app.infolist():
                path = PurePosixPath(info.filename)
                assert not path.is_absolute() and '..' not in path.parts
                assert info.filename.startswith('Adaptive Spot Bot Live.app/')
                data = app.read(info)
                z.writestr(copy.copy(info), data)
                if not info.is_dir():
                    sums.append(sha256(data).hexdigest() + '  ' + info.filename)
    else:
        extension = 'exe' if system == 'Windows' else 'deb'
        os_name = 'win' if system == 'Windows' else 'linux'
        target = build / f'AdaptiveSpotBot-Live-0.2.0-{os_name}-{arch}.{extension}'
        assert target.is_file()
        z.write(target, target.name)
        sums.append(sha256(target.read_bytes()).hexdigest() + '  ' + target.name)
    for language in ['ZH', 'EN']:
        text = (docs / f'README-{language}.md').read_text(encoding='utf-8')
        z.writestr(f'Guides/START-HERE-{language}.md', text)
        html = '<!doctype html><meta charset="utf-8"><title>Adaptive Spot Bot Live</title><style>body{max-width:900px;margin:40px auto;padding:20px;font:16px/1.7 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>' + escape(text) + '</pre>'
        z.writestr(f'Guides/START-HERE-{language}.html', html)
    z.write(docs / 'example-live-strategy.json', 'Guides/example-live-strategy.json')
    z.writestr('NATIVE-ACCEPTANCE.json', json.dumps(qa, indent=2))
    z.writestr('SHA256SUMS.txt', '\n'.join(sums) + '\n')
with ZipFile(destination) as z:
    assert z.testzip() is None
report = {'version': '0.2.0-personal', 'platform': system, 'arch': arch,
          'file': destination.name, 'bytes': destination.stat().st_size,
          'sha256': sha256(destination.read_bytes()).hexdigest(),
          'nativeSelfTestPassed': True, 'realOrdersSubmitted': 0, 'actualCredentialsUsed': False,
          'customerSubscriptionIntegrated': False, 'whopProductChanged': False,
          'unsigned': True, 'macZipPermissionsPreserved': system == 'Mac'}
(out / f'RESULT-{system}-{arch}.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
