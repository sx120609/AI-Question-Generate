. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-PackageRuntime
& $runtime.Node (Join-Path $PSScriptRoot 'src\vm-smoke.mjs') --secrets $runtime.Secrets --port 9229
if ($LASTEXITCODE -ne 0) { throw '自检未通过。' }
