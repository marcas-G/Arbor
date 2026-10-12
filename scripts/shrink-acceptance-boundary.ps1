param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preview", "Apply")]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$WorkspaceId,
  [Parameter(Mandatory = $true)]
  [string]$ProviderConfig,
  [int]$ExpectedRevision = -1
)

$ErrorActionPreference = "Stop"
$expectedWorkspace = "ws_01a12e7b-6329-79bc-960f-d2364b70e683"
if ($WorkspaceId -cne $expectedWorkspace) {
  throw "WorkspaceId must match the hardcoded acceptance Workspace."
}
if ($Mode -eq "Apply" -and $ExpectedRevision -lt 0) {
  throw "Apply requires -ExpectedRevision from a fresh Preview."
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$entryPath = [System.IO.Path]::GetFullPath((Join-Path $root "apps\single-workspace\dist\main.js"))
$dataRoot = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ArborFirstRelease"
$dbPath = Join-Path $dataRoot "data\arbor-slice.db"
$workspaceRoot = Join-Path $dataRoot "workspace"
$pidFile = Join-Path $dataRoot "daemon.pid"
$providerConfigPath = (Resolve-Path -LiteralPath $ProviderConfig).Path
$expectedPort = 8787

# Refuse before opening SQLite if the release daemon is still running or its
# identity cannot be proved. Both the current JSON record and legacy PID-only
# format are recognized; no process is stopped by this script.
$recordedPid = 0
$recordedInstance = $null
$recordedEntryPath = $entryPath
if (Test-Path -LiteralPath $pidFile) {
  $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  try { $recordedInstance = ConvertFrom-Json -InputObject $pidText } catch { }
  if ($recordedInstance -is [System.Management.Automation.PSCustomObject]) {
    if ($null -eq $recordedInstance.processId -or $null -eq $recordedInstance.port) {
      throw "The release PID record is incomplete; refusing to open the database."
    }
    $recordedPid = [int]$recordedInstance.processId
    $expectedPort = [int]$recordedInstance.port
    $recordedRoot = [System.IO.Path]::GetFullPath([string]$recordedInstance.appRoot)
    $recordedEntryPath = [System.IO.Path]::GetFullPath([string]$recordedInstance.entryPath)
    $expectedRecordedEntry = [System.IO.Path]::GetFullPath((Join-Path $recordedRoot "apps\single-workspace\dist\main.js"))
    $metadataMatches =
      [string]::Equals($recordedEntryPath, $expectedRecordedEntry, [System.StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals([string]$recordedInstance.databasePath, $dbPath, [System.StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals([string]$recordedInstance.workspaceRoot, $workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals([string]$recordedInstance.providerConfigPath, $providerConfigPath, [System.StringComparison]::OrdinalIgnoreCase)
    if (!$metadataMatches) {
      throw "The release PID record does not match this checkout/configuration; refusing to open the database."
    }
  } elseif (![int]::TryParse($pidText, [ref]$recordedPid)) {
    throw "The release PID file is malformed; refusing to open the database."
  }
}

$matchingNodeProcesses = @(
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf("apps\single-workspace\dist\main.js", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
)
$listenerRecords = @(Get-NetTCPConnection -State Listen -LocalPort $expectedPort -ErrorAction SilentlyContinue)
$recordedProcess = if ($recordedPid -gt 0) {
  Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue
} else { $null }

if ($recordedProcess) {
  $entryMatches = $recordedProcess.Name -in @("node.exe", "node") -and
    $recordedProcess.CommandLine -and
    $recordedProcess.CommandLine.IndexOf($recordedEntryPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $listenerMatches = $listenerRecords | Where-Object { $_.OwningProcess -eq $recordedPid } | Select-Object -First 1
  if (!$entryMatches -or !$listenerMatches) {
    throw "Recorded PID is live but its daemon identity is uncertain; refusing to open the database."
  }
  if ($recordedInstance -is [System.Management.Automation.PSCustomObject]) {
    try {
      $liveProcess = Get-Process -Id $recordedPid -ErrorAction Stop
      $savedStart = [DateTime]::Parse([string]$recordedInstance.processStartTimeUtc).ToUniversalTime()
      if ($liveProcess.StartTime.ToUniversalTime() -ne $savedStart) {
        throw "Recorded PID start time does not match the live process."
      }
    } catch {
      throw "Recorded PID identity cannot be verified; refusing to open the database."
    }
  }
  throw "Arbor release daemon PID $recordedPid is still listening; stop it before running this operation."
}

if ($matchingNodeProcesses.Count -gt 0 -or $listenerRecords.Count -gt 0) {
  throw "A release process or listener remains without a verifiable stopped PID record; refusing to open the database."
}

$env:ARBOR_CONFIG = $providerConfigPath
$env:ARBOR_DB = $dbPath
$env:ARBOR_PROJECT_ROOT = $workspaceRoot
$env:ARBOR_PROJECT_ID = "prj_01a12e7b-6329-7598-92a1-433fed86e35b"
$env:ARBOR_RELEASE_OFFLINE_CHECKED = "1"

$arguments = @(
  "--workspace", $expectedWorkspace
)
if ($Mode -eq "Preview") {
  $arguments += "--preview"
} else {
  $arguments += @("--apply", "--expected-revision", [string]$ExpectedRevision)
}

Push-Location $root
try {
  & node (Join-Path $root "apps\single-workspace\dist\resource-boundary-shrink-ops.js") @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "The resource boundary operation exited with code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
