param(
  [Parameter(Mandatory = $true)]
  [string]$JobConfig,
  [string]$Output = '',
  [int]$Port = 9229
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
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') run-job --port $Port --config $configPath --output $outputPath
if ($LASTEXITCODE -ne 0) { throw '任务未完成，请查看结果 JSON 中的暂停状态。' }
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') verify-result --file $outputPath
if ($LASTEXITCODE -ne 0) { throw '任务结果完整性校验未通过。' }
