$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$botScriptPath = Join-Path $workspacePath 'scripts\testnet.mjs'
$botEnvPath = Join-Path $workspacePath '.env.testnet'
$botDataPath = Join-Path $workspacePath '.paper-data'
$botLockPath = Join-Path $botDataPath 'testnet-bot.lock'
if (Test-Path -LiteralPath $botLockPath) {
    throw 'Testnet lock already exists. Verify the existing process before starting another instance.'
}
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $botDataPath -Force | Out-Null
$botProcess = Start-Process -FilePath $nodePath -ArgumentList @(
    "--env-file-if-exists=`"$botEnvPath`"", "`"$botScriptPath`"", '--watch', '--enable-testnet-orders'
) -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $botDataPath 'testnet-out.log') -RedirectStandardError (Join-Path $botDataPath 'testnet-error.log')
Set-Content -LiteralPath (Join-Path $botDataPath 'testnet-pid') -Value $botProcess.Id
Write-Output "Testnet virtual-only process started: $($botProcess.Id). Check .paper-data/testnet-out.log and testnet-error.log."
