param(
  [Parameter(Mandatory = $true)]
  [string]$JobConfig,
  [string]$QueueRoot = 'C:\DoubaoAutomation\interaction-queue'
)

. (Join-Path $PSScriptRoot 'common.ps1')
$node = Get-PackageNode
$configPath = (Resolve-Path -LiteralPath $JobConfig).Path
$queuePath = [System.IO.Path]::GetFullPath($QueueRoot)
New-Item -ItemType Directory -Path $queuePath -Force | Out-Null
& $node (Join-Path $PSScriptRoot 'src\cli.mjs') enqueue-job --queue $queuePath --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'Failed to enqueue the immutable interaction package.' }
