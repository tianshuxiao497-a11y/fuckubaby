$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$monitorScriptPath = Join-Path $workspacePath 'scripts\testnet-dashboard.mjs'
$monitorEnvPath = Join-Path $workspacePath '.env.testnet'
$monitorDataPath = Join-Path $workspacePath '.paper-data'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $monitorDataPath -Force | Out-Null
$monitorProcess = Start-Process -FilePath $nodePath -ArgumentList @(
    "--env-file-if-exists=`"$monitorEnvPath`"", "`"$monitorScriptPath`""
) -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $monitorDataPath 'dashboard-out.log') -RedirectStandardError (Join-Path $monitorDataPath 'dashboard-error.log')
Set-Content -LiteralPath (Join-Path $monitorDataPath 'dashboard-pid') -Value $monitorProcess.Id
Write-Output "Read-only monitor started: $($monitorProcess.Id), http://127.0.0.1:3001"
