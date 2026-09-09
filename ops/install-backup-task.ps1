param(
  [Parameter(Mandatory=$true)][string[]]$SourceIds,
  [string]$DestinationRoot = 'E:\backups\tg-mcp',
  [ValidatePattern('^[a-zA-Z0-9@.-]+$')][string]$RemoteHost = 's4relok@celticspear.com',
  [string]$TaskName = 'tg-mcp chat backups'
)
$ErrorActionPreference = 'Stop'
foreach ($sourceId in $SourceIds) {
  if ($sourceId -notmatch '^-?\d{1,24}$') { throw 'Every source must be one exact numeric ID' }
}
$destination = [IO.Path]::GetFullPath($DestinationRoot)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$configuration = [IO.Path]::GetFullPath((Join-Path $destination 'pull-config.json'))
if (-not $configuration.StartsWith($destination.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid configuration path' }
[IO.File]::WriteAllText($configuration, (@{ sourceIds = $SourceIds; destination = $destination; remoteHost = $RemoteHost } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'pull-backups.ps1'))
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$script`" -ConfigPath `"$configuration`" -RefreshServer"
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Description 'Manual only: refresh server archives once, pull verified copies, and rebuild the offline viewer. No scheduled triggers.' -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State
