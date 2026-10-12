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
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutPath = Join-Path $logDir "daemon-$runId.stdout.log"
$stderrPath = Join-Path $logDir "daemon-$runId.stderr.log"

New-Item -ItemType Directory -Force -Path $workspaceRoot, $dataDir, $logDir | Out-Null

if (Test-Path -LiteralPath $pidFile) {
  $recordedPid = 0
  [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$recordedPid)
  if ($recordedPid -gt 0 -and (Get-Process -Id $recordedPid -ErrorAction SilentlyContinue)) {
    throw "A release daemon is already recorded with PID $recordedPid. Use scripts/stop-release.ps1 first."
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
  -ArgumentList (Join-Path $root "apps\single-workspace\dist\main.js") `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline

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
