param(
  [Parameter(Mandatory = $true)]
  [string]$ResultFile
)

. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-PackageRuntime
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') stop-job --file (Resolve-Path -LiteralPath $ResultFile).Path
if ($LASTEXITCODE -ne 0) { throw '停止请求执行失败。' }

