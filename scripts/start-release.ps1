param(
  [Parameter(Mandatory = $true)]
  [Alias("ProviderConfig")]
  [string]$ProviderConfigFile,
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$providerConfigPath = (Resolve-Path -LiteralPath $ProviderConfigFile).Path
$loadedProviderConfig = Get-Content -LiteralPath $providerConfigPath -Raw | ConvertFrom-Json
$configuredProvider = $loadedProviderConfig.provider
$secretKind = [string]$configuredProvider.secret.kind
if (
  [string]::IsNullOrWhiteSpace([string]$configuredProvider.deploymentId) -or
  [string]::IsNullOrWhiteSpace([string]$configuredProvider.modelRef) -or
  [string]::IsNullOrWhiteSpace([string]$configuredProvider.endpoint) -or
  @("env", "file", "inline") -notcontains $secretKind
) {
  throw "Provider config must contain deploymentId, modelRef, endpoint, and a SecretRef-backed secret."
}

$dataRoot = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ArborFirstRelease"
$workspaceRoot = Join-Path $dataRoot "workspace"
$dataDir = Join-Path $dataRoot "data"
$logDir = Join-Path $dataRoot "logs"
$pidFile = Join-Path $dataRoot "daemon.pid"
$dbPath = Join-Path $dataDir "arbor-slice.db"
$entryPath = [System.IO.Path]::GetFullPath((Join-Path $root "apps\single-workspace\dist\main.js"))
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutPath = Join-Path $logDir "daemon-$runId.stdout.log"
$stderrPath = Join-Path $logDir "daemon-$runId.stderr.log"

New-Item -ItemType Directory -Force -Path $workspaceRoot, $dataDir, $logDir | Out-Null

if (Test-Path -LiteralPath $pidFile) {
  $pidContent = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $instance = $null
  try { $instance = ConvertFrom-Json -InputObject $pidContent } catch { }
  $recordedPid = 0
  if ($instance -is [System.Management.Automation.PSCustomObject]) {
    $recordedPid = [int]$instance.processId
  } else {
    [void][int]::TryParse($pidContent, [ref]$recordedPid)
  }
  $existingProcess = if ($recordedPid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue } else { $null }
  if ($existingProcess) {
    $expectedEntryInCommand = $existingProcess.CommandLine.IndexOf($entryPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $existingListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $recordedPid } | Select-Object -First 1
    $sameConfiguredInstance = $false
    if ($instance -is [System.Management.Automation.PSCustomObject]) {
      $sameConfiguredInstance =
        [string]::Equals([string]$instance.appRoot, $root, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$instance.entryPath, $entryPath, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$instance.databasePath, $dbPath, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$instance.workspaceRoot, $workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$instance.providerConfigPath, $providerConfigPath, [System.StringComparison]::OrdinalIgnoreCase) -and
        [int]$instance.port -eq $Port
      try {
        $liveProcess = Get-Process -Id $recordedPid -ErrorAction Stop
        $liveStartUtc = $liveProcess.StartTime.ToUniversalTime()
        $savedStartTicks = 0L
        $hasSavedStartTicks = [long]::TryParse([string]$instance.processStartTimeTicks, [ref]$savedStartTicks)
        $startMatches = if ($hasSavedStartTicks) {
          $liveStartUtc.Ticks -eq $savedStartTicks
        } else {
          # PowerShell 5 may convert the ISO JSON string to DateTime and drop
          # its fractional seconds. The legacy fallback therefore compares
          # the UTC clock to the stored whole second only.
          $liveStartSecond = $liveStartUtc.ToString("yyyy-MM-ddTHH:mm:ss")
          $storedStartSecond = ([DateTime]$instance.processStartTimeUtc).ToString("yyyy-MM-ddTHH:mm:ss")
          [string]::Equals($liveStartSecond, $storedStartSecond, [System.StringComparison]::Ordinal)
        }
        $sameConfiguredInstance = $sameConfiguredInstance -and $startMatches
      } catch {
        $sameConfiguredInstance = $false
      }
    }
    if (
      $existingProcess.Name -in @("node.exe", "node") -and
      $expectedEntryInCommand -and
      $existingListener -and
      (($instance -is [System.Management.Automation.PSCustomObject] -and $sameConfiguredInstance) -or $instance -isnot [System.Management.Automation.PSCustomObject])
    ) {
      try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/project-resources" -TimeoutSec 3 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
          Write-Output "Arbor is already ready at http://127.0.0.1:$Port"
          Write-Output "Database: $dbPath"
          Write-Output "Workspace files: $workspaceRoot"
          Write-Output "Daemon PID: $recordedPid"
          Write-Output "Logs: $logDir"
          exit 0
        }
      } catch { }
    }
    throw "PID $recordedPid is still running, but it does not match this Arbor release instance. It was left untouched."
  }
  Remove-Item -LiteralPath $pidFile -Force
}

$existingListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
  throw "Port $Port is already in use by PID $($existingListener.OwningProcess). Choose another port; no process was stopped."
}

$nodeCommand = Get-Command node -ErrorAction Stop
$env:ARBOR_CONFIG = $providerConfigPath
$env:ARBOR_DB = $dbPath
$env:ARBOR_PROJECT_ROOT = $workspaceRoot
$env:ARBOR_HTTP_PORT = [string]$Port
$env:ARBOR_WEB_DIST = Join-Path $root "apps/web/dist"

$process = Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList $entryPath `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru
$processStartUtc = (Get-Process -Id $process.Id).StartTime.ToUniversalTime()
$processStartTimeUtc = $processStartUtc.ToString("o")
[ordered]@{
  processId = $process.Id
  processStartTimeUtc = $processStartTimeUtc
  processStartTimeTicks = [long]$processStartUtc.Ticks
  appRoot = $root
  entryPath = $entryPath
  port = $Port
  databasePath = $dbPath
  workspaceRoot = $workspaceRoot
  providerConfigPath = $providerConfigPath
} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(60)
while ([DateTime]::UtcNow -lt $deadline) {
  if ($process.HasExited) {
    throw "The daemon exited during startup. Inspect logs in $logDir."
  }
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/project-resources" -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

if (!$ready) {
  throw "The daemon did not become ready within 60 seconds. Inspect logs in $logDir."
}

Write-Output "Arbor is ready at http://127.0.0.1:$Port"
Write-Output "Database: $dbPath"
Write-Output "Workspace files: $workspaceRoot"
Write-Output "Daemon PID: $($process.Id)"
Write-Output "Logs: $logDir"
