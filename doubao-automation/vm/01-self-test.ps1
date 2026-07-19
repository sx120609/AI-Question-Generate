. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-PackageRuntime
$arguments = @('--port', '9229')
if (-not [string]::IsNullOrWhiteSpace([string]$runtime.Secrets)) {
  $arguments += @('--secrets', [string]$runtime.Secrets)
}
& $runtime.Node (Join-Path $PSScriptRoot 'src\vm-smoke.mjs') @arguments
if ($LASTEXITCODE -ne 0) { throw '自检未通过。' }
