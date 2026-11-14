from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from hashlib import sha256
import json
import platform
import subprocess
import sys
import os

root = Path(__file__).resolve().parent.parent
version = '0.1.0-personal'
live = root / 'products' / 'spot-live-pilot' / 'live'
source_names = [
    'client.mjs', 'decimal.mjs', 'engine.mjs', 'ledger.mjs', 'risk.mjs',
    'server.mjs', 'strategy.mjs', 'vault.mjs', 'review.mjs',
    'ui.html', 'ui.js', 'ui.css', 'README-ZH.md', 'example-live-strategy.json',
]
library_names = [
    'adaptive-strategy.mjs', 'atomic-json.mjs', 'external-testnet-strategy.mjs',
    'testnet-commission.mjs', 'testnet-symbols.mjs',
]
if sys.argv[1:] != ['--native-offline-verified']:
    raise SystemExit('Run only after native offline verification.')

node = Path(subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip())
runtime_version = subprocess.check_output([str(node), '--version'], text=True).strip()
if runtime_version != 'v24.15.0':
    raise SystemExit('Pinned official Node.js v24.15.0 required.')

system = {'Windows': 'Windows', 'Linux': 'Linux', 'Darwin': 'Mac'}[platform.system()]
arch = {'AMD64': 'x64', 'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine()]
acceptance_file = root / 'exports' / 'live-personal-native-smoke.json'
acceptance = json.loads(acceptance_file.read_text(encoding='utf-8'))
if not acceptance['passed'] or acceptance['version'] != version or acceptance['exchangeRequests'] != 0:
    raise SystemExit('Native launch acceptance required.')

files = {}
for name in source_names:
    files['products/spot-live-pilot/live/' + name] = ((live / name).read_bytes(), 0o644)
for name in library_names:
    files['lib/' + name] = ((root / 'lib' / name).read_bytes(), 0o644)
files['runtime/' + ('node.exe' if system == 'Windows' else 'node')] = (node.read_bytes(), 0o755)
files['NODE-LICENSE.txt'] = ((live / 'NODE-LICENSE.txt').read_bytes(), 0o644)
files['START-HERE-ZH.md'] = ((live / 'README-ZH.md').read_bytes(), 0o644)
files['example-live-strategy.json'] = ((live / 'example-live-strategy.json').read_bytes(), 0o644)
launcher = 'Start-Live.cmd' if system == 'Windows' else 'Start-Live.command' if system == 'Mac' else 'Start-Live.sh'
if system == 'Windows':
    launch = '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0products\\spot-live-pilot\\live\\server.mjs" --desktop\r\nif errorlevel 1 pause\r\n'
else:
    launch = '#!/bin/sh\nset -eu\ncd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec ./runtime/node ./products/spot-live-pilot/live/server.mjs --desktop\n'
files[launcher] = (launch.encode('utf-8'), 0o755)

report = {
    'version': version,
    'platform': system,
    'arch': arch,
    'runtime': runtime_version,
    'nativeStartupPassed': True,
    'realOrdersSubmittedDuringAcceptance': 0,
    'actualCredentialsUsed': False,
    'whopProductUpdated': False,
    'customerSubscriptionIntegrated': False,
    'scope': 'Personal self-run live Spot pilot. User must explicitly arm on their own computer.',
    'limitations': [
        'Single active symbol per ledger; dust retains separate valuation.',
        'The first risk day starts with the initial program capital.',
        'Subsequent UTC+8 midnight equity uses recorded fills and candle opening prices.',
        '20% is a buy-stop trigger, not a guaranteed maximum financial loss.',
        'Local browser control page and bundled runtime; portable folder package.',
    ],
}
files['ACCEPTANCE.json'] = ((json.dumps(report, indent=2) + '\n').encode(), 0o644)
sums = '\n'.join(sha256(data).hexdigest() + '  ' + name for name, (data, mode) in files.items()) + '\n'
files['SHA256SUMS.txt'] = (sums.encode(), 0o644)

out = root / 'exports' / 'AdaptiveSpotBot-Live-Personal-0.1.0'
out.mkdir(parents=True, exist_ok=True)
destination = out / f'AdaptiveSpotBot-Live-Personal-{system}-{arch}-0.1.0.zip'
if destination.exists():
    raise SystemExit('Existing deliverable must be reviewed before replacement.')
with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
    for name, (data, mode) in files.items():
        info = ZipInfo(name)
        info.create_system = 3
        info.external_attr = (0o100000 | mode) << 16
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, data)
with ZipFile(destination) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Corrupt package.')
    for name, (data, mode) in files.items():
        if sha256(archive.read(name)).digest() != sha256(data).digest():
            raise SystemExit('Archive content differs.')
result = {**report, 'file': destination.name, 'bytes': destination.stat().st_size,
          'sha256': sha256(destination.read_bytes()).hexdigest()}
(out / f'RESULT-{system}-{arch}.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
