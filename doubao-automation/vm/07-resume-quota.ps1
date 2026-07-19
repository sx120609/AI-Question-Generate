param(
  [string]$QueueRoot = 'C:\DoubaoAutomation\interaction-queue'
)

. (Join-Path $PSScriptRoot 'common.ps1')
$node = Get-PackageNode
$queuePath = [System.IO.Path]::GetFullPath($QueueRoot)
& $node (Join-Path $PSScriptRoot 'src\cli.mjs') resume-quota --queue $queuePath
if ($LASTEXITCODE -ne 0) { throw 'Failed to release the quota gate and restore quota-paused jobs.' }
