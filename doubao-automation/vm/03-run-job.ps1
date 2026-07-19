param(
  [Parameter(Mandatory = $true)]
  [string]$JobConfig,
  [string]$Output = '',
  [int]$Port = 9229,
  [string]$TargetId = '',
  [switch]$Resume
)

. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-PackageRuntime
$configPath = (Resolve-Path -LiteralPath $JobConfig).Path
if ([string]::IsNullOrWhiteSpace($Output)) {
  $job = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
  $resultRoot = Join-Path $PSScriptRoot 'results'
  New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null
  $Output = Join-Path $resultRoot ("{0}.json" -f [string]$job.jobId)
}
$outputPath = [System.IO.Path]::GetFullPath($Output)
$runArguments = @('run-job', '--port', [string]$Port, '--config', $configPath, '--output', $outputPath)
if (-not [string]::IsNullOrWhiteSpace($TargetId)) { $runArguments += @('--target-id', $TargetId) }
if ($Resume) { $runArguments += '--resume' }
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') @runArguments
if ($LASTEXITCODE -ne 0) { throw 'Job did not complete. Inspect the result JSON for its paused state.' }
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') verify-result --file $outputPath
if ($LASTEXITCODE -ne 0) { throw 'Job result integrity verification failed.' }
