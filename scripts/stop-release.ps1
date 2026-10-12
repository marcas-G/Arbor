$ErrorActionPreference = "Stop"

$dataRoot = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ArborFirstRelease"
$pidFile = Join-Path $dataRoot "daemon.pid"
if (!(Test-Path -LiteralPath $pidFile)) {
  Write-Output "No Arbor first-release daemon PID file was found."
  exit 0
}

$pidContent = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$instance = $null
try { $instance = ConvertFrom-Json -InputObject $pidContent } catch { }
$daemonPid = 0
if ($instance -is [System.Management.Automation.PSCustomObject]) {
  $daemonPid = [int]$instance.processId
} elseif (![int]::TryParse($pidContent, [ref]$daemonPid)) {
  throw "The daemon PID file is invalid; inspect $pidFile before removing it."
}

$expectedRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$expectedEntry = [System.IO.Path]::GetFullPath((Join-Path $expectedRoot "apps\single-workspace\dist\main.js"))
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $daemonPid" -ErrorAction SilentlyContinue
if ($process) {
  $entryMatches = $process.CommandLine.IndexOf($expectedEntry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $instanceMatches = $instance -is [System.Management.Automation.PSCustomObject]
  $port = 8787
  if ($instanceMatches) {
    $port = [int]$instance.port
    $instanceMatches =
      [string]::Equals([string]$instance.appRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals([string]$instance.entryPath, $expectedEntry, [System.StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals([string]$instance.databasePath, (Join-Path $dataRoot "data\arbor-slice.db"), [System.StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals([string]$instance.workspaceRoot, (Join-Path $dataRoot "workspace"), [System.StringComparison]::OrdinalIgnoreCase)
    try {
      $liveProcess = Get-Process -Id $daemonPid -ErrorAction Stop
      $savedStart = [DateTime]::Parse([string]$instance.processStartTimeUtc).ToUniversalTime()
      $instanceMatches = $instanceMatches -and ($liveProcess.StartTime.ToUniversalTime() -eq $savedStart)
    } catch {
      $instanceMatches = $false
    }
  }
  $listenerMatches = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $daemonPid } | Select-Object -First 1
  if (
    $process.Name -notin @("node.exe", "node") -or
    !$entryMatches -or
    !$listenerMatches -or
    ($instance -is [System.Management.Automation.PSCustomObject] -and !$instanceMatches)
  ) {
    throw "PID $daemonPid does not match this first-release daemon instance; it was left running."
  }
  Stop-Process -Id $daemonPid
  Wait-Process -Id $daemonPid -Timeout 20 -ErrorAction SilentlyContinue
  Write-Output "Stopped Arbor first-release daemon (PID $daemonPid)."
} else {
  Write-Output "The recorded daemon process has already exited."
}

Remove-Item -LiteralPath $pidFile -Force
