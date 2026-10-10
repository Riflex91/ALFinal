# Installs the already existing AL Bot telemetry writer on this Windows PC.
# It intentionally does not change the Adventure Land gameplay/runtime.
$ErrorActionPreference = 'Stop'
$ssd = 'D:\ALBot\telemetry'
if (-not (Test-Path -LiteralPath 'D:\' -PathType Container)) {
  throw 'SSD_DRIVE_D_NOT_PRESENT: D:\ is required. No fallback to browser or C: storage.'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$server = Join-Path $PSScriptRoot 'telemetry-recorder.mjs'
$kvModule = Join-Path $PSScriptRoot 'ssd-kv-store.mjs'
if (-not (Test-Path -LiteralPath $kvModule -PathType Leaf)) { throw 'SSD_KV_MODULE_MISSING' }
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
  throw 'TELEMETRY_RECORDER_MISSING'
}
New-Item -ItemType Directory -Path $ssd, 'D:\ALBot\state\kv' -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $server + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
# Stop only our own existing task before updating its Node module dependency.
# Never kill arbitrary processes that may also use this port.
$existing = Get-ScheduledTask -TaskName 'ALBot-SSD-Telemetry' -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName 'ALBot-SSD-Telemetry' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Register-ScheduledTask -TaskName 'ALBot-SSD-Telemetry' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'ALBot-SSD-Telemetry'
$healthy = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $status = Invoke-RestMethod -Uri 'http://127.0.0.1:17391/health' -TimeoutSec 2
    $actual = [System.IO.Path]::GetFullPath([string]$status.store.root)
    $wanted = [System.IO.Path]::GetFullPath($ssd)
    $kvActual = [System.IO.Path]::GetFullPath([string]$status.kvStore.root)
    $kvWanted = [System.IO.Path]::GetFullPath('D:\ALBot\state\kv')
    # PowerShell 5.1: do not start a new line with "-and" inside an if.
    # Evaluate each comparison first, then combine the booleans on one line.
    $telemetryRootMatches = $actual.TrimEnd('\') -ieq $wanted.TrimEnd('\')
    $kvRootMatches = $kvActual.TrimEnd('\') -ieq $kvWanted.TrimEnd('\')
    $kvReady = ($null -ne $status.kvStore) -and ($status.kvStore.available -eq $true)
    if (($status.ok -eq $true) -and $telemetryRootMatches -and $kvReady -and $kvRootMatches) {
      $healthy = $true
      break
    }
  } catch {}
}
if (-not $healthy) {
  throw 'SSD_TELEMETRY_NOT_HEALTHY: Check Task Scheduler ALBot-SSD-Telemetry, drive D: and port 17391.'
}
# Verify a real atomic write/read/delete to D:\ALBot\state\kv.
$probeUrl = 'http://127.0.0.1:17391/v1/kv?key=albot%3Assd%3Ainstallation-probe%3Av1'
$probeValue = 'ssd-ready-' + [guid]::NewGuid().ToString('N')
$probeBody = @{ value = $probeValue } | ConvertTo-Json -Compress
$null = Invoke-RestMethod -Uri $probeUrl -Method Post -ContentType 'application/json' -Body $probeBody -TimeoutSec 5
$probeRead = Invoke-RestMethod -Uri $probeUrl -Method Get -TimeoutSec 5
if ($probeRead.ok -ne $true -or $probeRead.value -ne $probeValue) {
  throw 'SSD_KV_READ_AFTER_WRITE_FAILED'
}
$null = Invoke-RestMethod -Uri $probeUrl -Method Delete -TimeoutSec 5
Write-Host 'SSD_KV_READ_WRITE_DELETE_PASS' -ForegroundColor Green
Write-Host 'SSD_STATE_AND_TELEMETRY_ACTIVE' -ForegroundColor Green
Write-Host 'Telemetry: D:\ALBot\telemetry\raw and D:\ALBot\telemetry\daily'
Write-Host 'Bot state: D:\ALBot\state\kv'
Write-Host 'Task: ALBot-SSD-Telemetry (runs after Windows logon)'
