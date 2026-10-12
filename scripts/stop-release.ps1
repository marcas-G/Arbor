$ErrorActionPreference = "Stop"

$dataRoot = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ArborFirstRelease"
$pidFile = Join-Path $dataRoot "daemon.pid"
if (!(Test-Path -LiteralPath $pidFile)) {
  Write-Output "No Arbor first-release daemon PID file was found."
  exit 0
}

$daemonPid = 0
if (![int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$daemonPid)) {
  throw "The daemon PID file is invalid; inspect $pidFile before removing it."
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $daemonPid" -ErrorAction SilentlyContinue
if ($process) {
  $expectedEntry = Join-Path (Split-Path $PSScriptRoot -Parent) "apps\single-workspace\dist\main.js"
  if ($process.Name -notin @("node.exe", "node") -or !$process.CommandLine.Contains($expectedEntry)) {
    throw "PID $daemonPid is not the Arbor first-release daemon; it was left running."
  }
  Stop-Process -Id $daemonPid
  Wait-Process -Id $daemonPid -Timeout 20 -ErrorAction SilentlyContinue
  Write-Output "Stopped Arbor first-release daemon (PID $daemonPid)."
} else {
  Write-Output "The recorded daemon process has already exited."
}

Remove-Item -LiteralPath $pidFile -Force
