param(
  [Parameter(Mandatory = $true)]
  [string[]]$TargetIds,
  [string]$QueueRoot = 'C:\DoubaoAutomation\interaction-queue',
  [int]$Port = 9229,
  [switch]$Once
)

. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-PackageRuntime
$queuePath = [System.IO.Path]::GetFullPath($QueueRoot)
$targetList = ($TargetIds | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ','
if ([string]::IsNullOrWhiteSpace($targetList)) { throw 'TargetIds must contain at least one window ID.' }
$arguments = @('queue-pool', '--port', [string]$Port, '--queue', $queuePath, '--target-ids', $targetList)
if ($Once) { $arguments += '--once' }
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') @arguments
if ($LASTEXITCODE -ne 0) { throw 'The interaction pool stopped. Inspect the queue and result states.' }
