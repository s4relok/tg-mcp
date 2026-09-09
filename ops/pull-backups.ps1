param(
  [string[]]$SourceIds,
  [string]$ConfigPath,
  [string]$DestinationRoot = 'E:\backups\tg-mcp',
  [switch]$RefreshServer,
  [ValidatePattern('^[a-zA-Z0-9@.-]+$')][string]$RemoteHost = 's4relok@celticspear.com'
)
$ErrorActionPreference = 'Stop'
if ($ConfigPath) {
  $settings = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $SourceIds = @($settings.sourceIds)
  $DestinationRoot = [string]$settings.destination
  $RemoteHost = [string]$settings.remoteHost
}
if (-not $SourceIds -or $RemoteHost -notmatch '^[a-zA-Z0-9@.-]+$') { throw 'Exact source IDs and a valid SSH host are required' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = [IO.Path]::GetFullPath($DestinationRoot)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$downloadRoot = Join-Path $destination '.downloads'
[IO.Directory]::CreateDirectory($downloadRoot) | Out-Null
Start-Transcript -Path (Join-Path $destination 'pull.log') -Append | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
$remotePrefix = 'cd /srv/tg-mcp/current && TG_MCP_ENV_FILE=/srv/tg-mcp/shared/.env /srv/tg-mcp/shared/node/bin/node ops/backup-transfer.mjs'
$mutex = [Threading.Mutex]::new($false, 'Local\tg-mcp-backup-pull')
$acquired = $false
function Assert-Success([string]$Operation) {
  if ($LASTEXITCODE -ne 0) { throw "$Operation failed (exit $LASTEXITCODE)" }
}
function Assert-LocalPath([string]$Value) {
  $absolute = [IO.Path]::GetFullPath($Value)
  if (-not $absolute.StartsWith($destination.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Backup operation would escape its local destination'
  }
  return $absolute
}
try {
  try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw 'A backup pull is already running' }
  foreach ($sourceId in $SourceIds) {
    if ($sourceId -notmatch '^-?\d{1,24}$') { throw 'Each source must be one exact numeric ID' }
    if ($RefreshServer) {
      & ssh @sshOptions $RemoteHost "cd /srv/tg-mcp/current && /srv/tg-mcp/shared/node/bin/node src/cli.js backup-source-if-changed $sourceId --env-path /srv/tg-mcp/shared/.env"
      Assert-Success 'Refreshing server archive once'
    }
    $prepared = & ssh @sshOptions $RemoteHost "$remotePrefix prepare $sourceId"
    Assert-Success 'Preparing server snapshot'
    $job = ($prepared -join "`n") | ConvertFrom-Json
    if ($job.jobId -notmatch '^-?\d{1,24}-\d{13}-[a-f0-9-]{36}$' -or $job.sourceId -ne $sourceId) { throw 'Invalid server transfer ID' }
    $remoteDirectory = '/srv/tg-mcp/shared/backup-transfer/' + $job.jobId
    if ($job.directory -ne $remoteDirectory) { throw 'Unexpected server staging directory' }
    $work = Assert-LocalPath (Join-Path $downloadRoot $job.jobId)
    [IO.Directory]::CreateDirectory($work) | Out-Null
    $manifestFile = Assert-LocalPath (Join-Path $work 'manifest.json')
    & scp @sshOptions "${RemoteHost}:${remoteDirectory}/manifest.json" $manifestFile
    Assert-Success 'Downloading snapshot manifest'
    $missing = & $node (Join-Path $projectRoot 'ops/backup-local.mjs') plan $destination $manifestFile
    Assert-Success 'Planning verified incremental transfer'
    $missingFile = Assert-LocalPath (Join-Path $work 'missing.json')
    [IO.File]::WriteAllText($missingFile, ($missing -join "`n"), [Text.UTF8Encoding]::new($false))
    & scp @sshOptions $missingFile "${RemoteHost}:${remoteDirectory}/missing.json"
    Assert-Success 'Uploading missing-file inventory'
    & ssh @sshOptions $RemoteHost "$remotePrefix pack $($job.jobId)"
    Assert-Success 'Packing missing archive objects'
    $package = Assert-LocalPath (Join-Path $work 'payload.tar.gz')
    & scp @sshOptions "${RemoteHost}:${remoteDirectory}/payload.tar.gz" $package
    Assert-Success 'Downloading missing objects'
    & $node (Join-Path $projectRoot 'ops/backup-local.mjs') receive $destination $manifestFile $package $job.jobId
    Assert-Success 'Verifying and publishing local snapshot'
    $destinationEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($destination))
    & ssh @sshOptions $RemoteHost "$remotePrefix ack $($job.jobId) $destinationEncoded"
    Assert-Success 'Recording verified external copy'
    # Delete only this verified transfer's scratch files, never snapshots/objects.
    $work = Assert-LocalPath $work
    Remove-Item -LiteralPath $work -Recurse -Force
  }
  & $node (Join-Path $projectRoot 'ops/build-backup-viewer.mjs') $destination @SourceIds
  Assert-Success 'Building offline chat viewer'
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  Stop-Transcript | Out-Null
}
