param(
  [int]$Port = 9229
)

. (Join-Path $PSScriptRoot 'common.ps1')
$runtime = Initialize-PackageRuntime
$doubaoExe = Get-DoubaoExe
$profile = Join-Path $env:LOCALAPPDATA 'DoubaoAutomation\User Data'
$running = @(Get-Process -Name Doubao -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $doubaoExe })
if ($running.Count -gt 0) {
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 800
}
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') launch --exe $doubaoExe --profile $profile --port $Port
Start-Sleep -Seconds 2
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') probe --port $Port
if ($LASTEXITCODE -ne 0) { throw '豆包调试连接未建立。' }
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') office --port $Port
if ($LASTEXITCODE -ne 0) { throw '未能进入办公任务。首次使用时请完成一次登录后重新运行。' }
& $runtime.Node (Join-Path $PSScriptRoot 'src\cli.mjs') inspect --port $Port
if ($LASTEXITCODE -ne 0) { throw '办公任务状态读回失败。' }
